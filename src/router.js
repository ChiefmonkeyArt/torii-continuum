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

function resolve() {
  const hash = window.location.hash || '#/';
  const path = hash.slice(1);
  for (const r of routes) {
    const m = path.match(toRegex(r.pattern));
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      currentHandler = { pattern: r.pattern, params };
      try {
        r.handler(params);
      } catch (err) {
        if (onRouteError) onRouteError(err, r.pattern);
        else throw err;
      }
      return;
    }
  }
  // Fallback to landing
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
  if (window.location.hash === target) {
    resolve();
  } else if (opts.replace && typeof window.location.replace === 'function') {
    const { pathname, search } = window.location;
    window.location.replace(`${pathname || ''}${search || ''}${target}`);
  } else {
    window.location.hash = path;
  }
}

// Re-resolve the current hash against the route table. Exposed so auth
// revalidation (popstate / bfcache pageshow) can force the guard to run and the
// view to re-render even when the hash itself did not change.
export function resolveCurrent() { resolve(); }

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  resolve();
}
