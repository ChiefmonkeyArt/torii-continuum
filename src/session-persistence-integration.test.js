/**
 * CONT-SESSION-1 — what a hard refresh does to what you were just looking at.
 *
 * The reported regression: the public login modal is on screen, sign-in has NOT
 * succeeded, and F5 opens the Dashboard. That can only happen if storage and the
 * screen disagree — the screen showing "signed out" while storage holds a live
 * token — because on reload there is no screen to consult and storage wins.
 *
 * So every test here boots the REAL app, drives it to some signed-out-looking
 * state, and then performs an actual hard refresh: the window is destroyed, the
 * module registry is reset, and a brand new window is booted against the SAME
 * localStorage. Nothing survives except what was persisted, which is exactly the
 * question being asked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const TOKEN_KEY = 'continuum.session.v1';
const EXPIRY_KEY = 'continuum.session.exp.v1';
const MARKER_KEY = 'continuum.session.meta.v1';
const PROJECTS_KEY = 'continuum.v1';
const PUBKEY = 'a'.repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (exp) => `1000.${exp}.${PUBKEY}.1000.sig`;
const liveToken = () => tokenFor(nowSec() + 3600);
const staleToken = () => tokenFor(nowSec() - 3600);

const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

function defaultRoutes() {
  return {
    '/api/auth/challenge': { ok: true, challenge: 'c'.repeat(64), expires_in: 120 },
    '/api/auth/verify': () => ({ ok: true, token: liveToken(), expires_at: nowSec() + 3600 }),
  };
}

/**
 * @param {{hash?: string, seed?: object, signer?: 'ok'|'reject'|'never'|'none',
 *          routes?: object}} [opts]
 */
