/**
 * The session's explicit state machine (v0.2.92-alpha, CONT-AUTH-1).
 *
 * Before this, "are we logged in?" was a boolean derived on the spot from a
 * token's `exp`, and a session simply died mid-keystroke: the token passed the
 * check on one call and failed on the next, so the operator's first sign that
 * anything had happened was a bounce to the login page with their work still on
 * screen. There was no representation of "valid, but about to stop being
 * valid", which is the only window in which anything can be done about it.
 *
 * So the states are the token's real lifecycle, not the UI's convenience:
 *
 *   anonymous ──sign-in──▶ active ──clock──▶ expiring ──refresh──▶ refreshing
 *        ▲                   ▲                                        │
 *        │                   └────────────ok───────────────────────---┘
 *        └── signed-out ── expired ◀── fail / clock ─────────────------┘
 *
 * `expiring` is the whole point: it is still a fully authorised state (the
 * token works, the UI stays up) that additionally means "renew now". Only
 * `expired` and `anonymous` deny access, so a refresh that is in flight, or one
 * that failed while the token is still good, never logs anybody out early.
 *
 * Everything here is pure — no storage, no DOM, no timers, and time arrives as
 * an argument. The scheduling *math* lives here and is unit-tested directly;
 * only the `setTimeout` that acts on it lives in `src/auth.js`.
 */

/** Renew once the token has this little life left. */
export const REFRESH_WINDOW_SEC = 300; // 5 minutes

/**
 * Never schedule a wake-up further out than this, however long the token lives.
 * A tab left open for a day should not depend on one timer surviving a laptop
 * suspend to notice its session is nearly over.
 */
export const MAX_REFRESH_DELAY_MS = 15 * 60 * 1000; // 15 minutes

/** A failed refresh is retried no sooner than this while the token is alive. */
export const RETRY_BACKOFF_MS = 30 * 1000;

export const STATES = Object.freeze({
  ANONYMOUS: 'anonymous',
  ACTIVE: 'active',
  EXPIRING: 'expiring',
  REFRESHING: 'refreshing',
  EXPIRED: 'expired',
});

/** States in which the app is authorised to render protected surfaces. */
const AUTHORISED = Object.freeze([STATES.ACTIVE, STATES.EXPIRING, STATES.REFRESHING]);

/**
 * Does this state grant access? `refreshing` does, deliberately: the current
 * token has not expired yet, so tearing the shell down mid-renewal would log
 * the operator out to fix a problem they do not have.
 * @param {string} state
 */
export function isAuthorised(state) {
  return AUTHORISED.includes(state);
}

/**
 * Classify a token's expiry into a lifecycle state, ignoring any in-flight
 * refresh. This is the clock's opinion, which `reduce` then reconciles with
 * whatever the app is currently doing.
 * @param {number|null} expiresAtSec unix seconds, or null when there is no session
 * @param {number} nowSec unix seconds
 * @param {number} [windowSec]
 * @returns {'anonymous'|'active'|'expiring'|'expired'}
 */
export function classify(expiresAtSec, nowSec, windowSec = REFRESH_WINDOW_SEC) {
  if (!Number.isFinite(expiresAtSec) || expiresAtSec === null) return STATES.ANONYMOUS;
  if (!Number.isFinite(nowSec)) return STATES.ANONYMOUS;
  if (expiresAtSec <= nowSec) return STATES.EXPIRED;
  if (expiresAtSec - nowSec <= windowSec) return STATES.EXPIRING;
  return STATES.ACTIVE;
}

/**
 * The transition function. Events:
 *
 *   signed_in         a NIP-07 verify succeeded          → classify
 *   tick              the clock moved                    → classify, unless refreshing
 *   refresh_started   a renewal request went out
 *   refresh_ok        a renewal returned a fresh token   → classify
 *   refresh_failed    a renewal was refused              → see below
 *   signed_out        explicit sign-out or hard expiry   → anonymous
 *
 * A failed refresh is only fatal when the reason is fatal. `max_lifetime_reached`
 * is terminal by design — the agent will not renew this lineage again, so the
 * owner must re-sign. A transport blip, by contrast, leaves a still-valid token
 * in place, and the honest state for that is `expiring`: keep working, try
 * again shortly.
 *
 * @param {string} state current state
 * @param {{type: string, expiresAt?: number|null, now?: number, code?: string}} event
 * @param {number} [windowSec]
 * @returns {string} next state
 */
export function reduce(state, event, windowSec = REFRESH_WINDOW_SEC) {
  const type = event?.type;
  const at = (exp) => classify(exp ?? null, event?.now ?? 0, windowSec);

  switch (type) {
    case 'signed_out':
      return STATES.ANONYMOUS;

    case 'signed_in':
      return at(event.expiresAt);

    case 'tick':
      // A renewal in flight owns the state until it resolves — except that a
      // token which expires mid-flight really is expired, and pretending
      // otherwise would leave the shell showing protected data it can no
      // longer fetch.
      if (state === STATES.REFRESHING) {
        return at(event.expiresAt) === STATES.EXPIRED ? STATES.EXPIRED : STATES.REFRESHING;
      }
      return at(event.expiresAt);

    case 'refresh_started':
      // Only a live session can be renewed; starting from a dead one is a bug
      // in the caller, not a state to represent.
      return isAuthorised(state) ? STATES.REFRESHING : state;

    case 'refresh_ok':
      return at(event.expiresAt);

    case 'refresh_failed':
      if (event.code === 'max_lifetime_reached') return STATES.EXPIRED;
      return at(event.expiresAt);

    default:
      return state;
  }
}

/**
 * Should a refresh be attempted right now? True only in `expiring` — `active`
 * is too early (it would renew on a loop) and `refreshing` already is one.
 * @param {string} state
 */
export function shouldRefresh(state) {
  return state === STATES.EXPIRING;
}

/**
 * How long until the next check, in ms.
 *
 * Returns 0 when a refresh is already due, `null` when there is nothing to wait
 * for (no session, or one that is already gone). Otherwise it aims at the
 * moment the token enters its refresh window, clamped to MAX_REFRESH_DELAY_MS
 * so a long-lived token still gets periodic re-checks rather than one distant
 * timer that a suspended machine may never fire.
 *
 * @param {number|null} expiresAtSec unix seconds
 * @param {number} nowSec unix seconds
 * @param {number} [windowSec]
 * @returns {number|null} milliseconds, or null
 */
export function msUntilRefresh(expiresAtSec, nowSec, windowSec = REFRESH_WINDOW_SEC) {
  const state = classify(expiresAtSec, nowSec, windowSec);
  if (state === STATES.ANONYMOUS || state === STATES.EXPIRED) return null;
  if (state === STATES.EXPIRING) return 0;
  const untilWindowSec = expiresAtSec - windowSec - nowSec;
  return Math.min(Math.max(0, untilWindowSec) * 1000, MAX_REFRESH_DELAY_MS);
}
