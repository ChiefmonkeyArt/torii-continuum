/**
 * CONT-NAVSYNC-2 — the sign-in that finished, updated the address bar, and
 * still left the operator on the login page.
 *
 * v0.2.98 moved the post-auth render into the same turn as the URL write, which
 * removed the app's dependency on the `hashchange` event. It did not remove the
 * dependency underneath: `resolve()` still asked `window.location.hash` WHAT to
 * render. The URL is the one piece of state in this transition the app writes
 * but does not own, and a `location.replace()` fragment navigation goes through
 * the browser's session-history traversal queue — so the read-back is not
 * guaranteed to reflect the write in the same turn, and the write can be
 * deferred or refused outright. Whenever the read-back was stale the router
 * rendered the route for the OLD hash, which after a sign-in is the login card
 * the operator had just come from.
 *
 * These tests therefore do NOT model event delivery — `post-auth-navigation`
 * already owns that. They model the URL WRITE, at the deployed base path
 * `/continuum/` and from the production entry URL (no fragment at all, which is
 * what an operator typing the address gets). Four browsers, all real-world
 * shapes of the same thing:
 *
 *   published  — the write lands synchronously (a compliant browser)
 *   deferred   — the write lands a macrotask later, no event follows
 *   refused    — the write is silently dropped and the address bar never moves
 *   throwing   — the write raises, as it does when the navigation is blocked
 *
 * Under v0.2.98 `deferred` and `refused` recurse the guard chain into
 * MAX_REDIRECT_DEPTH and hand the operator the fail-closed error panel, and
 * `throwing` eats the entire transition and leaves the login card mounted with
 * "Signed in." beneath it. All four must reach the Dashboard, in the turn the
 * signer was approved in, with every login surface gone from the document.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const TOKEN_KEY = 'continuum.session.v1';
const EXPIRY_KEY = 'continuum.session.exp.v1';
const MARKER_KEY = 'continuum.session.meta.v1';
const PUBKEY = 'a'.repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (exp) => `1000.${exp}.${PUBKEY}.1000.sig`;

const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

/** Drain microtasks only — the operator's single browser turn. */
const sameTurn = async (n = 80) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** Let the task queue run too, so a deferred URL write and its events land. */
const laterTurns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};

// ─── The four browsers ──────────────────────────────────────
//
// Each returns a stand-in for `window.location`. It must be a PLAIN object:
// a Proxy over a real Location violates proxy invariants, because `replace` is
// a non-configurable data property, and the resulting TypeError would be the
// harness failing rather than the app.

function fakeLocation(loc, { replace }) {
  const fake = {};
  for (const k of ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'origin']) {
    Object.defineProperty(fake, k, { enumerable: true, get: () => loc[k] });
  }
  Object.defineProperty(fake, 'hash', {
    enumerable: true, get: () => loc.hash, set: (v) => { loc.hash = v; },
  });
  fake.assign = (u) => loc.assign(u);
  fake.reload = () => {};
  fake.toString = () => loc.href;
  fake.replace = replace(loc);
  return fake;
}

const BROWSERS = {
  // Spec-compliant: the fragment write is visible immediately.
  published: (w) => fakeLocation(w.location, { replace: (loc) => (u) => loc.replace(u) }),

  // The write is queued. `window.location.hash` still reads the OLD value for
  // the rest of this turn, and no event follows to correct it.
  deferred: (w) => fakeLocation(w.location, {
    replace: () => (u) => {
      setTimeout(() => { try { w.history.replaceState(null, '', u); } catch (_e) {} }, 0);
    },
  }),

  // The navigation is dropped on the floor: no error, no URL change, ever.
  refused: () => fakeLocation(dom.window.location, { replace: () => () => {} }),

  // The navigation is blocked and says so.
  throwing: (w) => fakeLocation(w.location, {
    replace: () => () => { throw new Error('navigation blocked'); },
  }),
};

/**
 * Boot the real app against the deployed base path.
 * @param {object} [o]
 * @param {keyof BROWSERS} [o.browser]
 * @param {string} [o.hash] starting fragment; DEFAULT IS NONE, which is what an
 *   operator who typed `https://host/continuum/` actually has. The app's boot
 *   resolve normalises that to '#/' internally without ever writing the URL, so
 *   the address bar and `renderedHash` start out disagreeing — the state every
 *   previous harness skipped by starting at '#/'.
 * @param {object} [o.seed] localStorage to boot against
 * @param {(n: number) => object} [o.verifyBody] the agent's /api/auth/verify reply
 * @param {number} [o.signerDelay] ms before the signer answers
 */
