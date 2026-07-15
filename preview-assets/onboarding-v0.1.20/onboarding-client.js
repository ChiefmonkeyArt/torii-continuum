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

// ─── Forbidden-clip semantic filter (v0.1.17) ───────────────────────
//
// Locomotion (walk / run / jog / sprint) and knock-down / fall-down clips
// must NEVER be selected — not for a step state, an auth phase, or a click
// reaction. The revised Chiefmonkey GLB ships several such clips
// (Walking, Running, Stylish_Walk_inplace, Clapping_Run, Knock_Down); the
// build pipeline (tools/optimize-glb.mjs) DROPS them from the production
// asset using this exact predicate, and every runtime pool is filtered
// through it as defence-in-depth. Matching is case-insensitive and robust
// to spaces / underscores / camelCase by normalising the name to bare
// lowercase alphanumerics first ("Stylish_Walk_inplace" → "stylishwalkinplace",
// "knock down" / "KnockDown" → "knockdown").
export const FORBIDDEN_CLIP_TOKENS = [
  'walk', 'walking',
  'run', 'running', 'jog', 'jogging', 'sprint', 'sprinting',
  'knockdown', 'knockeddown',
  'falldown', 'fallingdown', 'faildown',
];

function normalizeClipName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a clip name denotes forbidden locomotion or a knock-/fall-down.
 * Pure + exported so the build script and the runtime share one definition.
 * @param {string} name
 */
export function isForbiddenClip(name) {
  const n = normalizeClipName(name);
  if (!n) return false;
  return FORBIDDEN_CLIP_TOKENS.some((tok) => n.includes(tok));
}

/**
 * Filter an iterable of clip names down to the ones that are NOT forbidden.
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
export function filterForbidden(names) {
  return Array.from(names || []).filter((n) => !isForbiddenClip(n));
}

// ─── Dedicated per-step animation states (v0.1.17) ───────────────────
//
// Live onboarding steps (see index.html / deck.js): 1 Verify, 2 Wallet,
// 3 Routstr, 4 Welcome, 5 Recovery kit, 6 final curtain. Each gets ONE
// dedicated, suitable, loop-friendly clip that plays deterministically on
// entering/restoring the step. Primary clip first, then ordered fallbacks
// that also exist in the revised GLB; IDLE_CLIP is the universal floor.
// None of these are locomotion/knock-down (asserted by tests).
export const IDLE_CLIP = 'Idle_10';

export const STEP_CLIPS = {
  1: { clip: 'Talk_with_Hands_Open', fallbacks: ['Agree_Gesture', IDLE_CLIP] }, // verify — explaining
  2: { clip: 'Agree_Gesture', fallbacks: ['Talk_with_Hands_Open', IDLE_CLIP] }, // wallet — assent/handshake
  3: { clip: 'mage_soell_cast_3', fallbacks: ['Talk_with_Hands_Open', IDLE_CLIP] }, // routstr — "network of minds"
  4: { clip: 'Gentlemans_Bow', fallbacks: ['Agree_Gesture', IDLE_CLIP] }, // welcome — greeting bow
  5: { clip: IDLE_CLIP, fallbacks: ['Agree_Gesture'] }, // recovery kit — calm settle
  6: { clip: 'Victory_Cheer', fallbacks: ['FunnyDancing_02', IDLE_CLIP] }, // curtain — success
};

// Step-1 auth phase reactions, reconciled with the dedicated step machine.
// prompting/success/failure are transient overrides that ALWAYS return to the
// current step's dedicated clip afterwards (character.js). No forbidden or
// severe-damage clip appears here (the revised GLB has no confusion/hit clip
// that is allowed, so failure degrades to a talking reaction then idle).
export const ANIM = {
  prompting: { clip: 'Talk_with_Hands_Open', fallbacks: [IDLE_CLIP] },
  success: { clip: 'Agree_Gesture', fallbacks: ['Victory_Cheer', IDLE_CLIP] },
  failure: { clip: 'Stand_Talking_Angry', fallbacks: [IDLE_CLIP] },
};

// Curated click-reaction pool: playful surprise / gesture / dance /
// celebration one-shots. No locomotion, no knock-down, no severe hit/damage,
// and never the base idle (a click should always DO something). Frozen so a
// stray push can't smuggle a forbidden clip in; also filtered at use.
export const CLICK_POOL = Object.freeze([
  'FunnyDancing_02',
  'FunnyDancing_03',
  'Gangnam_Groove',
  'Hip_Hop_Dance_2',
  'Indoor_Swing',
  'Victory_Cheer',
  'Gentlemans_Bow',
  'Agree_Gesture',
  'Boxing_Practice',
  'mage_soell_cast_3',
  'Talk_with_Hands_Open',
]);

/**
 * Pick the animation clip to play for a phase given the clips actually
 * present in the loaded model. Returns the primary clip if available,
 * else the first available fallback, else null (caller keeps current).
 * Forbidden clips are never returned even if a caller lists one.
 * @param {'prompting'|'success'|'failure'} phase
 * @param {Iterable<string>|null|undefined} available clip names present in the GLB
 */
export function selectAnimation(phase, available) {
  const spec = ANIM[phase];
  if (!spec) return null;
  const candidates = [spec.clip, ...spec.fallbacks].filter((c) => !isForbiddenClip(c));
  // No knowledge of what's available → optimistically request the primary
  // (non-forbidden) clip; character.js still no-ops if it's genuinely missing.
  if (!available) return candidates[0] ?? null;
  const set = available instanceof Set ? available : new Set(available);
  for (const name of candidates) {
    if (set.has(name)) return name;
  }
  return null;
}

