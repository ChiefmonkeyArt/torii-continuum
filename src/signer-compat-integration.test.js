/**
 * CONT-SIGNER-1 — the login flow against the signers that actually exist.
 *
 * NIP-07 pins the call, not the answer, so extensions disagree about how much of
 * the event they return: some echo it whole, some return only `{ id, sig }`,
 * some omit `pubkey`, some rewrite `created_at`, and some are injected after our
 * bundle has already run. The flow was written against exactly one of those
 * shapes and forwarded the signer's answer to the agent verbatim.
 *
 * Every test here drives the REAL `startLogin` against a real `window.nostr`
 * stand-in, and the stubbed `/api/auth/verify` applies the same checks
 * `agent/core/auth.mjs` applies — kind, a challenge tag, and the presence of
 * every field the id hashes over. So a test passing means the browser put a
 * payload on the wire that the agent would actually accept, not merely that no
 * exception was thrown.
 *
 * The security argument for reconciling at all is that the agent independently
 * recomputes the id hash and verifies the signature against it, so filling a
 * gap can only produce a well-shaped payload — never an acceptance. The two
 * `pubkey` tests below are what hold that line: the key comes from the signer,
 * via `getPublicKey()`, and if the signer will not name one the login fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);
const ID = 'i'.repeat(64);
const SIG = 's'.repeat(128);
const CHALLENGE = 'c'.repeat(48);
const TOKEN_KEY = 'continuum.session.v1';

const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;

/**
 * @param {{signEvent: Function, getPublicKey?: Function|null, noSigner?: boolean,
 *          injectAfterMs?: number, verifyFail?: {code?: string, error: string}}} opts
 */
function makeWindow({
  signEvent,
  getPublicKey = async () => PUBKEY,
  noSigner = false,
  injectAfterMs = 0,
  verifyFail = null,
} = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://torii.test/continuum/#/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  const install = () => {
    window.nostr = { signEvent };
    if (getPublicKey) window.nostr.getPublicKey = getPublicKey;
  };
  if (!noSigner) {
    if (injectAfterMs) setTimeout(install, injectAfterMs);
    else install();
  }

  for (const k of GLOBALS) {
    if (k === 'fetch' || k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  const sent = [];
  window.__sent = sent;

  globalThis.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('/api/auth/challenge')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, challenge: CHALLENGE, expires_in: 120 }) };
    }
    if (u.includes('/api/auth/verify')) {
      const event = JSON.parse(init.body).event;
      sent.push(event);
      if (verifyFail) {
        return { ok: false, status: 401, json: async () => ({ ok: false, ...verifyFail }) };
      }
      // Stand in for agent/core/auth.mjs. These are its actual gates, in its
      // actual order, so a payload that passes here is one it would accept.
      const refuse = (code, error) => ({
        ok: false, status: 401, json: async () => ({ ok: false, code, error }),
      });
      if (event.kind !== 22242) return refuse('wrong_kind', 'wrong kind (expected 22242)');
      const tag = (event.tags || []).find((t) => Array.isArray(t) && t[0] === 'challenge');
      if (!tag || !tag[1]) return refuse('malformed_event', 'missing challenge tag');
      if (tag[1] !== CHALLENGE) return refuse('challenge_expired', 'unknown or expired challenge');
      if (event.content && event.content !== CHALLENGE) return refuse('malformed_event', 'content/tag mismatch');
      // The id hashes over [0, pubkey, created_at, kind, tags, content], so any
      // one of them being absent is an id mismatch at the agent.
      if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
        return refuse('malformed_event', 'id mismatch');
      }
      if (typeof event.created_at !== 'number') return refuse('malformed_event', 'id mismatch');
      if (typeof event.sig !== 'string' || !event.sig) return refuse('bad_signature', 'bad signature');
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, token: `1.${exp}.${event.pubkey}.1.sig`, expires_at: exp }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  return window;
}

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
};

