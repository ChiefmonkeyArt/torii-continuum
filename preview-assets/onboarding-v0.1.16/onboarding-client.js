/* =========================================================
   onboarding-client.js — step 1 live auth client (preview)

   Self-contained, no build step, no third-party CDN. Wires the
   onboarding step-1 "prove you're the operator" panel to the live
   same-origin agent API:

     POST /api/auth/challenge  -> { challenge, expires_in, kind: 22242 }
     POST /api/auth/verify {event} -> { token, expires_at }

   Primary signer path is NIP-07 via window.nostr (Plebeian Signer).
   Secondary path is NIP-46 with the *browser* acting as the NIP-46
   client (architecture per github.com/dsbaars/bunker46): the browser
   holds an ephemeral client key, talks to the operator's remote signer
   (bunker) over a relay, and asks it to sign the same 22242 auth event.
   There is deliberately NO server bunker-connect endpoint — the browser
   never hands any key or connection secret to the agent; only the final
   signed event reaches /api/auth/verify.

   Session, on success, is written to exactly:
     localStorage['torii.session']
   as JSON. Shape (no secrets — only what the app needs to make
   authenticated calls and show identity):
     {
       token:      string,  // HMAC session token from the agent
       expires_at: number,  // unix seconds; token TTL
       pubkey:     string,  // hex pubkey of the operator that signed
       method:     'nip07' | 'nip46',
       created_at: number   // unix seconds; when we stored it
     }

   The module exports pure, dependency-injected helpers so the whole
   flow is unit-testable offline (mock fetch / signer / storage / relay).
   When loaded in a browser it also self-wires the step-1 panel.
   ========================================================= */

export const AUTH_KIND = 22242;
export const SESSION_KEY = 'torii.session';

// Requested animation clips per phase. The live GLB may not ship every
// clip, so each phase carries an ordered fallback list of clips that DO
// exist in chiefmonkey6.glb; selectAnimation() walks it and returns null
// (== keep the current animation) when nothing matches. This is the
// "graceful fallback if a clip is unavailable" contract.
export const ANIM = {
  prompting: { clip: 'HandGesture_00', fallbacks: ['idle_to_push_up', 'Idle_03'] },
  success: { clip: 'Idle_03', fallbacks: [] },
  failure: { clip: 'Confused_02', fallbacks: ['Hit_Reaction_to_Waist', 'Knock_Down'] },
};

/**
 * Pick the animation clip to play for a phase given the clips actually
 * present in the loaded model. Returns the primary clip if available,
 * else the first available fallback, else null (caller keeps current).
 * @param {'prompting'|'success'|'failure'} phase
 * @param {Iterable<string>|null|undefined} available clip names present in the GLB
 */
export function selectAnimation(phase, available) {
  const spec = ANIM[phase];
  if (!spec) return null;
  // No knowledge of what's available → optimistically request the primary
  // clip; character.js still no-ops if it's genuinely missing.
  if (!available) return spec.clip;
  const set = available instanceof Set ? available : new Set(available);
  for (const name of [spec.clip, ...spec.fallbacks]) {
    if (set.has(name)) return name;
  }
  return null;
}

/**
 * Build the unsigned NIP-07/NIP-42-shaped auth event the agent expects.
 * Mirrors agent/core/auth.mjs exactly: kind 22242, content == challenge,
 * a 'challenge' tag and a 'relay' tag carrying this origin.
 */
export function buildAuthEvent(challenge, origin, now = () => Math.floor(Date.now() / 1000)) {
  return {
    kind: AUTH_KIND,
    created_at: now(),
    content: challenge,
    tags: [
      ['challenge', challenge],
      ['relay', origin],
    ],
  };
}

/**
 * Validate the /api/auth/challenge response. Fail closed: anything not
 * matching the exact contract (non-object, missing/empty challenge,
 * non-numeric or already-elapsed expiry, wrong kind) throws.
 * @returns {{ challenge: string, expires_in: number }}
 */
export function validateChallengeResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new Error('malformed challenge response');
  const { challenge, expires_in, kind } = resp;
  if (typeof challenge !== 'string' || challenge.length < 8) {
    throw new Error('malformed challenge');
  }
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0) {
    throw new Error('malformed challenge expiry');
  }
  // The agent tags challenges as kind 22242. If present it must match; a
  // missing kind is tolerated (older agents) but a wrong one is rejected.
  if (kind !== undefined && kind !== AUTH_KIND) {
    throw new Error('unexpected challenge kind');
  }
  return { challenge, expires_in };
}

/**
 * Validate the /api/auth/verify success body. Fail closed: the token must
 * be a non-empty string and expires_at, if present, a future-ish number.
 * @returns {{ token: string, expires_at: number|null }}
 */
export function validateVerifyResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new Error('malformed verify response');
  const { token, expires_at } = resp;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('missing session token');
  }
  let exp = null;
  if (expires_at !== undefined && expires_at !== null) {
    if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) {
      throw new Error('malformed token expiry');
    }
    exp = expires_at;
  }
  return { token, expires_at: exp };
}

/**
 * Validate a browser-side signed auth event before it is trusted or sent.
 * Fail closed on shape, kind, missing sig/pubkey, or a challenge tag that
 * does not match the challenge we issued (pubkey-mismatch and expired
 * challenges are additionally enforced server-side, but we refuse early).
 */
