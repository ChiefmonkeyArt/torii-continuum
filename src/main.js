/**
 * Continuum — app entry.
 * Boots store → mounts shell → registers routes → starts router → mounts chat.
 *
 * Application-first routing: the root ('/') is the app, never the sales page.
 *   • logged out  → branded login page rendered in place at root;
 *   • logged in   → redirect straight to #/dashboard.
 * The sales/marketing surface is isolated behind the explicit '#/about' route.
 * Login and About render full-bleed inside `landing-mode` (sidebar + chat dock
 * hidden). Every other route restores the standard shell. Protected views
 * (see nav-guard) bounce logged-out visitors to the login page without loops.
 */
import { initStore } from './data/store.js';
import { mountShell, mainContent, renderSidebar, applyStoredTheme } from './shell.js';
import { route, startRouter, navigate, currentRoute, resolveCurrent, setRouteErrorHandler } from './router.js';
import { mountChat } from './chat.js';
import { isSessionLive, endSession, isSignoutBroadcast, rehydrateSession, SIGNOUT_SENTINEL_KEY } from './auth.js';
import { rootTarget, guardRedirect, sessionChangeTarget, restoreTarget, demoRedirect, ROOT_PATH } from './nav-guard.js';
import { demoStore } from './demo/demo-fixtures.js';
import { renderDemoStub } from './demo/demo-mode.js';

import { renderAbout } from './views/landing.js';
import { renderLogin } from './views/login.js';
import { renderProjects } from './views/projects.js';
import { renderProjectHome } from './views/projectHome.js';
import { renderBoard } from './views/board.js';
import { renderMarketplace } from './views/marketplace.js';
import { renderRoutstr } from './views/routstr.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTeam } from './views/team.js';
import { renderGenesis } from './views/genesis.js';
import { renderMemory } from './views/memory.js';

function setLandingMode(on) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('landing-mode', !!on);
}

// Central auth gate. Wraps a route handler so that a logged-out visitor asking
// for a protected pattern is bounced to the login page BEFORE the protected
// view renders — the guarded handler returns without ever calling the wrapped
// renderer, so the protected screen is not shown even for a frame. Auth rules
// live in nav-guard (default-deny: only '/' is public); this is the single
// wiring point that enforces them across every app route.
function guarded(pattern, handler) {
  return (params) => {
    // Rehydrate from persistent storage BEFORE the guard decision so a fresh
    // tab (or bfcache restore) is authoritative from the token/marker rather
    // than any stale in-tab state — this is what stops the second-tab blank
    // right-hand region. rehydrateSession also drops a marker with no live
    // token so the guard never trusts an expired session.
    const { live } = rehydrateSession();
    const redirect = guardRedirect(pattern, live);
    // Replace, not push: a logged-out visitor who reached a protected hash (a
    // deep link, or Back onto a stale authenticated entry) is bounced to login
    // WITHOUT leaving that protected hash sitting in history to return to.
    if (redirect) { navigate(redirect, { replace: true }); return; }
    handler(params);
  };
}

// Demo surface wiring. The /demo/* routes are PUBLIC (nav-guard PUBLIC_PATTERNS)
// so a signed-out visitor can browse the read-only mockup. But a signed-in
// operator has real data — landing on a demo route sends them to the real
// equivalent instead (demoRedirect strips the /demo prefix). The handler renders
// the SAME view as the real route, passing { demo: true, fixtures: demoStore }
// so the view swaps its data source and gates every mutation to login WITHOUT
// forking the view. Bare (unguarded) registration is intentional and enforced
// as allowed by the nav-guard source-structure test.
function demoRoute(pattern, render) {
  return (params) => {
    const redirect = demoRedirect(pattern, isSessionLive());
    if (redirect) { navigate(redirect, { replace: true }); return; }
    render(params);
  };
}

