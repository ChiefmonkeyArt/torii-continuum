/**
 * Route-guard decisions for the application-first shell.
 *
 * Continuum's root (`/continuum/`) is the application, never a marketing page:
 *   • an authenticated operator lands directly on the dashboard;
 *   • everyone else sees the branded login page rendered in place at root;
 *   • every other screen — including the sales/marketing `/about` surface and
 *     the former "demo" routes (/projects, /marketplace, /routstr, /team) — is
 *     gated behind a live session.
 *
 * The contract is DEFAULT-DENY: the login page (root) is the ONLY public
 * surface. Any other pattern requires `isSessionLive()`; a logged-out visitor
 * asking for one is bounced to the login page instead of rendering the screen.
 * New app routes are therefore protected automatically — no per-view opt-in and
 * no allowlist to keep in sync.
 *
 * These helpers are pure (no DOM, no storage) so the redirect contract is
 * unit-tested directly. The router/main wiring calls them on every resolve —
 * including the initial resolve, which is what a browser refresh or a deep link
 * to `#/dashboard` triggers — so refresh/deep-link behaviour is guarded too.
 */

// The only public route: the login page, rendered in place at root. Everything
// not listed here is protected (default-deny).
export const PUBLIC_PATTERNS = Object.freeze(['/']);

// The root path. When unauthenticated this renders the login page in place;
// when authenticated it redirects to the dashboard.
export const ROOT_PATH = '/';
export const LOGIN_PATH = '/'; // login is rendered at root, no separate hash
export const DASHBOARD_PATH = '/dashboard';

export function isPublicPattern(pattern) {
  return PUBLIC_PATTERNS.includes(pattern);
}

// Default-deny: any pattern that is not explicitly public is protected.
export function isProtectedPattern(pattern) {
  return !isPublicPattern(pattern);
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
 * target is the login page (root). Because root is public and renders login in
 * place (it does not itself bounce anywhere when unauthenticated), there is no
 * redirect loop: protected→root→login is terminal.
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

/**
 * Revalidation decision for a HISTORY navigation or a back-forward-cache
 * restore (popstate / pageshow.persisted), where the normal hashchange→resolve
 * guard may not run. Given the pattern currently displayed and the FRESHLY
 * re-checked auth state, return a path to force-navigate to, or null when the
 * current view already matches the auth state.
 *
 * This is the belt-and-braces that makes sign-out a hard boundary: pressing
 * Back to a protected hash after logout — or the browser restoring a cached
 * authenticated DOM from bfcache — is bounced to the login page before the
 * protected content is usable. Pure (no DOM/storage) so the contract is
 * unit-tested directly.
 *   • protected pattern while logged out → LOGIN_PATH (bounce);
 *   • root while authed                  → DASHBOARD_PATH (never sit on login);
 *   • otherwise                          → null (already correct).
 * @param {string} pattern the route pattern currently displayed
 * @param {boolean} isAuthed the freshly revalidated auth state
 * @returns {string|null}
 */
export function restoreTarget(pattern, isAuthed) {
  const bounce = guardRedirect(pattern, isAuthed);
  if (bounce) return bounce;
  if (pattern === ROOT_PATH && isAuthed) return DASHBOARD_PATH;
  return null;
}
