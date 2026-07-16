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
import { route, startRouter, currentRoute, navigate } from './router.js';
import { mountChat } from './chat.js';
import { adoptOnboardingSession } from './data/agent.js';
import { isSessionLive } from './auth.js';
import { rootTarget, guardRedirect, isProtectedPattern } from './nav-guard.js';

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
  // Adopt a handed-off onboarding session (localStorage['torii.session']) before
  // anything renders, so a freshly onboarded operator lands authenticated on
  // #/dashboard instead of being bounced to a login/marketing screen.
  adoptOnboardingSession();
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

  // React to session changes so the shell and route stay honest.
  document.addEventListener('continuum:session-changed', () => {
    renderSidebar();
    const cr = currentRoute();
    if (!cr) return;
    const authed = isSessionLive();
    if (cr.pattern === '/') {
      // Just logged in at the login page → go to the app; else re-render login.
      if (authed) navigate('/dashboard');
      else renderLogin(mainContent());
    } else if (isProtectedPattern(cr.pattern) && !authed) {
      // Session dropped (e.g. expired / signed out) while on a protected view.
      navigate('/');
    }
  });

  // Prevent double-tap zoom on the chat button on iOS
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
