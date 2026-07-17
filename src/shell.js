/**
 * App shell: sidebar + main pane + docked chat container.
 * Views mount into #main-content.
 */

import { navigate, currentRoute } from './router.js';
import { listProjects } from './data/store.js';
import { isSessionLive, startLogin, endSession } from './auth.js';
import { isAgentConfigured } from './data/agent.js';

const NAV_ITEMS = [
  { id: 'projects',    label: 'Projects',    icon: iconProjects,    path: '/projects' },
  { id: 'marketplace', label: 'Marketplace', icon: iconMarket,      path: '/marketplace' },
  { id: 'routstr',     label: 'Routstr',     icon: iconRoutstr,     path: '/routstr' },
  { id: 'dashboard',   label: 'Dashboard',   icon: iconDashboard,   path: '/dashboard' },
  { id: 'team',        label: 'Team',        icon: iconTeam,        path: '/team' },
];

let mainEl, sidebarEl;

export function mountShell(root) {
  root.innerHTML = ''; // reset
  sidebarEl = document.createElement('nav');
  sidebarEl.className = 'sidebar';
  sidebarEl.setAttribute('aria-label', 'Continuum navigation');
  root.appendChild(sidebarEl);

  mainEl = document.createElement('main');
  mainEl.className = 'main';
  mainEl.setAttribute('id', 'main-content');
  root.appendChild(mainEl);

  renderSidebar();
  window.addEventListener('hashchange', renderSidebar);
}

export function mainContent() { return mainEl; }

// Build-time version string baked in by Vite (`define: __APP_VERSION__`).
// Returns e.g. "v0.2.57-alpha", or "v—" when the constant is absent (running
// outside Vite's pipeline, e.g. a bare unit test).
export function appVersion() {
  return `v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}`;
}

export function renderSidebar() {
  const projectCount = listProjects().length;
  const active = getActiveNav();

  sidebarEl.innerHTML = `
    <div class="brand" role="button" aria-label="Continuum home">
      <div class="brand-mark">⛩</div>
      <div>
        <div class="brand-name">Continuum</div>
        <div class="brand-sub">project engine</div>
      </div>
    </div>

    <div class="nav-section">Workspace</div>
    ${NAV_ITEMS.map((n) => `
      <div class="nav-item ${active === n.id ? 'active' : ''}" data-path="${n.path}" role="button" tabindex="0">
        <span class="nav-icon">${n.icon()}</span>
        <span>${n.label}</span>
        ${n.id === 'projects' ? `<span class="nav-badge">${projectCount}</span>` : ''}
      </div>
    `).join('')}

    <div class="nav-section">Signals</div>
    <div class="nav-item" data-path="/marketplace?ours=1" role="button" tabindex="0">
      <span class="nav-icon">${iconStar()}</span>
      <span>Our tasks</span>
    </div>
    <div class="nav-item" data-path="/routstr" role="button" tabindex="0">
      <span class="nav-icon">${iconPulse()}</span>
      <span>Usage</span>
    </div>

    <div class="sidebar-footer">
      <div class="footer-note">
        <b>Local-first.</b> Continuum stores your projects as nostr-shaped events — portable, signable, yours.
      </div>
      <div class="sidebar-version" data-app-version></div>
      <div class="sidebar-footer-row">
        <button class="session-btn ${isSessionLive() ? 'logged-in' : ''}" data-session-toggle title="${isSessionLive() ? 'Sign out' : 'Sign in with Nostr'}">
          <span class="session-icon">${isSessionLive() ? iconLogout() : iconKey()}</span>
          <span>${isSessionLive() ? 'Sign out' : (isAgentConfigured() ? 'Login' : 'Demo mode')}</span>
        </button>
        <button class="theme-toggle" data-theme-toggle title="Toggle theme" aria-label="Toggle theme">${currentTheme() === 'light' ? iconMoon() : iconSun()}</button>
      </div>
    </div>
  `;
  // Build-time version stamp so every deploy self-identifies. Rendered via
  // textContent (never innerHTML) even though __APP_VERSION__ is a trusted
  // build constant. Visible to logged-in and demo/unauthenticated users alike.
  const versionEl = sidebarEl.querySelector('[data-app-version]');
  if (versionEl) versionEl.textContent = appVersion();

  const toggle = sidebarEl.querySelector('[data-theme-toggle]');
  if (toggle) toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleTheme(); renderSidebar(); });
  const sessionBtn = sidebarEl.querySelector('[data-session-toggle]');
  if (sessionBtn) sessionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSessionLive()) { endSession(); renderSidebar(); }
    else { startLogin(); }
  });
  sidebarEl.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.path.replace(/\?.*/, '')));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
  sidebarEl.querySelector('.brand').addEventListener('click', () => navigate('/'));
}

// -- Theme --
const THEME_KEY = 'continuum.theme';
export function currentTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (_e) {}
  // Dark is Continuum's canonical look. If the user has never chosen, we
  // default to dark rather than tracking the OS preference — the amber-on-
  // bronze palette was designed dark-first.
  return 'dark';
}
export function applyStoredTheme() {
  let theme = 'dark'; // canonical default
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch (_e) {}
  document.documentElement.setAttribute('data-theme', theme);
}
export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_e) {}
}

function getActiveNav() {
  const cr = currentRoute();
  if (!cr) return 'projects';
  if (cr.pattern.startsWith('/projects')) return 'projects';
  if (cr.pattern.startsWith('/marketplace')) return 'marketplace';
  if (cr.pattern.startsWith('/routstr')) return 'routstr';
  if (cr.pattern.startsWith('/dashboard')) return 'dashboard';
  if (cr.pattern.startsWith('/team')) return 'team';
  return 'projects';
}

// -- Icons (inline SVG, currentColor) --
function iconProjects() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="6" height="4" rx="1"/><rect x="1.5" y="9" width="6" height="4" rx="1"/><rect x="8.5" y="3" width="6" height="10" rx="1"/></svg>`;
}
function iconMarket() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12l-1 3H3z"/><path d="M3 7v6h10V7"/><path d="M6 13v-3h4v3"/></svg>`;
}
function iconRoutstr() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 2 1.8 9 0 11M8 2.5c-1.8 2-1.8 9 0 11"/></svg>`;
}
function iconDashboard() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M1.5 6h13M6 6v8.5"/></svg>`;
}
function iconTeam() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5" r="2.5"/><path d="M1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M11 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.5.5 2.5 1.9 2.5 3.7"/></svg>`;
}
function iconStar() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 2l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.8l.7-4.3-3.1-3 4.3-.6z"/></svg>`;
}
function iconPulse() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8H4l1.5-4 3 8L10 8h4.5"/></svg>`;
}
function iconSun() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M2.6 2.6l1.05 1.05M12.35 12.35l1.05 1.05M1.5 8h1.5M13 8h1.5M2.6 13.4l1.05-1.05M12.35 3.65l1.05-1.05"/></svg>`;
}
function iconMoon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.5a5 5 0 1 1-6.5-6.5 5 5 0 0 0 6.5 6.5z"/></svg>`;
}
function iconKey() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="11" r="2.5"/><path d="M7 9l7-7M11 2h3v3M11 5l2 2"/></svg>`;
}
function iconLogout() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/><path d="M10 5l3 3-3 3M13 8H6"/></svg>`;
}
