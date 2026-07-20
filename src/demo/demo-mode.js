/**
 * Demo-mode helpers (v0.2.85-alpha).
 *
 * A signed-out visitor can browse a read-only mockup of the app at /demo/*.
 * The demo-capable views take a single `opts` bag ({ demo, fixtures }) and
 * switch data source with `demoSource()` instead of forking the view. These
 * helpers keep the demo/real fork tiny and testable:
 *
 *   • isDemo(opts)          — is this a demo render?
 *   • demoSource(opts, store) — pick the fixtures facade or the real store;
 *   • demoBanner()          — the persistent "fake data" banner (with a
 *                             sign-in link that routes to the login page);
 *   • goToLogin()           — route every demo CTA to the real login surface;
 *   • demoPath(opts, path)  — keep in-app links inside the /demo subtree while
 *                             browsing the mockup.
 *
 * Nothing here touches the network or the real store. Demo views never call
 * agent.* — the mockup is a static, obviously-fake snapshot.
 */
import { h } from '../views/util.js';
import { navigate } from '../router.js';
import { demoStore } from './demo-fixtures.js';

/** Is this render a demo (mockup) render? */
export function isDemo(opts) {
  return !!(opts && opts.demo);
}

/**
 * Pick the data source for a view: the read-only demo fixtures facade in demo
 * mode, otherwise the real store module. Callers pass the real store (its
 * namespace import) so this stays free of a hard store dependency.
 * @param {{demo?: boolean, fixtures?: object}} opts
 * @param {object} realStore the real src/data/store.js namespace
 */
export function demoSource(opts, realStore) {
  if (!isDemo(opts)) return realStore;
  return opts.fixtures || demoStore;
}

/** Route to the real login surface (rendered in place at root). */
export function goToLogin() {
  navigate('/');
}

/**
 * Prefix an in-app path with `/demo` while browsing the mockup so internal
 * links (e.g. a project card → its home page) stay on the demo surface. Outside
 * demo mode the path is returned unchanged.
 * @param {{demo?: boolean}} opts
 * @param {string} path an app path beginning with '/'
 */
export function demoPath(opts, path) {
  return isDemo(opts) ? '/demo' + path : path;
}

/**
 * The persistent demo banner: an obviously-fake-data notice with a sign-in
 * affordance that routes to the real login page. Rendered at the top of every
 * demo view. Pure DOM (via h()); the sign-in control calls goToLogin().
 */
export function demoBanner() {
  const signIn = h('button', {
    class: 'demo-banner-link linkish',
    type: 'button',
    onClick: goToLogin,
  }, ['Sign in for real data.']);
  return h('div', { class: 'demo-banner', role: 'status' }, [
    h('span', { class: 'demo-banner-tag', text: 'DEMO MODE' }),
    h('span', { text: ' — fake data. ' }),
    signIn,
  ]);
}