/**
 * Resolve the dedicated clip for a step against the clips present in the GLB.
 * Mirrors selectAnimation's contract for STEP_CLIPS, always forbidden-safe.
 * @param {number} step 1..6
 * @param {Iterable<string>|null|undefined} available
 * @returns {string|null}
 */
export function selectStepClip(step, available) {
  const spec = STEP_CLIPS[step];
  if (!spec) return null;
  const candidates = [spec.clip, ...spec.fallbacks].filter((c) => !isForbiddenClip(c));
  if (!available) return candidates[0] ?? null;
  const set = available instanceof Set ? available : new Set(available);
  for (const name of candidates) {
    if (set.has(name)) return name;
  }
  return null;
}

/**
 * Pick ONE click-reaction clip from the curated pool. Guarantees:
 *  - never a forbidden (locomotion / knock-down) clip
 *  - only clips actually present in the model (when `available` is given)
 *  - no immediate repeat of `last` (unless the pool collapses to one option)
 * Deterministic under an injected `rand` (default Math.random) for testing.
 * Returns null when nothing suitable is available (caller keeps current).
 * @param {object} [opts]
 * @param {Iterable<string>|null} [opts.available] clip names present in the GLB
 * @param {string|null} [opts.last] the previously played reaction (avoid repeat)
 * @param {string[]} [opts.pool] override pool (defaults to CLICK_POOL)
 * @param {() => number} [opts.rand] RNG in [0,1)
 */
export function pickClickReaction(opts = {}) {
  const pool = opts.pool || CLICK_POOL;
  const rand = opts.rand || Math.random;
  let choices = pool.filter((c) => !isForbiddenClip(c));
  if (opts.available) {
    const set = opts.available instanceof Set ? opts.available : new Set(opts.available);
    choices = choices.filter((c) => set.has(c));
  }
  if (choices.length === 0) return null;
  // Avoid an immediate repeat when we have more than one option.
  let candidates = choices;
  if (opts.last && choices.length > 1) {
    candidates = choices.filter((c) => c !== opts.last);
  }
  const i = Math.floor(rand() * candidates.length) % candidates.length;
  return candidates[i];
}

/**
 * Pure gate for a character click: whether a click should trigger a reaction
 * right now. Ignores clicks while a reaction is already active (spam guard)
 * and when the user prefers reduced motion, and only fires on a model hit.
 * @param {{active?:boolean, reducedMotion?:boolean, hit?:boolean}} state
 */
export function shouldReactToClick(state = {}) {
  if (state.reducedMotion) return false;
  if (state.active) return false;
  if (state.hit === false) return false;
  return true;
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

// ─── Recovery / resume + full-key export clients (v0.1.18) ──────────────

/**
 * Redacted resume snapshot. Read on load so a refresh/restart during a
 * paid-but-unclaimed session can finish the claim WITHOUT re-paying. Returns
 * the agent's { wallet, routstr, pending, claimable } body — never a secret.
 */
export async function fetchRecoveryState(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { ok: false, reason: 'no admin session' };
  const r = await adminFetch(fetchImpl, 'GET', '/api/onboarding/recovery/state', { token });
  return r.json || { ok: false };
}

/** The default (secret-free) Recovery Kit body. Served no-store by the agent. */
export async function fetchRecoveryKit(deps = {}) {
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { ok: false, reason: 'no admin session' };
  const r = await adminFetch(fetchImpl, 'GET', '/api/onboarding/recovery-kit', { token });
  if (!r.ok) return { ok: false, reason: r.json?.error || `kit failed (${r.status})` };
  return r.json || { ok: false };
}

/**
 * The ONE-TIME, no-store full-key reveal. Requires an explicit confirm — never
 * called implicitly. The returned key must NOT be persisted by the caller.
 */
export async function exportRoutstrKey(deps = {}) {
  if (deps.confirm !== true) return { ok: false, reason: 'explicit confirmation required' };
  const { fetchImpl, token } = resolveClient(deps);
  if (!fetchImpl || !token) return { ok: false, reason: 'no admin session' };
  const r = await adminFetch(fetchImpl, 'POST', '/api/onboarding/routstr/export-key', { token, body: { confirm: true } });
  if (!r.ok) return { ok: false, reason: r.json?.error || `export failed (${r.status})`, status: r.status };
  return { ok: true, ...r.json };
}

// ─── Payment / claim state machine (v0.1.18) ────────────────────────────
//
// The whole point of the fix: SUCCESS is reached ONLY when the agent reports
// key_stored === true (key claimed, encrypted, AND verified). A bare "paid"
// or "recoverable" result is NEVER success — it maps to a retryable claiming
// state so the UI never tells the operator they are done while their key is
// still unissued. These reducers are pure so the transitions are unit-tested.

export const ONBOARD_PHASES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  QUOTING: 'quoting',
  AWAITING_CONFIRM: 'awaiting_confirm',
  PAYING: 'paying',
  CLAIMING: 'claiming',
  PAID_UNCLAIMED: 'paid_unclaimed',
  VERIFYING: 'verifying',
  SUCCESS: 'success',
  ERROR: 'error',
});

