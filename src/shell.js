/**
 * App shell: sidebar + main pane + docked chat container.
 * Views mount into #main-content.
 */

import { navigate, currentRoute } from './router.js';
import { listProjects } from './data/store.js';
import { isSessionLive, startLogin, cancelLogin, endSession } from './auth.js';
import { isAgentConfigured, versionInfo, requestUpdate } from './data/agent.js';
import { describeVersionState, updateTargetTag } from './data/release.js';
import { h, openModal } from './views/util.js';
import { demoAware } from './demo/demo-mode.js';
import { navClickTarget } from './components/nav-link.js';
import { renderLoginStatus } from './components/login-status.js';

const NAV_ITEMS = [
  { id: 'projects',    label: 'Projects',    icon: iconProjects,    path: '/projects' },
  { id: 'marketplace', label: 'Marketplace', icon: iconMarket,      path: '/marketplace' },
  { id: 'routstr',     label: 'Routstr',     icon: iconRoutstr,     path: '/routstr' },
  { id: 'dashboard',   label: 'Dashboard',   icon: iconDashboard,   path: '/dashboard' },
  { id: 'team',        label: 'Team',        icon: iconTeam,        path: '/team' },
  { id: 'genesis',     label: 'Genesis',     icon: iconGenesis,     path: '/genesis' },
  { id: 'memory',      label: 'Memory',      icon: iconMemory,      path: '/memory' },
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
  // Read the authoritative auth state ONCE per render and derive the control's
  // label, icon, title AND action from that single value. Previously the label
  // was rendered from one read and the click branched on a second, later read —
  // so a token that lapsed in between produced a button reading "Sign out" that
  // called startLogin() and popped the signer.
  const authed = isSessionLive();

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
      <a class="nav-item ${active === n.id ? 'active' : ''}" href="${demoAware('#' + n.path)}" data-path="${n.path}">
        <span class="nav-icon">${n.icon()}</span>
        <span>${n.label}</span>
        ${n.id === 'projects' ? `<span class="nav-badge">${projectCount}</span>` : ''}
      </a>
    `).join('')}

    <div class="nav-section">Signals</div>
    <a class="nav-item" href="${demoAware('#/marketplace?ours=1')}" data-path="/marketplace?ours=1">
      <span class="nav-icon">${iconStar()}</span>
      <span>Our tasks</span>
    </a>
    <a class="nav-item" href="${demoAware('#/routstr')}" data-path="/routstr">
      <span class="nav-icon">${iconPulse()}</span>
      <span>Usage</span>
    </a>

    <div class="sidebar-footer">
      <div class="footer-note">
        <b>Local-first.</b> Continuum stores your projects as nostr-shaped events — portable, signable, yours.
      </div>
      <div class="sidebar-version" data-app-version></div>
      <div class="sidebar-update" data-sidebar-update hidden></div>
      <div class="sidebar-login-status" data-login-status role="status" aria-live="polite"></div>
      <div class="sidebar-footer-row">
        <button class="session-btn ${authed ? 'logged-in' : ''}" data-session-toggle data-session-intent="${authed ? 'signout' : 'signin'}" title="${authed ? 'Sign out' : 'Sign in with Nostr'}">
          <span class="session-icon">${authed ? iconLogout() : iconKey()}</span>
          <span>${authed ? 'Sign out' : (isAgentConfigured() ? 'Sign in' : 'Demo mode')}</span>
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
  const loginStatusEl = sidebarEl.querySelector('[data-login-status]');
  if (sessionBtn) sessionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // The action is bound to the RENDERED intent (`authed`, the same value the
    // label came from) — never to a second, later read. A control the operator
    // can see saying "Sign out" therefore always signs out, and can never reach
    // startLogin / window.nostr. In the opposite direction a control rendered
    // "Sign in" that finds a live session (signed in elsewhere since the render)
    // re-renders itself instead of starting a redundant challenge.
    if (authed) { confirmSignOut(); return; }
    if (isSessionLive()) { renderSidebar(); return; }
    startLogin({ onStatus: sidebarLoginStatus(loginStatusEl) });
  });
  sidebarEl.querySelectorAll('.nav-item').forEach((el) => {
    // Real anchors now (href baked with demoAware at render time, so hover URL,
    // ⌘/Ctrl-click "open in new tab" and the intercepted SPA transition all
    // agree and none bounce to a guarded route — the v0.2.85 demo-nav
    // regression). navClickTarget escape-hatches modifier / non-primary clicks
    // to the browser and returns the router target for a plain left click.
    el.addEventListener('click', (e) => {
      const target = navClickTarget(e, el.getAttribute('href'));
      if (target == null) return;
      e.preventDefault();
      navigate(target);
    });
  });
  sidebarEl.querySelector('.brand').addEventListener('click', () => navigate('/'));

  // VERSION-UPDATE-1: after login, if a newer release exists, reveal the latest
  // version + an Update button in the footer. Non-blocking; failures are silent
  // (the version stamp always shows). Only meaningful with a configured agent.
  refreshSidebarVersion();
}

// Fetch the version summary and, when logged in AND a newer release is known,
// render the latest version + an Update button into [data-sidebar-update].
async function refreshSidebarVersion() {
  const box = sidebarEl?.querySelector('[data-sidebar-update]');
  if (!box) return;
  if (!isAgentConfigured() || !isSessionLive()) { box.hidden = true; return; }

  let r;
  try { r = await versionInfo(); } catch { return; }
  if (!r || !r.ok) return;

  const state = describeVersionState(r.data);
  const tag = updateTargetTag(r.data);
  if (state.state !== 'newer' || !tag) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  renderUpdateAffordance(box, tag, state);
}

// Render a two-step confirm Update button + status. Two-step (arm → confirm)
// keeps the confirmation IN the UI without a modal, and prevents an accidental
// single click from queuing a deploy.
function renderUpdateAffordance(box, tag, state) {
  box.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sidebar-update-label';
  label.textContent = `Update available · ${state.latest}`;

  const status = document.createElement('div');
  status.className = 'sidebar-update-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const btn = document.createElement('button');
  btn.className = 'sidebar-update-btn';
  btn.type = 'button';
  btn.textContent = `Update to ${state.latest}`;
  btn.setAttribute('data-update-btn', '');

  let armed = false;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      btn.textContent = `Confirm update to ${state.latest}`;
      btn.classList.add('armed');
      status.textContent = 'Click again to confirm. The agent will update and restart.';
      return;
    }
    btn.disabled = true;
    btn.classList.remove('armed');
    status.textContent = 'Queuing update…';
    let res;
    try { res = await requestUpdate(tag); } catch (err) { res = { ok: false, reason: String(err) }; }
    if (!res || !res.ok) {
      btn.disabled = false;
      armed = false;
      btn.textContent = `Update to ${state.latest}`;
      status.textContent = `Update failed: ${res?.reason || 'unknown error'}`;
      status.classList.add('error');
      return;
    }
    status.classList.remove('error');
    status.textContent = 'Update queued. The agent will update and restart shortly; this page will reload when it is back.';
    pollForUpgrade(tag);
  });

  box.appendChild(label);
  box.appendChild(btn);
  box.appendChild(status);
}

// Poll /api/version until the live version reaches the target, then reload so
// the freshly-deployed assets load. Bounded so a stalled deploy stops polling.
function pollForUpgrade(tag, attempts = 0) {
  const want = String(tag).replace(/^v/, '');
  if (attempts > 40) return; // ~10 min at 15s
  setTimeout(async () => {
    let r;
    try { r = await versionInfo(); } catch { return pollForUpgrade(tag, attempts + 1); }
    const live = r?.ok ? String(r.data?.current || '').replace(/^v/, '') : '';
    if (live && live === want) {
      if (typeof window !== 'undefined' && window.location?.reload) window.location.reload();
      return;
    }
    pollForUpgrade(tag, attempts + 1);
  }, 15000);
}

// Inline login status sink for the sidebar login button (no modal). The
// renderer is SHARED with the login card — the sidebar used to render plain
// text, so the same failure offered install links on one surface and a dead
// sentence on the other.
function sidebarLoginStatus(el) {
  const sink = (s) => renderLoginStatus(el, s, {
    baseClass: 'sidebar-login-status',
    onRetry: () => startLogin({ onStatus: sink }),
    onCancel: cancelLogin,
  });
  return sink;
}

// The two outcomes of the sign-out confirmation, as plain callbacks so the
// decision logic is unit-testable without a DOM. Signing out is PURELY LOCAL:
//   • onConfirm → endSession(): clears the SPA session (continuum.session.v1)
//     AND the onboarding handoff (torii.session), then dispatches
//     continuum:session-changed. The app-level handler (main.js, PR #82) turns
//     that into a route back to the login modal. It NEVER calls startLogin /
//     window.nostr / signEvent — no signer prompt on sign-out.
//   • onCancel → no-op: the session is left intact and nothing navigates.
export function signOutOutcomes(deps = {}) {
  const end = typeof deps.endSession === 'function' ? deps.endSession : endSession;
  return {
    onConfirm() { end(); },
    onCancel() {},
  };
}

// Sign-out confirmation modal ("Signing out?" · Yes / Cancel). Reuses the shared
// openModal helper so it works from every route and matches Continuum's modal
// styling. Yes runs the local endSession(); Cancel closes and leaves the user
// exactly where they are. This path contains NO NIP-07/sign-in call.
export function confirmSignOut(deps = {}) {
  const open = typeof deps.openModal === 'function' ? deps.openModal : openModal;
  const { onConfirm, onCancel } = signOutOutcomes(deps);

  const cancel = h('button', {}, ['Cancel']);
  const yes = h('button', { class: 'primary' }, ['Yes']);
  const actions = h('div', { class: 'form-actions' }, [cancel, yes]);
  const body = h('div', {}, [actions]);

  const handle = open({ title: 'Signing out?', body });
  cancel.addEventListener('click', () => { handle.close(); onCancel(); });
  yes.addEventListener('click', () => { handle.close(); onConfirm(); });
  return handle;
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
  if (cr.pattern.startsWith('/genesis')) return 'genesis';
  if (cr.pattern.startsWith('/memory')) return 'memory';
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
function iconGenesis() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15M3 3l1.8 1.8M11.2 11.2 13 13M13 3l-1.8 1.8M4.8 11.2 3 13"/></svg>`;
}
function iconMemory() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M1 6h2M1 10h2M13 6h2M13 10h2M6 1v2M10 1v2M6 13v2M10 13v2"/><rect x="6" y="6" width="4" height="4" rx="0.5"/></svg>`;
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
