/**
 * CONT-AUTHUI-1 — integration tests that boot the REAL SPA in a real DOM.
 *
 * These are deliberately not unit tests. Every regression this ticket covers
 * (login card that never closes, blank content panel beside a live menu, a
 * "Sign out" button that popped the signer) was invisible to unit tests because
 * each individual module behaved correctly in isolation. The defects lived in
 * the wiring: the ORDER boot registers things in, and whether an exception in
 * one view is allowed to abandon the rest of boot.
 *
 * So each test here loads src/main.js against a JSDOM window, drives the real
 * controls with real clicks, and asserts on what an operator would actually see.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const TOKEN_KEY = 'continuum.session.v1';
const EXPIRY_KEY = 'continuum.session.exp.v1';
const MARKER_KEY = 'continuum.session.meta.v1';
const SIGNOUT_KEY = 'continuum.signout.v1';
const PUBKEY = 'a'.repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);
/** A token in the CURRENT 5-field shape. */
const liveToken = () => `1000.${nowSec() + 3600}.${PUBKEY}.1000.sig`;
/** A token in the PREVIOUS 4-field shape — what a not-yet-upgraded agent issues. */
const legacyToken = () => `1000.${nowSec() + 3600}.${PUBKEY}.legacysig`;

const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

/** Default agent responses: a successful challenge → verify handshake. */
function defaultRoutes() {
  return {
    '/api/auth/challenge': { ok: true, challenge: 'c'.repeat(64), expires_in: 120 },
    '/api/auth/verify': () => ({ ok: true, token: liveToken(), expires_at: nowSec() + 3600 }),
  };
}

/**
 * Boot the app in a fresh JSDOM window.
 * @param {{hash?: string, token?: string|null, expiry?: number|null,
 *          signer?: boolean|Error, routes?: object, seed?: object}} [opts]
 */
function makeWindow({ hash = '#/', token = null, expiry = null, signer = true, routes = {}, seed = {} } = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${hash}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  if (expiry) window.localStorage.setItem(EXPIRY_KEY, String(expiry));
  for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
  window.__CONTINUUM_AGENT_URL__ = '/continuum';
  if (signer) {
    window.nostr = {
      calls: 0,
      async signEvent(e) {
        this.calls += 1;
        if (signer instanceof Error) throw signer;
        return { ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY };
      },
    };
  }

  for (const k of GLOBALS) {
    if (k === 'fetch' || k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  const table = { ...defaultRoutes(), ...routes };
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || 'GET' });
    for (const [path, resp] of Object.entries(table)) {
      if (!u.includes(path)) continue;
      const r = typeof resp === 'function' ? resp() : resp;
      if (r instanceof Error) throw r;
      if (r && r.__status) return { ok: false, status: r.__status, json: async () => r.body ?? {} };
      return { ok: true, status: 200, json: async () => r };
    }
    // Anything unstubbed (notably /api/version) 404s rather than hanging.
    return { ok: false, status: 404, json: async () => ({}) };
  });
  window.__fetchCalls = calls;
  return window;
}

/** Let queued microtasks and zero-delay timers drain. */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
}

async function bootApp(opts) {
  const w = makeWindow(opts);
  await import('./main.js');
  await settle();
  return w;
}

const mainOf = (w) => w.document.getElementById('main-content');
const sessionBtn = (w) => w.document.querySelector('[data-session-toggle]');
const sessionLabel = (w) => sessionBtn(w)?.textContent.trim();
const loginCard = (w) => w.document.querySelector('.login-card');

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

// ─── Requirement 1 — sign-in from the public home screen ────

