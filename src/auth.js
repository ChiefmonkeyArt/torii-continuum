/**
 * NIP-07 login flow (AUTH-DIRECT-1) — signs a challenge event with Plebeian
 * Signer (or any NIP-07 extension) and hands it to the agent for verification.
 *
 * DIRECT INVOCATION: clicking Login invokes the browser NIP-07 extension
 * immediately — there is NO intermediate modal. Status and errors are surfaced
 * INLINE on the calling surface (the login card or the sidebar) via an injected
 * `onStatus` sink, so the original homescreen stays put on any failure and the
 * user sees a concise message where they clicked.
 *
 * Flow:
 *   1. window.nostr must exist (missing → inline "install a signer" message).
 *   2. POST /api/auth/challenge → { challenge, expires_in }.
 *   3. window.nostr.signEvent({ kind: 22242, content: challenge, tags: [...] }),
 *      guarded by a timeout so a hung/never-answered extension fails cleanly.
 *   4. POST /api/auth/verify { event } → { token, expires_at }; token stored.
 *   5. On success, dispatch continuum:session-changed (router navigates to the
 *      dashboard). On ANY failure (cancel, missing extension, denial, timeout,
 *      bad signature) we stay put and report inline.
 *
 * A module-level in-flight guard prevents double invocation / races from rapid
 * clicks or a second surface triggering login while one is running.
 */

import {
  requestChallenge,
  verifyChallenge,
  isLoggedIn,
  logout as clearSession,
  isAgentConfigured,
  getStoredToken,
  sessionExpiry,
  refreshSession as refreshSessionToken,
} from './data/agent.js';
import {
  STATES,
  classify,
  reduce,
  shouldRefresh,
  msUntilRefresh,
  RETRY_BACKOFF_MS,
} from './session-state.js';

const NIP42_KIND = 22242;
// Give the extension a bounded window to answer. A user who never approves (or a
// wedged extension) resolves as a clean timeout instead of hanging the button.
const SIGNER_TIMEOUT_MS = 90_000;

// Cross-tab sign-out broadcast. Writing this key fires a `storage` event in
// every OTHER tab of the same origin (never the writer), so a sign-out in one
// tab bounces them all to the login page. The value is a throwaway timestamp;
// only the write itself matters. Never holds a token or any secret.
export const SIGNOUT_SENTINEL_KEY = 'continuum.signout.v1';

// Non-secret session marker (SESSION-REHYDRATE-1). Written the moment a session
// becomes active so a freshly-opened tab (or a bfcache restore) can render the
// authenticated shell immediately from persistent storage instead of flashing a
// blank right-hand region. The actual HMAC session token lives in
// continuum.session.v1 (agent.js); that slot already holds a signed string, so
// this display-only marker { npub, connected_at } gets its OWN key rather than
// clobbering the token. npub is the signer pubkey hex (display shortcode source,
// no bech32 dep); connected_at is unix seconds. Never a secret key.
export const SESSION_MARKER_KEY = 'continuum.session.meta.v1';

/**
 * Persist (or with a null/falsey arg, clear) the session marker. Storage-only,
 * failure-swallowing so a blocked localStorage never breaks auth flow.
 * @param {{npub?: string, connected_at?: number}|null} marker
 */
export function writeSessionMarker(marker) {
  try {
    if (!marker) { localStorage.removeItem(SESSION_MARKER_KEY); return; }
    localStorage.setItem(SESSION_MARKER_KEY, JSON.stringify({
      npub: String(marker.npub || ''),
      connected_at: Number(marker.connected_at) || Math.floor(Date.now() / 1000),
    }));
  } catch (_e) {}
}

/**
 * Read the session marker back, or null when absent/corrupt. Pure w.r.t.
 * storage; never throws.
 * @returns {{npub: string, connected_at: number}|null}
 */
