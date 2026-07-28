/**
 * CONT-COMPLETE-1 — a 200 from /api/auth/verify that never becomes a session.
 *
 * These drive the REAL startLogin through the REAL login view and the REAL
 * router, because the symptom only existed at that join. The flow believed it
 * had succeeded, said "Signed in.", and dispatched a session change; the router
 * then asked the guard, the guard said nobody is signed in, and the operator was
 * replaced back onto the login card — whose status element the re-render had just
 * rebuilt empty. So the recorded behaviour before this change was:
 *
 *   agent log        : auth.verify.success  (200)
 *   operator's screen: a blank login card, no message, no button
 *   phases           : challenge -> signer -> verify -> done   ← "done" was a lie
 *
 * Nothing named the fault, so there was nothing to act on. Each case below is a
 * different real way a 200 fails to produce a session, and each must now end
 * with a sentence naming the component that can be fixed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PUBKEY = 'a'.repeat(64);
const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

function tokenFor(deltaSec) {
  const exp = Math.floor(Date.now() / 1000) + deltaSec;
  return `1.${exp}.${PUBKEY}.1.sig`;
}

/**
 * @param {object} o
 * @param {object|null} [o.verifyBody] body the agent replies with on 200
 * @param {boolean} [o.unparseable] 200 whose body is not JSON at all
 * @param {boolean} [o.blockStorage] localStorage.setItem throws (private mode)
 */
function mk(o = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://torii.test/continuum/index.html#/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__CONTINUUM_AGENT_URL__ = '/continuum';
  window.nostr = {
    signEvent: async (e) => ({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY }),
    getPublicKey: async () => PUBKEY,
  };

  for (const k of GLOBALS) {
    if (k !== 'fetch' && k !== 'getComputedStyle') globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.__APP_VERSION__ = '0.2.97-alpha';

  if (o.blockStorage) {
    // Exactly what a browser with site data blocked does: reads work, writes throw.
    const real = window.localStorage.getItem.bind(window.localStorage);
    globalThis.localStorage = {
      getItem: real,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
  }

  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/auth/challenge')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, challenge: 'c'.repeat(64) }) };
    }
    if (u.includes('/api/auth/verify')) {
      if (o.unparseable) {
        return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); } };
      }
      return { ok: true, status: 200, json: async () => o.verifyBody };
    }
    if (u.includes('/api/version')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });

  return window;
}

const flush = async (n = 16) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  delete globalThis.__APP_VERSION__;
});

/**
 * Mount the real login view under the real router, wired to the real
 * session-changed handling that main.js installs. Returns what the operator can
 * actually see, plus an ordered trace of statuses and session events so the
 * ordering guarantee is assertable.
 */
async function harness(w) {
  const auth = await import('./auth.js');
  const { renderLogin } = await import('./views/login.js');
  const { route, startRouter, navigate } = await import('./router.js');
  const { sessionChangeTarget } = await import('./nav-guard.js');
  const mount = w.document.getElementById('app');

  const trace = [];
  route('/', () => renderLogin(mount));
  route('/dashboard', () => { mount.textContent = 'DASHBOARD'; });
  startRouter();

  w.document.addEventListener('continuum:session-changed', () => {
    trace.push('session-changed');
    navigate(sessionChangeTarget(auth.isSessionLive()), { replace: true });
  });

  // The status element is recreated by every login re-render, so it must be
  // re-queried — holding a reference is the very mistake this bug rewarded.
  const statusEl = () => mount.querySelector('.login-inline-status');

  return {
    auth,
    trace,
    text: () => (statusEl() ? statusEl().textContent : ''),
    retryBtn: () => mount.querySelector('[data-login-retry]'),
    click: async () => {
      mount.querySelector('.login-btn').dispatchEvent(new w.Event('click'));
      await flush();
    },
  };
}