describe('sign-in from the public login surface', () => {
  it('renders the login card, not a protected view, when signed out', async () => {
    const w = await bootApp();
    expect(loginCard(w)).toBeTruthy();
    expect(w.location.hash).toBe('#/');
    expect(sessionLabel(w)).toBe('Sign in');
  });

  it('closes the login surface, replaces to the dashboard and renders the authenticated shell', async () => {
    const w = await bootApp();
    const entriesBefore = w.history.length;

    w.document.querySelector('.login-btn').click();
    await settle();

    // The login surface is GONE — not merely covered.
    expect(loginCard(w)).toBeNull();
    expect(w.location.hash).toBe('#/dashboard');
    // Content is mounted immediately, in the same turn as the redirect.
    expect(mainOf(w).children.length).toBeGreaterThan(0);
    expect(mainOf(w).innerHTML.length).toBeGreaterThan(100);
    // Full shell: sidebar nav present and out of landing mode.
    expect(w.document.querySelectorAll('.nav-item').length).toBeGreaterThan(5);
    expect(w.document.getElementById('app').classList.contains('landing-mode')).toBe(false);
    // The control now offers the opposite action.
    expect(sessionLabel(w)).toBe('Sign out');
    expect(sessionBtn(w).getAttribute('data-session-intent')).toBe('signout');
    // REPLACED, not pushed: no new history entry to go Back into.
    expect(w.history.length).toBe(entriesBefore);
  });

  it('does not leave a stale login surface reachable with Back', async () => {
    const w = await bootApp();
    w.document.querySelector('.login-btn').click();
    await settle();
    expect(w.location.hash).toBe('#/dashboard');

    w.dispatchEvent(new w.Event('popstate'));
    await settle();

    // Still authenticated content; the login card never returns.
    expect(loginCard(w)).toBeNull();
    expect(mainOf(w).children.length).toBeGreaterThan(0);
  });

  it('never navigates before authoritative success — signer rejection stays put', async () => {
    const w = await bootApp({ signer: new Error('User rejected') });
    w.document.querySelector('.login-btn').click();
    await settle();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
    expect(sessionLabel(w)).toBe('Sign in');
    expect(w.document.querySelector('.login-inline-status').textContent).toMatch(/declined/i);
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('never navigates before authoritative success — agent rejects the signature', async () => {
    const w = await bootApp({
      routes: { '/api/auth/verify': { __status: 401, body: { error: 'bad signature' } } },
    });
    w.document.querySelector('.login-btn').click();
    await settle();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
    expect(w.document.querySelector('.login-inline-status').className).toMatch(/error/);
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('double-submit runs ONE challenge, not two', async () => {
    const w = await bootApp();
    const btn = w.document.querySelector('.login-btn');
    btn.click();
    btn.click();
    btn.click();
    await settle();

    const challenges = w.__fetchCalls.filter((c) => c.url.includes('/api/auth/challenge'));
    expect(challenges.length).toBe(1);
    expect(w.nostr.calls).toBe(1);
    expect(w.location.hash).toBe('#/dashboard');
  });

  it('honours a token whose shape the client does not recognise, using the agent-stated expiry', async () => {
    // The agent is the authority on both the token and its lifetime. A client
    // that re-derives liveness from the token's field COUNT can disown a token
    // the agent just issued — which is what made sign-in "succeed" with the
    // login card still on screen.
    const w = await bootApp({
      routes: {
        '/api/auth/verify': () => ({ ok: true, token: legacyToken(), expires_at: nowSec() + 3600 }),
      },
    });
    w.document.querySelector('.login-btn').click();
    await settle();

    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
    expect(sessionLabel(w)).toBe('Sign out');
  });

  it('honours a successful verify that states no expires_at at all', async () => {
    const w = await bootApp({
      routes: { '/api/auth/verify': () => ({ ok: true, token: legacyToken() }) },
    });
    w.document.querySelector('.login-btn').click();
    await settle();

    expect(w.location.hash).toBe('#/dashboard');
    expect(sessionLabel(w)).toBe('Sign out');
  });
});

// ─── Requirement 2 — hard refresh while signed in ───────────

describe('hard refresh while signed in', () => {
  const AUTHED_ROUTES = ['#/dashboard', '#/projects', '#/marketplace', '#/routstr', '#/team', '#/genesis', '#/memory'];

  for (const hash of AUTHED_ROUTES) {
    it(`restores content at ${hash} — never a blank panel beside a live menu`, async () => {
      const w = await bootApp({ hash, token: liveToken(), expiry: nowSec() + 3600 });

      const main = mainOf(w);
      expect(main).toBeTruthy();
      // The exact regression: menu rendered, content region empty.
      expect(w.document.querySelectorAll('.nav-item').length).toBeGreaterThan(5);
      expect(main.children.length).toBeGreaterThan(0);
      expect(main.innerHTML.trim().length).toBeGreaterThan(100);
      expect(sessionLabel(w)).toBe('Sign out');
    });
  }

  it('mounts the chat dock before the first view renders', async () => {
    // Authenticated views write into the dock during render. If the dock is not
    // there yet the view throws mid-render, having already cleared the pane.
    const w = await bootApp({ hash: '#/dashboard', token: liveToken(), expiry: nowSec() + 3600 });
    expect(w.document.querySelector('.chat-dock')).toBeTruthy();
    expect(w.document.querySelector('.chat-log')).toBeTruthy();
  });

  it('keeps protected navigation working after the restore', async () => {
    const w = await bootApp({ hash: '#/dashboard', token: liveToken(), expiry: nowSec() + 3600 });

    const projects = [...w.document.querySelectorAll('.nav-item')]
      .find((a) => a.getAttribute('data-path') === '/projects');
    projects.dispatchEvent(new w.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    expect(w.location.hash).toBe('#/projects');
    expect(mainOf(w).children.length).toBeGreaterThan(0);
  });

  it('fails closed to the public home when the stored session has expired', async () => {
    const w = await bootApp({ hash: '#/dashboard', token: `1000.${nowSec() - 60}.${PUBKEY}.1000.sig` });

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
    expect(sessionLabel(w)).toBe('Sign in');
    // A marker with no live token must not be left behind claiming a session.
    expect(w.localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it('a view that throws fails closed to a visible panel, never an empty pane', async () => {
    const w = makeWindow({ hash: '#/dashboard', token: liveToken(), expiry: nowSec() + 3600 });
    const dashboard = await import('./views/dashboard.js');
    vi.spyOn(dashboard, 'renderDashboard').mockImplementation((mount) => {
      mount.innerHTML = '';
      throw new Error('boom');
    });
    await import('./main.js');
    await settle();

    const main = mainOf(w);
    expect(main.querySelector('.route-error')).toBeTruthy();
    expect(main.querySelector('[data-route-error-reload]')).toBeTruthy();
    // Boot completed despite the throw: the shell and dock are still there.
    expect(w.document.querySelectorAll('.nav-item').length).toBeGreaterThan(5);
    expect(w.document.querySelector('.chat-dock')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('a view that throws does not disable the session listeners', async () => {
    const w = makeWindow({ hash: '#/dashboard', token: liveToken(), expiry: nowSec() + 3600 });
    const dashboard = await import('./views/dashboard.js');
    vi.spyOn(dashboard, 'renderDashboard').mockImplementation(() => { throw new Error('boom'); });
    await import('./main.js');
    await settle();

    // Sign-out still exits: the handler registered before the failing resolve.
    const auth = await import('./auth.js');
    auth.endSession();
    await settle();
    expect(w.location.hash).toBe('#/');
    vi.restoreAllMocks();
  });
});

// ─── Requirement 3 — sign out ───────────────────────────────

describe('sign out', () => {
  async function bootSignedIn() {
    return bootApp({
      hash: '#/dashboard',
      token: liveToken(),
      expiry: nowSec() + 3600,
      seed: {
        'continuum.chat.threads': JSON.stringify({ global: [{ who: 'user', text: 'secret' }] }),
        'continuum.routstr.focusTopUp': '1',
      },
    });
  }

  it('the visible Sign out control signs out and never invokes the signer', async () => {
    const w = await bootSignedIn();
    expect(sessionLabel(w)).toBe('Sign out');

    sessionBtn(w).click();
    await settle();
    // A local confirmation, not a signer prompt.
    const modal = w.document.querySelector('.modal, [data-modal]');
    expect(modal).toBeTruthy();
    expect(w.nostr.calls).toBe(0);

    [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes').click();
    await settle();

    expect(w.nostr.calls).toBe(0);
    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
    expect(sessionLabel(w)).toBe('Sign in');
    expect(sessionBtn(w).getAttribute('data-session-intent')).toBe('signin');
  });

  it('a control rendered "Sign out" cannot fall through to sign-in when the token lapses first', async () => {
    // The action is bound to the rendered intent, so a token that expires
    // between paint and click can no longer turn Sign out into a signer prompt.
    const w = await bootSignedIn();
    expect(sessionLabel(w)).toBe('Sign out');
    w.localStorage.removeItem(TOKEN_KEY);
    w.localStorage.removeItem(EXPIRY_KEY);

    sessionBtn(w).click();
    await settle();

    expect(w.nostr.calls).toBe(0);
    expect(w.__fetchCalls.some((c) => c.url.includes('/api/auth/challenge'))).toBe(false);
  });

  it('clears owner-sensitive client state', async () => {
    const w = await bootSignedIn();
    sessionBtn(w).click();
    await settle();
    [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes').click();
    await settle();

    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(w.localStorage.getItem(EXPIRY_KEY)).toBeNull();
    expect(w.localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(w.localStorage.getItem('continuum.routstr.focusTopUp')).toBeNull();
    // The owner's conversation is gone from storage. The signed-out surface may
    // immediately persist its own greeting thread under the same key — that is
    // not owner data, so the assertion is about the CONTENT, not the key.
    expect(w.localStorage.getItem('continuum.chat.threads') || '').not.toMatch(/secret/);
    // In-memory chat is dropped too, not just its storage.
    expect(w.document.querySelector('.chat-log')?.textContent || '').not.toMatch(/secret/);
  });

  it('Back after sign-out reveals no protected UI', async () => {
    const w = await bootSignedIn();
    sessionBtn(w).click();
    await settle();
    [...w.document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes').click();
    await settle();

    w.location.hash = '#/dashboard';
    await settle();
    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();

    w.dispatchEvent(new w.Event('popstate'));
    await settle();
    expect(loginCard(w)).toBeTruthy();
  });

  it('a bfcache restore of a signed-out page does not reveal the dashboard', async () => {
    const w = await bootSignedIn();
    w.localStorage.removeItem(TOKEN_KEY);
    w.localStorage.removeItem(EXPIRY_KEY);

    const ev = new w.Event('pageshow');
    Object.defineProperty(ev, 'persisted', { value: true });
    w.dispatchEvent(ev);
    await settle();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
  });

  it('preserves cross-tab sign-out', async () => {
    const w = await bootSignedIn();
    w.localStorage.removeItem(TOKEN_KEY);
    w.localStorage.removeItem(EXPIRY_KEY);

    w.dispatchEvent(new w.StorageEvent('storage', { key: SIGNOUT_KEY, newValue: String(Date.now()) }));
    await settle();

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
    expect(sessionLabel(w)).toBe('Sign in');
  });
});

// ─── Requirement 4 — one authoritative auth state ───────────

describe('one authoritative auth state', () => {
  it('guard, shell control and refresh clock all read the same expiry', async () => {
    const exp = nowSec() + 3600;
    const w = await bootApp({ hash: '#/dashboard', token: liveToken(), expiry: exp });
    const agent = await import('./data/agent.js');
    const auth = await import('./auth.js');

    expect(agent.sessionExpiry()).toBe(exp);
    expect(agent.isLoggedIn()).toBe(true);
    expect(auth.isSessionLive()).toBe(true);
    expect(sessionBtn(w).getAttribute('data-session-intent')).toBe('signout');
    expect(auth.sessionState()).not.toBe('anonymous');
  });

  it('the agent-stated expiry wins over the token when they disagree', async () => {
    const agentSaid = nowSec() - 1; // agent says this session is over
    await bootApp({ hash: '#/dashboard', token: liveToken(), expiry: agentSaid });
    const agent = await import('./data/agent.js');
    expect(agent.isLoggedIn()).toBe(false);
  });

  it('an expiry with no token is not a session', async () => {
    await bootApp({ expiry: nowSec() + 3600 });
    const agent = await import('./data/agent.js');
    expect(agent.sessionExpiry()).toBeNull();
    expect(agent.isLoggedIn()).toBe(false);
  });
});
