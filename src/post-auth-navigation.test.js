/**
 * CONT-NAVSYNC-1 — sign-in succeeds and the operator stays on the login page.
 *
 * The v0.2.97 report, verbatim in behaviour: the signer is approved, the agent
 * verifies, the token is persisted AND read back — and the login card is still
 * the only thing on screen. Ctrl+R then opens the Dashboard, which is the proof
 * that nothing was wrong with the session: storage was correct all along and it
 * was the in-memory transition that never happened.
 *
 * The mechanism was that the transition was not performed, only *scheduled*.
 * navigate() wrote the hash and returned; rendering the new route was the job of
 * the `hashchange` event alone. Between the URL write and the browser delivering
 * that event there was a window in which the address bar said `#/dashboard` and
 * the DOM said login — and for a browser that coalesces, defers or (for a
 * `location.replace()` fragment navigation) withholds the event, that window
 * never closed. A second, quieter version of the same fault sat in the
 * session-changed listener, which re-rendered the sidebar BEFORE navigating:
 * an exception there never reaches dispatchEvent, so it silently ate the
 * transition and produced exactly the same screen.
 *
 * So these tests refuse to let a macrotask run. Everything they assert about the
 * post-verify turn is asserted after MICROTASKS only — the same turn the sign-in
 * completed in — and one of them boots a window whose `hashchange` is never
 * delivered at all, which is the production browser this was reported from as
 * far as the app can tell.
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

/**
 * Drain MICROTASKS only. A promise chain settles; a queued `hashchange`,
 * a setTimeout or anything else on the task queue does not. This is the whole
 * instrument: it is the operator's single browser turn.
 */
const sameTurn = async (n = 60) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** Let the task queue run too — i.e. later turns, including `hashchange`. */
const laterTurns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};

/**
 * @param {object} [o]
 * @param {string} [o.hash] starting hash
 * @param {object} [o.seed] localStorage to boot against
 * @param {boolean} [o.deafToFragmentEvents] model the browser this was reported
 *   from: the fragment write lands in the address bar and NO event follows it.
 *   Both `hashchange` and `popstate` are suppressed. Suppressing popstate is not
 *   artificial severity — a script-initiated fragment navigation fires
 *   `hashchange` only, never `popstate`; jsdom fires popstate anyway, and that
 *   quirk alone was enough to rescue the pre-fix app in this harness. The app
 *   must reach the Dashboard with neither event.
 * @param {(n: number) => object} [o.verifyBody] agent reply to /api/auth/verify
 */
function makeWindow(o = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${o.hash || '#/'}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(o.seed || {})) window.localStorage.setItem(k, v);
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  window.__signerCalls = 0;
  window.nostr = {
    signEvent: async (e) => {
      window.__signerCalls += 1;
      return { ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY };
    },
    getPublicKey: async () => PUBKEY,
  };

  if (o.deafToFragmentEvents) {
    const realAdd = window.addEventListener.bind(window);
    window.addEventListener = (type, fn, opts) => {
      if (type === 'hashchange' || type === 'popstate') return;
      return realAdd(type, fn, opts);
    };
  }

  // Count history entries the app creates. A fragment write via location.replace
  // must not add one; a push would.
  window.__pushCount = 0;
  const realPush = window.history.pushState.bind(window.history);
  window.history.pushState = (...a) => { window.__pushCount += 1; return realPush(...a); };

  for (const k of GLOBALS) {
    if (k === 'fetch' || k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  const verifyBody = o.verifyBody || (() => ({
    ok: true, token: tokenFor(nowSec() + 3600), expires_at: nowSec() + 3600,
  }));

  window.__requests = [];
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    window.__requests.push(u);
    if (u.includes('/api/auth/challenge')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, challenge: 'c'.repeat(64), expires_in: 120 }) };
    }
    if (u.includes('/api/auth/verify')) {
      return { ok: true, status: 200, json: async () => verifyBody() };
    }
    if (u.includes('/api/version')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, current: '0.2.98-alpha' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return window;
}

async function bootApp(o) {
  const w = makeWindow(o);
  await import('./main.js');
  await laterTurns();
  return w;
}

/** A real hard refresh: new window, fresh modules, only storage survives. */
async function hardRefresh(w, hash = '#/') {
  const seed = {};
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    seed[k] = w.localStorage.getItem(k);
  }
  try { w.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  vi.resetModules();
  return bootApp({ hash, seed });
}

