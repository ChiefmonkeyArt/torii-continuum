/**
 * routstr-provider.mjs — a hardened, SSRF-pinned adapter to ONE configured
 * Routstr provider, used by the onboarding Routstr step.
 *
 * WHY A SEPARATE ADAPTER (not core/routstr.mjs)
 *   core/routstr.mjs is the per-request chat path (Cashu token per completion).
 *   Onboarding needs a different, narrow surface: verify an operator-supplied
 *   `sk-...` key, read its balance/models, and — where the provider supports it
 *   — quote a Lightning top-up invoice the operator pays via their connected
 *   NWC wallet. That surface talks to the provider's account/wallet endpoints,
 *   not the completion endpoint, so it lives here behind its own guard rails.
 *
 * SECURITY POSTURE (verbatim from the slice constraints)
 *   • URL ALLOWLISTING / PINNING: every request is built against the single
 *     configured provider origin (cfg.routstr.provider.base_url, default
 *     cfg.routstr.endpoint). A request whose resolved origin does not match is
 *     refused before any socket opens — there is no open proxy and no
 *     caller-supplied URL anywhere in this module.
 *   • https ONLY. A non-https base_url is rejected at construction.
 *   • NO REDIRECTS: fetch uses redirect:'error', so a 30x can't bounce us to an
 *     attacker origin (the classic SSRF pivot).
 *   • BOUNDED: every request has an AbortController timeout and a response-body
 *     byte cap. Polling is bounded by attempts × interval.
 *   • FAIL CLOSED + CONSTANT-SAFE REDACTION: we never return a full `sk-...`
 *     key, never echo a raw upstream body in a user-facing error (only status
 *     code + generic label), and never log secrets.
 *
 * LIGHTNING INVOICE CONTRACT (source-grounded — Routstr/routstr-core
 * routstr/lightning.py, mounted at root via core/main.py:app.include_router)
 *   • CREATE  POST /lightning/invoice
 *       req  { amount_sats:int(1..1_000_000), purpose:"create"|"topup",
 *              api_key?, balance_limit?, balance_limit_reset?, validity_date? }
 *              — purpose "topup" requires Authorization: Bearer sk-...; purpose
 *              "create" (fund a fresh session) needs no auth and mints a new key
 *              on payment.
 *       res  InvoiceCreateResponse { invoice_id, bolt11, amount_sats,
 *              expires_at (unix seconds), payment_hash }
 *   • STATUS  GET /lightning/invoice/{invoice_id}/status
 *       res  InvoiceStatusResponse { status:"pending"|"paid"|"expired",
 *              api_key:"sk-…"|null (present once paid), amount_sats, paid_at,
 *              created_at, expires_at }
 *   • RECOVER POST /lightning/recover  { bolt11 } → InvoiceStatusResponse
 *       The source-grounded recoverable-state path: if a client loses the
 *       invoice_id (or a poll times out) it can re-derive status + the minted
 *       api_key from the bolt11 alone. routstr-core also runs a server-side
 *       periodic_invoice_watcher, so payment is credited even without polling.
 *
 *   These paths are the DEFAULTS (see DEFAULTS below); an operator can override
 *   or null them per deployment. Setting invoice_path to null re-arms the
 *   fail-closed "blocked" result (createInvoice → { blocked:true }) for a
 *   provider that genuinely lacks the endpoint. Nothing here is invented — the
 *   field names, purposes, and paths are lifted verbatim from routstr-core.
 */

import { createHash } from 'node:crypto';

const DEFAULTS = {
  min_topup_sats: 10,
  max_topup_sats: 10000,
  request_timeout_ms: 15000,
  max_response_bytes: 64 * 1024,
  poll_interval_ms: 3000,
  poll_max_attempts: 20,
  balance_path: '/v1/balance/info',
  models_path: '/v1/models',
  // Source-grounded Lightning paths (routstr-core routstr/lightning.py). See
  // header. {id} in the status path is substituted with the invoice_id.
  invoice_path: '/lightning/invoice',
  invoice_status_path: '/lightning/invoice/{id}/status',
  invoice_recover_path: '/lightning/recover',
};

