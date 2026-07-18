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
import { route, startRouter, navigate } from './router.js';
import { mountChat } from './chat.js';
import { isSessionLive } from './auth.js';
import { rootTarget, guardRedirect, sessionChangeTarget } from './nav-guard.js';

import { renderAbout } from './views/landing.js';
import { renderLogin } from './views/login.js';
import { renderProjects } from './views/projects.js';
import { renderProjectHome } from './views/projectHome.js';
import { renderBoard } from './views/board.js';
import { renderMarketplace } from './views/marketplace.js';
import { renderRoutstr } from './views/routstr.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTeam } from './views/team.js';

function setLandingMode(on) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('landing-mode', !!on);
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
    const target = rootTarget(isSessionLive());
    if (target) { navigate(target); return; }
    setLandingMode(true); renderLogin(mainContent());
  });
  // Sales/marketing content, isolated. Never the root, never onboarding done.
  route('/about', () => { setLandingMode(true); renderAbout(mainContent()); });
  route('/projects', () => { setLandingMode(false); renderProjects(mainContent()); renderSidebar(); });
  route('/projects/:slug', ({ slug }) => { setLandingMode(false); renderProjectHome(mainContent(), slug); renderSidebar(); });
  route('/projects/:slug/board', ({ slug }) => { setLandingMode(false); renderBoard(mainContent(), slug); renderSidebar(); });
  route('/marketplace', () => { setLandingMode(false); renderMarketplace(mainContent()); renderSidebar(); });
  route('/routstr', () => { setLandingMode(false); renderRoutstr(mainContent()); renderSidebar(); });
  route('/team', () => { setLandingMode(false); renderTeam(mainContent()); renderSidebar(); });
  // Protected: a logged-out visitor (incl. a refresh/deep-link) is bounced to
  // the login page at root. rootTarget keeps that terminal (no loop).
  route('/dashboard', () => {
    const redirect = guardRedirect('/dashboard', isSessionLive());
    if (redirect) { navigate(redirect); return; }
    setLandingMode(false); renderDashboard(mainContent()); renderSidebar();
  });

  startRouter();
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
    navigate(sessionChangeTarget(isSessionLive()));
  });

  // Prevent double-tap zoom on the chat button on iOS
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