// Accessible progress metadata per phase: a label, a 0..100 percentage for the
// progress/scanning bar, and whether the phase is "busy" (animated scan +
// aria-busy). Frozen so a stray mutation can't desync the bar.
export const PHASE_META = Object.freeze({
  idle: { label: '', pct: 0, busy: false },
  connecting: { label: 'Connecting to your wallet…', pct: 15, busy: true },
  quoting: { label: 'Requesting a Lightning invoice…', pct: 25, busy: true },
  awaiting_confirm: { label: 'Review the invoice, then confirm to pay.', pct: 35, busy: false },
  paying: { label: 'Paying from your wallet and minting your key…', pct: 60, busy: true },
  claiming: { label: 'Claiming your Routstr key…', pct: 80, busy: true },
  paid_unclaimed: { label: 'Paid — your sats are safe. Finishing your key…', pct: 70, busy: true },
  verifying: { label: 'Verifying your key with the provider…', pct: 90, busy: true },
  success: { label: 'Your Routstr key is claimed, encrypted, and verified.', pct: 100, busy: false },
  error: { label: 'Something needs your attention.', pct: 0, busy: false },
});

export function phaseMeta(phase) {
  return PHASE_META[phase] || PHASE_META.idle;
}

/**
 * Map a /routstr/pay result to the next phase. Success ONLY when key_stored.
 */
export function classifyPayResult(res) {
  if (!res || res.ok !== true) {
    return { phase: ONBOARD_PHASES.ERROR, reason: (res && res.reason) || 'payment failed' };
  }
  if (res.key_stored === true) {
    return { phase: ONBOARD_PHASES.SUCCESS, balance_sats: res.balance_sats ?? null, routstr: res.routstr || null };
  }
  // Paid but no key yet (recoverable, or watcher-lag). Never success.
  return { phase: ONBOARD_PHASES.PAID_UNCLAIMED, bolt11: res.bolt11 || null, reason: res.reason || 'key not yet issued' };
}

/**
 * Map a /routstr/recover result to the next phase. Success ONLY when
 * key_stored. A recoverable/pending result stays retryable (never success).
 */
export function classifyRecoverResult(res) {
  if (res && res.ok === true && res.key_stored === true) {
    return { phase: ONBOARD_PHASES.SUCCESS, balance_sats: res.balance_sats ?? null, routstr: res.routstr || null };
  }
  if (res && res.recoverable === true) {
    return { phase: ONBOARD_PHASES.PAID_UNCLAIMED, status: res.status || 'pending', reason: res.reason || 'not settled yet' };
  }
  return { phase: ONBOARD_PHASES.ERROR, reason: (res && res.reason) || 'could not claim the key' };
}

/** True when the resume snapshot says a paid invoice is unclaimed. */
export function shouldResumeClaim(stateBody) {
  return !!(stateBody && stateBody.claimable === true);
}

