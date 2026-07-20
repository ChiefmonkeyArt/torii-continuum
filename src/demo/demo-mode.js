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
import { h, clear } from '../views/util.js';
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
 * Open the real login surface. Every mutating CTA inside a demo view routes
 * here instead of firing its handler — the mockup can be explored but never
 * writes anything. (Alias of goToLogin with the name the views read as intent.)
 */
export function openLoginModal() {
  navigate('/');
}

/**
 * Wrap a mutating view action so that, while browsing the demo, it opens the
 * login surface instead of firing. Outside demo mode the original action runs
 * unchanged. Returns an event handler the views attach uniformly (Save,
 * Publish, Top Up, Connect, Delete, …) so no demo CTA can reach the network or
 * the real store.
 * @param {{demo?: boolean}|boolean} opts the view opts bag (or a bare demo flag)
 * @param {(...args: any[]) => any} action the real handler
 */
export function demoIntercept(opts, action) {
  const demo = typeof opts === 'boolean' ? opts : isDemo(opts);
  return (...args) => {
    if (demo) { openLoginModal(); return; }
    return typeof action === 'function' ? action(...args) : undefined;
  };
}

/**
 * Keep a hash href inside the /demo subtree while the current view is a demo
 * screen, so hover URLs, right-click "open in new tab" and ⌘-click all land on
 * the mockup rather than a guarded route (which would bounce to login). Reads
 * the LIVE location hash — unlike demoPath(opts, …) which is driven by the
 * render opts — so it can be composed at anchor-construction time (Item 3).
 *   • not on a demo screen                → href unchanged;
 *   • non-hash / external href            → unchanged;
 *   • root '#/' (the login CTA)           → unchanged;
 *   • already '#/demo…'                   → unchanged;
 *   • otherwise '#/x' → '#/demo/x'.
 * @param {string} href e.g. '#/projects'
 */
export function demoAware(href) {
  if (typeof href !== 'string') return href;
  const hash = (typeof document !== 'undefined' && document.location && document.location.hash) || '';
  if (!hash.startsWith('#/demo')) return href;
  if (!href.startsWith('#/')) return href;
  if (href === '#/') return href;
  if (href.startsWith('#/demo')) return href;
  return '#/demo' + href.slice(1);
}

/**
 * A minimal demo view stub: the persistent banner plus one obviously-fake card
 * with a sign-in CTA. Registered for demo routes that have no bespoke mockup
 * view yet (e.g. /demo/settings, /demo/health) so the whole /demo/* subtree is
 * navigable without a single guarded bounce or network call.
 * @param {HTMLElement} mount
 * @param {{demo?: boolean}} opts
 * @param {{title?: string, blurb?: string}} [meta]
 */
export function renderDemoStub(mount, opts, meta = {}) {
  clear(mount);
  if (isDemo(opts)) mount.appendChild(demoBanner());
  const title = meta.title || 'Demo';
  mount.appendChild(h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: title }),
      h('div', { class: 'page-sub', text: meta.blurb || 'A preview of this screen with sample data.' }),
    ]),
  ]));
  mount.appendChild(h('div', { class: 'card' }, [
    h('h3', { text: `${title} · sample` }),
    h('p', { class: 'muted', text: 'This is fake demo content. Sign in to see your real data.' }),
    h('button', { class: 'primary linkish', type: 'button', onClick: openLoginModal }, ['Sign in for real data']),
  ]));
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
