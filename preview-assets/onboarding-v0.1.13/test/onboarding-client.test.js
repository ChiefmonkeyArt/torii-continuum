/**
 * Offline tests for the onboarding step-1 auth client (v0.1.13-preview).
 * All network + signer + relay behaviour is mocked; no sockets, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AUTH_KIND,
  SESSION_KEY,
  ANIM,
  selectAnimation,
  buildAuthEvent,
  validateChallengeResponse,
  validateVerifyResponse,
  validateSignedEvent,
  buildSessionValue,
  storeSession,
  readSession,
  loginWithNip07,
  loginWithNip46,
  parseBunkerUri,
} from '../onboarding-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREVIEW_DIR = join(__dirname, '..');

// ── helpers ─────────────────────────────────────────────────────────
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// A hex pubkey (64) and sig (128) that pass shape validation.
const PUBKEY = 'a'.repeat(64);
const SIG = 'b'.repeat(128);

function goodSignedEvent(challenge, pubkey = PUBKEY) {
  return {
    kind: AUTH_KIND,
    created_at: 1000,
    content: challenge,
    pubkey,
    sig: SIG,
    id: 'c'.repeat(64),
    tags: [
      ['challenge', challenge],
      ['relay', 'https://chiefmonkey.art'],
    ],
  };
}

// fetch mock keyed by path; records every call.
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, opts) => {
    calls.push({ path, opts });
    const r = routes[path];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'no route' }) };
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const now = () => 1000;

// ── animation selection ─────────────────────────────────────────────
describe('selectAnimation', () => {
  it('maps phases to the exact requested clips', () => {
    expect(ANIM.prompting.clip).toBe('HandGesture_00');
    expect(ANIM.success.clip).toBe('Idle_03');
    expect(ANIM.failure.clip).toBe('Confused_02');
  });

  it('returns the primary clip when it is present', () => {
    const all = new Set(['HandGesture_00', 'Idle_03', 'Confused_02']);
    expect(selectAnimation('prompting', all)).toBe('HandGesture_00');
    expect(selectAnimation('success', all)).toBe('Idle_03');
    expect(selectAnimation('failure', all)).toBe('Confused_02');
  });

  it('falls back to an available clip when the primary is missing', () => {
    // Mirrors the shipped GLB: it lacks HandGesture_00 + Confused_02.
    const glb = new Set(['Idle_03', 'idle_to_push_up', 'Hit_Reaction_to_Waist', 'Knock_Down']);
    expect(selectAnimation('prompting', glb)).toBe('idle_to_push_up');
    expect(selectAnimation('failure', glb)).toBe('Hit_Reaction_to_Waist');
    expect(selectAnimation('success', glb)).toBe('Idle_03');
  });

  it('returns null (keep current) when nothing matches — graceful fallback', () => {
    expect(selectAnimation('failure', new Set(['Walking']))).toBeNull();
    expect(selectAnimation('bogus', new Set(['Idle_03']))).toBeNull();
  });
});

// ── API response validation (fail closed) ───────────────────────────
describe('validateChallengeResponse', () => {
  it('accepts a well-formed response', () => {
    const out = validateChallengeResponse({ challenge: 'deadbeefcafe', expires_in: 300, kind: 22242 });
    expect(out.challenge).toBe('deadbeefcafe');
    expect(out.expires_in).toBe(300);
  });

  it('rejects malformed / missing / wrong-kind challenges', () => {
    expect(() => validateChallengeResponse(null)).toThrow();
    expect(() => validateChallengeResponse({})).toThrow();
    expect(() => validateChallengeResponse({ challenge: 'short' })).toThrow();
    expect(() => validateChallengeResponse({ challenge: 'deadbeefcafe', expires_in: 0 })).toThrow();
    expect(() => validateChallengeResponse({ challenge: 'deadbeefcafe', expires_in: 300, kind: 1 })).toThrow();
  });
});

describe('validateVerifyResponse', () => {
  it('accepts a token with/without expiry', () => {
    expect(validateVerifyResponse({ token: 't' }).token).toBe('t');
    expect(validateVerifyResponse({ token: 't', expires_at: 42 }).expires_at).toBe(42);
  });

  it('fails closed on an absent or malformed token', () => {
    expect(() => validateVerifyResponse(null)).toThrow();
    expect(() => validateVerifyResponse({})).toThrow();
    expect(() => validateVerifyResponse({ token: '' })).toThrow();
    expect(() => validateVerifyResponse({ token: 't', expires_at: 'soon' })).toThrow();
  });
});

describe('validateSignedEvent', () => {
  it('accepts a well-formed signed event matching the challenge', () => {
    const ch = 'deadbeefcafe';
    expect(() => validateSignedEvent(goodSignedEvent(ch), ch)).not.toThrow();
  });

  it('fails closed on wrong kind, missing sig/pubkey, or challenge mismatch', () => {
    const ch = 'deadbeefcafe';
    expect(() => validateSignedEvent({ ...goodSignedEvent(ch), kind: 1 }, ch)).toThrow();
    expect(() => validateSignedEvent({ ...goodSignedEvent(ch), sig: undefined }, ch)).toThrow();
    expect(() => validateSignedEvent({ ...goodSignedEvent(ch), pubkey: 'xx' }, ch)).toThrow();
    expect(() => validateSignedEvent(goodSignedEvent(ch), 'other-challenge')).toThrow();
  });
});

// ── buildAuthEvent shape ────────────────────────────────────────────
describe('buildAuthEvent', () => {
  it('matches the agent contract exactly (kind 22242, content + tags)', () => {
    const ev = buildAuthEvent('deadbeefcafe', 'https://chiefmonkey.art', now);
    expect(ev.kind).toBe(22242);
    expect(ev.content).toBe('deadbeefcafe');
    expect(ev.created_at).toBe(1000);
    expect(ev.tags).toContainEqual(['challenge', 'deadbeefcafe']);
    expect(ev.tags).toContainEqual(['relay', 'https://chiefmonkey.art']);
  });
});

// ── session storage shape + key ─────────────────────────────────────
describe('session storage', () => {
  it('writes to exactly localStorage["torii.session"]', () => {
    expect(SESSION_KEY).toBe('torii.session');
    const store = fakeStorage();
    const s = buildSessionValue({ token: 'tok', expires_at: 5000, pubkey: PUBKEY, method: 'nip07' }, now);
    storeSession(s, store);
    expect(store._map.has('torii.session')).toBe(true);
    expect([...store._map.keys()]).toEqual(['torii.session']);
    expect(readSession(store)).toEqual(s);
  });

  it('stores only token + public identity metadata — no secrets', () => {
    const s = buildSessionValue({ token: 'tok', expires_at: 5000, pubkey: PUBKEY, method: 'nip46' }, now);
    expect(Object.keys(s).sort()).toEqual(['created_at', 'expires_at', 'method', 'pubkey', 'token']);
    const serialized = JSON.stringify(s).toLowerCase();
    for (const forbidden of ['nsec', 'secret', 'privkey', 'private', 'seed', 'bunker://']) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});

// ── NIP-07 flow ─────────────────────────────────────────────────────
describe('loginWithNip07', () => {
  const CH = 'deadbeefcafe0123';
  function routes() {
    return {
      '/api/auth/challenge': { body: { challenge: CH, expires_in: 300, kind: 22242 } },
      '/api/auth/verify': { body: { token: 'session-token', expires_at: 9999 } },
    };
  }

  it('succeeds end-to-end and stores a nip07 session', async () => {
    const phases = [];
    const fetchImpl = makeFetch(routes());
    const store = fakeStorage();
    const signer = { signEvent: async (t) => goodSignedEvent(t.content) };
    const res = await loginWithNip07({
      fetch: fetchImpl, signer, storage: store,
      origin: 'https://chiefmonkey.art', now, onPhase: (p) => phases.push(p),
    });
    expect(res.ok).toBe(true);
    expect(res.session.method).toBe('nip07');
    expect(res.session.token).toBe('session-token');
    expect(res.session.pubkey).toBe(PUBKEY);
    expect(readSession(store).token).toBe('session-token');
    expect(phases).toEqual(['prompting', 'success']);
    // verify posted the signed event
    const verifyCall = fetchImpl.calls.find((c) => c.path === '/api/auth/verify');
    expect(JSON.parse(verifyCall.opts.body).event.kind).toBe(22242);
  });

  // Regression (v0.1.13): the bodyless challenge POST must NOT advertise a
  // JSON content-type. Fastify rejects an empty body sent with
  // `Content-Type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY, HTTP 400),
  // which surfaced to the operator as "agent challenge failed (400)".
  it('sends the challenge POST with no body and no JSON content-type', async () => {
    const fetchImpl = makeFetch(routes());
    const signer = { signEvent: async (t) => goodSignedEvent(t.content) };
    const res = await loginWithNip07({
      fetch: fetchImpl, signer, storage: fakeStorage(),
      origin: 'https://chiefmonkey.art', now,
    });
    expect(res.ok).toBe(true);

    const challengeCall = fetchImpl.calls.find((c) => c.path === '/api/auth/challenge');
    expect(challengeCall.opts.body).toBeUndefined();
    const chHeaders = challengeCall.opts.headers || {};
    expect(chHeaders['Content-Type']).toBeUndefined();

    // The verify call DOES carry a body, so it must still set the JSON type.
    const verifyCall = fetchImpl.calls.find((c) => c.path === '/api/auth/verify');
    expect(verifyCall.opts.headers['Content-Type']).toBe('application/json');
    expect(typeof verifyCall.opts.body).toBe('string');
  });

  it('fails closed and does not store when the signer refuses', async () => {
    const phases = [];
    const store = fakeStorage();
    const signer = { signEvent: async () => { throw new Error('user rejected'); } };
    const res = await loginWithNip07({
      fetch: makeFetch(routes()), signer, storage: store, origin: 'o', now, onPhase: (p) => phases.push(p),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/refused/);
    expect(store._map.size).toBe(0);
    expect(phases).toEqual(['prompting', 'failure']);
  });

  it('fails closed when the agent returns no token', async () => {
    const store = fakeStorage();
    const r = routes();
    r['/api/auth/verify'] = { body: { expires_at: 1 } }; // no token
    const res = await loginWithNip07({
      fetch: makeFetch(r), signer: { signEvent: async (t) => goodSignedEvent(t.content) },
      storage: store, origin: 'o', now,
    });
    expect(res.ok).toBe(false);
    expect(store._map.size).toBe(0);
  });

  it('fails closed on a pubkey/challenge mismatch in the signed event', async () => {
    const store = fakeStorage();
    // Signer returns an event bound to a different challenge.
    const signer = { signEvent: async () => goodSignedEvent('some-other-challenge') };
    const res = await loginWithNip07({
      fetch: makeFetch(routes()), signer, storage: store, origin: 'o', now,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/mismatch/);
    expect(store._map.size).toBe(0);
  });

  it('fails when no signer is present (does not throw)', async () => {
    const res = await loginWithNip07({ fetch: makeFetch(routes()), signer: null, storage: fakeStorage() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signer not found/i);
  });
});

// ── NIP-46 browser client ───────────────────────────────────────────
describe('parseBunkerUri', () => {
  it('parses a valid bunker:// connection string', () => {
    const out = parseBunkerUri(`bunker://${PUBKEY}?relay=wss://relay.example&secret=abc123`);
    expect(out.remotePubkey).toBe(PUBKEY);
    expect(out.relays).toEqual(['wss://relay.example']);
    expect(out.secret).toBe('abc123');
  });

  it('fails closed on bad scheme, bad pubkey, or missing relay', () => {
    expect(() => parseBunkerUri('')).toThrow();
    expect(() => parseBunkerUri('nostrconnect://foo')).toThrow();
    expect(() => parseBunkerUri(`bunker://zzz?relay=wss://r`)).toThrow();
    expect(() => parseBunkerUri(`bunker://${PUBKEY}`)).toThrow();
    expect(() => parseBunkerUri(`bunker://${PUBKEY}?relay=http://not-ws`)).toThrow();
  });
});

describe('loginWithNip46', () => {
  const CH = 'deadbeefcafe0123';
  const BUNKER = `bunker://${PUBKEY}?relay=wss://relay.example&secret=s3cr3t`;
  function routes() {
    return {
      '/api/auth/challenge': { body: { challenge: CH, expires_in: 300, kind: 22242 } },
      '/api/auth/verify': { body: { token: 'session-token', expires_at: 9999 } },
    };
  }
  // Transport that acts as the NIP-46 client: connect + sign_event.
  function makeTransport() {
    const requests = [];
    return {
      requests,
      request: async (remotePubkey, method, params) => {
        requests.push({ remotePubkey, method, params });
        if (method === 'connect') return 'ack';
        if (method === 'sign_event') {
          const template = JSON.parse(params[0]);
          return goodSignedEvent(template.content);
        }
        throw new Error('unexpected method ' + method);
      },
    };
  }

  it('signs via the remote signer and stores a nip46 session', async () => {
    const fetchImpl = makeFetch(routes());
    const store = fakeStorage();
    const transport = makeTransport();
    const res = await loginWithNip46({
      bunkerUri: BUNKER, fetch: fetchImpl, transport, storage: store,
      origin: 'https://chiefmonkey.art', now,
    });
    expect(res.ok).toBe(true);
    expect(res.session.method).toBe('nip46');
    expect(readSession(store).token).toBe('session-token');
    // Handshake then sign_event, both to the remote signer pubkey.
    expect(transport.requests.map((r) => r.method)).toEqual(['connect', 'sign_event']);
    expect(transport.requests[0].remotePubkey).toBe(PUBKEY);
  });

  it('never calls a server bunker-connect endpoint — only challenge + verify', async () => {
    const fetchImpl = makeFetch(routes());
    const transport = makeTransport();
    await loginWithNip46({
      bunkerUri: BUNKER, fetch: fetchImpl, transport, storage: fakeStorage(), origin: 'o', now,
    });
    const paths = fetchImpl.calls.map((c) => c.path);
    expect(paths).toEqual(['/api/auth/challenge', '/api/auth/verify']);
    for (const p of paths) {
      expect(p.toLowerCase()).not.toContain('bunker');
      expect(p.toLowerCase()).not.toContain('nip46');
    }
    // The connection secret is never transmitted to the agent.
    for (const c of fetchImpl.calls) {
      expect(String(c.opts?.body || '')).not.toContain('s3cr3t');
    }
  });

  it('does not silently fall back when no transport is available', async () => {
    const fetchImpl = makeFetch(routes());
    const res = await loginWithNip46({
      bunkerUri: BUNKER, fetch: fetchImpl, transport: null, storage: fakeStorage(), now,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unavailable/i);
    // Fails before any network call — nothing leaks.
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('fails closed on a malformed connection string', async () => {
    const fetchImpl = makeFetch(routes());
    const res = await loginWithNip46({
      bunkerUri: 'not-a-bunker', fetch: fetchImpl, transport: makeTransport(), storage: fakeStorage(), now,
    });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });
});

// ── UI terminology + CDN guardrails ─────────────────────────────────
describe('step-1 UI copy + no CDN regression', () => {
  const html = readFileSync(join(PREVIEW_DIR, 'index.html'), 'utf8');
  // Isolate the step-1 panel.
  const step1 = html.slice(
    html.indexOf('data-panel="1"'),
    html.indexOf('data-panel="2"'),
  );

  it('step-1 signer button says "Sign with Plebeian Signer", never "Wallet"', () => {
    expect(step1).toContain('Sign with Plebeian Signer');
    expect(step1).not.toContain('Wallet');
    expect(step1).not.toContain('wallet');
  });

  it('keeps "Your Torii, your gateway" terminology and never says VPS', () => {
    expect(html).toContain('Your Torii');
    expect(html).toMatch(/gateway/i);
    expect(html).not.toMatch(/\bVPS\b/);
  });

  it('does not introduce a third-party production CDN for runtime code', () => {
    const banned = ['unpkg.com', 'jsdelivr.net', 'cdnjs', 'esm.sh', 'skypack', 'ga.jspm.io', 'googleapis.com'];
    for (const host of banned) {
      expect(html).not.toContain(host);
    }
    // Runtime scripts are same-origin relative paths.
    expect(html).toContain('./onboarding-client.js');
    expect(html).toContain('./three-libs/three/three.module.js');
  });

  it('onboarding-client.js is self-contained: no bare/CDN imports', () => {
    const client = readFileSync(join(PREVIEW_DIR, 'onboarding-client.js'), 'utf8');
    // No import statements at all (fully self-contained).
    expect(client).not.toMatch(/^\s*import\s/m);
    for (const host of ['unpkg', 'jsdelivr', 'esm.sh', 'skypack', 'cdnjs', 'http://', 'https://cdn']) {
      expect(client).not.toContain(host);
    }
  });
});