// Revalidate auth for whatever route is currently displayed and force a
// correction when it no longer matches the (freshly re-checked) session. This
// runs on history navigations (popstate) and back-forward-cache restores
// (pageshow.persisted) — the paths where hashchange→resolve may not fire, so
// without this a logged-out Back or a restored cached DOM could reveal the
// dashboard. isSessionLive() is re-read here (not captured) so a session that
// ended while the page was cached is honoured. When the view already matches
// (restoreTarget → null) we still re-resolve so a bfcache-restored DOM is
// re-rendered from the live auth state rather than shown stale.
function enforceRouteAuth() {
  const cr = currentRoute();
  const pattern = cr ? cr.pattern : '/';
  const target = restoreTarget(pattern, isSessionLive());
  if (target) { navigate(target, { replace: true }); return; }
  resolveCurrent();
}

function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  applyStoredTheme();
  // Boot never establishes a session implicitly. The index is gated solely by a
  // valid stored SPA session token (continuum.session.v1); with none, the login
  // modal is shown even when a NIP-07 signer is present. Signing in is always an
  // explicit user action (the sign-in control runs the NIP-07 challenge flow).
  initStore();
  mountShell(root);

  // Routes
  // Root is application-first: authed → dashboard, else render login in place.
  route('/', () => {
    // Same authority as every guarded route (CONT-SESSION-1). Root used to ask
    // isSessionLive() directly while guarded routes went through
    // rehydrateSession(); rendering the public login screen from a weaker read
    // than the guards use is how the screen and the next refresh came to
    // disagree. rehydrateSession also drops a marker left behind by an expired
    // token, so login never renders beside a stale "signed in as" artifact.
    const { live } = rehydrateSession();
    const target = rootTarget(live);
    if (target) { navigate(target, { replace: true }); return; }
    setLandingMode(true); renderLogin(mainContent());
  });
  // Every non-root route is protected (default-deny in nav-guard): a logged-out
  // visitor — including a refresh or a deep link — is bounced to the login page
  // at root before the view renders. rootTarget keeps that terminal (no loop).
  // Sales/marketing content (`/about`) is isolated and gated like the rest.
  route('/about', guarded('/about', () => { setLandingMode(true); renderAbout(mainContent()); }));
  route('/projects', guarded('/projects', () => { setLandingMode(false); renderProjects(mainContent()); renderSidebar(); }));
  route('/projects/:slug', guarded('/projects/:slug', ({ slug }) => { setLandingMode(false); renderProjectHome(mainContent(), slug); renderSidebar(); }));
  route('/projects/:slug/board', guarded('/projects/:slug/board', ({ slug }) => { setLandingMode(false); renderBoard(mainContent(), slug); renderSidebar(); }));
  route('/marketplace', guarded('/marketplace', () => { setLandingMode(false); renderMarketplace(mainContent()); renderSidebar(); }));
  route('/routstr', guarded('/routstr', () => { setLandingMode(false); renderRoutstr(mainContent()); renderSidebar(); }));
  route('/team', guarded('/team', () => { setLandingMode(false); renderTeam(mainContent()); renderSidebar(); }));
  route('/genesis', guarded('/genesis', () => { setLandingMode(false); renderGenesis(mainContent()); renderSidebar(); }));
  route('/memory', guarded('/memory', () => { setLandingMode(false); renderMemory(mainContent()); renderSidebar(); }));
  route('/dashboard', guarded('/dashboard', () => { setLandingMode(false); renderDashboard(mainContent()); renderSidebar(); }));

  // Public demo surface (/demo/*). Read-only mockup rendered from obviously-fake
  // fixtures; no agent calls, every CTA routes to login. A signed-in operator is
  // redirected to the real screen by demoRoute(). Views take { demo, fixtures }.
  const demoOpts = { demo: true, fixtures: demoStore };
  route('/demo', demoRoute('/demo', () => { setLandingMode(false); renderDashboard(mainContent(), demoOpts); renderSidebar(); }));
  route('/demo/dashboard', demoRoute('/demo/dashboard', () => { setLandingMode(false); renderDashboard(mainContent(), demoOpts); renderSidebar(); }));
  route('/demo/projects', demoRoute('/demo/projects', () => { setLandingMode(false); renderProjects(mainContent(), demoOpts); renderSidebar(); }));
  route('/demo/projects/:slug', demoRoute('/demo/projects/:slug', ({ slug }) => { setLandingMode(false); renderProjectHome(mainContent(), slug, demoOpts); renderSidebar(); }));
  route('/demo/marketplace', demoRoute('/demo/marketplace', () => { setLandingMode(false); renderMarketplace(mainContent(), demoOpts); renderSidebar(); }));
  route('/demo/routstr', demoRoute('/demo/routstr', () => { setLandingMode(false); renderRoutstr(mainContent(), demoOpts); renderSidebar(); }));
  route('/demo/team', demoRoute('/demo/team', () => { setLandingMode(false); renderTeam(mainContent(), demoOpts); renderSidebar(); }));
  // Demo equivalents for every remaining sidebar/real route. These have no
  // bespoke mockup view, so they render the shared demo stub (banner + one fake
  // card): the whole /demo/* subtree is navigable with zero guarded bounces and
  // zero network. genesis/memory mirror real routes; settings/health are
  // demo-only preview screens per the v0.2.86 brief.
  route('/demo/genesis',  demoRoute('/demo/genesis',  () => { setLandingMode(false); renderDemoStub(mainContent(), demoOpts, { title: 'Genesis' }); renderSidebar(); }));
  route('/demo/memory',   demoRoute('/demo/memory',   () => { setLandingMode(false); renderDemoStub(mainContent(), demoOpts, { title: 'Memory' }); renderSidebar(); }));
  route('/demo/settings', demoRoute('/demo/settings', () => { setLandingMode(false); renderDemoStub(mainContent(), demoOpts, { title: 'Settings' }); renderSidebar(); }));
  route('/demo/health',   demoRoute('/demo/health',   () => { setLandingMode(false); renderDemoStub(mainContent(), demoOpts, { title: 'Health' }); renderSidebar(); }));

  // ORDER IS LOAD-BEARING (CONT-AUTHUI-1). Everything below must be wired
  // BEFORE startRouter(), because startRouter() performs the first resolve
  // synchronously and that resolve renders a view.
  //
  //   • mountChat first: every authenticated view calls setChatContext(), which
  //     writes into the dock's elements. With the dock mounted after the first
  //     resolve, a hard refresh onto any authenticated route threw inside the
  //     router — clearing the main pane and then abandoning the rest of boot,
  //     which is what produced a blank content panel beside a live menu.
  //   • listeners second: they used to be registered after startRouter(), so a
  //     first resolve that threw took the session-changed / popstate / pageshow /
  //     storage handlers down with it. The page then looked signed-in but could
  //     never redirect on sign-in, exit on sign-out, guard Back, or honour
  //     another tab's logout — for the rest of its life.
  mountChat(root);

  // React to session changes so the shell and route stay honest. A mid-session
  // auth change (post-verify sign-in, or sign-out / expiry) must force a route
  // transition from ANY current surface — not only the login page or a
  // protected view. Previously demo routes (/projects, /marketplace, /routstr,
  // /team) reached via the sidebar sign-in/out control fell through this handler
  // and left the SPA stranded: sign-in never completed, sign-out never exited.
  // sessionChangeTarget() returns a concrete path (dashboard when authed, root/
  // login otherwise); navigate() re-resolves even when the hash is unchanged, so
  // the view always transitions to match the new auth state.
  document.addEventListener('continuum:session-changed', () => {
    renderSidebar();
    const authed = isSessionLive();
    // REPLACE in BOTH directions. Sign-out has always replaced, so the
    // authenticated surface being left is not retained for Back to restore.
    // Sign-in now replaces too: pushing left the login surface sitting in
    // history, so Back landed on a stale login screen — which then bounced
    // forward again via rootTarget, trapping the operator between two entries.
    // The entry being replaced is the one the operator just finished with, in
    // both directions, so neither is worth keeping.
    navigate(sessionChangeTarget(authed), { replace: true });
  });

  // Sign-out must remain a hard boundary across BROWSER history + bfcache, not
  // just in-app navigation. popstate covers Back/Forward; pageshow with
  // event.persisted covers a back-forward-cache restore that re-shows the
  // in-memory DOM without re-running boot or the router guard. Both revalidate
  // the live session and bounce a logged-out visitor off any protected view.
  window.addEventListener('popstate', enforceRouteAuth);
  window.addEventListener('pageshow', (e) => { if (e && e.persisted) enforceRouteAuth(); });

  // Multi-tab sign-out: when Sign Out fires in another tab it writes the
  // sign-out sentinel to localStorage, which fires a `storage` event HERE (the
  // event never fires in the writing tab). React by ending THIS tab's session
  // localOnly (so we don't re-broadcast and loop) and bouncing to login. The
  // localOnly endSession also dispatches continuum:session-changed, but the
  // explicit replace-navigate guarantees the bounce even if that handler order
  // ever changes.
  let lastSignoutTs = 0;
  window.addEventListener('storage', (e) => {
    if (!isSignoutBroadcast(e)) return;
    // Deduplicate by the sentinel's timestamp so a burst of storage events (or
    // the synthetic same-tab fallback landing alongside the native one) does not
    // re-run the sign-out repeatedly. A marker-cleared event carries no value;
    // treat it as a fresh signal only once per tick.
    const ts = e && e.key === SIGNOUT_SENTINEL_KEY ? Number(e.newValue) || 0 : Date.now();
    if (ts && ts === lastSignoutTs) return;
    lastSignoutTs = ts;
    endSession({ localOnly: true });
    navigate('/', { replace: true });
  });

  // Prevent double-tap zoom on the chat button on iOS
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });

  // A view that throws must not be able to leave the operator staring at an
  // empty pane. The router hands us the failure instead of letting it escape
  // (which previously aborted boot); we fail closed to a visible, actionable
  // panel and never leave main-content empty.
  setRouteErrorHandler(renderRouteError);

  // LAST. The first resolve renders a view, so every dependency a view can
  // reach — the chat dock, the session listeners, the error handler — is
  // already in place by the time this runs.
  startRouter();
}