export function validateSignedEvent(event, expectedChallenge) {
  if (!event || typeof event !== 'object') throw new Error('signer returned no event');
  if (event.kind !== AUTH_KIND) throw new Error('signer returned wrong kind');
  if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
    throw new Error('signer returned no pubkey');
  }
  if (typeof event.sig !== 'string' || event.sig.length !== 128) {
    throw new Error('signer returned no signature');
  }
  const tag = Array.isArray(event.tags)
    ? event.tags.find((t) => Array.isArray(t) && t[0] === 'challenge')
    : null;
  if (!tag || tag[1] !== expectedChallenge) {
    throw new Error('signed challenge mismatch');
  }
  if (event.content !== undefined && event.content !== expectedChallenge) {
    throw new Error('signed content mismatch');
  }
  return event;
}

/**
 * Build the localStorage['torii.session'] value. Only carries the returned
 * session token + public identity metadata the app needs — never any nsec,
 * bunker secret, or relay credential.
 */
export function buildSessionValue({ token, expires_at, pubkey, method }, now = () => Math.floor(Date.now() / 1000)) {
  return {
    token,
    expires_at: expires_at ?? null,
    pubkey,
    method,
    created_at: now(),
  };
}

/**
 * Persist a session to exactly localStorage['torii.session'].
 * storage defaults to window.localStorage.
 */
export function storeSession(session, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) throw new Error('no storage available');
  store.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function readSession(storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  const raw = store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Decide whether a stored session may be trusted to restore the authenticated
 * step without re-signing. Fail closed. There is no dedicated server session
 * validation endpoint, so we validate against the *existing* session token
 * semantics the agent already defines in agent/core/auth.mjs
 * (verifySessionToken): the token is a self-verifying HMAC of the form
 * `iat.exp.pubkey.sig`. We cannot recompute the HMAC in the browser (the
 * secret is server-only, and must stay that way), but we can enforce every
 * NON-secret invariant the agent enforces — exact 4-part shape, numeric
 * timestamps, a not-yet-elapsed expiry, and that the pubkey embedded in the
 * token matches the stored identity. Anything off → not valid → step 1.
 * This adds no server surface and never trusts storage blindly.
 */
export function isSessionValid(session, now = () => Math.floor(Date.now() / 1000)) {
  if (!session || typeof session !== 'object') return false;
  const { token, pubkey, method, expires_at } = session;
  if (typeof token !== 'string' || token.length === 0) return false;
  // Mirror the agent token shape exactly: iat.exp.pubkey.sig (4 parts).
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const iat = Number(parts[0]);
  const exp = Number(parts[1]);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(pubkey)) return false;
  if (method !== 'nip07' && method !== 'nip46') return false;
  const t = now();
  // The token's own expiry is authoritative — this is the agent's `exp < now`
  // check. Fail closed once elapsed.
  if (exp <= t) return false;
  // A stored expires_at, when present, must agree the token is still live.
  if (expires_at !== undefined && expires_at !== null) {
    if (typeof expires_at !== 'number' || !Number.isFinite(expires_at) || expires_at <= t) {
      return false;
    }
  }
  // Defence in depth: the identity baked into the token must match the stored
  // pubkey, so a hand-edited session can't pair a live token with a new pubkey.
  if (parts[2] !== pubkey) return false;
  return true;
}

/**
 * Read + validate the stored session for restoration on (re)load. Returns the
 * session only if still valid; otherwise removes it (fail closed cleanup) so a
 * dead/expired/tampered session can never be resurrected by a refresh.
 */
