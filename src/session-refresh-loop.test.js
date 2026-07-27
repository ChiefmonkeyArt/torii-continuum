/**
 * The session refresh loop in src/auth.js (CONT-AUTH-1) — the one place that
 * owns a timer and turns the pure state machine's decisions into side effects.
 *
 * Timers, the clock and the network are all injected, so the loop is driven by
 * hand and nothing here sleeps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TOKEN_KEY = 'continuum.session.v1';
const NOW = 1_700_000_000;

// vitest runs in the node environment here (no jsdom), so the browser globals
// auth.js touches have to be faked before it is imported.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

/** A token of the agent's shape `iat.exp.pubkey.oiat.sig`. */
function token(expSec, { oiat = 1000 } = {}) {
  return `1000.${expSec}.deadbeefpub.${oiat}.sig`;
}

/** A hand-driven timer queue: nothing fires until the test says so. */
function timerQueue() {
  const pending = [];
  let id = 0;
  return {
    setTimer: (fn, ms) => { pending.push({ id: ++id, fn, ms }); return id; },
    clearTimer: (tid) => {
      const i = pending.findIndex((p) => p.id === tid);
      if (i >= 0) pending.splice(i, 1);
    },
    get depth() { return pending.length; },
    get nextDelay() { return pending.length ? pending[pending.length - 1].ms : null; },
    /** Fire the most recently armed timer. */
    async fire() {
      const t = pending.pop();
      if (!t) throw new Error('no timer armed');
      await t.fn();
    },
  };
}

let auth;
let storage;

beforeEach(async () => {
  storage = fakeStorage();
  globalThis.localStorage = storage;
  globalThis.window = { location: { origin: 'https://example.test', pathname: '/continuum/' } };
  globalThis.document = { dispatchEvent: () => true, addEventListener: () => {} };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  vi.resetModules();
  auth = await import('./auth.js');
});

afterEach(() => {
  auth?.stopSessionRefresh?.();
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.CustomEvent;
});

/** Start the loop with every dependency injected. */
function start({ expiresAt, refresh, nowSec = () => NOW, onExpired = vi.fn() } = {}) {
  if (expiresAt !== null) storage.setItem(TOKEN_KEY, token(expiresAt));
  const timers = timerQueue();
  const state = auth.startSessionRefresh({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    nowSec,
    refresh,
    onExpired,
  });
  return { timers, state, onExpired };
}