function makeWindow({ hash = '#/', seed = {}, signer = 'ok', routes = {} } = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${hash}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  let settleSigner;
  const pending = new Promise((res) => { settleSigner = res; });
  window.__signerAnswers = settleSigner;

  if (signer !== 'none') {
    window.nostr = {
      calls: 0,
      signEvent(e) {
        this.calls += 1;
        const signed = { ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY };
        if (signer === 'never') return pending.then(() => signed);
        if (signer === 'reject') return Promise.reject(new Error('user rejected'));
        return Promise.resolve(signed);
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
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    for (const [path, resp] of Object.entries(table)) {
      if (!u.includes(path)) continue;
      const r = typeof resp === 'function' ? resp(init) : resp;
      if (r instanceof Error) throw r;
      if (r && typeof r.then === 'function') return r;
      if (r && r.__status) return { ok: false, status: r.__status, json: async () => r.body ?? {} };
      return { ok: true, status: 200, json: async () => r };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return window;
}

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
}

async function bootApp(opts) {
  const w = makeWindow(opts);
  await import('./main.js');
  await settle();
  return w;
}

/** Everything the tab persisted — the only thing a hard refresh can see. */
function snapshot(w) {
  const out = {};
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    out[k] = w.localStorage.getItem(k);
  }
  return out;
}

/**
 * A real hard refresh: tear the window down, drop every loaded module, and boot
 * a brand new app against the persisted storage and nothing else.
 */
async function hardRefresh(w, { hash = '#/', ...rest } = {}) {
  const seed = snapshot(w);
  try { w.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  vi.resetModules();
  return bootApp({ hash, seed, ...rest });
}

const mainOf = (w) => w.document.getElementById('main-content');
const loginCard = (w) => w.document.querySelector('.login-card');
const loginBtn = (w) => w.document.querySelector('.login-btn');
const sessionBtn = (w) => w.document.querySelector('[data-session-toggle]');
const cancelBtn = (w) => w.document.querySelector('[data-login-cancel]');
const isPublic = (w) => Boolean(loginCard(w)) && w.location.hash !== '#/dashboard';

/** Sign out through the real control, including its confirmation. */
async function signOut(w) {
  sessionBtn(w).click();
  await settle(5);
  const yes = [...w.document.querySelectorAll('.form-actions button')]
    .find((b) => b.textContent.trim() === 'Yes');
  yes.click();
  await settle();
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

// ─── The screen and storage must agree ───────────────────────

describe('the public login screen is authoritative', () => {
  it('stays public across a hard refresh when nothing was ever signed in', async () => {
    const first = await bootApp();
    expect(isPublic(first)).toBe(true);

    const after = await hardRefresh(first);

    expect(isPublic(after)).toBe(true);
    expect(after.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('never renders the login modal for a valid session — it is already on the app', async () => {
    const exp = nowSec() + 3600;
    const w = await bootApp({ seed: { [TOKEN_KEY]: tokenFor(exp), [EXPIRY_KEY]: String(exp) } });

    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
    expect(mainOf(w).textContent.trim()).not.toBe('');
  });

  it('refreshing a valid session lands on the dashboard without a login modal frame', async () => {
    const exp = nowSec() + 3600;
    const first = await bootApp({
      hash: '#/dashboard',
      seed: { [TOKEN_KEY]: tokenFor(exp), [EXPIRY_KEY]: String(exp) },
    });
    expect(loginCard(first)).toBeNull();

    const after = await hardRefresh(first, { hash: '#/dashboard' });

    expect(after.location.hash).toBe('#/dashboard');
    expect(loginCard(after)).toBeNull();
  });
});

// ─── An attempt that did not succeed must persist nothing ────

describe('a login attempt that did not succeed', () => {
  it('leaves nothing behind when the signer declines, so refresh stays public', async () => {
    const first = await bootApp({ signer: 'reject' });
    loginBtn(first).click();
    await settle();

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(isPublic(first)).toBe(true);

    const after = await hardRefresh(first, { signer: 'reject' });
    expect(isPublic(after)).toBe(true);
  });

  it('leaves nothing behind when the operator cancels, so refresh stays public', async () => {
    const first = await bootApp({ signer: 'never' });
    loginBtn(first).click();
    await settle();
    expect(cancelBtn(first)).not.toBeNull();

    cancelBtn(first).click();
    await settle();

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(isPublic(first)).toBe(true);

    const after = await hardRefresh(first, { signer: 'never' });
    expect(isPublic(after)).toBe(true);
  });

  it('cannot be resurrected by a verify that lands AFTER the cancel', async () => {
    // The reported regression, exactly: the screen says "cancelled", the reply
    // arrives late and writes a live token underneath it, and the next refresh
    // opens the dashboard from a sign-in the operator abandoned.
    let releaseVerify;
    const held = new Promise((res) => { releaseVerify = res; });
    const first = await bootApp({
      routes: {
        '/api/auth/verify': () => held.then(() => ({
          ok: true, status: 200,
          json: async () => ({ ok: true, token: liveToken(), expires_at: nowSec() + 3600 }),
        })),
      },
    });

    loginBtn(first).click();
    await settle();
    const { cancelLogin, loginStage } = await import('./auth.js');
    expect(loginStage()).toBe('verify');
    expect(cancelLogin()).toBe(true);
    await settle();

    releaseVerify();
    await settle();

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(isPublic(first)).toBe(true);

    const after = await hardRefresh(first);
    expect(isPublic(after)).toBe(true);
  });

  it('leaves nothing behind when the signer times out, so refresh stays public', async () => {
    const first = await bootApp({ signer: 'never' });
    const { STAGE_TIMEOUTS_MS } = await import('./login-stages.js');
    loginBtn(first).click();
    await settle();

    // Real timers here: the whole app is running, and faking the clock would
    // stall the router and the shell along with the stage deadline. Drive the
    // timeout by hand through the same path the deadline uses.
    const { cancelLogin, isLoginInFlight } = await import('./auth.js');
    expect(isLoginInFlight()).toBe(true);
    expect(STAGE_TIMEOUTS_MS.signer).toBeGreaterThan(0);
    cancelLogin();
    await settle();

    expect(isLoginInFlight()).toBe(false);
    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();

    const after = await hardRefresh(first, { signer: 'never' });
    expect(isPublic(after)).toBe(true);
  });

  it('does not leave a "signed in as" marker beside the login screen', async () => {
    const first = await bootApp({ signer: 'reject' });
    loginBtn(first).click();
    await settle();

    const after = await hardRefresh(first, { signer: 'reject' });
    expect(after.localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(isPublic(after)).toBe(true);
  });
});

// ─── Stale state must not read as authenticated ──────────────

describe('stale authenticated state', () => {
  it('an expired token refreshes to the public screen, not the dashboard', async () => {
    const exp = nowSec() - 3600;
    const w = await bootApp({
      hash: '#/dashboard',
      seed: { [TOKEN_KEY]: staleToken(), [EXPIRY_KEY]: String(exp) },
    });

    expect(w.location.hash).toBe('#/');
    expect(loginCard(w)).toBeTruthy();
  });

  it('an expired token does not leave a marker claiming a session', async () => {
    const exp = nowSec() - 3600;
    const w = await bootApp({
      seed: {
        [TOKEN_KEY]: staleToken(),
        [EXPIRY_KEY]: String(exp),
        [MARKER_KEY]: JSON.stringify({ pubkey: PUBKEY }),
      },
    });

    expect(w.localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(loginCard(w)).toBeTruthy();
  });
});

// ─── Sign-out is a boundary, including across a reload ───────

describe('explicit sign-out', () => {
  async function signedIn(opts = {}) {
    const exp = nowSec() + 3600;
    return bootApp({
      hash: '#/dashboard',
      seed: { [TOKEN_KEY]: tokenFor(exp), [EXPIRY_KEY]: String(exp) },
      ...opts,
    });
  }

  it('clears the token and refreshes to the public screen', async () => {
    const first = await signedIn();
    await signOut(first);

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(isPublic(first)).toBe(true);

    const after = await hardRefresh(first, { hash: first.location.hash });
    expect(isPublic(after)).toBe(true);
  });

  it('cannot be undone by a token renewal that lands afterwards', async () => {
    // The second proven race: sign out while the background renewal is on the
    // wire, and the reply rewrites a live token behind the login screen.
    let releaseRefresh;
    const held = new Promise((res) => { releaseRefresh = res; });
    const exp = nowSec() + 60;
    const first = await bootApp({
      hash: '#/dashboard',
      seed: { [TOKEN_KEY]: tokenFor(exp), [EXPIRY_KEY]: String(exp) },
      routes: {
        '/api/auth/refresh': () => held.then(() => ({
          ok: true, status: 200,
          json: async () => ({ ok: true, token: liveToken(), expires_at: nowSec() + 3600 }),
        })),
      },
    });

    await signOut(first);
    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();

    releaseRefresh();
    await settle();

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(first.localStorage.getItem(EXPIRY_KEY)).toBeNull();
    expect(isPublic(first)).toBe(true);
  });

  it('preserves local-first projects while clearing auth', async () => {
    const projects = JSON.stringify({ projects: [{ slug: 'atlas', name: 'Atlas' }] });
    const first = await signedIn();
    first.localStorage.setItem(PROJECTS_KEY, projects);

    await signOut(first);

    expect(first.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(first.localStorage.getItem(PROJECTS_KEY)).toBe(projects);
  });
});

// ─── One redirect, and no way back ───────────────────────────

describe('navigation after the auth state changes', () => {
  it('redirects to the dashboard exactly once on a successful sign-in', async () => {
    const w = await bootApp();
    const before = w.history.length;

    loginBtn(w).click();
    await settle();

    expect(w.location.hash).toBe('#/dashboard');
    expect(loginCard(w)).toBeNull();
    // Replace, not push: the login entry is consumed, not stacked behind us.
    expect(w.history.length).toBe(before);
  });

  it('Back after sign-out cannot restore the protected view', async () => {
    const exp = nowSec() + 3600;
    const w = await bootApp({
      hash: '#/dashboard',
      seed: { [TOKEN_KEY]: tokenFor(exp), [EXPIRY_KEY]: String(exp) },
    });
    await signOut(w);
    expect(isPublic(w)).toBe(true);

    w.history.back();
    await settle();

    expect(w.location.hash).not.toBe('#/dashboard');
    expect(loginCard(w)).toBeTruthy();
  });

  it('Back after sign-in cannot restore the login modal', async () => {
    const w = await bootApp();
    loginBtn(w).click();
    await settle();
    expect(w.location.hash).toBe('#/dashboard');

    w.history.back();
    await settle();

    expect(loginCard(w)).toBeNull();
    expect(w.location.hash).toBe('#/dashboard');
  });
});

// ─── Where the guard has to live ─────────────────────────────

describe('the auth-write guard sits below every caller', () => {
  it('guards both writers with the epoch that was current when they started', async () => {
    // A guard in the CALLER sits above the write and cannot stop it — that is
    // precisely how the existing attempt-generation check in auth.js was
    // bypassed. Both writers must capture the epoch before their await and
    // refuse to persist across a bump.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./data/agent.js', import.meta.url), 'utf8');
    for (const fn of ['verifyChallenge', 'refreshSession']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const guard = body.indexOf('authEpochNow()');
      const write = body.indexOf('setStoredToken(');
      expect(guard, `${fn} must capture the epoch`).toBeGreaterThan(-1);
      expect(write, `${fn} must be the writer under test`).toBeGreaterThan(guard);
    }
    expect(src).toMatch(/export function invalidateAuthWrites/);
  });

  it('bumps the epoch on sign-out and on an abandoned attempt', async () => {
    const fs = await import('node:fs');
    const agent = fs.readFileSync(new URL('./data/agent.js', import.meta.url), 'utf8');
    const auth = fs.readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
    expect(agent.slice(agent.indexOf('export function logout'))).toMatch(/invalidateAuthWrites\(\)/);
    expect(auth.slice(auth.indexOf('function endAttempt'))).toMatch(/invalidateAuthWrites\(\)/);
  });

  it('boots root from the same authority the route guards use', async () => {
    // Rendering the public login screen from a weaker read than guardRedirect
    // uses is how the screen and the next refresh came to disagree.
    const fs = await import('node:fs');
    const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
    const root = main
      .slice(main.indexOf("route('/', ()"), main.indexOf("route('/about'"))
      .replace(/^\s*\/\/.*$/gm, '');
    expect(root).toMatch(/rehydrateSession\(\)/);
    expect(root).not.toMatch(/isSessionLive\(\)/);
  });
});