export function restoreSession(deps = {}) {
  const storage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const session = readSession(storage);
  if (!session) return null;
  if (!isSessionValid(session, now)) {
    try {
      if (storage) storage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
  return session;
}

/**
 * Pure decision for the character GLB loader's retry policy (character.js).
 * On reload the same-origin `<link rel=preload as=fetch>` for the GLB can fail
 * to match GLTFLoader's own request, leaving the fetch stalled OR errored and
 * Chiefmonkey invisible. Either failure gets ONE cache-busting retry; a second
 * failure gives up rather than looping. Kept here (alongside selectAnimation)
 * as a pure, injectable helper so the retry policy is unit-testable without a
 * DOM or WebGL context. Does NOT touch the preload hints, so the v0.1.11
 * same-origin (no-crossorigin) preload fix is preserved.
 * @param {{loaded:boolean, retried:boolean}} state
 * @param {'stall'|'error'} event
 * @returns {{action:'retry'|'give-up'|'ignore', bustCache:boolean}}
 */
export function nextLoadAttempt(state, event) {
  if (!state || state.loaded) return { action: 'ignore', bustCache: false };
  if (event !== 'stall' && event !== 'error') return { action: 'ignore', bustCache: false };
  if (!state.retried) return { action: 'retry', bustCache: true };
  return { action: 'give-up', bustCache: false };
}

// ─── Character ↔ deck step synchronisation (v0.1.15) ────────────────
//
// character.js (a module) and deck.js (a classic script) are injected
// together and run in a non-deterministic order relative to each other and
// to the async GLB load. deck.js broadcasts the desired step via an
// `onboarding:step` CustomEvent (including the *restored* step 2 on reload),
// but the GLB may not be loaded yet when that fires — the old character.js
// dropped the event (empty actions map) and then, on load, hard-applied
// step 1, so a restored Step 2 (and its Idle_03) silently reverted and the
// stage could stay dark. This tiny pure state machine makes the "which step
// to show once the model is ready" decision order-independent and testable
// without a DOM/WebGL context, mirroring nextLoadAttempt()/selectAnimation().

// Deck steps are 1..5 with 6 the final curtain. Restore only ever targets an
// authenticated middle step (2..5). Anything outside 1..6 is not a step.
function normalizeStep(step) {
  const n = Number(step);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

/**
 * Create the character-readiness sync state used by character.js. Plain data
 * so it is trivially inspectable/testable:
 *   ready       - the GLB has loaded and its clips are live
 *   failed      - terminal load failure (retry already spent); stage stays dark
 *   pendingStep - the most recent step requested via onboarding:step, if any
 */
export function createCharacterSync() {
  return { ready: false, failed: false, pendingStep: null };
}

/**
 * Record a step requested (typically by deck.js's onboarding:step broadcast).
 * Returns whether character.js should apply it right now: only once the model
 * is ready (and not terminally failed). Before readiness the step is just
 * remembered as pendingStep so resolveReadyStep() can honour it on load —
 * this is the "session restore fired before model readiness" case.
 * @returns {{apply: boolean, step: number|null}}
 */
export function recordStep(sync, step) {
  const n = normalizeStep(step);
  if (!sync || n === null) return { apply: false, step: null };
  sync.pendingStep = n;
  return { apply: sync.ready && !sync.failed, step: n };
}

/**
 * Resolve the step to apply the instant the model becomes ready, and flip the
 * sync to ready. Order-independent:
 *  - if a step was already requested (deck ran first) honour it;
 *  - else fall back to the restored session step (deck ran after / its event
 *    was missed) when it names an authenticated middle step (2..5);
 *  - else Step 1.
 * `restoredStep` is read *at ready time* (e.g. window.__toriiRestoredStep) so
 * a late-evaluating onboarding-client.js is still picked up.
 * @returns {number} the deck step to apply
 */
export function resolveReadyStep(sync, restoredStep) {
  if (sync) sync.ready = true;
  if (sync && sync.pendingStep !== null) return sync.pendingStep;
  const r = normalizeStep(restoredStep);
  if (r !== null && r >= 2 && r <= 5) return r;
  return 1;
}

/**
 * Mark the character load as terminally failed (retry already spent). After
 * this, recordStep() will never ask character.js to apply a step, matching
 * the "leave the stage empty rather than loop" give-up policy.
 */
export function markCharacterFailed(sync) {
  if (sync) sync.failed = true;
  return sync;
}

async function postJson(fetchImpl, path, body) {
  // Only declare a JSON content-type when we actually send a JSON body.
  // The challenge call is bodyless; Fastify rejects an empty body carrying
  // `Content-Type: application/json` with 400 FST_ERR_CTP_EMPTY_JSON_BODY,
  // which surfaced to the operator as "agent challenge failed (400)".
  const hasBody = body !== undefined && body !== null;
  const res = await fetchImpl(path, {
    method: 'POST',
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Full NIP-07 login. Dependency-injected for offline testing.
 * @param {object} deps
 *   fetch    - same-origin fetch (default window.fetch bound)
 *   signer   - object with async signEvent(template) (default window.nostr)
 *   storage  - localStorage-like (default window.localStorage)
 *   origin   - relay tag origin (default location.origin)
 *   now      - () => unix seconds
 *   onPhase  - optional (phase) => void hook for animation/status
 * @returns {Promise<{ok:true, session}|{ok:false, reason:string}>}
 */
export async function loginWithNip07(deps = {}) {
  const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const signer = deps.signer || (typeof window !== 'undefined' ? window.nostr : null);
  const origin = deps.origin || (typeof location !== 'undefined' ? location.origin : '');
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const onPhase = deps.onPhase || (() => {});

  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!signer || typeof signer.signEvent !== 'function') {
    return { ok: false, reason: 'NIP-07 signer not found (install Plebeian Signer)' };
  }

  onPhase('prompting');
  try {
    // 1. Challenge
    const chal = await postJson(fetchImpl, '/api/auth/challenge');
    if (!chal.ok) return fail(onPhase, `agent challenge failed (${chal.status})`);
    const { challenge } = validateChallengeResponse(chal.json);

    // 2. Sign in the browser — nsec never leaves the extension.
    const template = buildAuthEvent(challenge, origin, now);
    let signed;
    try {
      signed = await signer.signEvent(template);
    } catch (e) {
      return fail(onPhase, `signer refused: ${e?.message || e}`);
    }
    validateSignedEvent(signed, challenge);

    // 3. Verify with the agent.
    const ver = await postJson(fetchImpl, '/api/auth/verify', { event: signed });
    if (!ver.ok) return fail(onPhase, ver.json?.error || `verify rejected (${ver.status})`);
    const { token, expires_at } = validateVerifyResponse(ver.json);

    // 4. Store session (torii.session).
    const session = buildSessionValue(
      { token, expires_at, pubkey: signed.pubkey, method: 'nip07' },
      now,
    );
    storeSession(session, deps.storage);
    onPhase('success');
    return { ok: true, session };
  } catch (e) {
    return fail(onPhase, e?.message || String(e));
  }
}

function fail(onPhase, reason) {
  onPhase('failure');
  return { ok: false, reason };
}

// ─── NIP-46 (browser is the client; bunker46 architecture) ──────────
//
// A bunker connection string looks like:
//   bunker://<remote-signer-pubkey-hex>?relay=wss://…&relay=wss://…&secret=…
// The browser mints an ephemeral client keypair, connects to the relay,
// and exchanges NIP-46 (kind 24133) requests encrypted to the remote
// signer. We ask it to `sign_event` the SAME 22242 auth event, then run
// the identical verify+store path. No server endpoint is involved and no
// key or bunker secret is ever transmitted to the agent.

/**
 * Parse a NIP-46 `bunker://` connection string. Fail closed on anything
 * that isn't a bunker URI with a 64-hex remote pubkey and >=1 relay.
 * @returns {{ remotePubkey: string, relays: string[], secret: string|null }}
 */
export function parseBunkerUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('empty connection string');
  const trimmed = uri.trim();
  if (!trimmed.startsWith('bunker://')) throw new Error('not a bunker:// connection string');
  let parsed;
  try {
    // Swap scheme so the URL parser yields host+search reliably.
    parsed = new URL('https://' + trimmed.slice('bunker://'.length));
  } catch {
    throw new Error('malformed connection string');
  }
  const remotePubkey = (parsed.hostname || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) throw new Error('bad remote signer pubkey');
  const relays = parsed.searchParams.getAll('relay').filter(Boolean);
  if (relays.length === 0) throw new Error('connection string has no relay');
  for (const r of relays) {
    if (!/^wss?:\/\//.test(r)) throw new Error('bad relay url');
  }
  const secret = parsed.searchParams.get('secret');
  return { remotePubkey, relays, secret: secret || null };
}

/**
 * Full NIP-46 login. The browser is the NIP-46 *client*. Transport and
 * crypto are injected so this is testable offline and so we never hard-bind
 * a heavy dependency into a static, build-free preview.
 *
 * @param {object} deps
 *   bunkerUri - the bunker:// connection string from the operator
 *   fetch     - same-origin fetch
 *   transport - { request(remotePubkey, method, params) => Promise<result> }
 *               A thin NIP-46 client: encrypts a kind-24133 request to the
 *               remote signer, publishes to the bunker's relays, and resolves
 *               with the decrypted result. `sign_event` returns the signed
 *               event (object or JSON string).
 *   storage   - localStorage-like
 *   origin    - relay tag origin for the auth event
 *   now, onPhase
 * @returns {Promise<{ok:true, session}|{ok:false, reason:string}>}
 */
export async function loginWithNip46(deps = {}) {
  const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const origin = deps.origin || (typeof location !== 'undefined' ? location.origin : '');
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const onPhase = deps.onPhase || (() => {});
  const transport = deps.transport;

  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!transport || typeof transport.request !== 'function') {
    // Privacy-first + explicit: we do NOT silently fall back to NIP-07 or to
    // any server-side bunker. Without a client transport the remote-signer
    // path simply cannot proceed, and we say so.
    return { ok: false, reason: 'NIP-46 remote signing unavailable in this browser' };
  }

  let conn;
  try {
    conn = parseBunkerUri(deps.bunkerUri);
  } catch (e) {
    return fail(onPhase, e?.message || 'bad connection string');
  }

  onPhase('prompting');
  try {
    // Establish the client<->signer session (NIP-46 connect handshake).
    await transport.request(conn.remotePubkey, 'connect', conn.secret ? [conn.remotePubkey, conn.secret] : [conn.remotePubkey]);

    // 1. Challenge from the agent.
    const chal = await postJson(fetchImpl, '/api/auth/challenge');
    if (!chal.ok) return fail(onPhase, `agent challenge failed (${chal.status})`);
    const { challenge } = validateChallengeResponse(chal.json);

    // 2. Ask the remote signer to sign the auth event.
    const template = buildAuthEvent(challenge, origin, now);
    let signed = await transport.request(conn.remotePubkey, 'sign_event', [JSON.stringify(template)]);
    if (typeof signed === 'string') {
      try {
        signed = JSON.parse(signed);
      } catch {
        return fail(onPhase, 'remote signer returned malformed event');
      }
    }
    validateSignedEvent(signed, challenge);

    // 3. Verify + 4. store — identical to the NIP-07 path.
    const ver = await postJson(fetchImpl, '/api/auth/verify', { event: signed });
    if (!ver.ok) return fail(onPhase, ver.json?.error || `verify rejected (${ver.status})`);
    const { token, expires_at } = validateVerifyResponse(ver.json);

    const session = buildSessionValue(
      { token, expires_at, pubkey: signed.pubkey, method: 'nip46' },
      now,
    );
    storeSession(session, deps.storage);
    onPhase('success');
    return { ok: true, session };
  } catch (e) {
    return fail(onPhase, e?.message || String(e));
  }
}

// ─── Step 2/3 admin-API client (wallet + Routstr) ───────────────────
//
// The operator's NWC connection string (Step 2) and Routstr sk- key (Step 3)
// are OPERATOR SECRETS the agent must USE. They are handled with the same
// discipline as an nsec: they enter only through an input, are sent once over
// the authenticated same-origin API, and are NEVER written to localStorage /
// sessionStorage, a URL, a log, or analytics. The agent stores them encrypted
// at rest and only ever returns a redacted view. These helpers are pure +
// dependency-injected so the whole flow is unit-testable offline.

/**
 * Structural check of an NWC URI, mirroring the agent's parseNwcUri rules so
 * obvious garbage is rejected before it leaves the browser. It NEVER returns,
 * logs, or persists the secret — only non-sensitive shape facts.
 * @returns {{ok:true, wallet_pubkey_prefix:string, relay_count:number}|{ok:false, reason:string}}
 */
export function validateNwcUriShape(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { ok: false, reason: 'paste your wallet connection string' };
  }
  const m = uri.trim().match(/^nostr\+?walletconnect:\/\/([0-9a-fA-F]{64})\?(.+)$/);
  if (!m) return { ok: false, reason: 'that does not look like a nostr+walletconnect:// string' };
  let params;
  try {
    params = new URLSearchParams(m[2]);
  } catch {
    return { ok: false, reason: 'malformed connection string' };
  }
  const relays = params.getAll('relay').filter(Boolean);
  if (relays.length === 0) return { ok: false, reason: 'connection string has no relay' };
  for (const r of relays) {
    if (!/^wss?:\/\//i.test(r)) return { ok: false, reason: 'relay must be a ws:// or wss:// URL' };
  }
  const secret = params.get('secret');
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    return { ok: false, reason: 'connection string has no valid secret' };
  }
  return { ok: true, wallet_pubkey_prefix: m[1].toLowerCase().slice(0, 12), relay_count: relays.length };
}

/**
 * Structural check of a Routstr key, mirroring the agent's shape guard. Never
 * returns the key. Accepts sk-… API keys and cashu… tokens.
 */
export function validateRoutstrKeyShape(key) {
  if (typeof key !== 'string' || !key.trim()) return { ok: false, reason: 'paste your Routstr key' };
  if (!/^(sk-[A-Za-z0-9._-]+|cashu[A-Za-z0-9._-]+)$/.test(key.trim())) {
    return { ok: false, reason: 'a Routstr key looks like sk-… (or a cashu… token)' };
  }
  return { ok: true };
}

/**
 * Validate a top-up amount for the fund-a-session path. Integer sats within the
 * provider bounds (defaults are permissive; the agent enforces the real ones).
 */
export function validateTopupAmount(sats, bounds = {}) {
  const n = Number(sats);
  if (!Number.isInteger(n)) return { ok: false, reason: 'enter a whole number of sats' };
  const min = Number.isFinite(bounds.min) ? bounds.min : 1;
  const max = Number.isFinite(bounds.max) ? bounds.max : Infinity;
  if (n < min) return { ok: false, reason: `minimum is ${min} sats` };
  if (n > max) return { ok: false, reason: `maximum is ${max} sats` };
  return { ok: true, sats: n };
}

/**
 * Build the Bearer header from the stored session token. The session token is
 * the ONLY credential the admin API needs; it is public-identity metadata, not
 * a secret key. Returns null when there is no usable session.
 */
export function bearerFromSession(session) {
  if (!session || typeof session.token !== 'string' || session.token.length === 0) return null;
  return `Bearer ${session.token}`;
}

async function adminFetch(fetchImpl, method, path, { token, body } = {}) {
  const hasBody = body !== undefined && body !== null;
  const headers = {};
  if (token) headers.Authorization = token;
  if (hasBody) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function resolveClient(deps) {
  const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const token = deps.token || bearerFromSession(readSession(deps.storage));
  return { fetchImpl, token };
}

/**
 * POST the NWC string to the agent. The URI is passed straight from the input
 * to the request body and is never persisted anywhere in the browser. Returns
 * the agent's REDACTED body (wallet prefix + capability matrix) — never the URI.
 */
export async function connectWallet(deps = {}) {
  const shape = validateNwcUriShape(deps.nwcUri);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!token) return { ok: false, reason: 'sign in first — no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/wallet/connect', {
    token,
    body: { nwc_uri: deps.nwcUri.trim() },
  });
  if (!r.ok) return { ok: false, reason: r.json?.error || `wallet connect failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

export async function walletStatus(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { connected: false };
  const r = await adminFetch(fetchImpl, 'GET', '/api/onboarding/wallet/status', { token });
  return r.json || { connected: false };
}

export async function disconnectWallet(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { ok: false, reason: 'no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/wallet/disconnect', { token });
  return r.json || { ok: false };
}

/**
 * POST an existing Routstr key. Same secret discipline as connectWallet: the
 * key goes straight from the input to the body and is never persisted here.
 * Returns the agent's redacted status (preview + balance + models).
 */
export async function connectRoutstrKey(deps = {}) {
  const shape = validateRoutstrKeyShape(deps.key);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!token) return { ok: false, reason: 'sign in first — no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/key', {
    token,
    body: { key: deps.key.trim() },
  });
  if (!r.ok) return { ok: false, reason: r.json?.error || `key verification failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

/**
 * Request a Lightning funding invoice via the source-grounded POST
 * /lightning/invoice (purpose "create"). NEVER pays. The agent returns
 * requires_confirmation:true with the bolt11 + quote_id. A structured
 * blocked:true result appears ONLY when an operator has explicitly disabled the
 * provider's invoice path — the existing-key path is then used instead.
 */
export async function quoteRoutstrTopup(deps = {}) {
  const amount = validateTopupAmount(deps.amountSats, deps.bounds);
  if (!amount.ok) return { ok: false, reason: amount.reason };
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!token) return { ok: false, reason: 'sign in first — no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/quote', {
    token,
    body: { amount_sats: amount.sats },
  });
  // 501 blocked is an expected, non-error state we surface with guidance.
  if (r.status === 501 && r.json?.blocked) {
    return { ok: false, blocked: true, reason: r.json.reason, guidance: r.json.guidance, bounds: r.json.bounds };
  }
  if (!r.ok) return { ok: false, reason: r.json?.error || `quote failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

/**
 * Pay a quoted invoice via the connected NWC wallet, then let the agent poll
 * the provider for the minted sk- key. HARD confirmation boundary: this is only
 * ever called from the explicit "Confirm & pay" button, and always passes
 * confirm:true. No autonomous or implicit spend exists. Passing quote_id lets
 * the agent claim the key; if the poll times out the response carries
 * recoverable:true + bolt11 (the payment is NOT lost — see recoverRoutstrInvoice).
 */
export async function payRoutstrInvoice(deps = {}) {
  if (deps.confirm !== true) return { ok: false, reason: 'explicit confirmation required' };
  if (typeof deps.invoice !== 'string' || !deps.invoice.trim()) return { ok: false, reason: 'no invoice to pay' };
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!token) return { ok: false, reason: 'sign in first — no admin session' };
  const body = { invoice: deps.invoice.trim(), confirm: true };
  if (typeof deps.quoteId === 'string' && deps.quoteId) body.quote_id = deps.quoteId;
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/pay', {
    token,
    body,
  });
  if (!r.ok) return { ok: false, reason: r.json?.error || `payment failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

/**
 * Claim (or re-claim) the minted key for an already-paid invoice via
 * POST /lightning/recover. Called when payRoutstrInvoice returned
 * recoverable:true. Idempotent — safe to retry until the provider's watcher
 * has credited the invoice and issued the key. NEVER pays.
 */
export async function recoverRoutstrInvoice(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };
  if (!token) return { ok: false, reason: 'sign in first — no admin session' };
  const body = {};
  if (typeof deps.bolt11 === 'string' && deps.bolt11.trim()) body.bolt11 = deps.bolt11.trim();
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/recover', {
    token,
    body,
  });
  // 202 = accepted-but-not-settled: honest, non-terminal, retryable.
  if (r.status === 202) return { ok: false, recoverable: true, status: r.json?.status || 'pending', reason: r.json?.reason };
  if (!r.ok) return { ok: false, reason: r.json?.error || `recover failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

export async function routstrStatus(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { connected: false };
  const r = await adminFetch(fetchImpl, 'GET', '/api/onboarding/routstr/status', { token });
  return r.json || { connected: false };
}

export async function disconnectRoutstr(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { ok: false, reason: 'no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/disconnect', { token });
  return r.json || { ok: false };
}

// ─── Browser wiring ─────────────────────────────────────────────────
// Only runs in a real DOM. Tests import the functions above and never
// trigger this block.

// Toggle a password-type secret input to text and back, without ever logging
// its value. Used by the Step 2/3 reveal buttons.
function wireReveal(input, btn) {
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.textContent = showing ? 'Show' : 'Hide';
  });
}

const CAP_LABELS = {
  can_pay_invoice: 'pay_invoice',
  can_make_invoice: 'make_invoice',
  can_lookup_invoice: 'lookup_invoice',
  can_get_balance: 'get_balance',
};

function renderStatus(el, kind, html) {
  if (!el) return;
  el.hidden = false;
  el.className = `conn-status is-${kind}`;
  el.innerHTML = html;
}

function capMatrixHtml(caps) {
  if (!caps) return '';
  const chips = Object.entries(CAP_LABELS)
    .map(([k, label]) => `<span class="cap-chip ${caps[k] ? 'has' : 'lacks'}">${label}</span>`)
    .join('');
  return `<div class="cap-matrix">${chips}</div>`;
}

export function initStep2(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="2"]');
  if (!panel) return;

  const input = panel.querySelector('[data-nwc-input]');
  const revealBtn = panel.querySelector('[data-nwc-reveal]');
  const connectBtn = panel.querySelector('[data-wallet-connect]');
  const disconnectBtn = panel.querySelector('[data-wallet-disconnect]');
  const statusEl = panel.querySelector('[data-wallet-status]');

  wireReveal(input, revealBtn);

  const showConnected = (body) => {
    const caps = body.capabilities;
    const kind = body.can_fund_routstr ? 'ok' : 'warn';
    const w = body.wallet || {};
    const notice = body.notice
      ? `<div class="conn-meta">${body.notice}</div>`
      : '<div class="conn-meta">Ready to fund Routstr.</div>';
    renderStatus(
      statusEl,
      kind,
      `<div class="conn-line"><span class="conn-dot"></span><span>Wallet connected${w.wallet_pubkey_prefix ? ` &middot; <code>${w.wallet_pubkey_prefix}…</code>` : ''}${typeof w.relay_count === 'number' ? ` &middot; ${w.relay_count} relay${w.relay_count === 1 ? '' : 's'}` : ''}</span></div>${capMatrixHtml(caps)}${notice}`,
    );
    if (disconnectBtn) disconnectBtn.hidden = false;
    if (connectBtn) connectBtn.querySelector('span').textContent = 'Reconnect a different wallet';
  };

  // Reflect any already-connected wallet on load (survives a reload; the URI
  // itself never comes back — only the redacted view).
  walletStatus({}).then((s) => { if (s && s.connected) showConnected(s); }).catch(() => {});

  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      const nwcUri = input ? input.value : '';
      const shape = validateNwcUriShape(nwcUri);
      if (!shape.ok) {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${shape.reason}</span></div>`);
        return;
      }
      connectBtn.disabled = true;
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Connecting to your wallet…</span></div>');
      const res = await connectWallet({ nwcUri });
      // Never echo the secret back: clear the box on every outcome.
      if (input) input.value = '';
      connectBtn.disabled = false;
      if (res.ok) {
        showConnected(res);
        window.dispatchEvent(new CustomEvent('onboarding:wallet-connected', { detail: { can_fund_routstr: !!res.can_fund_routstr } }));
      } else {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`);
      }
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      disconnectBtn.disabled = true;
      await disconnectWallet({});
      disconnectBtn.disabled = false;
      disconnectBtn.hidden = true;
      if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
      if (connectBtn) connectBtn.querySelector('span').textContent = 'Connect wallet';
    });
  }
}

export function initStep3(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="3"]');
  if (!panel) return;

  const pathRadios = Array.from(panel.querySelectorAll('[data-routstr-path]'));
  const keyForm = panel.querySelector('[data-routstr-key-form]');
  const fundForm = panel.querySelector('[data-routstr-fund-form]');
  const keyInput = panel.querySelector('[data-routstr-key-input]');
  const keyReveal = panel.querySelector('[data-routstr-key-reveal]');
  const topupInput = panel.querySelector('[data-topup-input]');
  const confirmEl = panel.querySelector('[data-routstr-confirm]');
  const statusEl = panel.querySelector('[data-routstr-status]');
  const keyConnectBtn = panel.querySelector('[data-routstr-key-connect]');
  const quoteBtn = panel.querySelector('[data-routstr-quote]');
  const disconnectBtn = panel.querySelector('[data-routstr-disconnect]');

  wireReveal(keyInput, keyReveal);

  const selectPath = (path) => {
    const key = path === 'key';
    if (keyForm) keyForm.hidden = !key;
    if (fundForm) fundForm.hidden = key;
    if (keyConnectBtn) keyConnectBtn.hidden = !key;
    if (quoteBtn) quoteBtn.hidden = key;
    if (confirmEl) { confirmEl.hidden = true; confirmEl.innerHTML = ''; }
    pathRadios.forEach((r) => {
      const card = r.closest('.choice-card');
      if (card) card.toggleAttribute('data-selected', r.value === path);
    });
  };
  pathRadios.forEach((r) => r.addEventListener('change', () => { if (r.checked) selectPath(r.value); }));

  const showConnected = (body) => {
    const bal = body.balance_sats ?? body.balance;
    const models = body.models_available;
    const prev = body.routstr?.key_preview || body.key_preview;
    renderStatus(
      statusEl,
      'ok',
      `<div class="conn-line"><span class="conn-dot"></span><span>Routstr key verified${prev ? ` &middot; <code>${prev}</code>` : ''}</span></div><div class="conn-meta">${bal != null ? `${bal} sats` : 'balance unknown'}${models != null ? ` &middot; ${models} models available` : ''}</div>`,
    );
    if (disconnectBtn) disconnectBtn.hidden = false;
  };

  routstrStatus({}).then((s) => { if (s && s.connected) showConnected(s); }).catch(() => {});

  if (keyConnectBtn) {
    keyConnectBtn.addEventListener('click', async () => {
      const key = keyInput ? keyInput.value : '';
      const shape = validateRoutstrKeyShape(key);
      if (!shape.ok) {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${shape.reason}</span></div>`);
        return;
      }
      keyConnectBtn.disabled = true;
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Verifying with your provider…</span></div>');
      const res = await connectRoutstrKey({ key });
      if (keyInput) keyInput.value = '';
      keyConnectBtn.disabled = false;
      if (res.ok) {
        showConnected(res);
        window.dispatchEvent(new CustomEvent('onboarding:advance', { detail: { from: 3 } }));
      } else {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`);
      }
    });
  }

  const renderConfirm = (quote) => {
    if (!confirmEl) return;
    confirmEl.hidden = false;
    const exp = quote.expires_at ? `<div class="ci-row"><span class="ci-key">Expires</span><span class="ci-val">${quote.expires_at}</span></div>` : '';
    confirmEl.innerHTML =
      `<div class="ci-title">Review before paying</div>` +
      `<div class="ci-row"><span class="ci-key">Amount</span><span class="ci-val">${quote.amount_sats} sats</span></div>` +
      `<div class="ci-row"><span class="ci-key">Provider</span><span class="ci-val">${quote.provider_host || '—'}</span></div>` +
      exp +
      `<div class="ci-row"><span class="ci-key">Invoice</span><span class="ci-val">${quote.invoice}</span></div>` +
      `<div class="ci-actions"><button class="btn-primary" data-routstr-pay-confirm><span>Confirm &amp; pay from wallet</span><span class="arrow">&rarr;</span></button></div>`;
    const payBtn = confirmEl.querySelector('[data-routstr-pay-confirm]');
    payBtn.addEventListener('click', async () => {
      payBtn.disabled = true;
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Paying via your wallet…</span></div>');
      const paid = await payRoutstrInvoice({ invoice: quote.invoice, quoteId: quote.quote_id, confirm: true });
      payBtn.disabled = false;
      if (paid.ok && paid.key_stored) {
        confirmEl.hidden = true; confirmEl.innerHTML = '';
        renderStatus(statusEl, 'ok', '<div class="conn-line"><span class="conn-dot"></span><span>Paid and funded. Your Routstr key is stored and ready.</span></div>');
      } else if (paid.ok && paid.recoverable) {
        // Payment settled but the key isn't mintable yet — offer a retry that
        // claims it via /lightning/recover. The sats are NOT lost.
        confirmEl.hidden = true; confirmEl.innerHTML = '';
        renderRecover(paid.bolt11 || quote.invoice);
      } else if (paid.ok) {
        confirmEl.hidden = true; confirmEl.innerHTML = '';
        renderStatus(statusEl, 'ok', '<div class="conn-line"><span class="conn-dot"></span><span>Paid. Your Routstr session is funding—key will appear once the provider mints it.</span></div>');
      } else {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${paid.reason}</span></div>`);
      }
    });
  };

  // Recoverable state: the invoice is paid but the key hasn't been issued yet.
  // Offer an idempotent "Claim key" retry that hits /lightning/recover.
  const renderRecover = (bolt11) => {
    renderStatus(
      statusEl,
      'warn',
      '<div class="conn-line"><span class="conn-dot"></span><span>Paid — the provider is still minting your key. Your sats are safe.</span></div>' +
      '<div class="ci-actions"><button class="btn-primary" data-routstr-recover><span>Claim key</span><span class="arrow">&rarr;</span></button></div>',
    );
    const recBtn = statusEl && statusEl.querySelector('[data-routstr-recover]');
    if (!recBtn) return;
    recBtn.addEventListener('click', async () => {
      recBtn.disabled = true;
      const rec = await recoverRoutstrInvoice({ bolt11 });
      recBtn.disabled = false;
      if (rec.ok && rec.key_stored) {
        renderStatus(statusEl, 'ok', '<div class="conn-line"><span class="conn-dot"></span><span>Key claimed and stored. Your Routstr session is ready.</span></div>');
      } else if (rec.recoverable) {
        renderStatus(statusEl, 'warn', `<div class="conn-line"><span class="conn-dot"></span><span>Not settled yet (${rec.status || 'pending'}). Your sats are safe — try again in a moment.</span></div><div class="ci-actions"><button class="btn-primary" data-routstr-recover><span>Claim key</span><span class="arrow">&rarr;</span></button></div>`);
        const again = statusEl.querySelector('[data-routstr-recover]');
        if (again) again.addEventListener('click', () => renderRecover(bolt11));
      } else {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${rec.reason || 'could not claim the key'}</span></div>`);
      }
    });
  };

  if (quoteBtn) {
    quoteBtn.addEventListener('click', async () => {
      const amountSats = topupInput ? topupInput.value : '';
      const amount = validateTopupAmount(amountSats);
      if (!amount.ok) {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${amount.reason}</span></div>`);
        return;
      }
      quoteBtn.disabled = true;
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Requesting an invoice…</span></div>');
      const res = await quoteRoutstrTopup({ amountSats: amount.sats });
      quoteBtn.disabled = false;
      if (res.ok && res.requires_confirmation) {
        renderConfirm(res);
        if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
      } else if (res.blocked) {
        renderStatus(statusEl, 'warn', `<div class="conn-line"><span class="conn-dot"></span><span>Your provider can't mint keys by Lightning invoice yet.</span></div><div class="conn-meta">${res.guidance || 'Use an existing Routstr key instead.'}</div>`);
      } else {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`);
      }
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      disconnectBtn.disabled = true;
      await disconnectRoutstr({});
      disconnectBtn.disabled = false;
      disconnectBtn.hidden = true;
      if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
    });
  }
}

export function initStep1(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="1"]');
  if (!panel) return;

  const signBtn = panel.querySelector('[data-sign-primary]');
  const altBtn = panel.querySelector('[data-sign-alt]');
  const nip46Row = panel.querySelector('[data-nip46]');
  const nip46Input = panel.querySelector('[data-bunker-input]');
  const nip46Go = panel.querySelector('[data-bunker-go]');
  const statusEl = panel.querySelector('[data-auth-status]');

  const emitPhase = (phase) => {
    // Drive Chiefmonkey via the existing custom-event channel; character.js
    // maps phase -> clip with graceful fallback.
    window.dispatchEvent(new CustomEvent('onboarding:anim', { detail: { phase } }));
    if (statusEl) {
      const msg = {
        prompting: 'Waiting for your signer…',
        success: 'Verified. You hold the admin npub.',
        failure: statusEl.dataset.err || 'Signing failed. Try again.',
      }[phase];
      if (msg) statusEl.textContent = msg;
    }
  };

  const setErr = (reason) => {
    if (statusEl) statusEl.dataset.err = reason;
  };

  const finish = (result) => {
    if (result.ok) {
      // Advance the deck to step 2 on success.
      window.dispatchEvent(new CustomEvent('onboarding:advance', { detail: { from: 1 } }));
    } else {
      setErr(result.reason);
      emitPhase('failure');
    }
  };

  if (signBtn) {
    signBtn.addEventListener('click', async () => {
      signBtn.disabled = true;
      const result = await loginWithNip07({ onPhase: emitPhase });
      signBtn.disabled = false;
      finish(result);
    });
  }

  if (altBtn && nip46Row) {
    altBtn.addEventListener('click', () => {
      const open = nip46Row.hasAttribute('hidden');
      if (open) nip46Row.removeAttribute('hidden');
      else nip46Row.setAttribute('hidden', '');
      if (open && nip46Input) nip46Input.focus();
    });
  }

  if (nip46Go) {
    nip46Go.addEventListener('click', async () => {
      const bunkerUri = nip46Input ? nip46Input.value : '';
      nip46Go.disabled = true;
      const result = await loginWithNip46({
        bunkerUri,
        transport: window.__toriiNip46Transport || null,
        onPhase: emitPhase,
      });
      nip46Go.disabled = false;
      finish(result);
    });
  }

  // Restore-on-reload: if a still-valid session survived a refresh, advance
  // past step 1 without forcing a re-sign. window.__toriiRestoredStep is set
  // at module load (below) before this runs; we also emit onboarding:advance
  // so deck.js advances whichever way it happened to initialise (the global
  // covers the case where deck.js starts up *after* this dispatch). Buttons
  // stay wired so navigating back to step 1 can still re-sign.
  if (window.__toriiRestoredStep && window.__toriiRestoredStep > 1) {
    window.dispatchEvent(new CustomEvent('onboarding:advance', { detail: { from: 1 } }));
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Compute session restore as early as possible (at module eval, before the
  // deck initialises) so deck.js can read the target start step regardless of
  // the order the async module/classic scripts happen to execute in.
  try {
    if (restoreSession()) window.__toriiRestoredStep = 2;
  } catch {
    /* ignore — fail closed to step 1 */
  }
  const initAll = () => {
    initStep1();
    initStep2();
    initStep3();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
}
