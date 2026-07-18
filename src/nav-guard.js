/**
 * Route-guard decisions for the application-first shell.
 *
 * Continuum's root (`/continuum/`) is the application, never a marketing page:
 *   • an authenticated operator lands directly on the dashboard;
 *   • everyone else sees the branded login page rendered in place at root;
 *   • the sales/marketing surface is isolated behind an explicit `/about` route.
 *
 * These helpers are pure (no DOM, no storage) so the redirect contract is
 * unit-tested directly. The router/main wiring calls them on every resolve —
 * including the initial resolve, which is what a browser refresh or a deep link
 * to `#/dashboard` triggers — so refresh/deep-link behaviour is guarded too.
 */

// Views that require a live session. A logged-out visitor asking for one of
// these is sent to the login page (root) instead of the view.
export const PROTECTED_PATTERNS = Object.freeze(['/dashboard']);

// The root path. When unauthenticated this renders the login page in place;
// when authenticated it redirects to the dashboard.
export const ROOT_PATH = '/';
export const LOGIN_PATH = '/'; // login is rendered at root, no separate hash
export const DASHBOARD_PATH = '/dashboard';

export function isProtectedPattern(pattern) {
  return PROTECTED_PATTERNS.includes(pattern);
}

/**
 * What should the root (`/`) do given the session state?
 * @param {boolean} isAuthed
 * @returns {string|null} a path to redirect to, or null to render login in place
 */
export function rootTarget(isAuthed) {
  return isAuthed ? DASHBOARD_PATH : null;
}

/**
 * For an arbitrary requested pattern, return a redirect path when the guard
 * must bounce the visitor, or null when the requested view may render as-is.
 *
 * Only protected patterns bounce, and only when unauthenticated; the bounce
 * target is the login page (root). Because root renders login in place (it
 * does not itself bounce anywhere when unauthenticated), there is no redirect
 * loop: protected→root→login is terminal.
 * @param {string} pattern route pattern being resolved (e.g. '/dashboard')
 * @param {boolean} isAuthed
 * @returns {string|null}
 */
export function guardRedirect(pattern, isAuthed) {
  if (isProtectedPattern(pattern) && !isAuthed) return LOGIN_PATH;
  return null;
}

/**
 * Where must the SPA route to when the auth state changes MID-SESSION — i.e.
 * after a successful NIP-07 verify (sign-in) or after a sign-out / expiry? This
 * fires from ANY current route, not just the login page or a protected view:
 *   • authed  → the dashboard (leave whatever surface triggered sign-in);
 *   • else    → root, which renders the login surface in place.
 * A concrete path is always returned (never null) so the caller can force a
 * router re-resolve and the view transitions even when the hash is unchanged —
 * this is the invariant that makes sign-in complete and sign-out exit from
 * every screen, including the demo routes (/projects, /marketplace, …).
 * @param {boolean} isAuthed the auth state AFTER the change
 * @returns {string} DASHBOARD_PATH when authed, else ROOT_PATH
 */
export function sessionChangeTarget(isAuthed) {
  return isAuthed ? DASHBOARD_PATH : ROOT_PATH;
}
