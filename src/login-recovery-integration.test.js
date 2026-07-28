/**
 * CONT-LOGIN-1 — the stalled login, end to end.
 *
 * These drive the REAL startLogin against a real JSDOM and render its statuses
 * through the REAL shared status component, because every symptom being fixed
 * here was only visible at that join: the flow could be running perfectly well
 * while the screen said nothing, offered nothing, and answered a second click
 * with silence.
 *
 * The recorded behaviour before this change:
 *   STATUSES: [challenge, signing]   ← then nothing, forever
 *   IN FLIGHT: true                  ← never released
 *   HAS cancelLogin EXPORT: undefined
 *   SECOND CLICK PRODUCED STATUSES: 0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PUBKEY = 'a'.repeat(64);
const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

/** A fetch that never answers but DOES honour abort, like a real hung request. */
function hang(signal) {
  return new Promise((_res, rej) => {
    if (!signal) return;
    signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      rej(e);
    });
  });
}

function token() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `1.${exp}.${PUBKEY}.1.sig`;
}

/**
 * @param {object} o
 * @param {'ok'|'hang'|'reject'|'never'} [o.signer] how the extension behaves
 * @param {boolean} [o.noSigner] no NIP-07 extension at all
 * @param {boolean} [o.challengeHangs]
 * @param {boolean} [o.verifyRejects]
 */
function mk(o = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="status"></div></body></html>', {
    url: 'https://torii.test/continuum/#/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  // A signer we can settle by hand, so a "late" answer after cancel is testable.
  let settleSigner;
  const signerPending = new Promise((res) => { settleSigner = res; });

  if (!o.noSigner) {
    window.nostr = {
      calls: 0,
      signEvent(e) {
        this.calls += 1;
        if (o.signer === 'never') return signerPending.then(() => ({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY }));
        if (o.signer === 'reject') return Promise.reject(new Error('user rejected'));
        return Promise.resolve({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY });
      },
    };
  }

  for (const k of GLOBALS) {
    if (k !== 'fetch' && k !== 'getComputedStyle') globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/auth/challenge')) {
      if (o.challengeHangs) return hang(init?.signal);
      return { ok: true, status: 200, json: async () => ({ ok: true, challenge: 'c'.repeat(64) }) };
    }
    if (u.includes('/api/auth/verify')) {
      if (o.verifyHangs) return hang(init?.signal);
      if (o.verifyRejects) {
        return { ok: false, status: 401, json: async () => ({ ok: false, error: 'bad signature' }) };
      }
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return { ok: true, status: 200, json: async () => ({ ok: true, token: token(), expires_at: exp }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  window.__signerAnswers = settleSigner;
  return window;
}

/** Let pending promise chains run without advancing the clock. */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
});

/**
 * Wire startLogin to the shared renderer exactly as both real surfaces do, and
 * expose the rendered DOM plus the raw status stream.
 */
async function harness(w) {
  const auth = await import('./auth.js');
  const { renderLoginStatus } = await import('./components/login-status.js');
  const el = w.document.getElementById('status');
  const seen = [];
  const sink = (s) => {
    seen.push(s);
    renderLoginStatus(el, s, {
      onRetry: () => auth.startLogin({ onStatus: sink }),
      onCancel: () => auth.cancelLogin(),
    });
  };
  return {
    auth,
    el,
    seen,
    sink,
    start: () => auth.startLogin({ onStatus: sink }),
    cancelBtn: () => el.querySelector('[data-login-cancel]'),
    retryBtn: () => el.querySelector('[data-login-retry]'),
    text: () => el.textContent,
    sessions: (() => {
      let n = 0;
      w.document.addEventListener('continuum:session-changed', () => { n += 1; });
      return () => n;
    })(),
  };
}

describe('a signer that never answers', () => {
  it('offers a way out instead of an unbounded silent wait', async () => {
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();

    expect(t.auth.isLoginInFlight()).toBe(true);
    expect(t.auth.loginStage()).toBe('signer');
    // The affordance the operator was missing entirely.
    expect(t.cancelBtn()).not.toBeNull();
    expect(t.text()).toMatch(/step 2 of 3/);
  });

  it('stops claiming to be merely "waiting" once the wait runs long', async () => {
    const w = mk({ signer: 'never' });
    const { SIGNER_SLOW_HINT_MS } = await import('./login-stages.js');
    const t = await harness(w);
    t.start();
    await flush();
    const before = t.text();

    await vi.advanceTimersByTimeAsync(SIGNER_SLOW_HINT_MS + 10);

    expect(t.text()).not.toBe(before);
    expect(t.text()).toMatch(/popup/i);
    // Still trying — the escalation is copy only, the stage keeps running.
    expect(t.auth.isLoginInFlight()).toBe(true);
    expect(t.cancelBtn()).not.toBeNull();
  });

  it('gives up on its own deadline rather than hanging forever', async () => {
    const w = mk({ signer: 'never' });
    const { STAGE_TIMEOUTS_MS } = await import('./login-stages.js');
    const t = await harness(w);
    t.start();
    await flush();

    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.signer + 100);

    expect(t.auth.isLoginInFlight()).toBe(false);
    expect(t.text()).toMatch(/did not answer in time/i);
    expect(t.retryBtn()).not.toBeNull();
  });
});

