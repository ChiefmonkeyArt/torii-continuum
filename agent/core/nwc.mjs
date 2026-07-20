/**
 * nwc.mjs — Nostr Wallet Connect (NIP-47) client for the Torii agent.
 *
 * WHAT THIS DOES
 *   The operator pastes an NWC connection URI in the browser during
 *   onboarding. The browser POSTs it once over the authenticated same-origin
 *   API; the agent stores it encrypted at rest (see lib/secretstore.mjs) and
 *   USES it to talk NIP-47 to the operator's wallet service: get_info (to
 *   learn capabilities) and pay_invoice (to fund a Routstr session, ONLY after
 *   the operator explicitly confirms an invoice quote — never autonomously).
 *
 * SECURITY POSTURE (verbatim from the slice constraints)
 *   • The NWC URI carries a wallet-service pubkey, one or more relay URLs, and
 *     a `secret` (the client's private key). The secret is the whole ballgame:
 *     anyone holding it can spend. It therefore NEVER leaves the agent process
 *     except as NIP-04 ciphertext to the wallet's own relay. It is never
 *     logged, never returned over the API, never placed in an error string.
 *   • redactNwc() is the ONLY shape that may cross the API boundary: a wallet
 *     pubkey prefix, relay hosts, and a non-reversible secret fingerprint.
 *   • parseNwcUri() is strict and fails closed. A structurally invalid URI is
 *     rejected before anything touches the store or the network.
 *
 * TRANSPORT INJECTION
 *   The NIP-47 relay plumbing (encrypt → publish 23194 → await 23195 →
 *   decrypt) is behind an injected `transport`, so the request/response
 *   orchestration is unit-testable offline with a fake transport. The live
 *   transport (createLiveNwcTransport) uses nostr-tools + globalThis.WebSocket
 *   and FAILS CLOSED when WebSocket is absent (Node < 22.4.0), rather than
 *   pretending to connect.
 */

import { fingerprint } from '../lib/secretstore.mjs';

// NIP-47 event kinds.
const KIND_INFO = 13194;     // replaceable info event (plaintext capability list)
const KIND_REQUEST = 23194;  // client → wallet (NIP-04 encrypted {method,params})
const KIND_RESPONSE = 23195; // wallet → client (NIP-04 encrypted {result_type,result,error})

// pay_invoice is the ONE capability required to fund a Routstr session or make
// any outgoing payment. Everything else is optional and its absence must NOT
// block connecting the wallet — only funding.
const REQUIRED_FOR_FUNDING = 'pay_invoice';

// The capability vocabulary we surface in the matrix. Anything the wallet
// advertises beyond this is preserved in `methods` but not given a boolean.
const KNOWN_METHODS = [
  'pay_invoice',
  'make_invoice',
  'lookup_invoice',
  'get_balance',
  'get_info',
];

const HEX64 = /^[0-9a-f]{64}$/;

// Redact a BOLT11 for logs: first 10 + last 6 chars only. Mirrors the wallet
// module so no full invoice ever reaches a log line.
function redactBolt11(b) {
  return typeof b === 'string' && b.length > 20 ? `${b.slice(0, 10)}…${b.slice(-6)}` : 'invoice';
}

/**
 * Parse + validate an NWC connection URI. Fails closed on anything malformed.
 *
 * Accepted shape (NIP-47):
 *   nostr+walletconnect://<64-hex wallet pubkey>?relay=<ws(s) url>&secret=<64-hex>
 *   (relay may repeat; lud16 and other params are ignored)
 *
 * @returns {{ok:true, walletPubkey, relays:string[], secret, lud16:string|null}
 *           | {ok:false, reason:string}}
 */
export function parseNwcUri(uri) {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    return { ok: false, reason: 'empty uri' };
  }
  const trimmed = uri.trim();
  // The wallet pubkey sits in the authority position. Accept the canonical
  // `nostr+walletconnect://` scheme and the legacy `nostrwalletconnect://`
  // spelling some wallets still emit. Extract pubkey + raw query by hand — a
  // custom-scheme URL parse is inconsistent across runtimes for the authority.
  const m =
    /^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})(?:\?(.*))?$/.exec(trimmed) ||
    /^nostrwalletconnect:\/\/([0-9a-fA-F]{64})(?:\?(.*))?$/.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      reason: 'expected nostr+walletconnect://<64-hex-pubkey>?relay=...&secret=...',
    };
  }
  const walletPubkey = m[1].toLowerCase();
  if (!HEX64.test(walletPubkey)) {
    return { ok: false, reason: 'wallet pubkey must be 64 hex chars' };
  }

  let params;
  try {
    params = new URLSearchParams(m[2] || '');
  } catch {
    return { ok: false, reason: 'malformed query string' };
  }

  const relaysRaw = params.getAll('relay').map((r) => r.trim()).filter(Boolean);
  if (relaysRaw.length === 0) {
    return { ok: false, reason: 'at least one relay= is required' };
  }
  const relays = [];
  for (const r of relaysRaw) {
    let u;
    try {
      u = new URL(r);
    } catch {
      return { ok: false, reason: 'relay is not a valid URL' };
    }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
      return { ok: false, reason: 'relay must be a ws:// or wss:// URL' };
    }
    relays.push(u.toString());
  }

  const secret = (params.get('secret') || '').trim().toLowerCase();
  if (!HEX64.test(secret)) {
    return { ok: false, reason: 'secret must be 64 hex chars' };
  }

  const lud16 = params.get('lud16');
  return { ok: true, walletPubkey, relays, secret, lud16: lud16 || null };
}

