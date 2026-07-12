/**
 * Continuum — app entry.
 * Boots store → mounts shell → registers routes → starts router → mounts chat.
 *
 * Landing route ('/') renders full-bleed inside main, and toggles a
 * `landing-mode` class on #app to hide sidebar + chat dock. Every other
 * route restores the standard shell.
 */
import { initStore } from './data/store.js';
import { mountShell, mainContent, renderSidebar, applyStoredTheme } from './shell.js';
import { route, startRouter, currentRoute } from './router.js';
import { mountChat } from './chat.js';

import { renderLanding } from './views/landing.js';
import { renderProjects } from './views/projects.js';
import { renderProjectHome } from './views/projectHome.js';
import { renderMarketplace } from './views/marketplace.js';
import { renderRoutstr } from './views/routstr.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSetup } from './views/setup.js';

function setLandingMode(on) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('landing-mode', !!on);
}

function boot() {
  const root = document.getElementById('app');
  if (!root) return;

  applyStoredTheme();
  initStore();
  mountShell(root);

  // Routes
  route('/', () => { setLandingMode(true); renderLanding(mainContent()); });
  route('/setup', () => { setLandingMode(true); renderSetup(mainContent()); });
  route('/projects', () => { setLandingMode(false); renderProjects(mainContent()); renderSidebar(); });
  route('/projects/:slug', ({ slug }) => { setLandingMode(false); renderProjectHome(mainContent(), slug); renderSidebar(); });
  route('/marketplace', () => { setLandingMode(false); renderMarketplace(mainContent()); renderSidebar(); });
  route('/routstr', () => { setLandingMode(false); renderRoutstr(mainContent()); renderSidebar(); });
  route('/dashboard', () => { setLandingMode(false); renderDashboard(mainContent()); renderSidebar(); });

  startRouter();
  mountChat(root);

  // Check if agent is in setup mode — redirect to setup wizard
  checkSetupMode();

  // Re-render sidebar when session changes so the login/logout button stays honest
  document.addEventListener('continuum:session-changed', () => {
    renderSidebar();
    // If we're on landing, re-render it so its CTAs reflect the new state
    const cr = currentRoute();
    if (cr && cr.pattern === '/') renderLanding(mainContent());
  });

  // Prevent double-tap zoom on the chat button on iOS
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/**
 * Check if the agent is in first-run setup mode.
 * If so, redirect to the setup wizard.
 */
async function checkSetupMode() {
  try {
    // Import isAgentConfigured inline — same logic as agent.js
    let agentBase = '';
    if (window.__CONTINUUM_AGENT_URL__) agentBase = window.__CONTINUUM_AGENT_URL__.replace(/\/$/, '');
    else if (import.meta.env?.VITE_AGENT_URL) agentBase = import.meta.env.VITE_AGENT_URL.replace(/\/$/, '');
    else return; // No agent configured (demo mode) — skip

    const resp = await fetch(`${agentBase}/api/setup/status`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.setup_mode === true) {
      // Redirect to setup wizard if not already there
      if (!window.location.hash.includes('/setup')) {
        window.location.hash = '#/setup';
      }
    }
  } catch (_e) {
    // Agent unreachable — silently continue (normal for demo build)
  }
}