/** Whole seconds, floored at zero, as "Ns" (used by the elapsed timer). */
export function formatCountdown(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${s}s`;
}

/**
 * Format a whole-sats amount with grouping, e.g. 10000 → "10,000". Non-finite
 * input yields null so callers can fall back to "balance unknown". Pure so the
 * "msats must display as 10,000 sats" contract is unit-tested without a DOM.
 */
export function formatSats(n) {
  if (n === null || n === undefined || n === '') return null;
  if (!Number.isFinite(Number(n))) return null;
  return Math.round(Number(n)).toLocaleString('en-US');
}

// ─── Final curtain: deterministic navigation (v0.1.19) ──────────────────
//
// The previous curtain only console.log'd a commented-out redirect, so the
// "Your Torii is open. Stepping through…" screen span forever. These pure,
// injectable helpers make the transition deterministic and testable:
//   • resolveContinuumDestination picks the real same-origin Continuum home.
//     The Continuum SPA is served at /continuum/ (nginx alias) and is a
//     hash-router app, so the operator must land on the app dashboard —
//     /continuum/#/dashboard — NOT the bare /continuum/ which renders the
//     public marketing/landing surface. A deployment may override the target
//     via window.__toriiContinuumHome, but ONLY to a same-origin path — an
//     absolute/cross-origin value is rejected to avoid an open redirect.
//   • planCurtainTransition returns the (bounded) timings for showing the
//     fallback link and firing automatic navigation, honouring reduced motion.

export const CONTINUUM_HOME = '/continuum/#/dashboard';

export function resolveContinuumDestination(win = typeof window !== 'undefined' ? window : undefined) {
  const fallback = CONTINUUM_HOME;
  const override = win && typeof win.__toriiContinuumHome === 'string' ? win.__toriiContinuumHome.trim() : '';
  if (!override) return fallback;
  // Only accept a same-origin destination. A bare path ("/foo") is same-origin
  // by definition; an absolute URL must match this origin exactly.
  if (override.startsWith('/') && !override.startsWith('//')) return override;
  try {
    const origin = win && win.location ? win.location.origin : undefined;
    const u = new URL(override, origin);
    if (origin && u.origin === origin) return u.pathname + u.search + u.hash;
  } catch {
    /* fall through to the safe default */
  }
  return fallback;
}

/**
 * Bounded curtain timings. Never returns Infinity, so navigation is always
 * attempted and the screen can never hang. Under reduced motion we skip the
 * dramatic beat and navigate almost immediately.
 * @param {{reducedMotion?: boolean}} [opts]
 * @returns {{ navigateAfterMs: number, fallbackAfterMs: number }}
 */
export function planCurtainTransition({ reducedMotion = false } = {}) {
  if (reducedMotion) return { navigateAfterMs: 300, fallbackAfterMs: 0 };
  return { navigateAfterMs: 2400, fallbackAfterMs: 900 };
}

// ─── Secret reveal masking policy (v0.1.19) ─────────────────────────────
//
// The Step-5 inline Routstr-key reveal must re-mask on a fixed set of events so
// a revealed key is never left on screen. This pure predicate is the single
// source of truth for "does this event force a re-mask?", shared by the DOM
// wiring and the tests. Every listed event masks; anything else does not.
export const MASK_EVENTS = Object.freeze([
  'toggle', // operator clicked the eye again
  'leave-step', // deck moved away from step 5
  'visibility-hidden', // tab hidden / backgrounded
  'session-expired', // admin session no longer valid
  'timeout', // conservative auto-hide elapsed
]);

export function shouldMaskReveal(event) {
  return MASK_EVENTS.includes(event);
}

/** Conservative auto-hide for an inline revealed secret (ms). */
export const REVEAL_TIMEOUT_MS = 45000;

// ─── Recovery Kit builder (v0.1.18) ─────────────────────────────────────
//
// Turns the agent's redacted kit body into a downloadable text bundle. The
// DEFAULT kit EXCLUDES every secret — no NWC connection secret, no full
// Routstr key — carrying only redacted previews, fingerprints, the provider
// host, the (public) admin npub, and human instructions. A full key is placed
// in the bundle ONLY when `revealedKey` is passed, which only ever happens at
// the moment of an explicit one-time export the operator chose.
export const RECOVERY_KIT_FILENAME = 'torii-recovery-kit.txt';

export function buildRecoveryKit(kitBody, { revealedKey = null } = {}) {
  const b = kitBody || {};
  const lines = [];
  lines.push('TORII CONTINUUM — RECOVERY KIT');
  lines.push(`Generated: ${b.generated_at || new Date().toISOString()}`);
  if (b.agent_version) lines.push(`Agent version: ${b.agent_version}`);
  lines.push('');
  lines.push('IDENTITY');
  lines.push(`  Admin npub: ${b.admin_npub || '(unknown)'}`);
  lines.push(`  Provider:   ${b.provider_host || '(unknown)'}`);
  lines.push('');
  lines.push('ROUTSTR');
  if (b.routstr && b.routstr.connected) {
    lines.push(`  Key (redacted): ${b.routstr.key_preview || '—'}`);
    if (b.routstr.key_fingerprint) lines.push(`  Fingerprint:    ${b.routstr.key_fingerprint}`);
    if (b.routstr.balance_sats != null) lines.push(`  Balance:        ${formatSats(b.routstr.balance_sats) ?? b.routstr.balance_sats} sats`);
  } else {
    lines.push('  Not connected.');
  }
  lines.push('');
  lines.push('WALLET (NWC)');
  if (b.wallet && b.wallet.connected) {
    const w = b.wallet.wallet || {};
    lines.push(`  Wallet pubkey: ${w.wallet_pubkey_prefix ? w.wallet_pubkey_prefix + '…' : '—'}`);
    lines.push(`  Relays:        ${(w.relays || []).join(', ') || '—'}`);
    lines.push('  Connection secret: NOT included (re-pair from your wallet app).');
  } else {
    lines.push('  Not connected.');
  }
  lines.push('');
  if (revealedKey) {
    lines.push('SENSITIVE — FULL ROUTSTR KEY (you explicitly revealed this)');
    lines.push(`  ${revealedKey}`);
    lines.push('  Treat this like cash. Do not share. Delete this file after moving the key.');
    lines.push('');
  }
  lines.push('INSTRUCTIONS');
  for (const line of (Array.isArray(b.instructions) ? b.instructions : [])) lines.push(`  - ${line}`);
  if (b.notes) { lines.push(''); lines.push('NOTES'); lines.push(`  ${b.notes}`); }
  return { filename: RECOVERY_KIT_FILENAME, text: lines.join('\n'), includes_secret_key: !!revealedKey };
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

// ─── Accessible progress + auto-advance (v0.1.18) ───────────────────────
//
// A single visible, screen-reader-announced progress region drives every long
// Routstr step (connect → quote → pay → claim → verify). It is fed exclusively
// from phaseMeta() so the bar, scanning animation, label, and aria-busy state
// can never desync from the state machine.

function setProgress(region, phase) {
  if (!region) return;
  const meta = phaseMeta(phase);
  region.hidden = false;
  region.setAttribute('aria-busy', String(!!meta.busy));
  region.dataset.phase = phase;
  const fill = region.querySelector('[data-op-fill]');
  const scan = region.querySelector('[data-op-scan]');
  const label = region.querySelector('[data-op-label]');
  if (fill) fill.style.width = `${meta.pct}%`;
  if (scan) scan.hidden = !meta.busy;
  if (label) label.textContent = meta.label;
}

function hideProgress(region) {
  if (!region) return;
  region.hidden = true;
  region.removeAttribute('aria-busy');
  const timerEl = region.querySelector('[data-op-timer]');
  if (timerEl) timerEl.textContent = '';
}

// A live-updating "elapsed" timer so the operator can see the step is doing
// something during a long mint/claim. Returns a stop() closure.
function startElapsed(region) {
  const timerEl = region && region.querySelector('[data-op-timer]');
  if (!timerEl) return () => {};
  const t0 = Date.now();
  timerEl.textContent = '0s';
  const id = setInterval(() => {
    timerEl.textContent = formatCountdown((Date.now() - t0) / 1000);
  }, 250);
  return () => clearInterval(id);
}

// Collapse every Step-3 SETUP control once the key is verified. Once the key is
// claimed/encrypted/verified there is nothing left to set up, so the two path
// cards, both input forms, the invoice-confirm card, the progress/scanning bar,
// and all setup CTAs (Verify & connect / Request an invoice / Disconnect) are
// hidden. This is what removes the three competing CTAs and the 0s countdown —
// leaving a single green summary plus one Continue button below it.
function collapseStep3Setup(doc) {
  const panel = doc && doc.querySelector('.panel[data-panel="3"]');
  if (!panel) return null;
  const hide = (sel) => panel.querySelectorAll(sel).forEach((el) => { el.hidden = true; });
  hide('.routstr-paths');
  hide('[data-routstr-key-form]');
  hide('[data-routstr-fund-form]');
  hide('[data-routstr-confirm]');
  hide('[data-routstr-progress]');
  hide('[data-routstr-key-connect]');
  hide('[data-routstr-quote]');
  hide('[data-routstr-disconnect]');
  return panel;
}

// SUCCESS terminal render: never reached until the agent reported key_stored.
// Collapses the setup UI, shows ONE concise green verified summary (redacted key
// id + correctly-labelled balance), and offers a SINGLE explicit Continue button
// placed OUTSIDE the summary box. No countdown, no auto-advance: the operator
// steps through when ready. Advancing is idempotent (fires at most once). The
// `_seconds` arg is retained for call-site compatibility and intentionally
// ignored — there is no timer any more.
function renderSuccessAdvance(statusEl, region, fromStep, body, _seconds) {
  const doc = statusEl && statusEl.ownerDocument;
  // Verified: kill any scanning/progress UI outright.
  hideProgress(region);
  const panel = collapseStep3Setup(doc);
  // Mark the panel claimed. This is the single source of truth the setup
  // handlers (quote / key-connect) consult to refuse any further invoice or
  // payment initiation — closing the stale-UI / double-click race where a
  // handler fires after the key is already verified.
  if (panel) panel.dataset.claimed = '1';
  const prev = body && body.routstr && body.routstr.key_preview;
  const bal = body && body.balance_sats;
  const balText = formatSats(bal);
  renderStatus(
    statusEl,
    'ok',
    `<div class="conn-line"><span class="conn-dot"></span><span>Your Routstr key is claimed, encrypted, and verified${prev ? ` &middot; <code>${prev}</code>` : ''}.</span></div>` +
      `${balText != null ? `<div class="conn-meta">Balance: ${balText} sats</div>` : ''}`,
  );

  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.dispatchEvent(new CustomEvent('onboarding:advance', { detail: { from: fromStep } }));
  };

  // The ONE action: a Continue button OUTSIDE the green summary box. Reuse a
  // dedicated slot in the panel actions if present; otherwise append after the
  // status region so it never sits inside the summary.
  if (doc && panel) {
    let cont = panel.querySelector('[data-routstr-continue]');
    if (!cont) {
      const actions = panel.querySelector('.panel-actions') || panel;
      cont = doc.createElement('button');
      cont.className = 'btn-primary';
      cont.setAttribute('data-routstr-continue', '');
      cont.innerHTML = '<span>Continue</span><span class="arrow">&rarr;</span>';
      actions.appendChild(cont);
    }
    cont.hidden = false;
    cont.disabled = false;
    cont.addEventListener('click', go, { once: true });
  }
}

// Idempotent claim runner. Hits the agent's /routstr/recover (empty body → the
// agent supplies the stored bolt11) and NEVER pays. On PAID_UNCLAIMED it offers
// a manual retry; SUCCESS only when key_stored. Used by both the pay flow and
// refresh-resume.
async function runClaim(statusEl, region, bolt11, fromStep) {
  setProgress(region, ONBOARD_PHASES.CLAIMING);
  const stop = startElapsed(region);
  const rec = await recoverRoutstrInvoice(bolt11 ? { bolt11 } : {});
  stop();
  const next = classifyRecoverResult(rec);
  if (next.phase === ONBOARD_PHASES.SUCCESS) {
    renderSuccessAdvance(statusEl, region, fromStep, next);
    return next;
  }
  if (next.phase === ONBOARD_PHASES.PAID_UNCLAIMED) {
    setProgress(region, ONBOARD_PHASES.PAID_UNCLAIMED);
    renderStatus(
      statusEl,
      'warn',
      `<div class="conn-line"><span class="conn-dot"></span><span>Paid — your sats are safe. Your key isn't issued yet (${next.status || 'pending'}).</span></div>` +
        `<div class="ci-actions"><button class="btn-primary" data-routstr-claim><span>Claim key</span><span class="arrow">&rarr;</span></button></div>`,
    );
    const btn = statusEl.querySelector('[data-routstr-claim]');
    if (btn) btn.addEventListener('click', () => { btn.disabled = true; runClaim(statusEl, region, bolt11, fromStep); });
    return next;
  }
  hideProgress(region);
  renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${next.reason}</span></div>`);
  return next;
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
  const progressEl = panel.querySelector('[data-routstr-progress]');
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

  // A verified/funded key is a CLAIMED terminal state: there is nothing left to
  // set up, so we always collapse every setup control and render the single
  // green summary + one Continue button — never the bare summary that left the
  // path cards, key form, and "Verify & connect" / "Request an invoice" CTAs on
  // screen alongside it. Normalises whichever redacted shape the source used
  // (recovery snapshot's routstr{} vs routstr/status's top-level fields).
  const showClaimed = (body) => {
    const routstr = body.routstr || {};
    const key_preview = routstr.key_preview || body.key_preview || null;
    const balance_sats = body.balance_sats ?? routstr.balance_sats ?? body.balance ?? null;
    renderSuccessAdvance(statusEl, progressEl, 3, { routstr: { key_preview }, balance_sats });
  };

  // Refresh-resume (v0.1.18): on load, read the redacted recovery snapshot.
  // If a paid invoice is unclaimed, finish the claim automatically WITHOUT
  // re-payment. If a key is already connected, reflect it and offer to step on.
  // This is what fixes the "refresh loses my paid session" bug.
  fetchRecoveryState({}).then((state) => {
    if (shouldResumeClaim(state)) {
      selectPath('fund');
      runClaim(statusEl, progressEl, null, 3);
      return;
    }
    if (state && state.routstr && state.routstr.connected) {
      showClaimed({ routstr: state.routstr, balance_sats: state.routstr.balance_sats });
      return;
    }
    routstrStatus({}).then((s) => { if (s && s.connected) showClaimed(s); }).catch(() => {});
  }).catch(() => {
    routstrStatus({}).then((s) => { if (s && s.connected) showClaimed(s); }).catch(() => {});
  });

  if (keyConnectBtn) {
    keyConnectBtn.addEventListener('click', async () => {
      // Stale-UI guard: never act once the key is claimed/verified.
      if (panel.dataset.claimed) return;
      const key = keyInput ? keyInput.value : '';
      const shape = validateRoutstrKeyShape(key);
      if (!shape.ok) {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${shape.reason}</span></div>`);
        return;
      }
      keyConnectBtn.disabled = true;
      setProgress(progressEl, ONBOARD_PHASES.VERIFYING);
      const stop = startElapsed(progressEl);
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Verifying with your provider…</span></div>');
      const res = await connectRoutstrKey({ key });
      stop();
      if (keyInput) keyInput.value = '';
      if (res.ok) {
        // Idempotency: a verified key is terminal — keep the button disabled.
        renderSuccessAdvance(statusEl, progressEl, 3, res);
      } else {
        keyConnectBtn.disabled = false;
        hideProgress(progressEl);
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
      // Duplicate-payment prevention: the confirm button is the ONE payment
      // boundary. Once clicked it is permanently disabled so a double-click or
      // impatient re-click can never mint/pay twice. A claimed panel (key
      // already verified via any path) also hard-blocks a stale confirm click.
      if (payBtn.disabled || panel.dataset.claimed) return;
      payBtn.disabled = true;
      confirmEl.hidden = true; confirmEl.innerHTML = '';
      setProgress(progressEl, ONBOARD_PHASES.PAYING);
      const stop = startElapsed(progressEl);
      const paid = await payRoutstrInvoice({ invoice: quote.invoice, quoteId: quote.quote_id, confirm: true });
      stop();
      const next = classifyPayResult(paid);
      if (next.phase === ONBOARD_PHASES.SUCCESS) {
        renderSuccessAdvance(statusEl, progressEl, 3, next);
      } else if (next.phase === ONBOARD_PHASES.PAID_UNCLAIMED) {
        // Paid but the key isn't minted yet. Sats are safe. Claim idempotently
        // via /routstr/recover — never a second payment.
        await runClaim(statusEl, progressEl, next.bolt11 || quote.invoice, 3);
      } else {
        hideProgress(progressEl);
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${next.reason}</span></div>`);
      }
    });
  };

  if (quoteBtn) {
    quoteBtn.addEventListener('click', async () => {
      // Stale-UI guard: a claimed key means the funding path is closed — never
      // request another invoice (which is the first step toward a duplicate pay).
      if (panel.dataset.claimed) return;
      const amountSats = topupInput ? topupInput.value : '';
      const amount = validateTopupAmount(amountSats);
      if (!amount.ok) {
        renderStatus(statusEl, 'err', `<div class="conn-line"><span class="conn-dot"></span><span>${amount.reason}</span></div>`);
        return;
      }
      quoteBtn.disabled = true;
      setProgress(progressEl, ONBOARD_PHASES.QUOTING);
      renderStatus(statusEl, 'warn', '<div class="conn-line"><span class="conn-dot"></span><span>Requesting an invoice…</span></div>');
      const res = await quoteRoutstrTopup({ amountSats: amount.sats });
      quoteBtn.disabled = false;
      if (res.ok && res.requires_confirmation) {
        setProgress(progressEl, ONBOARD_PHASES.AWAITING_CONFIRM);
        renderConfirm(res);
        if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
      } else if (res.blocked) {
        hideProgress(progressEl);
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
      hideProgress(progressEl);
      if (statusEl) { statusEl.hidden = true; statusEl.innerHTML = ''; }
    });
  }
}

// ─── Step 5 · Recovery kit (v0.1.19) ────────────────────────────────────
//
// Two fixes over v0.1.18:
//   1. Download IS the confirmation. Clicking "Download recovery kit" fetches
//      the full Routstr key over the explicit, admin-authenticated, no-store
//      export endpoint and writes it into the downloaded file (a Blob, so the
//      key is never put in localStorage/sessionStorage/URL/logs). The NWC
//      connection secret is still excluded. There is no separate "reveal"
//      prerequisite and no "next download" limbo state.
//   2. The ROUTSTR KEY row carries BRANDED inline show/hide (eye) + copy
//      controls — no unbranded window.confirm/prompt/alert anywhere. Revealing
//      inline fetches the key the same safe way; it is masked again on toggle,
//      on leaving the step, on tab hide, on session expiry, and after a
//      conservative timeout (see shouldMaskReveal / REVEAL_TIMEOUT_MS).
function triggerDownload(doc, filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  // Revoke on the next tick so the click has committed the navigation.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Small branded inline glyphs (no emoji, no third-party icon font).
const EYE_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 4.5C5.8 4.5 2.3 7 1 10c1.3 3 4.8 5.5 9 5.5s7.7-2.5 9-5.5c-1.3-3-4.8-5.5-9-5.5Zm0 9a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm0-1.8a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.3 3.3 1 4.6l2.5 2.6C2.4 8 1.5 8.9 1 10c1.3 3 4.8 5.5 9 5.5 1.6 0 3.1-.35 4.4-.95l2 2 1.3-1.3L2.3 3.3Zm7.7 8.9a2.2 2.2 0 0 1-2.2-2.2l2.2 2.2Zm0-6.7c4.2 0 7.7 2.5 9 5.5-.5 1.1-1.3 2.1-2.3 2.9l-2.6-2.6a3.5 3.5 0 0 0-4.4-4.4L7 4.9c.95-.26 1.95-.4 3-.4Z"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 2.5A1.5 1.5 0 0 0 5.5 4v9A1.5 1.5 0 0 0 7 14.5h6A1.5 1.5 0 0 0 14.5 13V4A1.5 1.5 0 0 0 13 2.5H7Zm0 1.5h6v9H7V4ZM3.5 6A1.5 1.5 0 0 0 2 7.5v9A1.5 1.5 0 0 0 3.5 18H10a1.5 1.5 0 0 0 1.5-1.5V16H10v.5H3.5v-9H4V6h-.5Z"/></svg>';

export function initStep5(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="5"]');
  if (!panel) return;

  const previewEl = panel.querySelector('[data-kit-preview]');
  const statusEl = panel.querySelector('[data-kit-status]');
  const downloadBtn = panel.querySelector('[data-download-kit]');
  const continueBtn = panel.querySelector('[data-kit-continue]');

  let kitBody = null;       // redacted agent kit (no secrets)
  let revealedKey = null;   // full key, in memory ONLY while shown inline
  let revealTimer = null;   // conservative auto-hide timer

  const sessionLive = () => {
    try { return !!restoreSession(); } catch { return false; }
  };

  const setStatus = (kind, html) => {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.className = `conn-status is-${kind}`;
    statusEl.innerHTML = html;
  };

  const clearRevealTimer = () => {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  };

  const keyValEl = () => previewEl && previewEl.querySelector('[data-kit-keyval]');
  const eyeBtn = () => previewEl && previewEl.querySelector('[data-kit-eye]');

  // Re-mask: drop the in-memory key, restore the redacted preview, reset the
  // eye control. Idempotent and safe to call for any mask reason.
  const maskKey = () => {
    revealedKey = null;
    clearRevealTimer();
    const val = keyValEl();
    const eye = eyeBtn();
    if (val) { val.textContent = (kitBody && kitBody.routstr && kitBody.routstr.key_preview) || '—'; val.classList.remove('is-revealed'); }
    if (eye) { eye.setAttribute('aria-pressed', 'false'); eye.setAttribute('aria-label', 'Show full Routstr key'); eye.innerHTML = EYE_SVG; }
  };

  const renderPreview = () => {
    if (!previewEl) return;
    const b = kitBody || {};
    const connected = !!(b.routstr && b.routstr.connected);
    const rows = [];
    rows.push(`<div class="kit-row"><span class="kit-key">Admin npub</span><span class="kit-val">${b.admin_npub || '—'}</span></div>`);
    rows.push(`<div class="kit-row"><span class="kit-key">Provider</span><span class="kit-val">${b.provider_host || '—'}</span></div>`);
    if (connected) {
      // Branded inline key row: masked value + eye (show/hide) + copy.
      rows.push(
        `<div class="kit-row kit-row-key"><span class="kit-key">Routstr key</span>` +
          `<span class="kit-keywrap">` +
            `<span class="kit-val" data-kit-keyval>${b.routstr.key_preview || '—'}</span>` +
            `<span class="kit-keyctl">` +
              `<button type="button" class="kit-iconbtn" data-kit-eye aria-pressed="false" aria-label="Show full Routstr key">${EYE_SVG}</button>` +
              `<button type="button" class="kit-iconbtn" data-kit-copy aria-label="Copy full Routstr key">${COPY_SVG}</button>` +
            `</span>` +
          `</span>` +
        `</div>`,
      );
      if (b.routstr.balance_sats != null) {
        const bt = formatSats(b.routstr.balance_sats) ?? b.routstr.balance_sats;
        rows.push(`<div class="kit-row"><span class="kit-key">Balance</span><span class="kit-val">${bt} sats</span></div>`);
      }
    } else {
      rows.push(`<div class="kit-row"><span class="kit-key">Routstr key</span><span class="kit-val">not connected</span></div>`);
    }
    if (b.wallet && b.wallet.connected) {
      const w = b.wallet.wallet || {};
      rows.push(`<div class="kit-row"><span class="kit-key">Wallet</span><span class="kit-val">${w.wallet_pubkey_prefix ? `${w.wallet_pubkey_prefix}…` : 'connected'}</span></div>`);
    }
    previewEl.innerHTML = rows.join('');
    wireKeyControls();
  };

  // Fetch the full key over the explicit, no-store export endpoint. Never
  // persists it — the caller holds it only transiently.
  const fetchFullKey = async () => {
    if (!sessionLive()) return { ok: false, reason: 'your session expired — sign in again' };
    const res = await exportRoutstrKey({ confirm: true });
    if (res.ok && res.key) return { ok: true, key: res.key };
    return { ok: false, reason: res.reason || 'could not read your key' };
  };

  const revealInline = async () => {
    const val = keyValEl();
    const eye = eyeBtn();
    if (eye) eye.disabled = true;
    const res = await fetchFullKey();
    if (eye) eye.disabled = false;
    if (!res.ok) { setStatus('err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`); return; }
    revealedKey = res.key;
    if (val) { val.textContent = revealedKey; val.classList.add('is-revealed'); }
    if (eye) { eye.setAttribute('aria-pressed', 'true'); eye.setAttribute('aria-label', 'Hide full Routstr key'); eye.innerHTML = EYE_OFF_SVG; }
    setStatus('warn', '<div class="conn-line"><span class="conn-dot"></span><span>Full key shown. It hides automatically — never stored in this browser.</span></div>');
    clearRevealTimer();
    revealTimer = setTimeout(() => { if (shouldMaskReveal('timeout')) maskKey(); }, REVEAL_TIMEOUT_MS);
  };

  const copyKey = async () => {
    // Reuse an already-revealed key; otherwise fetch transiently, copy, discard.
    let key = revealedKey;
    if (!key) {
      const res = await fetchFullKey();
      if (!res.ok) { setStatus('err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`); return; }
      key = res.key;
    }
    try {
      const clip = typeof navigator !== 'undefined' && navigator.clipboard;
      if (!clip || typeof clip.writeText !== 'function') throw new Error('clipboard unavailable');
      await clip.writeText(key);
      setStatus('ok', '<div class="conn-line"><span class="conn-dot"></span><span>Full key copied to your clipboard. Paste it somewhere safe, then clear your clipboard.</span></div>');
    } catch {
      setStatus('err', '<div class="conn-line"><span class="conn-dot"></span><span>Could not copy automatically — reveal the key with the eye and copy it manually.</span></div>');
    } finally {
      // Drop the transient copy immediately unless it is the one being shown.
      if (!revealedKey) key = null;
    }
  };

  function wireKeyControls() {
    const eye = eyeBtn();
    const copyBtn = previewEl && previewEl.querySelector('[data-kit-copy]');
    if (eye) {
      eye.addEventListener('click', () => {
        if (revealedKey) { if (shouldMaskReveal('toggle')) maskKey(); }
        else revealInline();
      });
    }
    if (copyBtn) copyBtn.addEventListener('click', copyKey);
  }

  // Load the redacted kit on entry so the preview shows real (safe) values and
  // the download works immediately.
  fetchRecoveryKit({}).then((body) => {
    if (body && body.ok !== false) { kitBody = body; renderPreview(); }
  }).catch(() => {});

  // Mask on leaving step 5, on tab hide, and on session loss. Each maps to a
  // MASK_EVENTS reason so the policy stays in one pure place.
  if (typeof window !== 'undefined') {
    window.addEventListener('onboarding:step', (e) => {
      const step = e && e.detail && e.detail.step;
      if (step !== 5 && revealedKey && shouldMaskReveal('leave-step')) maskKey();
    });
  }
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden' && revealedKey && shouldMaskReveal('visibility-hidden')) maskKey();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
      if (!kitBody) {
        const body = await fetchRecoveryKit({});
        if (body && body.ok !== false) { kitBody = body; renderPreview(); }
      }
      if (!kitBody) { setStatus('err', '<div class="conn-line"><span class="conn-dot"></span><span>Could not build your kit — sign in and try again.</span></div>'); return; }
      // The download click IS the explicit confirmation: include the full key.
      // Reuse an inline-revealed key if present; otherwise fetch it once.
      let keyForKit = revealedKey;
      if (!keyForKit && kitBody.routstr && kitBody.routstr.connected) {
        const res = await fetchFullKey();
        if (!res.ok) { setStatus('err', `<div class="conn-line"><span class="conn-dot"></span><span>${res.reason}</span></div>`); return; }
        keyForKit = res.key;
      }
      const kit = buildRecoveryKit(kitBody, { revealedKey: keyForKit });
      triggerDownload(doc, kit.filename, kit.text);
      // Drop the transient key reference (unless it is the one shown inline).
      if (!revealedKey) keyForKit = null;
      setStatus('ok', `<div class="conn-line"><span class="conn-dot"></span><span>Recovery kit downloaded${kit.includes_secret_key ? ' — it includes your full Routstr key. Treat the file like cash.' : ' (no Routstr key was available to include).'}</span></div>`);
      if (continueBtn) continueBtn.hidden = false;
    });
  }
}

