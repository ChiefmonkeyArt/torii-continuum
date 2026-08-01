/**
 * CONT-NAVSYNC-3 — the post-auth transition under BROWSER-ACCURATE globals.
 *
 * Every previous harness (including CONT-NAVSYNC-1 and -2) left Node's timers
 * installed as `globalThis.setTimeout` / `clearTimeout`. The application module
 * graph closes over those bindings at import time, so the code under test never
 * saw the object a real browser gives it: a WebIDL operation on `Window` that
 * brand-checks its receiver. Node's timers ignore `this` entirely.
 *
 * That single harness gap is why 1779 passing tests coexisted with an app that
 * no browser could sign into. `src/auth.js` stored `setTimeout` as a property
 * and called it as `deps.setTimer(...)`, which passes `deps` as the receiver:
 *
 *   • in every browser  → TypeError: Illegal invocation
 *   • in Node's timers  → works fine
 *
 * The throw landed in two places, producing the two reported symptoms:
 *
 *   1. PRE-REFRESH. `startSessionRefresh()` runs on the sign-in success path
 *      immediately after "Signed in." is shown and immediately BEFORE
 *      `continuum:session-changed` is dispatched. The throw skipped the
 *      dispatch, so the transition never began: login card still mounted,
 *      "Signed in." beneath it, session fully persisted.
 *   2. POST-REFRESH. `rehydrateSession()` calls it too, and that runs inside
 *      EVERY route handler. On a reload the throw escaped the handler into the
 *      router's fail-closed sink — "This screen failed to load / Your session
 *      is still valid." The reported route is whichever frame threw, so the
 *      deployed entry URL (`/continuum/`, no fragment) reports **Route /**.
 *
 * These tests therefore install brand-checked timers as the globals the module
 * graph binds, so the receiver contract is stated outright rather than
 * inherited from whatever the runtime happens to tolerate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const TOKEN_KEY = 'continuum.session.v1';
const EXPIRY_KEY = 'continuum.session.exp.v1';
const MARKER_KEY = 'continuum.session.meta.v1';
const PUBKEY = 'a'.repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (exp) => `1000.${exp}.${PUBKEY}.1000.sig`;

// Timers are part of this list deliberately — installing the Window's is the
// whole point of the file.
const GLOBALS = ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'];

// Vitest itself runs on these; they must be back in place before the next test.
const NODE_GLOBALS = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));

// Timer ids handed out by the Window, so a test can prove renewal was armed.
let scheduled = [];
let dom;
let errors = [];

const sameTurn = async (n = 80) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const laterTurns = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1)); };

/**
 * Wrap a Window operation in the WebIDL brand check every browser applies to
 * it: legal with no receiver (the global is substituted), TypeError with a
 * foreign one.
 *
 * The wrappers are installed on `globalThis` — the binding the application's
 * module graph actually closes over — and NOT onto the Window itself, whose own
 * property jsdom's timer internals re-enter.
 */
function brandChecked(window, name) {
  // Schedule through the runtime's own timer rather than the Window's: jsdom
  // implements `window.setTimeout` by calling the bare global `setTimeout`, so
  // a wrapper installed over that global and delegating to the Window would
  // call itself forever. Only the receiver check is being modelled here.
  const real = NODE_GLOBALS[name];
  if (typeof real !== 'function') return undefined;
  return function checked(...args) {
    if (this != null && this !== globalThis && this !== window) {
      throw new TypeError(`Failed to execute '${name}' on 'Window': Illegal invocation`);
    }
    const id = real(...args);
    if (name === 'setTimeout') scheduled.push(id);
    return id;
  };
}

