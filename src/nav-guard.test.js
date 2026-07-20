/**
 * Full-app auth gating (v0.2.73-alpha).
 *
 * The requirement: "You should not be on any screen unless you are signed in."
 * Only the login page (root, `/`) is public; every other route requires a live
 * session. This suite has two layers:
 *
 *   1. Pure decision tests for nav-guard (no DOM). These lock the default-deny
 *      contract: `/` is public, everything else is protected, and a logged-out
 *      visitor asking for a protected pattern is bounced to the login page.
 *
 *   2. An integration harness that wires the REAL router (src/router.js) + the
 *      REAL session check (isSessionLive → isLoggedIn → the stored token) + the
 *      REAL guard, mirroring the guarded() wiring in src/main.js. It drives the
 *      hash and asserts which view actually rendered — including the blocking
 *      check that a successful login (token persisted, THEN session-changed)
 *      lands on the dashboard rather than bouncing back to login.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  guardRedirect,
  rootTarget,
  sessionChangeTarget,
  isPublicPattern,
  isProtectedPattern,
  isDemoPattern,
  realEquivalent,
  demoRedirect,
  ROOT_PATH,
  LOGIN_PATH,
  DASHBOARD_PATH,
} from './nav-guard.js';
import { route, navigate, startRouter } from './router.js';
import { isSessionLive } from './auth.js';

// Every protected app route the requirement calls out, plus the marketing
// surface, which is gated too under default-deny.
const PROTECTED_ROUTES = ['/dashboard', '/projects', '/marketplace', '/routstr', '/team', '/about'];

// ── Layer 1: pure guard decisions ──────────────────────────────────
describe('nav-guard — default-deny contract', () => {
  it('only the root/login path is public', () => {
    expect(isPublicPattern('/')).toBe(true);
    for (const p of PROTECTED_ROUTES) {
      expect(isPublicPattern(p)).toBe(false);
      expect(isProtectedPattern(p)).toBe(true);
    }
    // A brand-new, unknown route is protected automatically (no allowlist).
    expect(isProtectedPattern('/some/future/route')).toBe(true);
  });

  it('bounces every protected route to the login page when logged out', () => {
    for (const p of PROTECTED_ROUTES) {
      expect(guardRedirect(p, false)).toBe(LOGIN_PATH);
    }
  });

  it('lets every protected route render when authed', () => {
    for (const p of PROTECTED_ROUTES) {
      expect(guardRedirect(p, true)).toBeNull();
    }
  });

  it('never bounces the public root, in either auth state', () => {
    expect(guardRedirect('/', false)).toBeNull();
    expect(guardRedirect('/', true)).toBeNull();
  });

  it('routes auth-state changes: authed → dashboard, logged out → login', () => {
    expect(sessionChangeTarget(true)).toBe(DASHBOARD_PATH);
    expect(sessionChangeTarget(false)).toBe(ROOT_PATH);
    // Root render decision mirrors it.
    expect(rootTarget(true)).toBe(DASHBOARD_PATH);
    expect(rootTarget(false)).toBeNull();
  });
});

// ── Demo surface rules ─────────────────────────────────────────────
// The /demo subtree is public (signed-out mockup), never bounced when logged
// out, and redirected to the real screen when a signed-in operator lands there.
describe('nav-guard — demo surface', () => {
  const DEMO_ROUTES = ['/demo', '/demo/dashboard', '/demo/projects', '/demo/projects/:slug', '/demo/marketplace', '/demo/routstr', '/demo/team'];

  it('every demo route is public and not protected', () => {
    for (const p of DEMO_ROUTES) {
      expect(isPublicPattern(p)).toBe(true);
      expect(isProtectedPattern(p)).toBe(false);
      expect(isDemoPattern(p)).toBe(true);
    }
    // A real route is not a demo route.
    expect(isDemoPattern('/dashboard')).toBe(false);
    expect(isDemoPattern('/demonstration')).toBe(false); // prefix guard, not substring
  });

  it('never bounces a demo route when logged out', () => {
    for (const p of DEMO_ROUTES) expect(guardRedirect(p, false)).toBeNull();
  });

  it('maps each demo route to its real equivalent (strip /demo, root→dashboard)', () => {
    expect(realEquivalent('/demo')).toBe('/dashboard');
    expect(realEquivalent('/demo/dashboard')).toBe('/dashboard');
    expect(realEquivalent('/demo/projects')).toBe('/projects');
    expect(realEquivalent('/demo/projects/:slug')).toBe('/projects/:slug');
    expect(realEquivalent('/demo/marketplace')).toBe('/marketplace');
    expect(realEquivalent('/demo/routstr')).toBe('/routstr');
    expect(realEquivalent('/demo/team')).toBe('/team');
    // Non-demo patterns pass through unchanged.
    expect(realEquivalent('/dashboard')).toBe('/dashboard');
  });

  it('redirects a signed-in operator off demo to the real screen; leaves signed-out browsing', () => {
    for (const p of DEMO_ROUTES) {
      expect(demoRedirect(p, true)).toBe(realEquivalent(p));
      expect(demoRedirect(p, false)).toBeNull();
    }
    // A real route never triggers a demo redirect, in either auth state.
    expect(demoRedirect('/dashboard', true)).toBeNull();
    expect(demoRedirect('/dashboard', false)).toBeNull();
  });
});

// ── Layer 2: integration harness (real router + real session check) ─
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const TOKEN_KEY = 'continuum.session.v1';
// A token that isLoggedIn/tokenLooksLive accepts: `iat.exp.pubkey.sig`, exp>now.
const LIVE_TOKEN = '1.9999999999.pk.sig';

// Records the view the router actually rendered, so we can assert a protected
// screen is NEVER shown to a logged-out visitor.
const rendered = { view: null };

function setToken(tok) {
  if (tok) global.localStorage.setItem(TOKEN_KEY, tok);
  else global.localStorage.removeItem(TOKEN_KEY);
}

// Mirror src/main.js: wrap protected handlers with the central guard so the
// wrapped renderer never runs for a bounced (logged-out) visitor.
function guarded(pattern, view) {
  return () => {
    const redirect = guardRedirect(pattern, isSessionLive());
    if (redirect) { navigate(redirect); return; }
    rendered.view = view;
  };
}

// Register the route table once — router keeps a module-level route list.
let registered = false;
function registerRoutes() {
  if (registered) return;
  registered = true;
  route('/', () => {
    const target = rootTarget(isSessionLive());
    if (target) { navigate(target); return; }
    rendered.view = 'login';
  });
  route('/about', guarded('/about', 'about'));
  route('/projects', guarded('/projects', 'projects'));
  route('/projects/:slug', guarded('/projects/:slug', 'projectHome'));
  route('/projects/:slug/board', guarded('/projects/:slug/board', 'board'));
  route('/marketplace', guarded('/marketplace', 'marketplace'));
  route('/routstr', guarded('/routstr', 'routstr'));
  route('/team', guarded('/team', 'team'));
  route('/dashboard', guarded('/dashboard', 'dashboard'));
}

// Minimal window shim: a settable hash that fires hashchange listeners, which
// is exactly what src/router.js drives navigation through.
function installWindow(initialHash) {
  const listeners = {};
  let hash = initialHash;
  const win = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    _fire(type) { (listeners[type] || []).forEach((fn) => fn()); },
  };
  const loc = {
    origin: 'https://the-live-site.example',
    get hash() { return hash; },
    // Mirror the browser: assigning a fragment without a leading '#' is
    // normalised to include one. router.navigate() relies on this (it assigns
    // `location.hash = '/dashboard'` and later compares against '#/dashboard').
    set hash(v) {
      const nv = String(v).startsWith('#') ? String(v) : '#' + v;
      if (nv !== hash) { hash = nv; win._fire('hashchange'); }
    },
  };
  Object.defineProperty(win, 'location', { get() { return loc; } });
  global.window = win;
}

// Simulate a session-change event the way src/main.js handles it: the token is
// already persisted, THEN we route to sessionChangeTarget(current auth state).
function fireSessionChange() {
  navigate(sessionChangeTarget(isSessionLive()));
}

beforeEach(() => {
  global.localStorage = new FakeStorage();
  rendered.view = null;
  registerRoutes();
});

afterEach(() => {
  delete global.window;
  delete global.localStorage;
});

describe('unauthenticated direct navigation to a protected route', () => {
  for (const path of ['/dashboard', '/projects', '/marketplace', '/routstr', '/team']) {
    it(`${path} renders the login modal, NOT the protected screen`, () => {
      setToken(null);
      installWindow('#' + path);
      startRouter(); // initial resolve = the deep-link/refresh path

      expect(rendered.view).toBe('login');
      expect(global.window.location.hash).toBe('#/');
    });
  }
});

describe('authenticated navigation to a protected route', () => {
  for (const [path, view] of [
    ['/dashboard', 'dashboard'],
    ['/projects', 'projects'],
    ['/marketplace', 'marketplace'],
    ['/routstr', 'routstr'],
    ['/team', 'team'],
  ]) {
    it(`${path} renders ${view}`, () => {
      setToken(LIVE_TOKEN);
      installWindow('#' + path);
      startRouter();
      expect(rendered.view).toBe(view);
    });
  }
});

describe('successful login → dashboard (blocking check: must not bounce)', () => {
  it('token persisted first, THEN session-changed → dashboard renders', () => {
    // Start logged out on the login page.
    setToken(null);
    installWindow('#/');
    startRouter();
    expect(rendered.view).toBe('login');

    // NIP-07 verify succeeds: the token is persisted BEFORE routing…
    setToken(LIVE_TOKEN);
    expect(isSessionLive()).toBe(true);

    // …then the session-changed handler routes. The guard now sees an authed
    // session and lets /dashboard render (it is NOT bounced back to login).
    fireSessionChange();
    expect(rendered.view).toBe('dashboard');
    expect(global.window.location.hash).toBe('#/dashboard');
  });
});

describe('logout from a protected route → login modal', () => {
  it('clearing the token then session-changing lands on login', () => {
    // Authenticated on the dashboard.
    setToken(LIVE_TOKEN);
    installWindow('#/dashboard');
    startRouter();
    expect(rendered.view).toBe('dashboard');

    // Sign out: token cleared, then routed.
    setToken(null);
    fireSessionChange();
    expect(rendered.view).toBe('login');
    expect(global.window.location.hash).toBe('#/');
  });
});

// ── Source-structure guard: the route table is default-deny by construction ──
// A future author who adds an unguarded protected route must fail CI here.
describe('src/main.js — every registered route is public-root or guarded()', () => {
  it('no route escapes the guard except the public patterns', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'main.js'), 'utf8');

    // Public patterns that are allowed to register a bare (unguarded) handler:
    // the root/login page renders in place, and the demo surface is explicitly
    // public (nav-guard PUBLIC_PATTERNS) with its own in-view session gating.
    const PUBLIC_OK = (pattern) =>
      pattern === '/' || pattern === '/demo' || pattern.startsWith('/demo/');

    // Match every `route('<pattern>', <rest-of-line>)` registration.
    const re = /route\(\s*'([^']+)'\s*,([^\n]*)/g;
    const seen = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const [, pattern, rest] = m;
      seen.push(pattern);
      if (PUBLIC_OK(pattern)) continue;
      expect(rest.includes(`guarded('${pattern}'`)).toBe(true);
    }
    // Sanity: we actually parsed the table (guards nothing-matched false-pass).
    expect(seen).toContain('/dashboard');
    expect(seen.length).toBeGreaterThanOrEqual(8);
  });
});

// ── Source-structure guard: login surface exposes ONLY the public demo peek ──
// The login card may link to the public /demo mockup, but must not resurrect the
// old unauthenticated entry points into the real (now-gated) app routes.
describe('login surface exposes only the public demo peek', () => {
  it('links to #/demo/dashboard and nothing that enters a gated real route', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'views/login.js'), 'utf8');
    // The one allowed peek: an href into the public demo surface.
    expect(src).toContain('#/demo/dashboard');
    // The old affordances into real routes must stay gone.
    expect(src).not.toContain('Explore the demo');
    expect(src).not.toMatch(/navigate\('\/projects'\)/);
  });
});