/** Drive a real login and collect every status the surface would have shown. */
async function login(opts) {
  const w = makeWindow(opts);
  const auth = await import('./auth.js');
  const seen = [];
  await auth.startLogin({ onStatus: (s) => seen.push(s) });
  await settle();
  return { w, seen, last: seen.at(-1), auth, sent: w.__sent };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

const whole = (e) => ({ ...e, pubkey: PUBKEY, id: ID, sig: SIG });

// ─── The shapes signers return ───────────────────────────────

describe('a signer that returns less than the whole event', () => {
  it('signs in when the signer returns only {id, sig}', async () => {
    // Several NIP-46 bridges and remote signers do exactly this. Forwarded
    // verbatim it reached the agent as a kind-less, tag-less object and came
    // back as the agent's complaint about our own payload.
    const { last, sent } = await login({ signEvent: async () => ({ id: ID, sig: SIG }) });

    expect(last).toMatchObject({ phase: 'done', done: true });
    expect(sent[0]).toMatchObject({
      kind: 22242,
      content: CHALLENGE,
      id: ID,
      sig: SIG,
      pubkey: PUBKEY,
    });
    expect(sent[0].tags).toEqual([['challenge', CHALLENGE], ['relay', 'https://torii.test']]);
    expect(typeof sent[0].created_at).toBe('number');
  });

  it('signs in when the signer echoes the event but omits pubkey', async () => {
    const { last, sent } = await login({
      signEvent: async (e) => ({ ...e, id: ID, sig: SIG }),
    });

    expect(last).toMatchObject({ phase: 'done', done: true });
    expect(sent[0].pubkey).toBe(PUBKEY);
  });

  it('takes the pubkey from the signer, never from anywhere else', async () => {
    // The whole safety argument rests on this. A key we chose would change the
    // id hash and be refused, so the only correct source is the signer itself —
    // and here the signer names a DIFFERENT key than the tests elsewhere use,
    // to prove the value is not a constant leaking in from the harness.
    const { last, sent } = await login({
      signEvent: async () => ({ id: ID, sig: SIG }),
      getPublicKey: async () => OTHER_PUBKEY,
    });

    expect(last).toMatchObject({ phase: 'done', done: true });
    expect(sent[0].pubkey).toBe(OTHER_PUBKEY);
  });

  it('fails honestly when the signer will not name a pubkey at all', async () => {
    // Nothing local can fill this hole, and inventing one would only produce a
    // payload the agent refuses. So the flow must stop and say the signer is the
    // problem — not offer a plain retry against the agent.
    const { last, sent } = await login({
      signEvent: async () => ({ id: ID, sig: SIG }),
      getPublicKey: null,
    });

    expect(last.error).toBe(true);
    expect(last.stage).toBe('signer');
    expect(last.recovery).toBe('switch-signer');
    expect(sent).toHaveLength(0);
  });

  it('reports an answer with no signature as unsigned, and sends nothing', async () => {
    const { last, sent } = await login({ signEvent: async (e) => ({ ...e, id: ID }) });

    expect(last).toMatchObject({ phase: 'error', stage: 'signer', kind: 'unsigned' });
    expect(last.retryable).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe('a signer that changes what it signed', () => {
  it('still signs in when the signer rewrites created_at', async () => {
    // A REGRESSION GUARD, not a bug. NIP-07 permits a signer to adjust
    // created_at and the agent accepts it, because the signature covers whatever
    // the signer chose. This case already worked, and a reconciliation that
    // preferred our own values would have silently broken it.
    const rewritten = 1_600_000_000;
    const { last, sent } = await login({
      signEvent: async (e) => whole({ ...e, created_at: rewritten }),
    });

    expect(last).toMatchObject({ phase: 'done', done: true });
    expect(sent[0].created_at).toBe(rewritten);
  });

  it('keeps extra tags the signer added rather than overwriting them', async () => {
    const { last, sent } = await login({
      signEvent: async (e) => whole({ ...e, tags: [...e.tags, ['client', 'bridge']] }),
    });

    expect(last).toMatchObject({ phase: 'done', done: true });
    expect(sent[0].tags).toContainEqual(['client', 'bridge']);
  });

  it('blames the signer, not the agent, when it drops the challenge tag', async () => {
    // Previously: "Your agent rejected the signature: missing challenge tag" —
    // the wrong component named, and a Retry offered against a signer that will
    // do the same thing again. Re-adding the tag is not an option either: it
    // would change the id and invalidate the signature.
    const { last, sent } = await login({ signEvent: async (e) => whole({ ...e, tags: [] }) });

    expect(last.error).toBe(true);
    expect(last.stage).toBe('signer');
    expect(last.kind).toBe('signer_changed_challenge');
    expect(last.recovery).toBe('switch-signer');
    expect(last.retryable).toBe(false);
    expect(last.message).toMatch(/signer/i);
    expect(sent).toHaveLength(0);
  });

  it('blames the signer when it rewrites the challenge value', async () => {
    const { last, sent } = await login({
      signEvent: async (e) => whole({ ...e, tags: [['challenge', 'd'.repeat(48)]] }),
    });

    expect(last.kind).toBe('signer_changed_challenge');
    expect(sent).toHaveLength(0);
  });
});

// ─── Injection timing ────────────────────────────────────────

describe('a signer that is injected late', () => {
  it('signs in when window.nostr appears after the click', async () => {
    // Extensions inject from a content script that is not ordered against our
    // bundle. Deciding "no signer" from one synchronous read told an operator
    // who HAS a signer to go install one — and no_signer offers no retry, so it
    // was a dead end for a working setup.
    const { last } = await login({ signEvent: async (e) => whole(e), injectAfterMs: 60 });

    expect(last).toMatchObject({ phase: 'done', done: true });
  });

  it('still concludes there is no signer when none ever appears', async () => {
    const { last, w } = await login({ noSigner: true });

    expect(last).toMatchObject({ kind: 'no_signer', recovery: 'install-signer', signerMissing: true });
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('does not delay a signer that was there all along', async () => {
    const t0 = Date.now();
    const { last } = await login({ signEvent: async (e) => whole(e) });

    expect(last).toMatchObject({ phase: 'done', done: true });
    // Generous, but far below the injection window: the present-signer path must
    // not pay for the absent-signer one.
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('leaves no attempt latched after giving up on a missing signer', async () => {
    const { auth } = await login({ noSigner: true });
    expect(auth.isLoginInFlight()).toBe(false);
    expect(auth.loginStage()).toBeNull();
  });
});

// ─── Routing on the agent's refusal ──────────────────────────

describe('what the agent refuses, and what the operator is offered', () => {
  it('does not offer a retry loop for a key that is not the owner', async () => {
    // The refusal a retry can never fix. Previously recovery:'retry', which is
    // an invitation to press a button forever.
    const { last, w } = await login({
      signEvent: async (e) => whole(e),
      verifyFail: { code: 'not_owner', error: 'pubkey is not admin npub' },
    });

    expect(last.kind).toBe('not_owner');
    expect(last.recovery).toBe('switch-signer');
    expect(last.retryable).toBe(false);
    expect(last.message).toMatch(/owner/i);
    expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('DOES offer a retry when the challenge merely expired', async () => {
    const { last } = await login({
      signEvent: async (e) => whole(e),
      verifyFail: { code: 'challenge_expired', error: 'unknown or expired challenge' },
    });

    expect(last.kind).toBe('challenge_expired');
    expect(last.retryable).toBe(true);
    expect(last.recovery).toBe('retry');
  });

  it('names the signer when the agent could not verify what it produced', async () => {
    for (const code of ['malformed_event', 'wrong_kind', 'bad_signature']) {
      vi.resetModules();
      const { last } = await login({
        signEvent: async (e) => whole(e),
        verifyFail: { code, error: 'nope' },
      });
      expect(last.kind, code).toBe('signer_incompatible');
      expect(last.recovery, code).toBe('switch-signer');
      try { dom?.window?.close(); } catch (_e) {}
    }
  });

  it('behaves exactly as before against an agent that sends no code', async () => {
    // Forward compatibility the other way: this browser talking to an agent
    // released before the code existed must degrade to the old generic message.
    const { last } = await login({
      signEvent: async (e) => whole(e),
      verifyFail: { error: 'something the old agent said' },
    });

    expect(last.kind).toBe('agent_rejected');
    expect(last.recovery).toBe('retry');
    expect(last.message).toContain('something the old agent said');
  });
});

// ─── Every failure still reaches the screen with a way forward ─

describe('no signer failure is a dead end', () => {
  const cases = [
    ['returns nothing', { signEvent: async () => null }],
    ['returns a string', { signEvent: async () => 'signed' }],
    ['returns an unsigned event', { signEvent: async (e) => ({ ...e, id: ID }) }],
    ['drops the challenge tag', { signEvent: async (e) => whole({ ...e, tags: [] }) }],
    ['will not name a pubkey', { signEvent: async () => ({ id: ID, sig: SIG }), getPublicKey: null }],
    ['throws', { signEvent: async () => { throw new Error('user rejected'); } }],
  ];

  for (const [name, opts] of cases) {
    it(`gives the operator something to do when the signer ${name}`, async () => {
      const { last, w, auth } = await login(opts);

      expect(last.error).toBe(true);
      expect(last.message.length).toBeGreaterThan(0);
      // Either a button to press or a list of signers to install — never a bare
      // sentence with nothing behind it.
      expect(last.retryable || last.recovery === 'switch-signer'
        || last.recovery === 'install-signer').toBe(true);
      // And a failed attempt persists nothing that a refresh could read as a
      // session (CONT-SESSION-1's invariant, held here too).
      expect(w.localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(auth.isLoginInFlight()).toBe(false);
      try { dom?.window?.close(); } catch (_e) {}
    });
  }
});

// ─── Where the reconciliation has to sit ─────────────────────

describe('the shape fix sits between the signer and the wire', () => {
  it('sends the reconciled event, not the signer’s raw answer', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function startLogin'));

    const reconcile = body.indexOf('reconcileSignedEvent(');
    const verify = body.indexOf('await verifyChallenge(');
    expect(reconcile).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(reconcile);
    // The raw answer must not be what goes on the wire.
    expect(body.slice(verify, verify + 60)).toContain('reconciled.event');
  });

  it('checks the challenge survived before spending a round trip on it', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function startLogin'));

    expect(body.indexOf('signerAlteredChallenge('))
      .toBeLessThan(body.indexOf('await verifyChallenge('));
  });
});