describe('starting the loop', () => {
  it('a comfortable session arms a timer and stays active', () => {
    const { timers, state } = start({ expiresAt: NOW + 3600, refresh: vi.fn() });
    expect(state).toBe('active');
    expect(auth.sessionState()).toBe('active');
    expect(timers.depth).toBe(1);
  });

  it('no session at all arms nothing', () => {
    const { timers, state, onExpired } = start({ expiresAt: null, refresh: vi.fn() });
    expect(state).toBe('anonymous');
    expect(timers.depth).toBe(0);
    // "never signed in" must not be reported as "your session ended".
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('an already-dead token ends the session immediately and arms nothing', () => {
    const { timers, state, onExpired } = start({ expiresAt: NOW - 1, refresh: vi.fn() });
    expect(state).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(timers.depth).toBe(0);
  });

  it('restarting replaces the timer instead of stacking a second loop', () => {
    // Two loops against one session would double every renewal request.
    storage.setItem(TOKEN_KEY, token(NOW + 3600));
    const timers = timerQueue();
    const deps = {
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      nowSec: () => NOW, refresh: vi.fn(), onExpired: vi.fn(),
    };
    auth.startSessionRefresh(deps);
    auth.startSessionRefresh(deps);
    auth.startSessionRefresh(deps);
    expect(timers.depth).toBe(1);
  });

  it('stopping cancels the pending timer and forgets the state', () => {
    const { timers } = start({ expiresAt: NOW + 3600, refresh: vi.fn() });
    auth.stopSessionRefresh();
    expect(timers.depth).toBe(0);
    expect(auth.sessionState()).toBe('anonymous');
  });
});

describe('renewing', () => {
  it('a token inside the window is renewed and the new expiry is scheduled', async () => {
    const refresh = vi.fn(async () => {
      storage.setItem(TOKEN_KEY, token(NOW + 86400));
      return { ok: true, expires_at: NOW + 86400 };
    });
    const { timers } = start({ expiresAt: NOW + 60, refresh });
    expect(timers.nextDelay).toBe(0); // already due

    await timers.fire();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(auth.sessionState()).toBe('active');
    expect(timers.depth).toBe(1); // the loop continues
  });

  it('a comfortable token is NOT renewed when its timer fires early', async () => {
    // The 15-minute cap means a long-lived token wakes up repeatedly; each of
    // those wake-ups must re-check rather than renew on a loop.
    const refresh = vi.fn();
    const { timers } = start({ expiresAt: NOW + 86400, refresh });
    await timers.fire();
    expect(refresh).not.toHaveBeenCalled();
    expect(auth.sessionState()).toBe('active');
    expect(timers.depth).toBe(1);
  });

  it('the operator stays authorised for the whole renewal', async () => {
    let during = null;
    const refresh = vi.fn(async () => {
      during = auth.sessionState();
      return { ok: true, expires_at: NOW + 86400 };
    });
    const { timers } = start({ expiresAt: NOW + 60, refresh });
    await timers.fire();
    // Not 'expiring' and certainly not 'expired' — the token is still good.
    expect(during).toBe('refreshing');
  });
});

describe('when renewal fails', () => {
  it('a transport failure keeps the session and backs off', async () => {
    // A flaky agent must not evict somebody whose token is still valid.
    const refresh = vi.fn(async () => ({ ok: false, code: 'offline' }));
    const { timers, onExpired } = start({ expiresAt: NOW + 60, refresh });
    await timers.fire();

    expect(onExpired).not.toHaveBeenCalled();
    expect(auth.sessionState()).toBe('expiring');
    expect(timers.depth).toBe(1);
    expect(timers.nextDelay).toBe(30_000); // RETRY_BACKOFF_MS, not a hot loop
  });

  it('max_lifetime_reached ends the session — the owner must sign again', async () => {
    const refresh = vi.fn(async () => ({ ok: false, code: 'max_lifetime_reached' }));
    const { timers, onExpired } = start({ expiresAt: NOW + 60, refresh });
    await timers.fire();

    expect(auth.sessionState()).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(timers.depth).toBe(0); // no point retrying a permanent no
  });

  it('a token that dies during the request ends the session', async () => {
    let t = NOW;
    const refresh = vi.fn(async () => { t = NOW + 120; return { ok: false, code: 'offline' }; });
    const { timers, onExpired } = start({
      expiresAt: NOW + 60, refresh, nowSec: () => t,
    });
    await timers.fire();
    expect(auth.sessionState()).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('an expiry that passes before the timer fires ends the session without a request', async () => {
    let t = NOW;
    const refresh = vi.fn();
    const { timers, onExpired } = start({ expiresAt: NOW + 60, refresh, nowSec: () => t });
    t = NOW + 61;
    await timers.fire();
    expect(refresh).not.toHaveBeenCalled();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle wiring', () => {
  it('ending the session stops the loop', () => {
    const { timers } = start({ expiresAt: NOW + 3600, refresh: vi.fn() });
    expect(timers.depth).toBe(1);
    auth.endSession({ localOnly: true });
    expect(timers.depth).toBe(0);
    expect(auth.sessionState()).toBe('anonymous');
  });

  it('rehydrating a live session in a fresh tab starts its own loop', () => {
    // Otherwise only the tab that signed in would keep the session alive, and
    // a reload would silently stop the clock. rehydrateSession consults the
    // real clock, so this fixture needs a genuinely future expiry.
    storage.setItem(TOKEN_KEY, token(Math.floor(Date.now() / 1000) + 3600));
    const r = auth.rehydrateSession();
    expect(r.live).toBe(true);
    expect(auth.sessionState()).not.toBe('anonymous');
  });

  it('rehydrating with no session does not start one', () => {
    const r = auth.rehydrateSession();
    expect(r.live).toBe(false);
    expect(auth.sessionState()).toBe('anonymous');
  });
});