// ─── Final curtain controller (v0.1.19) ────────────────────────────────
//
// Replaces the old console.log-only redirect that left the curtain spinning
// forever. On reaching the curtain step the deck broadcasts onboarding:step
// with step === 6; we then navigate deterministically to the resolved
// same-origin Continuum home, reveal a real "Open Continuum now" link as a
// bounded fallback (in case automatic navigation is blocked), and guarantee the
// spinner is never shown indefinitely.
export const CURTAIN_STEP = 6;

export function initCurtain(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const panel = doc.querySelector('.panel[data-panel="6"]');
  if (!panel) return;
  const openLink = panel.querySelector('[data-curtain-open]');
  const lede = panel.querySelector('.curtain-lede');
  const spinner = panel.querySelector('.curtain-spinner');
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    const win = typeof window !== 'undefined' ? window : undefined;
    const dest = resolveContinuumDestination(win);
    const reducedMotion = !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const { navigateAfterMs, fallbackAfterMs } = planCurtainTransition({ reducedMotion });
    if (openLink) openLink.setAttribute('href', dest);
    // Reveal the fallback control so a blocked auto-nav always leaves a way through.
    setTimeout(() => { if (openLink) openLink.hidden = false; }, fallbackAfterMs);
    // Deterministic navigation.
    setTimeout(() => {
      try { if (win && win.location) win.location.assign(dest); } catch { /* fallback link remains */ }
    }, navigateAfterMs);
    // Never appear to hang: if we're still on this screen shortly after the
    // navigation attempt, drop the spinner and make the link the clear action.
    setTimeout(() => {
      if (spinner) spinner.hidden = true;
      if (lede) lede.textContent = 'Almost there — open Continuum to finish.';
      if (openLink) openLink.hidden = false;
    }, navigateAfterMs + 1500);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('onboarding:step', (e) => {
      if (e && e.detail && e.detail.step === CURTAIN_STEP) start();
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
    initStep5();
    initCurtain();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
}