/** sk- key redaction: never reversible, never the full key. */
export function redactRoutstrKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const last4 = key.slice(-4);
  return {
    key_preview: `sk-…${last4}`,
    key_fingerprint: fp(key),
  };
}

// Local fingerprint — label domain-separates it from secretstore's audit
// fingerprint so a value can't be correlated across the two logs.
function fp(s) {
  return createHash('sha256').update('routstr:' + s, 'utf8').digest('hex').slice(0, 12);
}

function num(v, dflt) {
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/**
 * @param {object} cfg  frozen loadConfig() result
 * @param {object} deps { fetchImpl?, log?, now? }
 */
export function createRoutstrProvider(cfg, deps = {}) {
  const provider = cfg?.routstr?.provider || {};
  const baseUrlRaw = provider.base_url || cfg?.routstr?.endpoint;
  if (typeof baseUrlRaw !== 'string' || !baseUrlRaw) {
    throw new Error('routstr-provider: base_url (or routstr.endpoint) required');
  }
  let base;
  try {
    base = new URL(baseUrlRaw);
  } catch {
    throw new Error('routstr-provider: base_url is not a valid URL');
  }
  if (base.protocol !== 'https:') {
    throw new Error('routstr-provider: base_url must be https://');
  }
  // The immutable pin. Every request origin must equal this or it is refused.
  const ALLOWED_ORIGIN = base.origin;

  const log = deps.log || { info() {}, warn() {}, error() {} };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('routstr-provider: no fetch implementation available');
  }

  const opt = {
    minTopup: num(provider.min_topup_sats, DEFAULTS.min_topup_sats),
    maxTopup: num(provider.max_topup_sats, DEFAULTS.max_topup_sats),
    timeoutMs: num(provider.request_timeout_ms, DEFAULTS.request_timeout_ms),
    maxBytes: num(provider.max_response_bytes, DEFAULTS.max_response_bytes),
    pollIntervalMs: num(provider.poll_interval_ms, DEFAULTS.poll_interval_ms),
    pollMaxAttempts: num(provider.poll_max_attempts, DEFAULTS.poll_max_attempts),
    balancePath: provider.balance_path || DEFAULTS.balance_path,
    modelsPath: provider.models_path || DEFAULTS.models_path,
    // Presence check (not `??`/`||`) so an operator can explicitly disable a
    // path with `null` — re-arming the fail-closed blocked result — while an
    // absent key still falls back to the source-grounded default. (`?? default`
    // would treat an explicit null as nullish and snap it back to the default,
    // making the path impossible to disable.)
    invoicePath: 'invoice_path' in provider ? provider.invoice_path : DEFAULTS.invoice_path,
    invoiceStatusPath: 'invoice_status_path' in provider ? provider.invoice_status_path : DEFAULTS.invoice_status_path,
    invoiceRecoverPath: 'invoice_recover_path' in provider ? provider.invoice_recover_path : DEFAULTS.invoice_recover_path,
  };

  /**
   * Build a URL from a provider-relative path and assert it stays pinned to the
   * configured origin. Rejects absolute URLs, protocol-relative (`//host`)
   * tricks, and any cross-origin result.
   */
  function pin(path) {
    if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')) {
      throw new Error('routstr-provider: path must be an absolute /path on the pinned origin');
    }
    const u = new URL(path, base);
    if (u.origin !== ALLOWED_ORIGIN || u.protocol !== 'https:') {
      throw new Error('routstr-provider: refusing off-origin request (SSRF guard)');
    }
    return u;
  }

  /**
   * The single choke point for all outbound calls. Pinned origin, no redirects,
   * bounded timeout, bounded body. Returns { ok, status, json|null } and NEVER
   * throws a raw upstream body outward.
   */
  async function call(path, { method = 'GET', headers = {}, body = null } = {}) {
    let url;
    try {
      url = pin(path);
    } catch (e) {
      return { ok: false, status: 0, reason: e.message, json: null };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opt.timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body,
        redirect: 'error', // SSRF: never follow a 30x off the pinned origin
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e?.name === 'AbortError';
      return { ok: false, status: 0, reason: aborted ? 'timeout' : 'network', json: null };
    }
    clearTimeout(timer);

    // Bound the response body. Reject oversize by declared length up front, and
    // hard-cap the actual bytes we read so a lying content-length can't OOM us.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opt.maxBytes) {
      return { ok: false, status: res.status, reason: 'response_too_large', json: null };
    }
    const text = await readCapped(res, opt.maxBytes);
    if (text === null) {
      return { ok: false, status: res.status, reason: 'response_too_large', json: null };
    }
    let json = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { ok: res.ok, status: res.status, json };
  }

  function authHeaders(key) {
    return { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  }

  /**
   * Validate & verify an operator-supplied Routstr key against the pinned
   * provider. Reads balance/info; falls back to a models probe with the key so
   * we confirm the key actually authenticates. Returns only redacted metadata.
   *
   * @param {string} key `sk-...` (or a cashu token the provider accepts)
   */
  async function verifyKey(key) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      return { ok: false, reason: 'key required' };
    }
    const k = key.trim();
    // Shape guard: accept sk-... or a cashu... token; reject anything with
    // whitespace/control chars that could smuggle a header.
    if (!/^(sk-[A-Za-z0-9._-]+|cashu[A-Za-z0-9._-]+)$/.test(k)) {
      return { ok: false, reason: 'key must be an sk-... key or a cashu token' };
    }
    const info = await call(opt.balancePath, { headers: authHeaders(k) });
    if (info.status === 401 || info.status === 403) {
      return { ok: false, reason: 'provider rejected the key (unauthorized)' };
    }
    let balanceSats = null;
    let capabilities = {};
    if (info.ok && info.json && typeof info.json === 'object') {
      balanceSats = extractBalanceSats(info.json);
      capabilities = extractKeyCapabilities(info.json);
    }
    // Confirm the key authenticates and the provider serves models. models is
    // public, so we send it WITH the key to double as an auth probe when
    // balance/info wasn't conclusive.
    const models = await call(opt.modelsPath, { headers: authHeaders(k) });
    const modelCount = models.ok && Array.isArray(models.json?.data)
      ? models.json.data.length
      : (models.ok && Array.isArray(models.json) ? models.json.length : null);

    if (!info.ok && !models.ok) {
      return { ok: false, reason: `provider unreachable or key invalid (status ${info.status || models.status})` };
    }
    log.info(`[routstr-provider] verifyKey ok (fp=${fp(k)}, balance_known=${balanceSats !== null})`);
    return {
      ok: true,
      ...redactRoutstrKey(k),
      balance_sats: balanceSats,
      models_available: modelCount,
      capabilities,
    };
  }

  /** Public models list (no key needed), pinned + bounded. */
  async function listModels() {
    const res = await call(opt.modelsPath, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `provider status ${res.status}` };
    const data = Array.isArray(res.json?.data) ? res.json.data : (Array.isArray(res.json) ? res.json : []);
    return { ok: true, count: data.length, models: data.map(safeModel) };
  }

  /** Clamp/validate a requested top-up amount against configured bounds. */
  function checkAmountBounds(sats) {
    if (!Number.isInteger(sats)) return { ok: false, reason: 'amount must be an integer number of sats' };
    if (sats < opt.minTopup) return { ok: false, reason: `amount below minimum (${opt.minTopup} sats)` };
    if (sats > opt.maxTopup) return { ok: false, reason: `amount above maximum (${opt.maxTopup} sats)` };
    return { ok: true, sats };
  }

  /**
   * Quote a Lightning invoice via the source-grounded POST /lightning/invoice.
   * `purpose` defaults to "create" (fund a brand-new session — no key, mints one
   * on payment); "topup" adds to an existing key and requires it. Returns the
   * bolt11 + invoice_id so the caller can pay (via NWC, after explicit confirm)
   * and then poll status. This function NEVER pays.
   *
   * When invoice_path is explicitly nulled by config, returns the fail-closed
   * { blocked:true } result instead of inventing an endpoint.
   */
  async function createInvoice({ amountSats, purpose = 'create', key = null } = {}) {
    const bounds = checkAmountBounds(amountSats);
    if (!bounds.ok) return bounds;

    if (!opt.invoicePath) {
      return {
        ok: false,
        blocked: true,
        reason: 'provider_invoice_disabled',
        guidance:
          'routstr.provider.invoice_path is disabled (null) for this deployment. ' +
          'Set it to the provider Lightning path (default /lightning/invoice) to enable ' +
          'funding-by-invoice, or use an existing sk- key instead.',
      };
    }
    if (purpose !== 'create' && purpose !== 'topup') {
      return { ok: false, reason: 'purpose must be "create" or "topup"' };
    }

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const body = { amount_sats: bounds.sats, purpose };
    if (purpose === 'topup') {
      // topup credits an existing key — the provider requires it as a bearer.
      if (typeof key !== 'string' || !/^sk-[A-Za-z0-9._-]+$/.test(key)) {
        return { ok: false, reason: 'topup requires an existing sk- key' };
      }
      headers.Authorization = `Bearer ${key}`;
    }

    const res = await call(opt.invoicePath, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok || !res.json) {
      return { ok: false, reason: `provider status ${res.status}` };
    }
    // InvoiceCreateResponse: { invoice_id, bolt11, amount_sats, expires_at, payment_hash }
    const invoice = firstString(res.json, ['bolt11', 'invoice', 'pr', 'payment_request']);
    const quoteId = firstString(res.json, ['invoice_id', 'id', 'quote_id']);
    if (!invoice || !quoteId) return { ok: false, reason: 'provider returned an incomplete invoice' };
    return {
      ok: true,
      invoice,
      amount_sats: Number.isFinite(res.json.amount_sats) ? res.json.amount_sats : bounds.sats,
      provider_host: ALLOWED_ORIGIN,
      quote_id: quoteId,
      payment_hash: firstString(res.json, ['payment_hash']) || null,
      expires_at: Number.isFinite(res.json.expires_at) ? res.json.expires_at : null,
      purpose,
    };
  }

  // Parse an InvoiceStatusResponse into our normalized shape.
  function readStatus(json) {
    const status = typeof json?.status === 'string' ? json.status : 'unknown';
    const key = firstString(json, ['api_key', 'key', 'sk']);
    return {
      status,
      key,
      paid: status === 'paid',
      expired: status === 'expired',
      amount_sats: Number.isFinite(json?.amount_sats) ? json.amount_sats : null,
      paid_at: Number.isFinite(json?.paid_at) ? json.paid_at : null,
    };
  }

  /**
   * Poll GET /lightning/invoice/{invoice_id}/status until paid, bounded by
   * attempts × interval. On payment the provider populates api_key ("sk-…"),
   * which we return redacted alongside the raw key so onboarding can store it.
   * If polling exhausts before settlement we return a RECOVERABLE result (the
   * payment may still land via the server-side watcher) — callers should keep
   * the bolt11 and use recoverInvoice().
   */
  async function pollInvoice({ quoteId }, { sleep } = {}) {
    if (!opt.invoiceStatusPath) {
      return { ok: false, blocked: true, reason: 'provider_invoice_disabled' };
    }
    if (typeof quoteId !== 'string' || quoteId.length === 0) {
      return { ok: false, reason: 'quoteId required' };
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(quoteId)) {
      return { ok: false, reason: 'quoteId has an unexpected shape' };
    }
    const wait = typeof sleep === 'function'
      ? sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
    const path = opt.invoiceStatusPath.replace('{id}', encodeURIComponent(quoteId));
    for (let attempt = 0; attempt < opt.pollMaxAttempts; attempt++) {
      const res = await call(path, { headers: { Accept: 'application/json' } });
      if (res.ok && res.json) {
        const st = readStatus(res.json);
        if (st.paid && st.key) return { ok: true, key: st.key, status: 'paid', ...redactRoutstrKey(st.key) };
        if (st.expired) return { ok: false, reason: 'invoice expired', status: 'expired' };
      }
      if (attempt < opt.pollMaxAttempts - 1) await wait(opt.pollIntervalMs);
    }
    return { ok: false, recoverable: true, reason: 'polling timed out before settlement' };
  }

  /**
   * Recover an already-created invoice's status + minted key from its bolt11
   * alone, via POST /lightning/recover. This is the precise recoverable path
   * when an invoice_id was lost or a poll timed out after the wallet paid.
   */
  async function recoverInvoice({ bolt11 } = {}) {
    if (!opt.invoiceRecoverPath) {
      return { ok: false, blocked: true, reason: 'provider_invoice_disabled' };
    }
    if (typeof bolt11 !== 'string' || bolt11.trim().length === 0) {
      return { ok: false, reason: 'bolt11 required' };
    }
    // bolt11 invoices are bech32 (lnbc…); reject anything with whitespace/control
    // chars that could smuggle a header or body.
    const inv = bolt11.trim();
    if (!/^ln[a-z0-9]+$/i.test(inv)) return { ok: false, reason: 'bolt11 has an unexpected shape' };
    const res = await call(opt.invoiceRecoverPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ bolt11: inv }),
    });
    if (!res.ok || !res.json) return { ok: false, reason: `provider status ${res.status}` };
    const st = readStatus(res.json);
    if (st.paid && st.key) return { ok: true, key: st.key, status: 'paid', ...redactRoutstrKey(st.key) };
    if (st.expired) return { ok: false, reason: 'invoice expired', status: 'expired' };
    return { ok: false, recoverable: true, status: st.status, reason: 'invoice not yet settled' };
  }

  return {
    verifyKey,
    listModels,
    createInvoice,
    pollInvoice,
    recoverInvoice,
    checkAmountBounds,
    bounds: { min: opt.minTopup, max: opt.maxTopup },
    providerHost: ALLOWED_ORIGIN,
    _pin: pin, // exposed for SSRF unit tests
  };
}