/**
 * The ONLY representation of an NWC connection allowed to cross the API
 * boundary or enter a log line. Never contains the secret or the full URI.
 *
 * Accepts either a raw URI string or an already-parsed object. Returns null
 * when the input can't be parsed (caller decides how to surface "not set").
 */
export function redactNwc(uriOrParsed) {
  const parsed =
    typeof uriOrParsed === 'string' ? parseNwcUri(uriOrParsed) : uriOrParsed;
  if (!parsed || parsed.ok === false || !parsed.walletPubkey || !parsed.secret) {
    return null;
  }
  let relayHosts = [];
  try {
    relayHosts = (parsed.relays || []).map((r) => new URL(r).host);
  } catch {
    relayHosts = [];
  }
  return {
    wallet_pubkey_prefix: parsed.walletPubkey.slice(0, 12),
    relays: relayHosts,
    relay_count: (parsed.relays || []).length,
    secret_fingerprint: fingerprint(parsed.secret),
  };
}

/**
 * Build a capability matrix from a wallet's advertised method list.
 *
 * `can_fund_routstr` is the gate the Routstr step keys off: without
 * pay_invoice the wallet cannot make outgoing payments, so we must NOT let the
 * operator advance to funding — but we still connect the wallet and report the
 * (reduced) capabilities honestly.
 */
export function buildCapabilityMatrix(methods) {
  const set = new Set(
    Array.isArray(methods)
      ? methods.filter((m) => typeof m === 'string' && m.length > 0)
      : [],
  );
  const matrix = {};
  for (const m of KNOWN_METHODS) matrix[m] = set.has(m);
  return {
    methods: [...set],
    matrix,
    can_pay_invoice: set.has('pay_invoice'),
    can_make_invoice: set.has('make_invoice'),
    can_lookup_invoice: set.has('lookup_invoice'),
    can_get_balance: set.has('get_balance'),
    can_fund_routstr: set.has(REQUIRED_FOR_FUNDING),
  };
}

/**
 * NIP-47 client over an injected transport.
 *
 * transport contract (all async, all bounded by the caller's timeout):
 *   request({ method, params, timeoutMs }) →
 *     { ok:true, result } | { ok:false, code, message }
 *   capabilities({ timeoutMs }) → { ok:true, methods:string[] } | { ok:false }
 *   close() → void
 *
 * The client never logs secrets and never returns raw upstream error bodies —
 * only a short, sanitised reason.
 */
