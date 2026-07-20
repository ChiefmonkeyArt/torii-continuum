/**
 * App-routing / auth slice (v0.2.44-alpha).
 *
 * Continuum's root is application-first: logged out → branded login page in
 * place at root; logged in → dashboard. The sales/marketing page is isolated
 * behind an explicit #/about route and is never the root or an onboarding
 * completion target. Protected views bounce logged-out visitors to login
 * without a redirect loop.
 *
 * No jsdom/happy-dom is available in this environment, so the routing contract
 * is proven two ways:
 *   1. the pure guard-decision layer (src/nav-guard.js) — exhaustively;
 *   2. the wiring itself (src/main.js, views) — via source-structure assertions
 *      that lock the app-first mapping and the sales-page isolation in place,
 *      mirroring the repo's existing template/regression-lock test style.
 * Session adoption is exercised end-to-end against the real agent helpers with
 * an in-memory localStorage stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PUBLIC_PATTERNS,
  ROOT_PATH,
  LOGIN_PATH,
  DASHBOARD_PATH,
  isPublicPattern,
  isProtectedPattern,
  rootTarget,
  guardRedirect,
  sessionChangeTarget,
  restoreTarget,
} from '../src/nav-guard.js';
import { getStoredToken, setStoredToken, isLoggedIn, logout } from '../src/data/agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');
const read = (p) => readFileSync(join(SRC, p), 'utf8');
// Strip line comments + block comments so a mention in a doc-comment never
// satisfies (or trips) a structural assertion about actual code.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;
const pubkey = 'a'.repeat(64);
const liveToken = `1000.${future}.${pubkey}.deadbeefsig`;
const deadToken = `1000.${past}.${pubkey}.deadbeefsig`;

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

describe('nav-guard: unauthenticated root → login', () => {
  it('renders login in place at root (no redirect) when logged out', () => {
    expect(rootTarget(false)).toBeNull();
  });
  it('login is rendered at root, not a separate hash route', () => {
    expect(LOGIN_PATH).toBe(ROOT_PATH);
  });
});

describe('nav-guard: authenticated root → dashboard', () => {
  it('redirects root straight to the dashboard when logged in', () => {
    expect(rootTarget(true)).toBe(DASHBOARD_PATH);
    expect(DASHBOARD_PATH).toBe('/dashboard');
  });
});

describe('nav-guard: dashboard protection', () => {
  it('marks /dashboard protected (and it is not in the public allowlist)', () => {
    expect(isProtectedPattern('/dashboard')).toBe(true);
    expect(PUBLIC_PATTERNS).not.toContain('/dashboard');
  });
  it('bounces a logged-out visitor from /dashboard to login', () => {
    expect(guardRedirect('/dashboard', false)).toBe(LOGIN_PATH);
  });
  it('lets a logged-in visitor render /dashboard', () => {
    expect(guardRedirect('/dashboard', true)).toBeNull();
  });
});

describe('nav-guard: no redirect loop', () => {
  it('protected→login is terminal (root renders login in place, never bounces)', () => {
    // Unauthed: dashboard → login (root); root → render-in-place (null). No cycle.
    const bounce = guardRedirect('/dashboard', false);
    expect(bounce).toBe(ROOT_PATH);
    expect(rootTarget(false)).toBeNull();
  });
});

describe('full-app gating: only the login page is public (default-deny)', () => {
  it('the public allowlist is the root/login path plus the demo subtree', () => {
    expect(PUBLIC_PATTERNS).toEqual(['/', '/demo', '/demo/*']);
    expect(isPublicPattern('/')).toBe(true);
    expect(guardRedirect('/', false)).toBeNull();
  });
  it('gates /about — the sales surface now requires a session too', () => {
    expect(isProtectedPattern('/about')).toBe(true);
    expect(guardRedirect('/about', false)).toBe(LOGIN_PATH);
    expect(guardRedirect('/about', true)).toBeNull();
  });
  it('gates the former demo shell views (/projects, /marketplace, /routstr, /team)', () => {
    for (const p of ['/projects', '/projects/torii', '/marketplace', '/routstr', '/team']) {
      expect(isProtectedPattern(p)).toBe(true);
      expect(guardRedirect(p, false)).toBe(LOGIN_PATH);
      expect(guardRedirect(p, true)).toBeNull();
    }
  });
});

describe('index gate: no implicit session on boot', () => {
  let stub;
  beforeEach(() => { stub = makeStorageStub(); globalThis.localStorage = stub; });
  afterEach(() => { delete globalThis.localStorage; delete globalThis.window; });

  it('(a) NIP-07 signer present + no valid session → root renders login, not dashboard', () => {
    // Signer available, and even a live onboarding envelope lingering in storage:
    // neither may authenticate the index. Only an explicit sign-in can.
    globalThis.window = { nostr: { signEvent: async () => ({}), getPublicKey: async () => pubkey } };
    stub.setItem('torii.session', JSON.stringify({ token: liveToken, pubkey, method: 'nip07' }));
    expect(getStoredToken()).toBeNull();
    expect(isLoggedIn()).toBe(false);
    expect(rootTarget(isLoggedIn())).toBeNull(); // render login in place
    expect(guardRedirect('/dashboard', isLoggedIn())).toBe(LOGIN_PATH);
  });

  it('(b) explicit sign-in persists a valid session → next load resolves to the dashboard', () => {
    // verifyChallenge stores the agent-issued token; simulate that persisted state.
    setStoredToken(liveToken);
    expect(isLoggedIn()).toBe(true);
    expect(rootTarget(isLoggedIn())).toBe(DASHBOARD_PATH);
    expect(guardRedirect('/dashboard', isLoggedIn())).toBeNull();
  });

  it('(c) sign-out clears session + onboarding envelope → next load shows login', () => {
    setStoredToken(liveToken);
    stub.setItem('torii.session', JSON.stringify({ token: liveToken, pubkey, method: 'nip07' }));
    logout();
    expect(getStoredToken()).toBeNull();
    expect(stub.getItem('torii.session')).toBeNull();
    expect(isLoggedIn()).toBe(false);
    expect(rootTarget(isLoggedIn())).toBeNull();
  });
});

describe('expired/invalid session → login', () => {
  let stub;
  beforeEach(() => { stub = makeStorageStub(); globalThis.localStorage = stub; });
  afterEach(() => { delete globalThis.localStorage; });

  it('an expired SPA token is not live → root renders login and dashboard bounces', () => {
    stub.setItem('continuum.session.v1', deadToken);
    expect(isLoggedIn()).toBe(false);
    expect(rootTarget(isLoggedIn())).toBeNull();
    expect(guardRedirect('/dashboard', isLoggedIn())).toBe(LOGIN_PATH);
  });

  it('a live SPA token keeps root→dashboard and dashboard allowed', () => {
    stub.setItem('continuum.session.v1', liveToken);
    expect(isLoggedIn()).toBe(true);
    expect(rootTarget(isLoggedIn())).toBe(DASHBOARD_PATH);
    expect(guardRedirect('/dashboard', isLoggedIn())).toBeNull();
  });
});

describe('mid-session auth change → forced route transition (v0.2.71-alpha)', () => {
  it('sign-in (authed) forces the dashboard, from any surface', () => {
    expect(sessionChangeTarget(true)).toBe(DASHBOARD_PATH);
    expect(DASHBOARD_PATH).toBe('/dashboard');
  });

  it('sign-out (not authed) forces root, which renders login in place', () => {
    expect(sessionChangeTarget(false)).toBe(ROOT_PATH);
    expect(sessionChangeTarget(false)).toBe(LOGIN_PATH);
  });

  it('always returns a concrete path (never null) so the router re-resolves', () => {
    expect(sessionChangeTarget(true)).toBeTruthy();
    expect(sessionChangeTarget(false)).toBeTruthy();
  });
});

describe('restoreTarget: history/bfcache revalidation makes sign-out a hard boundary (v0.2.75-alpha)', () => {
  it('bounces a protected pattern to login when logged out (Back onto a stale dashboard)', () => {
    expect(restoreTarget('/dashboard', false)).toBe(LOGIN_PATH);
    for (const p of ['/dashboard', '/projects', '/marketplace', '/routstr', '/team', '/about']) {
      expect(restoreTarget(p, false)).toBe(LOGIN_PATH);
    }
  });

  it('leaves a protected pattern as-is when still authenticated', () => {
    expect(restoreTarget('/dashboard', true)).toBeNull();
  });

  it('never leaves an authenticated visitor sitting on the login/root surface', () => {
    expect(restoreTarget('/', true)).toBe(DASHBOARD_PATH);
  });

  it('leaves the login/root surface as-is when logged out (no loop)', () => {
    expect(restoreTarget('/', false)).toBeNull();
  });
});

describe('end-to-end auth-state transition through the real session helpers', () => {
  let stub;
  beforeEach(() => { stub = makeStorageStub(); globalThis.localStorage = stub; });
  afterEach(() => { delete globalThis.localStorage; });

  it('successful verify → session persisted → transition target is the dashboard', () => {
    // verifyChallenge() persists the agent-issued token; simulate that write.
    setStoredToken(liveToken);
    expect(isLoggedIn()).toBe(true);
    // The continuum:session-changed handler routes off the live auth state.
    expect(sessionChangeTarget(isLoggedIn())).toBe(DASHBOARD_PATH);
  });

  it('sign-out clears every auth key → transition target is the login modal', () => {
    setStoredToken(liveToken);
    stub.setItem('torii.session', JSON.stringify({ token: liveToken, pubkey, method: 'nip07' }));
    logout();
    expect(getStoredToken()).toBeNull();
    expect(stub.getItem('torii.session')).toBeNull();
    expect(isLoggedIn()).toBe(false);
    expect(sessionChangeTarget(isLoggedIn())).toBe(LOGIN_PATH);
  });
});

describe('wiring: main.js session-changed handler forces a transition (source lock)', () => {
  const main = stripComments(read('main.js'));
  const handler = main.slice(main.indexOf("addEventListener('continuum:session-changed'"));

  it('routes off sessionChangeTarget(isSessionLive()) on every session change', () => {
    expect(handler).toMatch(/const\s+authed\s*=\s*isSessionLive\(\)/);
    expect(handler).toMatch(/navigate\(\s*sessionChangeTarget\(\s*authed\s*\)/);
  });

  it('replaces (not pushes) history on sign-out so Back cannot restore the dashboard', () => {
    // v0.2.75-alpha: on sign-out (authed === false) the current authenticated
    // entry is replaced, so the Back button has no dashboard entry to return to.
    expect(handler).toMatch(/\{\s*replace:\s*!authed\s*\}/);
  });

  it('does not gate the transition on the current route being the root', () => {
    // The old handler only acted when cr.pattern === '/', stranding sign-in/out
    // performed from the demo routes. The transition must be unconditional now.
    expect(handler).not.toMatch(/pattern\s*===\s*'\/'/);
  });
});

describe('wiring: main.js maps the application-first shell (source lock)', () => {
  const main = stripComments(read('main.js'));

  it('root route renders the login page via rootTarget, not the sales page', () => {
    expect(main).toMatch(/route\(\s*'\/'\s*,/);
    expect(main).toMatch(/rootTarget\(/);
    expect(main).toMatch(/renderLogin\(/);
    // The root handler must not render the About/sales content.
    const rootHandler = main.slice(main.indexOf("route('/',"), main.indexOf("route('/about'"));
    expect(rootHandler).not.toMatch(/renderAbout/);
  });

  it('about route renders the sales content and is separate from root', () => {
    const aboutHandler = main.slice(main.indexOf("route('/about'"), main.indexOf("route('/projects'"));
    expect(aboutHandler).toMatch(/renderAbout\(/);
  });

  it('every non-root route is wrapped in the central guard() helper', () => {
    // The guard() wrapper runs guardRedirect(pattern, isSessionLive()) and bails
    // before the wrapped renderer, so a logged-out visitor never sees the view.
    expect(main).toMatch(/function guarded\(pattern, handler\)/);
    expect(main).toMatch(/guardRedirect\(pattern, isSessionLive\(\)\)/);
    for (const p of ['/about', '/projects', '/marketplace', '/routstr', '/team', '/dashboard']) {
      expect(main).toMatch(new RegExp(`route\\(\\s*'${p.replace(/\//g, '\\/')}'\\s*,\\s*guarded\\(\\s*'${p.replace(/\//g, '\\/')}'`));
    }
  });

  it('the root/login route is NOT wrapped in the guard (it is the public surface)', () => {
    const rootHandler = main.slice(main.indexOf("route('/',"), main.indexOf("route('/about'"));
    expect(rootHandler).not.toMatch(/guarded\(/);
    expect(rootHandler).toMatch(/renderLogin\(/);
  });

  it('root no longer imports or renders the legacy renderLanding symbol', () => {
    expect(main).not.toMatch(/renderLanding/);
  });
});

describe('wiring: sales-page isolation + no external requests in new views', () => {
  it('login view is a dedicated surface, not the sales content', () => {
    const login = read('views/login.js');
    expect(login).toMatch(/export function renderLogin/);
    expect(login).toMatch(/startLogin/); // uses existing NIP-07 flow
    // No password field / secret handling invented.
    expect(login).not.toMatch(/type=["']password["']/i);
    expect(login).not.toMatch(/\bnsec\b\s*[:=]/i);
  });

  it('sales content lives only in the About view (renderAbout export)', () => {
    const about = read('views/landing.js');
    expect(about).toMatch(/export function renderAbout/);
    expect(about).not.toMatch(/export function renderLanding/);
  });

  it('new view sources contain no external loading vector (Google/CDN/etc.)', () => {
    for (const f of ['views/login.js', 'views/landing.js', 'nav-guard.js', 'main.js']) {
      const src = read(f);
      // No preconnect/script/style to any external host.
      const loaders = [...src.matchAll(/(?:@import\s+url\(|\bimport\(|\bfetch\(|\.src\s*=\s*|new\s+Image[^;]*\.src\s*=\s*)\s*["'`]?(https?:\/\/[^"'`)\s]+)/gi)];
      expect(loaders.length).toBe(0);
      // Belt and braces: no google/gstatic/fontshare/CDN host referenced as a resource.
      for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'googleapis.com', 'gstatic.com', 'api.fontshare.com', 'unpkg.com', 'jsdelivr.net', 'cdnjs']) {
        expect(src.includes(host)).toBe(false);
      }
    }
  });
});
