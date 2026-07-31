/**
 * Tiny hash-based router. Keeps routes portable across
 * static hosts (no SPA fallback needed).
 *
 * Route grammar:
 *   #/projects
 *   #/projects/:slug
 *   #/marketplace
 *   #/routstr
 *   #/dashboard
 */

const routes = [];
let currentHandler = null;
let onRouteError = null;

// The hash whose view is currently on screen. Set by every resolve that
// actually ran a handler, and consulted by the `hashchange` listener so the
// event that trails a navigate() we already rendered is a no-op instead of a
// second, redundant rebuild of the same view.
let renderedHash = null;

// Ceiling on a synchronous guard-redirect chain (CONT-NAVSYNC-1). navigate()
// now resolves in the same turn, so a pair of guards that disagreed would
// recurse instead of ping-ponging through the event loop. The real chains are
// one hop and terminal (nav-guard proves it); this only stops a future
// mis-wiring from becoming a stack overflow.
const MAX_REDIRECT_DEPTH = 10;
let redirectDepth = 0;

export function route(pattern, handler) {
  routes.push({ pattern, keys: keysOf(pattern), handler });
}

/**
 * Register the fail-closed sink for a view that throws (CONT-AUTHUI-1).
 *
 * Without this, an exception from a handler escaped resolve() — and because the
 * FIRST resolve happens inside startRouter() during boot, it aborted the rest of
 * boot: the pane had already been cleared by the view, so the operator was left
 * with an empty region beside a working menu and none of the listeners that are
 * registered after routing. Containing it here keeps one broken screen from
 * taking down the whole shell.
 * @param {((err: unknown, pattern: string) => void)|null} fn
 */
export function setRouteErrorHandler(fn) {
  onRouteError = typeof fn === 'function' ? fn : null;
}

function keysOf(pattern) {
  return (pattern.match(/:[a-zA-Z]+/g) || []).map((s) => s.slice(1));
}

function toRegex(pattern) {
  const p = pattern.replace(/:[a-zA-Z]+/g, '([^/]+)').replace(/\//g, '\\/');
  return new RegExp('^' + p + '$');
}

/**
 * Render whatever the current hash names.
 * @param {{force?: boolean}} [opts]
 *   force — resolve even when this hash is already the rendered one. Every
 *   deliberate resolve (boot, navigate, auth revalidation) forces; only the
 *   `hashchange` listener does not, because that event is the trailing echo of
 *   a URL write navigate() has already rendered.
 */
function resolve({ force = false } = {}) {
  const hash = window.location.hash || '#/';
  if (!force && hash === renderedHash) return;
  const path = hash.slice(1);
  for (const r of routes) {
    const m = path.match(toRegex(r.pattern));
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      currentHandler = { pattern: r.pattern, params };
      renderedHash = hash;
      redirectDepth += 1;
      try {
        if (redirectDepth > MAX_REDIRECT_DEPTH) {
          throw new Error(`redirect loop at ${r.pattern}`);
        }
        r.handler(params);
      } catch (err) {
        if (onRouteError) onRouteError(err, r.pattern);
        else throw err;
      } finally {
        redirectDepth -= 1;
      }
      return;
    }
  }
  // Fallback to landing
  renderedHash = null;
  window.location.hash = '#/';
}

export function currentRoute() { return currentHandler; }

/**
 * Navigate to a hash path.
 * @param {string} path e.g. '/dashboard'
 * @param {object} [opts]
 * @param {boolean} [opts.replace] replace the current history entry instead of
 *   pushing a new one. Used on sign-out so the authenticated entry we are
 *   leaving cannot be returned to with the Back button, and by the auth
 *   revalidation on history/bfcache restores so a bounced protected hash does
 *   not linger in history.
 */
export function navigate(path, opts = {}) {
  const target = '#' + path;
  if (window.location.hash !== target) {
    if (opts.replace && typeof window.location.replace === 'function') {
      const { pathname, search } = window.location;
      window.location.replace(`${pathname || ''}${search || ''}${target}`);
    } else {
      window.location.hash = path;
    }
  }
  // Render in the SAME turn as the URL write (CONT-NAVSYNC-1). Writing the hash
  // only *schedules* a `hashchange`, and the render used to be that event's job
  // alone — so between a completed sign-in and the browser delivering the event
  // the address bar said /dashboard while the login card was still the only
  // thing on screen. Any browser that coalesces, defers or (for a
  // location.replace() fragment navigation) withholds that event left the
  // operator there permanently, with a perfectly good session in storage that
  // only a reload would surface. Resolving here makes the transition part of
  // the navigation instead of a hope about the event loop; the trailing
  // hashchange then dedupes against renderedHash.
  resolve({ force: true });
}

// Re-resolve the current hash against the route table. Exposed so auth
// revalidation (popstate / bfcache pageshow) can force the guard to run and the
// view to re-render even when the hash itself did not change.
export function resolveCurrent() { resolve({ force: true }); }

export function startRouter() {
  window.addEventListener('hashchange', () => resolve());
  resolve({ force: true });
}