export function createNwcClient(parsed, deps = {}) {
  if (!parsed || parsed.ok === false) {
    throw new Error('createNwcClient: a valid parseNwcUri() result is required');
  }
  const transport = deps.transport;
  if (!transport || typeof transport.request !== 'function') {
    throw new Error('createNwcClient: transport with request() is required');
  }
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const defaultTimeout = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 15000;

  /**
   * get_info + capability discovery. Prefers the methods list from the
   * get_info response; falls back to the replaceable 13194 info event when the
   * wallet doesn't echo methods in get_info. Returns a capability matrix plus
   * a few non-secret descriptive fields.
   */
  async function getInfo({ timeoutMs } = {}) {
    const t = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout;
    let methods = null;
    let descriptive = {};
    const info = await transport.request({ method: 'get_info', params: {}, timeoutMs: t });
    if (info.ok && info.result && typeof info.result === 'object') {
      if (Array.isArray(info.result.methods)) methods = info.result.methods;
      // Non-secret descriptive fields only. Never surface anything that could
      // identify funds movement here.
      descriptive = {
        alias: typeof info.result.alias === 'string' ? info.result.alias.slice(0, 64) : null,
        network: typeof info.result.network === 'string' ? info.result.network.slice(0, 16) : null,
      };
    }
    if (!Array.isArray(methods) || methods.length === 0) {
      if (typeof transport.capabilities === 'function') {
        const caps = await transport.capabilities({ timeoutMs: t });
        if (caps.ok && Array.isArray(caps.methods)) methods = caps.methods;
      }
    }
    if (!Array.isArray(methods)) {
      return { ok: false, reason: info.ok ? 'wallet advertised no methods' : sanitize(info) };
    }
    const cap = buildCapabilityMatrix(methods);
    log.info(
      `[nwc] get_info ok (methods=${cap.methods.length}, pay_invoice=${cap.can_pay_invoice})`,
    );
    return { ok: true, ...cap, ...descriptive };
  }

  /**
   * pay_invoice. The confirmation boundary lives at the ROUTE layer: this is
   * only ever called after the operator has explicitly confirmed a quoted
   * invoice. The client itself performs no autonomous spending.
   *
   * @param {string} invoice bolt11
   */
  async function payInvoice(invoice, { timeoutMs, amountMsat } = {}) {
    if (typeof invoice !== 'string' || invoice.trim().length === 0) {
      return { ok: false, reason: 'invoice (bolt11) required' };
    }
    const t = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout;
    const params = { invoice: invoice.trim() };
    if (Number.isFinite(amountMsat) && amountMsat > 0) params.amount = amountMsat;
    const res = await transport.request({ method: 'pay_invoice', params, timeoutMs: t });
    if (!res.ok) {
      log.warn(`[nwc] pay_invoice failed (code=${res.code || 'none'})`);
      return { ok: false, reason: sanitize(res), code: res.code || null };
    }
    const preimage = res.result?.preimage;
    log.info('[nwc] pay_invoice ok');
    return {
      ok: true,
      preimage: typeof preimage === 'string' ? preimage : null,
      fees_paid_msat: Number.isFinite(res.result?.fees_paid) ? res.result.fees_paid : null,
    };
  }

  /**
   * make_invoice (NIP-47). Issues a BOLT11 on the connected wallet so the
   * operator can be paid into that wallet. Amount is sats here; NIP-47 wants
   * millisats on the wire. Returns only non-secret fields; never a preimage.
   *
   * @param {{ amountSats:number, memo?:string, expirySec?:number, timeoutMs?:number }} opts
   */
  async function makeInvoice({ amountSats, memo, expirySec, timeoutMs } = {}) {
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return { ok: false, reason: 'amount must be a positive integer (sats)' };
    }
    const t = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout;
    const params = { amount: amountSats * 1000 };
    if (typeof memo === 'string' && memo.trim()) params.description = memo.trim().slice(0, 128);
    if (Number.isFinite(expirySec) && expirySec > 0) params.expiry = expirySec;
    const res = await transport.request({ method: 'make_invoice', params, timeoutMs: t });
    if (!res.ok) {
      log.warn(`[nwc] make_invoice failed (code=${res.code || 'none'})`);
      return { ok: false, reason: sanitize(res), code: res.code || null };
    }
    const r = res.result || {};
    const invoice = r.invoice || r.bolt11 || r.payment_request;
    if (typeof invoice !== 'string' || invoice.length === 0) {
      return { ok: false, reason: 'wallet returned no invoice' };
    }
    log.info(`[nwc] make_invoice ok (${redactBolt11(invoice)})`);
    return {
      ok: true,
      invoice,
      payment_hash: typeof r.payment_hash === 'string' ? r.payment_hash : null,
      amount_sats: amountSats,
      expiry: Number.isFinite(r.expiry) ? r.expiry : null,
    };
  }

  /**
   * lookup_invoice (NIP-47). Reports settlement of an invoice this wallet
   * issued. Paid is derived from a positive `settled_at` OR an explicit settled
   * state. Never returns the preimage over this surface.
   *
   * @param {{ paymentHash?:string, invoice?:string, timeoutMs?:number }} opts
   */
  async function lookupInvoice({ paymentHash, invoice, timeoutMs } = {}) {
    const t = Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout;
    const params = {};
    if (typeof paymentHash === 'string' && paymentHash) params.payment_hash = paymentHash;
    else if (typeof invoice === 'string' && invoice) params.invoice = invoice;
    else return { ok: false, reason: 'payment_hash or invoice required' };
    const res = await transport.request({ method: 'lookup_invoice', params, timeoutMs: t });
    if (!res.ok) {
      log.warn(`[nwc] lookup_invoice failed (code=${res.code || 'none'})`);
      return { ok: false, reason: sanitize(res), code: res.code || null };
    }
    const r = res.result || {};
    const settledAt = Number.isFinite(r.settled_at) && r.settled_at > 0 ? r.settled_at : null;
    const paid = settledAt !== null || r.state === 'settled' || r.settled === true;
    return { ok: true, paid, state: paid ? 'PAID' : 'UNPAID', settled_at: settledAt };
  }

  async function close() {
    if (typeof transport.close === 'function') {
      try { await transport.close(); } catch { /* best effort */ }
    }
  }

  return { getInfo, payInvoice, makeInvoice, lookupInvoice, close };
}