describe('cancelling', () => {
  it('releases the attempt and says so', async () => {
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();

    t.cancelBtn().dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();

    expect(t.auth.isLoginInFlight()).toBe(false);
    expect(t.auth.loginStage()).toBeNull();
    expect(t.text()).toMatch(/cancelled/i);
    // A cancel is an outcome the operator chose, not a failure to shout about.
    expect(t.el.className).not.toMatch(/error/);
  });

  it('ignores a signer that answers after the operator gave up', async () => {
    // The dangerous case: the extension finally resolves minutes later. It must
    // not resurrect the abandoned attempt, store a token, or navigate the app
    // out from under whatever the operator is now doing.
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();
    t.cancelBtn().dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();
    const afterCancel = t.text();

    w.__signerAnswers();
    await vi.advanceTimersByTimeAsync(1000);

    expect(w.localStorage.getItem('continuum.session.v1')).toBeNull();
    expect(t.sessions()).toBe(0);
    expect(t.text()).toBe(afterCancel);
    expect(t.auth.isLoginInFlight()).toBe(false);
  });

  it('lets the operator start over immediately afterwards', async () => {
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();
    t.cancelBtn().dispatchEvent(new w.Event('click', { bubbles: true }));
    await flush();

    // A fresh attempt reaches the signer again — the latch is genuinely free.
    t.start();
    await flush();
    expect(t.auth.isLoginInFlight()).toBe(true);
    expect(w.nostr.calls).toBe(2);
  });
});

describe('clicking again while an attempt is running', () => {
  it('answers the click instead of swallowing it', async () => {
    // Previously: `if (loginInFlight) return;` → zero statuses, a dead button.
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();
    const before = t.seen.length;

    await t.start();
    await flush();

    expect(t.seen.length).toBeGreaterThan(before);
    expect(t.seen.at(-1).phase).toBe('busy');
  });

  it('does not pop a second signer prompt', async () => {
    const w = mk({ signer: 'never' });
    const t = await harness(w);
    t.start();
    await flush();
    await t.start();
    await flush();

    expect(w.nostr.calls).toBe(1);
  });
});

describe('a hung agent', () => {
  it('bounds the challenge with its own deadline, not the generic client budget', async () => {
    const w = mk({ challengeHangs: true });
    const { STAGE_TIMEOUTS_MS } = await import('./login-stages.js');
    const t = await harness(w);
    t.start();
    await flush();
    expect(t.auth.isLoginInFlight()).toBe(true);

    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.challenge + 100);

    // Well inside the old 30s default, which is what used to apply here.
    expect(STAGE_TIMEOUTS_MS.challenge + 100).toBeLessThan(30_000);
    expect(t.auth.isLoginInFlight()).toBe(false);
    expect(t.text()).toMatch(/challenge/);
    expect(t.retryBtn()).not.toBeNull();
  });

  it('never invokes the signer when the challenge fails', async () => {
    const w = mk({ challengeHangs: true });
    const { STAGE_TIMEOUTS_MS } = await import('./login-stages.js');
    const t = await harness(w);
    t.start();
    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.challenge + 100);

    expect(w.nostr.calls).toBe(0);
  });
});