const mainOf = (w) => w.document.getElementById('main-content');
const loginCard = (w) => w.document.querySelector('.login-card');
const sessionBtn = (w) => w.document.querySelector('[data-session-toggle]');
const dashboardTitle = (w) => {
  const el = mainOf(w).querySelector('.page-title');
  return el ? el.textContent : '';
};
const landingMode = (w) => w.document.getElementById('app').classList.contains('landing-mode');

/** Click Sign in and drain MICROTASKS only — one browser turn, no `hashchange`. */
async function signInSameTurn(w) {
  w.document.querySelector('.login-btn').dispatchEvent(new w.Event('click'));
  await sameTurn();
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

// ─── The reported bug ────────────────────────────────────────

describe('a verified sign-in reaches the Dashboard in the same turn', () => {
  it('replaces the login surface without waiting for hashchange', async () => {
    const w = await bootApp();
    expect(loginCard(w)).not.toBeNull();

    await signInSameTurn(w);

    // No macrotask has run. This is the turn the operator's click happened in.
    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
    expect(dashboardTitle(w)).toBe('Dashboard');
  });

  it('renders the Dashboard even when no navigation event is ever delivered', async () => {
    // The production symptom as the app can observe it: the URL write lands, no
    // event follows. Before CONT-NAVSYNC-1 the render had no trigger of its own,
    // so this window sat on the login card forever with a valid session.
    const w = await bootApp({ deafToFragmentEvents: true });
    await signInSameTurn(w);
    await laterTurns();

    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
    expect(dashboardTitle(w)).toBe('Dashboard');
  });

  it('leaves landing-mode so the app chrome is back', async () => {
    const w = await bootApp();
    expect(landingMode(w)).toBe(true);

    await signInSameTurn(w);

    expect(landingMode(w)).toBe(false);
  });

  it('shows Sign out in the same turn, bound to the sign-out intent', async () => {
    const w = await bootApp();
    expect(sessionBtn(w).getAttribute('data-session-intent')).toBe('signin');

    await signInSameTurn(w);

    expect(sessionBtn(w).getAttribute('data-session-intent')).toBe('signout');
    expect(sessionBtn(w).textContent).toMatch(/sign out/i);
  });

  it('renders protected Dashboard content, not an empty pane', async () => {
    const w = await bootApp();
    await signInSameTurn(w);

    expect(mainOf(w).querySelectorAll('.card').length).toBeGreaterThan(0);
    expect(mainOf(w).textContent).toMatch(/Overall progress/);
  });

  it('does not need a reload — but a reload lands in the same place', async () => {
    const w = await bootApp();
    await signInSameTurn(w);
    await laterTurns();

    const after = await hardRefresh(w, '#/dashboard');

    expect(after.location.hash).toBe('#/dashboard');
    expect(loginCard(after)).toBeNull();
    expect(dashboardTitle(after)).toBe('Dashboard');
  });
});

// ─── Ordering and races ──────────────────────────────────────

describe('the order the post-verify turn happens in', () => {
  it('says "Signed in." before publishing, and publishes before rendering', async () => {
    const w = makeWindow();
    const auth = await import('./auth.js');
    const trace = [];
    w.document.addEventListener('continuum:session-changed', () => {
      trace.push('session-changed');
      trace.push(`live:${auth.isSessionLive()}`);
    });
    await auth.startLogin({ onStatus: (s) => { if (s.done) trace.push('done'); } });
    await sameTurn();

    expect(trace).toEqual(['done', 'session-changed', 'live:true']);
  });

  it('publishes a session the listener can already read back from storage', async () => {
    // The listener navigates, and the guard it triggers asks storage. Publishing
    // before the token settled would bounce the operator straight back to login.
    const w = makeWindow();
    const auth = await import('./auth.js');
    let tokenSeen = null;
    let markerSeen = null;
    w.document.addEventListener('continuum:session-changed', () => {
      tokenSeen = w.localStorage.getItem(TOKEN_KEY);
      markerSeen = w.localStorage.getItem(MARKER_KEY);
    });
    await auth.startLogin();
    await sameTurn();

    expect(tokenSeen).toBeTruthy();
    expect(markerSeen).toBeTruthy();
    expect(JSON.parse(markerSeen).npub).toBe(PUBKEY);
  });

  it('has already released the login latch by the time the Dashboard renders', async () => {
    // The dashboard is built while startLogin is still on the stack. With the
    // latch still held, a sign-in control on the new screen answered "already
    // signing in" and the never-wedge watchdog was still armed to write an error
    // over a surface the attempt no longer owns.
    const w = makeWindow();
    const auth = await import('./auth.js');
    let latchAtPublish = null;
    w.document.addEventListener('continuum:session-changed', () => {
      latchAtPublish = auth.isLoginInFlight();
    });
    await auth.startLogin();
    await sameTurn();

    expect(latchAtPublish).toBe(false);
    expect(auth.isLoginInFlight()).toBe(false);
    expect(auth.loginStage()).toBeNull();
  });

  it('runs the guard exactly once and does not bounce back to login', async () => {
    const w = await bootApp();
    await signInSameTurn(w);
    await laterTurns();

    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
  });

  it('ignores the hashchange that trails a navigate it already rendered', async () => {
    // navigate() renders synchronously, so the event is now an echo. Acting on
    // it would rebuild the identical view a second time and throw away whatever
    // the operator had already touched on it.
    const w = await bootApp();
    await signInSameTurn(w);
    const first = mainOf(w).querySelector('.page-title');

    w.dispatchEvent(new w.Event('hashchange'));

    expect(mainOf(w).querySelector('.page-title')).toBe(first);
  });

  it('a sidebar that throws on sign-out cannot strand the operator on a protected screen', async () => {
    // A listener exception never reaches dispatchEvent, so anything ordered
    // ahead of the navigation could silently eat it. On sign-out that is not a
    // cosmetic failure: the dashboard stays on screen with a dead session.
    const w = await bootApp();
    await signInSameTurn(w);
    await laterTurns();
    expect(dashboardTitle(w)).toBe('Dashboard');

    Object.defineProperty(w.document.querySelector('.sidebar'), 'innerHTML', {
      set() { throw new Error('sidebar render failed'); },
      get() { return ''; },
      configurable: true,
    });

    const auth = await import('./auth.js');
    auth.endSession();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
  });
});

// ─── History and loops ───────────────────────────────────────

describe('history stays clean', () => {
  it('replaces the login entry rather than pushing the dashboard on top', async () => {
    const w = await bootApp();
    const before = w.history.length;

    await signInSameTurn(w);
    await laterTurns();

    expect(w.history.length).toBe(before);
    expect(w.__pushCount).toBe(0);
  });

  it('does not re-enter the signer or re-verify after the transition', async () => {
    const w = await bootApp();
    await signInSameTurn(w);
    await laterTurns();

    expect(w.__signerCalls).toBe(1);
    expect(w.__requests.filter((u) => u.includes('/api/auth/verify')).length).toBe(1);
  });

  it('bounces a logged-out visitor to login once and stops there', async () => {
    const w = await bootApp({ hash: '#/dashboard' });

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
  });
});

// ─── v0.2.97 guarantees that must survive ────────────────────

describe('the v0.2.97 protections are intact', () => {
  it('a 200 with no token neither navigates nor claims a session', async () => {
    const w = await bootApp({ verifyBody: () => ({ ok: true }) });
    await signInSameTurn(w);
    await laterTurns();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(w.document.querySelector('.login-inline-status').textContent).toMatch(/no session/i);
  });

  it('a token that is born expired stays on the login card and names the clock', async () => {
    const w = await bootApp({
      verifyBody: () => ({ ok: true, token: tokenFor(nowSec() - 10), expires_at: nowSec() - 10 }),
    });
    await signInSameTurn(w);
    await laterTurns();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
    expect(w.document.querySelector('.login-inline-status').textContent).toMatch(/clock/i);
  });

  it('a cancelled attempt whose verify lands late navigates nowhere', async () => {
    // Stale-response protection. The reply arrives after the operator gave up,
    // and now that navigation is synchronous a leaked one would yank a signed-out
    // screen onto the Dashboard rather than merely writing a stale token.
    const w = makeWindow();
    let release;
    const held = new Promise((r) => { release = r; });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes('/api/auth/verify')) {
        await held;
      }
      return realFetch(url, init);
    });

    await import('./main.js');
    await laterTurns();

    const trace = [];
    w.document.addEventListener('continuum:session-changed', () => trace.push('session-changed'));
    w.document.querySelector('.login-btn').dispatchEvent(new w.Event('click'));
    await sameTurn();

    const auth = await import('./auth.js');
    expect(auth.isLoginInFlight()).toBe(true);
    auth.cancelLogin();

    release();
    await laterTurns();

    expect(trace).toEqual([]);
    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('signing out returns to login in the same turn, with no way back', async () => {
    const w = await bootApp();
    await signInSameTurn(w);
    await laterTurns();
    expect(loginCard(w)).toBeNull();

    const auth = await import('./auth.js');
    auth.endSession();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).not.toBeNull();
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(w.localStorage.getItem(EXPIRY_KEY)).toBeNull();
    expect(w.__pushCount).toBe(0);
  });
});