// A short, allow-listed reason string for NIP-47 error codes. We never echo a
// raw upstream message — only a bounded, known code plus a generic label.
const KNOWN_NWC_CODES = new Set([
  'RATE_LIMITED', 'NOT_IMPLEMENTED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED',
  'RESTRICTED', 'UNAUTHORIZED', 'INTERNAL', 'OTHER', 'PAYMENT_FAILED',
  'NOT_FOUND',
]);

function sanitize(res) {
  const code = typeof res?.code === 'string' && KNOWN_NWC_CODES.has(res.code) ? res.code : 'ERROR';
  return `wallet error (${code})`;
}

/**
 * Live NIP-47 transport over nostr-tools + globalThis.WebSocket.
 *
 * FAILS CLOSED when WebSocket is unavailable (Node < 22.4.0). The agent's
 * production target is Node >= 22.4.0 where WebSocket is a global; we refuse to
 * fake a transport rather than silently no-op a payment path.
 *
 * Each call opens a relay, does one request/response round trip, and closes —
 * bounded and simple for the two operations we need (get_info once, pay_invoice
 * once per funding). nostr-tools is imported lazily so a unit test that injects
 * its own transport never pulls the relay/websocket stack.
 *
 * @param {object} parsed parseNwcUri() result
 */
export async function createLiveNwcTransport(parsed, deps = {}) {
  if (!parsed || parsed.ok === false) {
    throw new Error('createLiveNwcTransport: valid parseNwcUri() result required');
  }
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error(
      'createLiveNwcTransport: global WebSocket unavailable — Node >= 22.4.0 required for the live NWC path',
    );
  }
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure');
  const { nip04 } = await import('nostr-tools');
  const { Relay } = await import('nostr-tools/relay');

  const secretBytes = Buffer.from(parsed.secret, 'hex');
  const clientPubkey = getPublicKey(secretBytes);
  const walletPubkey = parsed.walletPubkey;

  async function connect() {
    let lastErr;
    for (const url of parsed.relays) {
      try {
        return await Relay.connect(url);
      } catch (e) {
        lastErr = e;
        log.warn(`[nwc] relay connect failed (${new URL(url).host})`);
      }
    }
    throw new Error(`no relay reachable${lastErr ? '' : ''}`);
  }

  async function request({ method, params, timeoutMs = 15000 }) {
    let relay;
    try {
      relay = await connect();
    } catch {
      return { ok: false, code: 'OTHER', message: 'relay unreachable' };
    }
    try {
      const content = await nip04.encrypt(secretBytes, walletPubkey, JSON.stringify({ method, params }));
      const reqEvent = finalizeEvent(
        {
          kind: KIND_REQUEST,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', walletPubkey]],
          content,
        },
        secretBytes,
      );

      const responsePromise = new Promise((resolve) => {
        const sub = relay.subscribe(
          [{ kinds: [KIND_RESPONSE], '#e': [reqEvent.id], authors: [walletPubkey] }],
          {
            async onevent(ev) {
              try {
                const plain = await nip04.decrypt(secretBytes, walletPubkey, ev.content);
                const parsedResp = JSON.parse(plain);
                if (parsedResp.error) {
                  resolve({ ok: false, code: parsedResp.error.code || 'OTHER' });
                } else {
                  resolve({ ok: true, result: parsedResp.result });
                }
              } catch {
                resolve({ ok: false, code: 'OTHER', message: 'undecryptable response' });
              } finally {
                try { sub.close(); } catch { /* noop */ }
              }
            },
          },
        );
      });

      await relay.publish(reqEvent);

      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, code: 'OTHER', message: 'timeout' }), timeoutMs),
      );
      return await Promise.race([responsePromise, timeout]);
    } catch {
      return { ok: false, code: 'OTHER', message: 'request failed' };
    } finally {
      try { relay.close(); } catch { /* noop */ }
    }
  }

  async function capabilities({ timeoutMs = 15000 }) {
    let relay;
    try {
      relay = await connect();
    } catch {
      return { ok: false };
    }
    try {
      const infoPromise = new Promise((resolve) => {
        const sub = relay.subscribe(
          [{ kinds: [KIND_INFO], authors: [walletPubkey], limit: 1 }],
          {
            onevent(ev) {
              const methods = (ev.content || '').split(/\s+/).filter(Boolean);
              resolve({ ok: true, methods });
              try { sub.close(); } catch { /* noop */ }
            },
          },
        );
      });
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false }), timeoutMs));
      return await Promise.race([infoPromise, timeout]);
    } catch {
      return { ok: false };
    } finally {
      try { relay.close(); } catch { /* noop */ }
    }
  }

  return { request, capabilities, close() {}, _clientPubkey: clientPubkey };
}