// ── defensive parsing helpers (upstream shapes vary; never trust blindly) ──

async function readCapped(res, maxBytes) {
  // Prefer streaming so we stop at the cap; fall back to text() when the body
  // isn't a web stream (some fetch polyfills / test doubles).
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* noop */ }
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  return text.length > maxBytes ? null : text;
}

function extractBalanceSats(json) {
  // Routstr balance may arrive as sats or msats under a few field names.
  if (Number.isFinite(json.balance_sats)) return json.balance_sats;
  if (Number.isFinite(json.balance)) return json.balance;
  if (Number.isFinite(json.balance_msats)) return Math.floor(json.balance_msats / 1000);
  if (json.wallet && Number.isFinite(json.wallet.balance)) return json.wallet.balance;
  return null;
}

function extractKeyCapabilities(json) {
  const out = {};
  if (json.restrictions && typeof json.restrictions === 'object') {
    out.restricted = true;
  }
  if (Array.isArray(json.child_keys)) out.child_keys = json.child_keys.length;
  return out;
}

function safeModel(m) {
  if (typeof m === 'string') return { id: m };
  return {
    id: typeof m?.id === 'string' ? m.id.slice(0, 128) : null,
    // pricing shape varies; surface only if present and numeric
    prompt: Number.isFinite(m?.pricing?.prompt) ? m.pricing.prompt : undefined,
    completion: Number.isFinite(m?.pricing?.completion) ? m.pricing.completion : undefined,
  };
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