export function readSessionMarker() {
  try {
    const raw = localStorage.getItem(SESSION_MARKER_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return null;
    return { npub: String(m.npub || ''), connected_at: Number(m.connected_at) || 0 };
  } catch { return null; }
}

/**
 * Rehydrate session view-state from persistent storage. Run on every top-level
 * view mount and on a bfcache pageshow restore so a fresh tab is authoritative
 * immediately: liveness derives from the persisted token (isSessionLive reads
 * localStorage), and the display marker is returned alongside so a guarded view
 * renders the authenticated shell with no blank flash. A marker with no live
 * token is stale (token expired, or cleared by another tab) and is dropped so
 * the UI never claims a session it cannot back.
 * @returns {{live: boolean, marker: ({npub: string, connected_at: number}|null)}}
 */
export function rehydrateSession() {
  const live = isSessionLive();
  const marker = readSessionMarker();
  if (marker && !live) { writeSessionMarker(null); }
  // A tab that rehydrates an existing session owns its renewal too — otherwise
  // only the tab that performed the sign-in would keep the session alive, and
  // reloading the page would silently stop the clock.
  if (live) startSessionRefresh();
  return { live, marker: live ? marker : null };
}

/**
 * Is this `storage` event a cross-tab sign-out broadcast? True for a write
 * (newValue set) to the sign-out sentinel key, OR for the session marker being
 * cleared (newValue null) — both mean another tab ended the session and this
 * one must follow. A write to the marker (a fresh sign-in elsewhere) is NOT a
 * sign-out. Pure + exported so the listener contract is unit-tested without a
 * real StorageEvent.
 * @param {{key?: string|null, newValue?: string|null}} event
 */
export function isSignoutBroadcast(event) {
  if (!event) return false;
  if (event.key === SIGNOUT_SENTINEL_KEY && event.newValue != null) return true;
  if (event.key === SESSION_MARKER_KEY && event.newValue == null) return true;
  return false;
}

// Browsers never fire `storage` in the tab that wrote the key — the event is
// delivered only to OTHER same-origin tabs. So a sign-out in the writer tab that
// relied purely on the storage listener would do nothing locally. We already
// dispatch continuum:session-changed for the same-tab path, but we ALSO dispatch
// a synthetic same-tab `storage` event so the identical listener runs in the
// writer, keeping the sign-out path uniform across every tab. Guarded for the
// jsdom-free/test environment where window or StorageEvent may be absent.
function dispatchSameTabSignout() {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    let ev;
    if (typeof StorageEvent === 'function') {
      ev = new StorageEvent('storage', { key: SIGNOUT_SENTINEL_KEY, newValue: String(Date.now()) });
    } else if (typeof Event === 'function') {
      ev = new Event('storage');
      ev.key = SIGNOUT_SENTINEL_KEY;
      ev.newValue = String(Date.now());
    } else { return; }
    window.dispatchEvent(ev);
  } catch (_e) {}
}

// Race guard: at most one login attempt in flight across ALL surfaces.
let loginInFlight = false;

export function hasSigner() {
  return typeof window !== 'undefined' && window.nostr && typeof window.nostr.signEvent === 'function';
}

export function isLoginInFlight() { return loginInFlight; }

export function isSessionLive() { return isLoggedIn(); }

/**
 * End the local session and route back to login. Sign-out is purely local
 * (stateless HMAC tokens carry their own expiry; there is no server session to
 * revoke), so this clears the stored tokens and dispatches
 * continuum:session-changed — the app handler routes to the login modal.
 *
 * By default it ALSO writes the cross-tab sign-out sentinel so every other open
 * tab bounces to login too. The `localOnly` option skips that write: it is set
 * by the `storage`-event handler that reacts to ANOTHER tab's broadcast, so
 * reacting to a broadcast never re-broadcasts (no cross-tab loop).
 * @param {{localOnly?: boolean}} [opts]
 */
export function endSession(opts = {}) {
  stopSessionRefresh();
  clearSession();
  writeSessionMarker(null);
  if (!opts.localOnly) {
    try { localStorage.setItem(SIGNOUT_SENTINEL_KEY, String(Date.now())); } catch (_e) {}
    // Fire the same-tab storage fallback so the writer tab's own storage
    // listener runs (browsers suppress the native event on the writer).
    dispatchSameTabSignout();
  }
  document.dispatchEvent(new CustomEvent('continuum:session-changed'));
}

// ─── Session refresh (CONT-AUTH-1) ──────────────────────────
//
// The state machine in session-state.js decides WHAT should happen; this is the
// only place that owns a timer and performs the side effects. One timer at a
// time, always cancelled before a new one is armed, so a re-entrant call (a
// second tab waking, a sign-in while a timer is pending) cannot leave two
// renewal loops running against the same session.

let refreshTimer = null;
let currentState = STATES.ANONYMOUS;
let deps = null;

/** The live session state. Exported for the UI and for assertions. */
export function sessionState() {
  return currentState;
}

/** Cancel any pending renewal and forget the session state. */
export function stopSessionRefresh() {
  if (refreshTimer !== null) {
    (deps?.clearTimer || clearTimeout)(refreshTimer);
    refreshTimer = null;
  }
  currentState = STATES.ANONYMOUS;
}

/**
 * Begin keeping the current session alive.
 *
 * Dependencies are injectable so the loop is testable without real time or a
 * network; production passes nothing.
 *
 * A refusal that the agent calls terminal (`max_lifetime_reached`) ends the
 * session immediately — the owner has to visit their signer again, and
 * pretending otherwise would just fail every subsequent call. Any other
 * failure leaves the still-valid token alone and simply tries again later: a
 * flaky network is not a reason to throw somebody out of their work.
 */
export function startSessionRefresh(overrides = {}) {
  stopSessionRefresh();
  deps = {
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    nowSec: () => Math.floor(Date.now() / 1000),
    refresh: refreshSessionToken,
    onExpired: () => endSession(),
    ...overrides,
  };

  // sessionExpiry() is the same authoritative value isSessionLive() consumes —
  // the agent's stated expires_at, falling back to the token only when absent.
  // Reading it here keeps the renewal clock and the guard from disagreeing.
  currentState = classify(sessionExpiry(), deps.nowSec());
  if (currentState === STATES.ANONYMOUS) return currentState;
  if (currentState === STATES.EXPIRED) {
    deps.onExpired();
    return currentState;
  }
  arm();
  return currentState;
}