describe('the absolute deadline', () => {
  it('releases the latch even if every stage timer fails to fire', async () => {
    // The never-wedge guarantee. The latch must not be only as reliable as the
    // least reliable thing it awaits — which is a browser extension.
    const w = mk({ signer: 'never' });
    const { LOGIN_DEADLINE_MS } = await import('./login-stages.js');
    const t = await harness(w);

    const timers = [];
    t.auth.startLogin({
      onStatus: t.sink,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    await flush();
    expect(t.auth.isLoginInFlight()).toBe(true);

    const watchdog = timers.find((x) => x.ms === LOGIN_DEADLINE_MS);
    expect(watchdog).toBeDefined();
    watchdog.fn();
    await flush();

    expect(t.auth.isLoginInFlight()).toBe(false);
    expect(t.auth.loginStage()).toBeNull();
    expect(t.text()).toMatch(/did not answer in time/i);
  });
});

describe('recovering', () => {
  it('signs in on a retry after the signer declined', async () => {
    const w = mk({ signer: 'reject' });
    const t = await harness(w);
    await t.start();
    await flush();

    expect(t.text()).toMatch(/declined/i);
    const retry = t.retryBtn();
    expect(retry).not.toBeNull();

    // Second time the operator approves.
    w.nostr.signEvent = function (e) {
      this.calls += 1;
      return Promise.resolve({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: PUBKEY });
    };
    retry.dispatchEvent(new w.Event('click', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(50);
    await flush(20);

    expect(w.localStorage.getItem('continuum.session.v1')).toBeTruthy();
    expect(t.sessions()).toBe(1);
    expect(t.text()).toMatch(/signed in/i);
  });

  it('offers install links, and no retry, when there is no extension', async () => {
    const w = mk({ noSigner: true });
    const { SIGNER_WAIT_MS, KNOWN_SIGNERS } = await import('./signer-compat.js');
    const t = await harness(w);
    const done = t.start();

    // "No signer" is now concluded after a brief wait, not from one synchronous
    // read, because extensions inject from a content script that is not ordered
    // against our bundle (CONT-SIGNER-1). So the clock has to move before the
    // verdict lands — and on fake timers it only moves when we say so.
    await vi.advanceTimersByTimeAsync(SIGNER_WAIT_MS + 50);
    await done;
    await flush();

    // A missing extension is the one failure a button cannot fix. Every signer
    // in the registry is offered, not one hand-picked vendor.
    const links = t.el.querySelectorAll('.login-inline-links a');
    const expected = KNOWN_SIGNERS.reduce((n, sg) => n + sg.links.length, 0);
    expect(links.length).toBe(expected);
    expect(expected).toBeGreaterThan(2);
    expect(t.retryBtn()).toBeNull();
    expect(t.auth.isLoginInFlight()).toBe(false);
  });

  it('names the agent, retryably, when the agent rejects the signature', async () => {
    const w = mk({ verifyRejects: true });
    const t = await harness(w);
    await t.start();
    await flush(20);

    expect(t.text()).toMatch(/agent rejected/i);
    expect(t.retryBtn()).not.toBeNull();
    expect(t.auth.isLoginInFlight()).toBe(false);
  });
});

describe('the happy path still works', () => {
  it('walks the three stages and signs in', async () => {
    const w = mk();
    const t = await harness(w);
    await t.start();
    await flush(20);

    expect(t.seen.map((s) => s.phase)).toEqual(
      expect.arrayContaining(['challenge', 'signer', 'verify', 'done']),
    );
    expect(w.localStorage.getItem('continuum.session.v1')).toBeTruthy();
    expect(t.sessions()).toBe(1);
    expect(t.auth.isLoginInFlight()).toBe(false);
    // No leftover affordances on a clean success.
    expect(t.cancelBtn()).toBeNull();
    expect(t.retryBtn()).toBeNull();
  });

  it('bounds the last stage too, so a hung verify cannot wedge the attempt', async () => {
    // Verify is the easiest stage to forget: the signature is already in hand,
    // so a hang here looks like success that never arrives.
    const w = mk({ verifyHangs: true });
    const { STAGE_TIMEOUTS_MS } = await import('./login-stages.js');
    const t = await harness(w);
    t.start();
    await flush(20);
    expect(t.auth.loginStage()).toBe('verify');

    await vi.advanceTimersByTimeAsync(STAGE_TIMEOUTS_MS.verify + 100);

    expect(t.auth.isLoginInFlight()).toBe(false);
    expect(t.text()).toMatch(/verify/);
    expect(t.retryBtn()).not.toBeNull();
    expect(w.localStorage.getItem('continuum.session.v1')).toBeNull();
  });
});