function makeWindow(o = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${o.hash || ''}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(o.seed || {})) window.localStorage.setItem(k, v);
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  window.__pushCount = 0;
  const realPush = window.history.pushState.bind(window.history);
  window.history.pushState = (...a) => { window.__pushCount += 1; return realPush(...a); };

  const signerDelay = o.signerDelay ?? 0;
  window.__signerCalls = 0;
  window.nostr = {
    signEvent: (e) => {
      window.__signerCalls += 1;
      const signed = { ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY };
      return signerDelay
        ? new Promise((r) => setTimeout(() => r(signed), signerDelay))
        : Promise.resolve(signed);
    },
    getPublicKey: async () => PUBKEY,
  };

  for (const k of GLOBALS) {
    if (k === 'fetch' || k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.window = o.browser
    ? new Proxy(window, {
      get(t, p) {
        if (p === 'location') return t.__fakeLocation;
        const v = t[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t, p, v) { t[p] = v; return true; },
      has(t, p) { return p in t; },
    })
    : window;
  if (o.browser) window.__fakeLocation = BROWSERS[o.browser](window);
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  const verifyBody = o.verifyBody || ((n) => ({ ok: true, token: tokenFor(n + 3600), expires_at: n + 3600 }));
  const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = vi.fn((u) => {
    u = String(u);
    if (u.includes('/api/auth/challenge')) return reply({ ok: true, challenge: 'c'.repeat(64), expires_in: 120 });
    if (u.includes('/api/auth/verify')) return reply(verifyBody(nowSec()));
    if (u.includes('/api/version')) return reply({ ok: true, current: '0.2.99-alpha' });
    return reply({}, 404);
  });
  return window;
}

/** Everything the operator can actually observe, in one object. */
const observe = (w) => ({
  hash: w.location.hash,
  // "Every login surface", not just the card: the scene wrapper carries the
  // full-viewport backdrop as well, and it is queried across the WHOLE document
  // rather than the mount, so a surface parked outside #main-content would fail.
  loginSurfaces: w.document.querySelectorAll('.login-scene, .login-card, .login-bg').length,
  title: w.document.querySelector('#main-content .page-title')?.textContent || '',
  dashboard: !!w.document.querySelector('#main-content .page-title'),
  landing: w.document.getElementById('app').classList.contains('landing-mode'),
  sessionIntent: w.document.querySelector('[data-session-toggle]')?.getAttribute('data-session-intent'),
  sidebarVisible: !!w.document.querySelector('.sidebar .nav-item'),
  routeError: !!w.document.querySelector('.route-error'),
  token: w.localStorage.getItem(TOKEN_KEY),
});

async function bootAndSignIn(w, { settle = laterTurns } = {}) {
  await import('./main.js');
  await sameTurn();
  const btn = w.document.querySelector('.login-btn');
  expect(btn, 'login card must be the boot surface').toBeTruthy();
  btn.dispatchEvent(new w.Event('click'));
  await settle();
  return observe(w);
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

describe('a verified sign-in transitions off the login page in every browser', () => {
  for (const browser of Object.keys(BROWSERS)) {
    describe(`browser: the URL write is ${browser}`, () => {
      it('renders the Dashboard and removes every login surface', async () => {
        const w = makeWindow({ browser });
        const s = await bootAndSignIn(w);

        expect(s.loginSurfaces, 'a login surface survived the transition').toBe(0);
        expect(s.dashboard).toBe(true);
        expect(s.title).toBe('Dashboard');
        expect(s.routeError, 'the transition fell through to the error panel').toBe(false);
      });

      it('updates navigation state and the Sign Out control in the same flow', async () => {
        const w = makeWindow({ browser });
        const s = await bootAndSignIn(w);

        expect(s.landing, 'landing-mode must be off once the shell is live').toBe(false);
        expect(s.sidebarVisible).toBe(true);
        expect(s.sessionIntent).toBe('signout');
      });

      it('persists the session and never pushes a history entry', async () => {
        const w = makeWindow({ browser });
        const s = await bootAndSignIn(w);

        expect(s.token).toBeTruthy();
        expect(w.localStorage.getItem(MARKER_KEY)).toBeTruthy();
        expect(w.__pushCount, 'sign-in must replace, never push').toBe(0);
      });

      it('completes in the turn the signer was approved in', async () => {
        const w = makeWindow({ browser });
        // sameTurn drains microtasks ONLY: no macrotask, so a deferred URL write
        // has NOT landed and no hashchange has been delivered. The Dashboard must
        // already be on screen anyway.
        const s = await bootAndSignIn(w, { settle: sameTurn });

        expect(s.loginSurfaces).toBe(0);
        expect(s.title).toBe('Dashboard');
        expect(s.routeError).toBe(false);
      });

      it('does not bounce back to login once later turns run', async () => {
        const w = makeWindow({ browser });
        await bootAndSignIn(w, { settle: sameTurn });
        // The trailing hashchange / popstate / deferred write all land here. None
        // of them may rebuild the login surface over a live session.
        await laterTurns(40);
        const s = observe(w);

        expect(s.loginSurfaces).toBe(0);
        expect(s.title).toBe('Dashboard');
        expect(s.sessionIntent).toBe('signout');
      });
    });
  }

  it('reaches the Dashboard with a human-scale signer wait and a real fragment write', async () => {
    const w = makeWindow({ browser: 'published', signerDelay: 25 });
    const s = await bootAndSignIn(w, { settle: () => laterTurns(60) });

    expect(w.__signerCalls).toBe(1);
    expect(s.hash).toBe('#/dashboard');
    expect(s.loginSurfaces).toBe(0);
    expect(s.title).toBe('Dashboard');
  });

  it('writes #/dashboard when the browser lets it, so a reload lands in the same place', async () => {
    const w = makeWindow({ browser: 'published' });
    const s = await bootAndSignIn(w);
    expect(s.hash).toBe('#/dashboard');
  });

  it('still shows the Dashboard when the address bar itself is stuck', async () => {
    // The `refused` browser never moves the URL. That is a cosmetic failure the
    // app cannot fix; being unable to USE the app is not. The screen must be
    // correct even when the address bar is not.
    const w = makeWindow({ browser: 'refused' });
    const s = await bootAndSignIn(w);
    expect(s.hash).toBe('');
    expect(s.title).toBe('Dashboard');
    expect(s.loginSurfaces).toBe(0);
  });
});

describe('the transition preserves every auth and stale-response protection', () => {
  it('navigates nowhere when a 200 carries no token', async () => {
    const w = makeWindow({ browser: 'deferred', verifyBody: () => ({ ok: true }) });
    const s = await bootAndSignIn(w);

    expect(s.loginSurfaces).toBeGreaterThan(0);
    expect(s.title).toBe('');
    expect(s.token).toBeNull();
    expect(s.sessionIntent).not.toBe('signout');
  });

  it('navigates nowhere when the token is born expired', async () => {
    const w = makeWindow({
      browser: 'deferred',
      verifyBody: (n) => ({ ok: true, token: tokenFor(n - 60), expires_at: n - 60 }),
    });
    const s = await bootAndSignIn(w);

    expect(s.loginSurfaces).toBeGreaterThan(0);
    expect(s.title).toBe('');
  });

  it('navigates nowhere when the agent rejects the signature', async () => {
    const w = makeWindow({
      browser: 'throwing',
      verifyBody: () => ({ ok: false, code: 'bad_signature', reason: 'bad signature' }),
    });
    const s = await bootAndSignIn(w);

    expect(s.loginSurfaces).toBeGreaterThan(0);
    expect(s.token).toBeNull();
  });

  it('does not resurrect an attempt the operator cancelled, even mid-write', async () => {
    const w = makeWindow({ browser: 'deferred', signerDelay: 10 });
    await import('./main.js');
    await sameTurn();
    const { cancelLogin } = await import('./auth.js');

    w.document.querySelector('.login-btn').dispatchEvent(new w.Event('click'));
    await sameTurn();
    cancelLogin();
    await laterTurns(40);
    const s = observe(w);

    expect(s.loginSurfaces).toBeGreaterThan(0);
    expect(s.title).toBe('');
    expect(s.token, 'a cancelled attempt must not leave a session behind').toBeNull();
  });

  it('a logged-out deep link to a protected hash still lands on login, not the Dashboard', async () => {
    const w = makeWindow({ browser: 'deferred', hash: '#/dashboard' });
    await import('./main.js');
    await sameTurn();
    const s = observe(w);

    expect(s.loginSurfaces).toBeGreaterThan(0);
    expect(s.title).toBe('');
  });

  it('sign-out leaves no authenticated surface standing, in every browser', async () => {
    for (const browser of Object.keys(BROWSERS)) {
      vi.resetModules();
      const w = makeWindow({ browser });
      await bootAndSignIn(w);
      const { endSession } = await import('./auth.js');

      endSession();
      await laterTurns(20);
      const s = observe(w);

      expect(s.title, `${browser}: dashboard survived sign-out`).toBe('');
      expect(s.loginSurfaces, `${browser}: login must be back`).toBeGreaterThan(0);
      expect(s.token).toBeNull();

      try { dom?.window?.close(); } catch (_e) {}
    }
  });
});