function makeWindow({ seed = {}, hash = '', signer = true } = {}) {
  // The deployed base path, and — for the default case — the production entry
  // URL, which carries NO fragment. That is the state that reports "Route /".
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${hash}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  window.__pushCount = 0;
  const realPush = window.history.pushState.bind(window.history);
  window.history.pushState = (...a) => { window.__pushCount += 1; return realPush(...a); };

  if (signer) {
    window.nostr = {
      signEvent: (e) => Promise.resolve({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY }),
      getPublicKey: async () => PUBKEY,
    };
  }

  for (const k of GLOBALS) {
    if (k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
    const fn = brandChecked(window, name);
    if (fn) globalThis[name] = fn;
  }

  globalThis.console.error = (...a) => {
    errors.push(a.map((x) => (x && x.stack ? x.stack : String(x))).join(' '));
  };
  return window;
}

function mockAgent({ verify } = {}) {
  const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = vi.fn((u) => {
    u = String(u);
    if (u.includes('/api/auth/challenge')) return reply({ ok: true, challenge: 'c'.repeat(64), expires_in: 120 });
    if (u.includes('/api/auth/verify')) {
      const n = nowSec();
      return verify ? verify(n, reply) : reply({ ok: true, token: tokenFor(n + 3600), expires_at: n + 3600 });
    }
    if (u.includes('/api/version')) return reply({ ok: true, current: '0.2.99-alpha' });
    return reply({}, 404);
  });
}

const liveSeed = () => {
  const n = nowSec();
  return {
    [TOKEN_KEY]: tokenFor(n + 3600),
    [EXPIRY_KEY]: String(n + 3600),
    [MARKER_KEY]: JSON.stringify({ npub: 'npub1x', connected_at: n }),
  };
};

/** Counted across the WHOLE document, so a surface parked outside the mount fails. */
const loginSurfaces = (w) => w.document.querySelectorAll('.login-scene, .login-card, .login-bg').length;
const title = (w) => w.document.querySelector('#main-content .page-title')?.textContent || '';
const routeErrorDetail = (w) => w.document.querySelector('.route-error-detail')?.textContent || '';
const hasRouteError = (w) => !!w.document.querySelector('.route-error');
const sessionBtn = (w) => w.document.querySelector('[data-session-toggle]');
const sessionIntent = (w) => sessionBtn(w)?.getAttribute('data-session-intent');

/** Sign out for real: the control opens a confirmation modal, then "Yes". */
function signOut(w) {
  sessionBtn(w)?.dispatchEvent(new w.Event('click', { bubbles: true }));
  const yes = Array.from(w.document.querySelectorAll('.modal-backdrop button'))
    .find((b) => /^yes$/i.test((b.textContent || '').trim()));
  yes?.dispatchEvent(new w.Event('click', { bubbles: true }));
  return !!yes;
}

beforeEach(() => { vi.resetModules(); errors = []; scheduled = []; });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) { /* already closed */ }
  for (const k of GLOBALS) delete globalThis[k];
  Object.assign(globalThis, NODE_GLOBALS);
  dom = undefined;
});

describe('CONT-NAVSYNC-3: the injected timer is callable in a browser', () => {
  it('startSessionRefresh arms renewal without an Illegal invocation', async () => {
    makeWindow({ seed: liveSeed() });
    mockAgent();
    const { startSessionRefresh, stopSessionRefresh } = await import('./auth.js');
    expect(() => startSessionRefresh()).not.toThrow();
    // Not "fixed" by never scheduling anything: renewal really is armed.
    expect(scheduled.length).toBeGreaterThan(0);
    stopSessionRefresh();
  });

  it('a Window timer called with a foreign receiver still throws (the harness is honest)', async () => {
    makeWindow({ seed: liveSeed() });
    // Exactly the shape src/auth.js used to have: the native stored on an
    // object, then invoked as that object's method.
    const holder = { setTimer: globalThis.setTimeout };
    expect(() => holder.setTimer(() => {}, 0)).toThrow(/Illegal invocation/);
    // ...and the shape it has now: called as a bare identifier, no receiver.
    const bare = globalThis.setTimeout;
    expect(() => bare(() => {}, 0)).not.toThrow();
  });
});

describe('CONT-NAVSYNC-3: post-refresh boot with a live session', () => {
  // '' is the production entry URL. It is the case that reported "Route /".
  for (const hash of ['', '#/', '#/dashboard']) {
    it(`renders the Dashboard at entry ${JSON.stringify(hash) || '(no fragment)'}`, async () => {
      const w = makeWindow({ hash, seed: liveSeed() });
      mockAgent();
      await import('./main.js');
      await sameTurn();

      expect(hasRouteError(w)).toBe(false);
      expect(routeErrorDetail(w)).toBe('');
      expect(errors.join('\n')).not.toContain('route render failed');
      expect(title(w)).toBe('Dashboard');
      expect(loginSurfaces(w)).toBe(0);
      expect(w.localStorage.getItem(TOKEN_KEY)).toBeTruthy();
    });
  }

  it('never shows the fail-closed panel for Route / while the session is valid', async () => {
    const w = makeWindow({ seed: liveSeed() });
    mockAgent();
    await import('./main.js');
    await sameTurn();
    await laterTurns();

    // The exact production report, asserted as text.
    expect(w.document.body.textContent).not.toContain('This screen failed to load');
    expect(w.document.body.textContent).not.toContain('Route /');
    expect(title(w)).toBe('Dashboard');
  });

  it('offers Sign Out and does not bounce back on later turns', async () => {
    const w = makeWindow({ seed: liveSeed() });
    mockAgent();
    await import('./main.js');
    await sameTurn();
    await laterTurns();

    expect(sessionIntent(w)).toBe('signout');
    expect(title(w)).toBe('Dashboard');
    expect(loginSurfaces(w)).toBe(0);
  });
});