function arm(delayOverrideMs = null) {
  if (!deps) return;
  const wait = delayOverrideMs === null
    ? msUntilRefresh(sessionExpiry(), deps.nowSec())
    : delayOverrideMs;
  if (wait === null) return;
  refreshTimer = deps.setTimer(tick, wait);
}

async function tick() {
  if (!deps) return;
  refreshTimer = null;
  const now = deps.nowSec();
  currentState = reduce(currentState, { type: 'tick', expiresAt: sessionExpiry(), now });

  if (currentState === STATES.EXPIRED) {
    deps.onExpired();
    return;
  }
  if (!shouldRefresh(currentState)) {
    arm();
    return;
  }

  currentState = reduce(currentState, { type: 'refresh_started' });
  const result = await deps.refresh();
  const after = deps.nowSec();

  if (result?.ok) {
    currentState = reduce(currentState, {
      type: 'refresh_ok',
      expiresAt: result.expires_at ?? sessionExpiry(),
      now: after,
    });
    arm();
    return;
  }

  currentState = reduce(currentState, {
    type: 'refresh_failed',
    code: result?.code,
    expiresAt: sessionExpiry(),
    now: after,
  });
  if (currentState === STATES.EXPIRED) {
    deps.onExpired();
    return;
  }
  // Still authorised — back off rather than retrying against a flaky agent as
  // fast as the event loop allows.
  arm(RETRY_BACKOFF_MS);
}

/**
 * Build the NIP-07 login event params. Pure + exported so the challenge/relay
 * wiring is unit-tested without a signer.
 * @param {string} challenge
 * @param {string} origin
 * @param {number} [nowMs]
 */
export function buildLoginEvent(challenge, origin, nowMs = Date.now()) {
  return {
    kind: NIP42_KIND,
    created_at: Math.floor(nowMs / 1000),
    content: challenge,
    tags: [
      ['challenge', challenge],
      ['relay', origin],
    ],
  };
}

/**
 * Resolve/reject a promise with a timeout. Pure + exported for tests.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => any} [makeTimer] injectable setTimeout for tests
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, makeTimer = setTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = makeTimer(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timeout'));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } },
    );
  });
}

/**
 * Begin the login flow. Invokes the NIP-07 extension directly (no modal).
 * @param {object} [opts]
 * @param {(s:{phase:string, message:string, error?:boolean, done?:boolean, signerMissing?:boolean}) => void} [opts.onStatus]
 *        inline status sink on the calling surface.
 */
export async function startLogin(opts = {}) {
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const say = (phase, message, extra = {}) => onStatus({ phase, message, ...extra });

  // Double-invocation / race guard.
  if (loginInFlight) return;

  // Demo build with no agent: explain inline, do not invoke a signer.
  if (!isAgentConfigured()) {
    say('unavailable', 'Login requires a self-hosted agent. See agent/README.md to bring up your Torii.', { error: true });
    return;
  }

  // No NIP-07 extension: keep the useful "install a signer" guidance, inline.
  if (!hasSigner()) {
    say('no-signer', 'No NIP-07 signer found. Install Plebeian Signer, then try again.', { error: true, signerMissing: true });
    return;
  }

  loginInFlight = true;
  try {
    // 1. Challenge
    say('challenge', 'Requesting challenge from your agent…');
    const chal = await requestChallenge();
    if (!chal.ok) {
      say('error', `Could not reach agent: ${chal.reason}`, { error: true });
      return;
    }
    const { challenge } = chal.data;

    // 2. Sign directly in the extension (bounded by a timeout).
    say('signing', 'Waiting for your signer to approve the login…');
    let signed;
    try {
      signed = await withTimeout(
        window.nostr.signEvent(buildLoginEvent(challenge, window.location.origin)),
        SIGNER_TIMEOUT_MS,
      );
    } catch (e) {
      const reason = e && e.message === 'timeout'
        ? 'Signer timed out. Approve the request in your extension, then try again.'
        : `Signer declined: ${e?.message || e}`;
      say('error', reason, { error: true });
      return;
    }
    if (!signed || typeof signed !== 'object') {
      say('error', 'Signer returned no signature. Try again.', { error: true });
      return;
    }

    // 3. Verify
    say('verifying', 'Verifying signature…');
    const verified = await verifyChallenge(signed);
    if (!verified.ok) {
      say('error', `Agent rejected the signature: ${verified.reason}`, { error: true });
      return;
    }

    // 4. Success → persist the non-secret session marker (so a fresh tab can
    // rehydrate the authenticated shell) then let the router navigate to the
    // dashboard. The pubkey is the third field of the HMAC token
    // (iat.exp.pubkey.oiat.sig) — display-only, never the secret key.
    const pubkey = (getStoredToken() || '').split('.')[2] || '';
    writeSessionMarker({ npub: pubkey, connected_at: Math.floor(Date.now() / 1000) });
    startSessionRefresh();
    say('done', 'Signed in.', { done: true });
    document.dispatchEvent(new CustomEvent('continuum:session-changed'));
  } finally {
    loginInFlight = false;
  }
}