describe('a 200 that carries no token', () => {
  it('says so, on screen, instead of bouncing back to a blank card', async () => {
    const w = mk({ verifyBody: { ok: true } });
    const t = await harness(w);
    await t.click();

    expect(t.auth.isSessionLive()).toBe(false);
    // The whole point: the operator is told something.
    expect(t.text()).not.toBe('');
    expect(t.text()).toMatch(/no session/i);
    expect(t.text()).not.toMatch(/signed in/i);
  });

  it('names the proxy as the thing to look at, and offers a retry', async () => {
    const w = mk({ verifyBody: { ok: true } });
    const t = await harness(w);
    await t.click();

    expect(t.text()).toMatch(/proxy/i);
    expect(t.retryBtn()).not.toBeNull();
  });

  it('never claims a session change that did not happen', async () => {
    // Dispatching it is what pulled the operator back to a freshly-rendered
    // login card, destroying the only surface a message could have appeared on.
    const w = mk({ verifyBody: { ok: true } });
    const t = await harness(w);
    await t.click();

    expect(t.trace).not.toContain('session-changed');
  });

  it('treats a 200 whose body is not JSON the same way', async () => {
    const w = mk({ unparseable: true });
    const t = await harness(w);
    await t.click();

    expect(t.text()).toMatch(/no session/i);
    expect(t.auth.isSessionLive()).toBe(false);
  });

  it('treats a token under an unexpected key as absent rather than as success', async () => {
    // A shape the client does not read is indistinguishable from none, and
    // guessing at nested shapes is how a client starts trusting a token it
    // cannot verify. Refusing loudly is the honest answer.
    const w = mk({ verifyBody: { ok: true, data: { token: tokenFor(3600) } } });
    const t = await harness(w);
    await t.click();

    expect(t.text()).toMatch(/no session/i);
  });
});

describe('a session that is born expired', () => {
  it('names the clock disagreement rather than reporting success', async () => {
    // Very common on a self-hosted VPS whose clock has drifted. The token stores
    // and parses perfectly; it is simply already dead.
    const w = mk({
      verifyBody: {
        ok: true, token: tokenFor(-10), expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });
    const t = await harness(w);
    await t.click();

    expect(t.text()).toMatch(/clock/i);
    expect(t.text()).not.toMatch(/signed in/i);
    expect(t.auth.isSessionLive()).toBe(false);
  });

  it('does not fire a sign-out from inside the sign-in', async () => {
    // The renewal loop used to classify this token as expired the instant it was
    // started and call endSession() — a sign-out dispatched from the middle of
    // the success path, which cleared the token and re-rendered the view out from
    // under the message that was about to be written to it.
    const w = mk({
      verifyBody: {
        ok: true, token: tokenFor(-10), expires_at: Math.floor(Date.now() / 1000) - 10,
      },
    });
    const t = await harness(w);
    await t.click();

    expect(t.trace).not.toContain('session-changed');
  });
});

describe('a token this browser cannot keep', () => {
  it('blames storage, not the agent', async () => {
    // Private browsing / blocked site data. Sending this operator to debug a
    // healthy agent is the wrong turn the single generic message used to cause.
    const w = mk({
      blockStorage: true,
      verifyBody: {
        ok: true, token: tokenFor(3600), expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    const t = await harness(w);
    await t.click();

    expect(t.text()).toMatch(/browser|site data|private/i);
    expect(t.text()).not.toMatch(/proxy/i);
    expect(t.auth.isSessionLive()).toBe(false);
  });
});

describe('the sign-in that does work', () => {
  const good = () => ({
    ok: true, token: tokenFor(3600), expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  it('still completes, and still reaches the dashboard', async () => {
    const w = mk({ verifyBody: good() });
    const t = await harness(w);
    await t.click();

    expect(t.auth.isSessionLive()).toBe(true);
    expect(t.trace).toContain('session-changed');
  });

  it('announces success BEFORE the side effects that re-render the surface', async () => {
    // Ordering is load-bearing, not cosmetic: the session change re-resolves the
    // route, and the router re-resolves even when the hash is unchanged, which
    // rebuilds the status element. A 'done' written afterwards landed on a
    // detached node — a success message nobody could see.
    const w = mk({ verifyBody: good() });
    const auth = await import('./auth.js');
    const trace = [];
    w.document.addEventListener('continuum:session-changed', () => trace.push('session-changed'));
    await auth.startLogin({
      onStatus: (s) => { if (s.done) trace.push('done'); },
    });
    await flush();

    expect(trace).toEqual(['done', 'session-changed']);
  });

  it('leaves the attempt latch released either way', async () => {
    for (const body of [good(), { ok: true }]) {
      vi.resetModules();
      const w = mk({ verifyBody: body });
      const t = await harness(w);
      await t.click();
      expect(t.auth.isLoginInFlight()).toBe(false);
    }
  });
});
