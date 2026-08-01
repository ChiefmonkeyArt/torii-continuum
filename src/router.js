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
 * Render the route for `path`, or — when no path is given — for whatever the
 * current hash names.
 * @param {{force?: boolean, path?: string|null}} [opts]
 *   force — resolve even when this hash is already the rendered one. Every
 *   deliberate resolve (boot, navigate, auth revalidation) forces; only the
 *   `hashchange` listener does not, because that event is the trailing echo of
 *   a URL write navigate() has already rendered.
 *   path — the destination navigate() was ASKED for (CONT-NAVSYNC-2). Rendering
 *   from the argument instead of re-reading `window.location.hash` is what makes
 *   the transition independent of whether the browser has published the URL
 *   write yet; see navigate().
 */
function resolve({ force = false, path: navPath = null } = {}) {
  const hash = navPath != null ? '#' + navPath : (window.location.hash || '#/');
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
  // Fallback to landing. Render it here too rather than leaving it to the
  // hashchange the URL write only schedules — an unmatched hash must not be
  // able to strand the operator on the previous screen.
  renderedHash = null;
  writeLocation('#/', false);
  if (hash !== '#/') resolve({ force: true, path: '/' });
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
  if (window.location.hash !== target) writeLocation(target, opts.replace);
  // Render in the SAME turn as the URL write (CONT-NAVSYNC-1), and render the
  // path we were ASKED for rather than reading the URL back (CONT-NAVSYNC-2).
  //
  // v0.2.98 moved the render here but still let `resolve()` re-read
  // `window.location.hash` to decide WHAT to render — a value the app has just
  // written but does not own. A `location.replace()` fragment navigation is put
  // through the session-history traversal queue, so the read-back is not
  // guaranteed to reflect the write in the same turn, and the write itself can
  // be refused outright. When the read came back stale the router rendered the
  // route for the OLD hash — the login card the operator had just signed in
  // from — and the trailing `hashchange` that would have corrected it is the
  // very event these browsers coalesce, defer or withhold. That is the
  // "signed in, still on the login page, fixed by Ctrl+R" report.
  //
  // Passing the path makes the destination an argument instead of an
  // observation, so the transition no longer depends on the URL write being
  // visible, synchronous, permitted, or announced.
  resolve({ force: true, path });
}

/**
 * Write the address bar, best effort. The URL is BOOKKEEPING, not the trigger:
 * navigate() renders from the path it was given, so a write that is deferred,
 * refused or throws must degrade to a stale address bar and nothing worse. It
 * used to run before the render with nothing catching it, which made a blocked
 * `location.replace()` swallow the whole transition.
 * @param {string} target the hash to write, including '#'
 * @param {boolean} [replace] replace the history entry instead of pushing
 */
function writeLocation(target, replace) {
  if (replace && typeof window.location.replace === 'function') {
    try {
      const { pathname, search } = window.location;
      window.location.replace(`${pathname || ''}${search || ''}${target}`);
      return;
    } catch (_e) {
      // Fall through: a pushed entry is a far smaller problem than a screen
      // that never changes.
    }
  }
  try { window.location.hash = target.slice(1); } catch (_e) {}
}

// Re-resolve the current hash against the route table. Exposed so auth
// revalidation (popstate / bfcache pageshow) can force the guard to run and the
// view to re-render even when the hash itself did not change.
export function resolveCurrent() { resolve({ force: true }); }

export function startRouter() {
  window.addEventListener('hashchange', () => resolve());
  resolve({ force: true });
}