// Fail-closed surface for a route handler that threw. Shows what happened
// without leaking internals, offers a reload, and — when the session is not
// live — a way back to the public home rather than a dead authenticated shell.
function renderRouteError(err, pattern) {
  const mount = mainContent();
  if (!mount) return;
  const authed = isSessionLive();
  mount.innerHTML = '';
  const box = document.createElement('section');
  box.className = 'route-error card';
  box.setAttribute('role', 'alert');

  const title = document.createElement('h2');
  title.textContent = 'This screen failed to load';
  const body = document.createElement('p');
  body.className = 'muted';
  body.textContent = authed
    ? 'Your session is still valid. Reloading usually clears this.'
    : 'You are signed out. Sign in again to continue.';
  const detail = document.createElement('p');
  detail.className = 'route-error-detail muted';
  detail.textContent = `Route ${pattern || 'unknown'}`;

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const reload = document.createElement('button');
  reload.className = 'primary';
  reload.type = 'button';
  reload.setAttribute('data-route-error-reload', '');
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => { window.location.reload(); });
  actions.appendChild(reload);
  if (!authed) {
    const home = document.createElement('button');
    home.type = 'button';
    home.setAttribute('data-route-error-home', '');
    home.textContent = 'Go to sign in';
    home.addEventListener('click', () => { navigate(ROOT_PATH, { replace: true }); });
    actions.appendChild(home);
  }

  box.append(title, body, detail, actions);
  mount.appendChild(box);
  setLandingMode(false);
  try { console.error('[continuum] route render failed', pattern, err); } catch (_e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
