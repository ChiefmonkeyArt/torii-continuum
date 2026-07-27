/**
 * Sign-out is a HARD security boundary (v0.2.75-alpha).
 *
 * Regression for the production report on v0.2.69-alpha: after Sign out the app
 * showed the login page, but the browser Back button restored the previously
 * authenticated dashboard. This suite drives the REAL router (src/router.js) and
 * the REAL guard decisions (src/nav-guard.js) through a faithful window /
 * history / bfcache stub, wired exactly like main.js, and proves:
 *
 *   sign in → dashboard → sign out → Back  ⇒ dashboard stays inaccessible
 *   a bfcache restore (pageshow.persisted) after sign-out ⇒ bounced to login
 *   a lingering protected history entry     ⇒ guard bounces on Back
 *
 * The environment has no jsdom, so the stub models only the history semantics
 * the router relies on (hash get/set = push, location.replace = replace-in-place,
 * history.back = move pointer + fire popstate then hashchange, pageshow).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { route, navigate, startRouter, currentRoute, resolveCurrent } from './router.js';
import {
  rootTarget,
  guardRedirect,
  sessionChangeTarget,
  restoreTarget,
} from './nav-guard.js';

// ── Mutable per-test state the (once-registered) route handlers read ──────────
let authed = false;
let rendered = [];

// Mirror of main.js's guarded() wrapper.
function guarded(pattern, handler) {
  return (params) => {
    const redirect = guardRedirect(pattern, authed);
    if (redirect) { navigate(redirect, { replace: true }); return; }
    handler(params);
  };
}

// Mirror of main.js's enforceRouteAuth().
function enforceRouteAuth() {
  const cr = currentRoute();
  const pattern = cr ? cr.pattern : '/';
  const target = restoreTarget(pattern, authed);
  if (target) { navigate(target, { replace: true }); return; }
  resolveCurrent();
}

// Mirror of main.js's continuum:session-changed handler.
function applySessionChange() {
  navigate(sessionChangeTarget(authed), { replace: !authed });
}

// Routes registered ONCE (module load) so the router's route table is not
// duplicated across tests; handlers read the mutable `authed` / `rendered`.
route('/', () => {
  const target = rootTarget(authed);
  if (target) { navigate(target); return; }
  rendered.push('login');
});
route('/dashboard', guarded('/dashboard', () => rendered.push('dashboard')));

// ── Faithful window/history/bfcache stub ─────────────────────────────────────
function makeEnv(initialHash = '#/') {
  const listeners = {};
  let stack = [initialHash];
  let idx = 0;
  function fire(type, extra = {}) {
    (listeners[type] || []).forEach((fn) => fn({ type, ...extra }));
  }
  const location = {
    pathname: '/continuum/',
    search: '',
    get hash() { return stack[idx]; },
    set hash(v) {
      const nv = v[0] === '#' ? v : '#' + v;
      if (nv === stack[idx]) return;      // no-op, matches browser
      stack = stack.slice(0, idx + 1);    // truncate forward history
      stack.push(nv);
      idx = stack.length - 1;
      fire('hashchange');
    },
    replace(url) {
      const hi = url.indexOf('#');
      const nv = hi >= 0 ? url.slice(hi) : '#/';
      const changed = nv !== stack[idx];
      stack[idx] = nv;                     // replace current entry in place
      if (changed) fire('hashchange');
    },
  };
  const history = {
    back() { if (idx > 0) { idx -= 1; fire('popstate'); fire('hashchange'); } },
    forward() { if (idx < stack.length - 1) { idx += 1; fire('popstate'); fire('hashchange'); } },
  };
  return {
    win: {
      location,
      history,
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    },
    fire,
    get hash() { return stack[idx]; },
    get depth() { return stack.length; },
    get stack() { return stack.slice(); },
  };
}

let env;
beforeEach(() => {
  authed = false;
  rendered = [];
  env = makeEnv('#/');
  global.window = env.win;
  // main.js wires these two on boot.
  global.window.addEventListener('popstate', enforceRouteAuth);
  global.window.addEventListener('pageshow', (e) => { if (e && e.persisted) enforceRouteAuth(); });
});
afterEach(() => { delete global.window; });

// Sign in, boot the router, and land on the dashboard — the shared precondition.
function signInAndLand() {
  authed = true;
  startRouter();               // resolve '#/' → authed → navigate('/dashboard')
  expect(rendered).toContain('dashboard');
  expect(env.hash).toBe('#/dashboard');
}

describe('sign in → dashboard → sign out → Back', () => {
  it('keeps the dashboard inaccessible after Back (login is shown, not dashboard)', () => {
    signInAndLand();

    // Sign out: clears session, session-changed handler routes to login.
    authed = false;
    applySessionChange();
    expect(env.hash).toBe('#/');
    expect(rendered[rendered.length - 1]).toBe('login');

    // The authenticated dashboard entry was REPLACED, not pushed — pressing Back
    // cannot return to it.
    const before = rendered.length;
    env.win.history.back();

    const after = rendered.slice(before);
    expect(after).not.toContain('dashboard');
    expect(env.hash).toBe('#/');
  });

  it('never renders the dashboard again for the rest of a logged-out session', () => {
    signInAndLand();
    authed = false;
    applySessionChange();

    const renders = rendered.length;
    env.win.history.back();
    env.win.history.forward();
    env.win.history.back();

    expect(rendered.slice(renders)).not.toContain('dashboard');
  });
});

describe('guard catches a lingering protected history entry (defense in depth)', () => {
  it('bounces to login when Back lands on a still-present #/dashboard while logged out', () => {
    // Simulate history where the dashboard entry was NOT replaced (e.g. a deeper
    // entry): [#/, #/dashboard, #/]. Being logged out, Back onto #/dashboard must
    // bounce via the per-route guard, never render the dashboard.
    env = makeEnv('#/');
    global.window = env.win;
    global.window.addEventListener('popstate', enforceRouteAuth);
    authed = true;
    startRouter();                 // → #/dashboard rendered
    authed = true;
    navigate('/');                 // push #/ (pointer now at #/, dashboard behind)
    authed = false;                // session ends
    rendered = [];

    env.win.history.back();        // Back onto #/dashboard

    expect(rendered).not.toContain('dashboard');
    // The guard replaced the protected hash with login (root).
    expect(env.hash).toBe('#/');
  });
});

describe('bfcache restore after sign-out (pageshow.persisted)', () => {
  it('revalidates and bounces a restored authenticated DOM to login', () => {
    signInAndLand();

    // The session ends while the page sits in the back-forward cache (sign-out in
    // another tab / expiry). The cached DOM still shows the dashboard and neither
    // hashchange nor popstate fires — only pageshow(persisted).
    authed = false;
    const before = rendered.length;

    env.fire('pageshow', { persisted: true });

    expect(currentRoute().pattern).not.toBe('/dashboard');
    expect(rendered.slice(before)).toContain('login');
    expect(rendered.slice(before)).not.toContain('dashboard');
    expect(env.hash).toBe('#/');
  });

  it('a NON-persisted pageshow (normal load) does not force a bounce', () => {
    signInAndLand();
    const before = rendered.length;
    env.fire('pageshow', { persisted: false });
    // No revalidation navigation triggered for a fresh (non-bfcache) load.
    expect(rendered.slice(before)).not.toContain('login');
  });
});

// ── Source-structure locks for the main.js wiring (main.js auto-boots on import
//    and cannot be imported under node, so we assert the wiring textually — the
//    repo's established jsdom-free convention). ────────────────────────────────
describe('main.js wiring (source lock)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('a session change replaces (not pushes) history in both directions', () => {
    // Sign-out: Back cannot restore the dashboard. Sign-in: Back cannot land on
    // the stale login surface (which then bounced forward again, trapping the
    // operator between two history entries).
    expect(main).toMatch(/navigate\(\s*sessionChangeTarget\(\s*authed\s*\)\s*,\s*\{\s*replace:\s*true\s*\}\s*\)/);
  });

  it('the per-route guard bounces with replace, not push', () => {
    expect(main).toMatch(/navigate\(\s*redirect\s*,\s*\{\s*replace:\s*true\s*\}\s*\)/);
  });

  it('revalidates auth on popstate and on bfcache pageshow(persisted)', () => {
    expect(main).toMatch(/addEventListener\(\s*'popstate'\s*,\s*enforceRouteAuth\s*\)/);
    expect(main).toMatch(/addEventListener\(\s*'pageshow'\s*,/);
    expect(main).toMatch(/e\.persisted/);
    expect(main).toMatch(/function enforceRouteAuth\(\)/);
    expect(main).toMatch(/restoreTarget\(/);
  });
});
