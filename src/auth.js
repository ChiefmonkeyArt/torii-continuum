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
} from './data/agent.js';

const NIP42_KIND = 22242;
// Give the extension a bounded window to answer. A user who never approves (or a
// wedged extension) resolves as a clean timeout instead of hanging the button.
const SIGNER_TIMEOUT_MS = 90_000;

// Cross-tab sign-out broadcast. Writing this key fires a `storage` event in
// every OTHER tab of the same origin (never the writer), so a sign-out in one
// tab bounces them all to the login page. The value is a throwaway timestamp;
// only the write itself matters. Never holds a token or any secret.
export const SIGNOUT_SENTINEL_KEY = 'continuum.signout.v1';

/**
 * Is this `storage` event a cross-tab sign-out broadcast? True only for a write
 * (newValue set) to the sentinel key — a removeItem/clear (newValue null) is
 * ignored so clearing storage never spuriously signs a tab out. Pure + exported
 * so the listener contract is unit-tested without a real StorageEvent.
 * @param {{key?: string|null, newValue?: string|null}} event
 */
export function isSignoutBroadcast(event) {
  return !!event && event.key === SIGNOUT_SENTINEL_KEY && event.newValue != null;
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
  clearSession();
  if (!opts.localOnly) {
    try { localStorage.setItem(SIGNOUT_SENTINEL_KEY, String(Date.now())); } catch (_e) {}
  }
  document.dispatchEvent(new CustomEvent('continuum:session-changed'));
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

    // 4. Success → let the router navigate to the dashboard.
    say('done', 'Signed in.', { done: true });
    document.dispatchEvent(new CustomEvent('continuum:session-changed'));
  } finally {
    loginInFlight = false;
  }
}