describe('CONT-NAVSYNC-3: sign-in transition (pre-refresh)', () => {
  it('publishes the session change and leaves the login card', async () => {
    const w = makeWindow();
    mockAgent();
    let published = 0;
    w.document.addEventListener('continuum:session-changed', () => { published += 1; });

    await import('./main.js');
    await sameTurn();
    expect(loginSurfaces(w)).toBeGreaterThan(0);

    w.document.querySelector('.login-btn')?.dispatchEvent(new w.Event('click'));
    await laterTurns(30);

    // The dispatch sits on the line AFTER startSessionRefresh(); a throw there
    // is what silently ate the whole transition.
    expect(published).toBeGreaterThan(0);
    expect(loginSurfaces(w)).toBe(0);
    expect(title(w)).toBe('Dashboard');
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeTruthy();
    expect(sessionIntent(w)).toBe('signout');
    expect(w.__pushCount).toBe(0);
    expect(hasRouteError(w)).toBe(false);
  });

  it('survives a hard refresh at whatever the address bar ended up saying', async () => {
    // --- turn 1: sign in at the production entry URL
    const w1 = makeWindow();
    mockAgent();
    await import('./main.js');
    await sameTurn();
    w1.document.querySelector('.login-btn')?.dispatchEvent(new w1.Event('click'));
    await laterTurns(30);

    const href = w1.location.href;
    const storage = {};
    for (let i = 0; i < w1.localStorage.length; i++) {
      const k = w1.localStorage.key(i);
      storage[k] = w1.localStorage.getItem(k);
    }
    try { dom.window.close(); } catch (_e) { /* already closed */ }
    for (const k of GLOBALS) delete globalThis[k];
    Object.assign(globalThis, NODE_GLOBALS);

    // --- turn 2: a real reload of that URL, with the persisted session
    vi.resetModules();
    errors = [];
    scheduled = [];
    const w2 = makeWindow({ hash: href.includes('#') ? `#${href.split('#')[1]}` : '', seed: storage });
    mockAgent();
    await import('./main.js');
    await sameTurn();
    await laterTurns();

    expect(hasRouteError(w2)).toBe(false);
    expect(title(w2)).toBe('Dashboard');
    expect(loginSurfaces(w2)).toBe(0);
  });
});

describe('CONT-NAVSYNC-3: auth protections hold under browser globals', () => {
  it('a verify 200 carrying no token does not sign anyone in', async () => {
    const w = makeWindow();
    mockAgent({ verify: (_n, reply) => reply({ ok: true }) });
    await import('./main.js');
    await sameTurn();
    w.document.querySelector('.login-btn')?.dispatchEvent(new w.Event('click'));
    await laterTurns(30);

    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(loginSurfaces(w)).toBeGreaterThan(0);
    expect(title(w)).not.toBe('Dashboard');
  });

  it('a token that is already expired does not sign anyone in', async () => {
    const w = makeWindow();
    mockAgent({ verify: (n, reply) => reply({ ok: true, token: tokenFor(n - 60), expires_at: n - 60 }) });
    await import('./main.js');
    await sameTurn();
    w.document.querySelector('.login-btn')?.dispatchEvent(new w.Event('click'));
    await laterTurns(30);

    expect(loginSurfaces(w)).toBeGreaterThan(0);
    expect(title(w)).not.toBe('Dashboard');
  });

  it('a rejected signature leaves the operator on login', async () => {
    const w = makeWindow();
    mockAgent({ verify: (_n, reply) => reply({ ok: false, error: 'bad signature' }, 401) });
    await import('./main.js');
    await sameTurn();
    w.document.querySelector('.login-btn')?.dispatchEvent(new w.Event('click'));
    await laterTurns(30);

    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(loginSurfaces(w)).toBeGreaterThan(0);
  });

  it('a logged-out deep link to #/dashboard is bounced to login, not to the error panel', async () => {
    const w = makeWindow({ hash: '#/dashboard' });
    mockAgent();
    await import('./main.js');
    await sameTurn();

    expect(hasRouteError(w)).toBe(false);
    expect(loginSurfaces(w)).toBeGreaterThan(0);
    expect(title(w)).not.toBe('Dashboard');
  });

  it('an expired stored session boots to login with the marker dropped', async () => {
    const n = nowSec();
    const w = makeWindow({
      seed: {
        [TOKEN_KEY]: tokenFor(n - 60),
        [EXPIRY_KEY]: String(n - 60),
        [MARKER_KEY]: JSON.stringify({ npub: 'npub1x', connected_at: n - 3600 }),
      },
    });
    mockAgent();
    await import('./main.js');
    await sameTurn();

    expect(hasRouteError(w)).toBe(false);
    expect(loginSurfaces(w)).toBeGreaterThan(0);
    expect(w.localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it('sign-out clears the session and returns to login', async () => {
    const w = makeWindow({ seed: liveSeed() });
    mockAgent();
    await import('./main.js');
    await sameTurn();
    expect(title(w)).toBe('Dashboard');

    expect(signOut(w)).toBe(true);
    await laterTurns(30);

    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(loginSurfaces(w)).toBeGreaterThan(0);
    expect(hasRouteError(w)).toBe(false);
  });
});
