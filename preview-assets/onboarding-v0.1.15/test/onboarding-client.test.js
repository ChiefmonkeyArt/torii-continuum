/**
 * Offline tests for the onboarding step-1 auth client (v0.1.15-preview).
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
  isSessionValid,
  restoreSession,
  nextLoadAttempt,
  createCharacterSync,
  recordStep,
  resolveReadyStep,
  markCharacterFailed,
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

// ── v0.1.14: session restore on reload (bug #1) ─────────────────────
// A valid stored session must restore the authenticated step on reload; an
// invalid/expired/tampered one must fail closed to step 1 (and be cleared).
// Tokens mirror the agent's self-verifying `iat.exp.pubkey.sig` shape.
describe('isSessionValid / restoreSession (reload restore, fail closed)', () => {
  const now = () => 1000;
  const SIG64 = 'd'.repeat(64);
  // exp in the future relative to now()=1000; pubkey embedded matches.
  const goodToken = `900.5000.${PUBKEY}.${SIG64}`;
  function goodSession(over = {}) {
    return { token: goodToken, expires_at: 5000, pubkey: PUBKEY, method: 'nip07', created_at: 900, ...over };
  }

  it('accepts a well-formed, unexpired session bound to its token pubkey', () => {
    expect(isSessionValid(goodSession(), now)).toBe(true);
    expect(isSessionValid(goodSession({ method: 'nip46' }), now)).toBe(true);
    // expires_at is optional; the token exp alone is authoritative.
    expect(isSessionValid(goodSession({ expires_at: null }), now)).toBe(true);
  });

  it('fails closed on expiry, bad shape, bad pubkey, wrong method, or identity mismatch', () => {
    expect(isSessionValid(null, now)).toBe(false);
    expect(isSessionValid({}, now)).toBe(false);
    // token exp already elapsed
    expect(isSessionValid(goodSession({ token: `900.999.${PUBKEY}.${SIG64}`, expires_at: 999 }), now)).toBe(false);
    // stored expires_at says dead even though token looks live
    expect(isSessionValid(goodSession({ expires_at: 999 }), now)).toBe(false);
    // not 4 parts
    expect(isSessionValid(goodSession({ token: `900.5000.${PUBKEY}` }), now)).toBe(false);
    // non-numeric timestamps
    expect(isSessionValid(goodSession({ token: `x.y.${PUBKEY}.${SIG64}` }), now)).toBe(false);
    // pubkey not 64-hex
    expect(isSessionValid(goodSession({ pubkey: 'nope' }), now)).toBe(false);
    // unknown signer method
    expect(isSessionValid(goodSession({ method: 'password' }), now)).toBe(false);
    // token's embedded pubkey disagrees with the stored pubkey (tamper)
    expect(isSessionValid(goodSession({ token: `900.5000.${'e'.repeat(64)}.${SIG64}` }), now)).toBe(false);
  });

  it('restoreSession returns a valid session and leaves storage intact', () => {
    const store = fakeStorage();
    storeSession(goodSession(), store);
    const out = restoreSession({ storage: store, now });
    expect(out).not.toBeNull();
    expect(out.token).toBe(goodToken);
    expect(store._map.has(SESSION_KEY)).toBe(true);
  });

  it('restoreSession fails closed AND clears an expired/invalid session', () => {
    const store = fakeStorage();
    storeSession(goodSession({ token: `900.999.${PUBKEY}.${SIG64}`, expires_at: 999 }), store);
    expect(restoreSession({ storage: store, now })).toBeNull();
    // Dead session removed so a subsequent reload can't resurrect it.
    expect(store._map.has(SESSION_KEY)).toBe(false);
  });

  it('restoreSession returns null when there is no stored session', () => {
    const store = fakeStorage();
    expect(restoreSession({ storage: store, now })).toBeNull();
  });
});

// ── v0.1.14: character GLB loader retry policy (bug #2) ──────────────
describe('nextLoadAttempt (Chiefmonkey reappears after reload)', () => {
  it('retries once with cache-bust on the first stall OR error', () => {
    expect(nextLoadAttempt({ loaded: false, retried: false }, 'stall'))
      .toEqual({ action: 'retry', bustCache: true });
    // The reload regression: a hard error must also trigger the retry, not a
    // silent give-up (the pre-v0.1.14 onErr hid the canvas permanently).
    expect(nextLoadAttempt({ loaded: false, retried: false }, 'error'))
      .toEqual({ action: 'retry', bustCache: true });
  });

  it('gives up after the retry has already been spent (no infinite loop)', () => {
    expect(nextLoadAttempt({ loaded: false, retried: true }, 'error').action).toBe('give-up');
    expect(nextLoadAttempt({ loaded: false, retried: true }, 'stall').action).toBe('give-up');
  });

  it('ignores stall/error once the model has loaded, and unknown events', () => {
    expect(nextLoadAttempt({ loaded: true, retried: false }, 'stall').action).toBe('ignore');
    expect(nextLoadAttempt({ loaded: true, retried: true }, 'error').action).toBe('ignore');
    expect(nextLoadAttempt({ loaded: false, retried: false }, 'bogus').action).toBe('ignore');
    expect(nextLoadAttempt(null, 'error').action).toBe('ignore');
  });
});

// ── v0.1.14: reload wiring guardrails (source-level) ────────────────
// These assert the wiring that connects the pure helpers above to the live
// page, and that the v0.1.11 same-origin (no-crossorigin) preload fix is not
// reintroduced as a CORS cache mismatch.
describe('reload wiring + preload cache guardrails', () => {
  const html = readFileSync(join(PREVIEW_DIR, 'index.html'), 'utf8');
  const character = readFileSync(join(PREVIEW_DIR, 'character.js'), 'utf8');
  const deck = readFileSync(join(PREVIEW_DIR, 'deck.js'), 'utf8');
  const client = readFileSync(join(PREVIEW_DIR, 'onboarding-client.js'), 'utf8');

  it('onboarding-client restores a valid session to a start step on load', () => {
    expect(client).toContain('restoreSession()');
    expect(client).toContain('__toriiRestoredStep');
  });

  it('deck opens on the restored step and does not hard-code start at 1', () => {
    expect(deck).toContain('__toriiRestoredStep');
  });

  it('character.js routes both stall and error through the retry policy', () => {
    expect(character).toContain('nextLoadAttempt');
    expect(character).toContain("handleFailure('stall')");
    expect(character).toContain("handleFailure('error')");
  });

  it('same-origin GLB/wasm preloads carry NO crossorigin (v0.1.11 fix kept)', () => {
    // Pull out each preload line and assert the fetch-type ones are plain
    // same-origin (no crossorigin attribute) — a crossorigin preload uses CORS
    // credentials mode that GLTFLoader/DRACOLoader don't, causing the reload
    // stall this whole retry path exists to survive.
    const preloadLines = html.split('\n').filter((l) => l.includes('rel="preload"'));
    const glbLine = preloadLines.find((l) => l.includes('chiefmonkey6.glb'));
    const wasmLine = preloadLines.find((l) => l.includes('draco_decoder.wasm'));
    expect(glbLine).toBeTruthy();
    expect(wasmLine).toBeTruthy();
    expect(glbLine).not.toContain('crossorigin');
    expect(wasmLine).not.toContain('crossorigin');
  });
});

// ── v0.1.15: character↔deck step-sync race (Chiefmonkey after soft reload) ──
// character.js (module) and deck.js (classic) run in a non-deterministic order
// vs. each other and vs. the async GLB load. The pure sync state machine must
// land on the *restored* Step 2 (and thus its Idle_03) once the model is
// ready, whichever order things happen in, and must never revert to Step 1.
describe('character step sync (restore ↔ model-load race)', () => {
  it('ordering A — session restore fires BEFORE model load: replays Step 2 on ready', () => {
    const sync = createCharacterSync();
    // deck.js broadcasts the restored step while the GLB is still loading.
    const rec = recordStep(sync, 2);
    // Nothing to apply yet (model not ready) — the step is remembered.
    expect(rec).toEqual({ apply: false, step: 2 });
    expect(sync.ready).toBe(false);
    // Model finishes: the pending Step 2 is honoured, not the old hard-coded 1.
    const step = resolveReadyStep(sync, /* restored */ 2);
    expect(step).toBe(2);
    expect(sync.ready).toBe(true);
    // Step 2's clip is Idle_03 (mirrors STEP_FRAMES[2].anim) — asserted so the
    // restored authenticated pose is Idle_03, per the standing clip contract.
    expect(ANIM.success.clip).toBe('Idle_03');
  });

  it('ordering B — model loads BEFORE the step broadcast: falls back to restored step, then a late step applies immediately', () => {
    const sync = createCharacterSync();
    // onLoaded runs first with no pending step. window.__toriiRestoredStep is
    // already 2 (onboarding-client.js set it at eval), so we resolve to 2.
    expect(resolveReadyStep(sync, 2)).toBe(2);
    expect(sync.ready).toBe(true);
    // A late onboarding:step (e.g. deck re-broadcasting after onboarding:advance)
    // now applies immediately because the model is ready.
    expect(recordStep(sync, 2)).toEqual({ apply: true, step: 2 });
    // And ordinary forward navigation keeps applying live.
    expect(recordStep(sync, 3)).toEqual({ apply: true, step: 3 });
  });

  it('order-independence: A and B resolve to the same restored step', () => {
    const a = createCharacterSync();
    recordStep(a, 2);
    const b = createCharacterSync();
    expect(resolveReadyStep(a, 2)).toBe(resolveReadyStep(b, 2));
  });

  it('ordinary reload / cache-hit (no session): resolves to Step 1, no revert', () => {
    const sync = createCharacterSync();
    // deck opens on Step 1 and broadcasts it; a fast cache-hit onLoaded follows.
    expect(recordStep(sync, 1)).toEqual({ apply: false, step: 1 });
    expect(resolveReadyStep(sync, undefined)).toBe(1);
    // No restored step present → still Step 1 even if resolve races ahead of
    // any broadcast at all.
    expect(resolveReadyStep(createCharacterSync(), undefined)).toBe(1);
    expect(resolveReadyStep(createCharacterSync(), null)).toBe(1);
  });

  it('never trusts an out-of-range restored step (fail safe to Step 1)', () => {
    // The curtain (6) and anything outside 2..5 are not valid restore targets.
    expect(resolveReadyStep(createCharacterSync(), 6)).toBe(1);
    expect(resolveReadyStep(createCharacterSync(), 0)).toBe(1);
    expect(resolveReadyStep(createCharacterSync(), 99)).toBe(1);
    expect(resolveReadyStep(createCharacterSync(), 'two')).toBe(1);
    // But a genuine pending step from the deck is honoured over the fallback.
    const sync = createCharacterSync();
    recordStep(sync, 3);
    expect(resolveReadyStep(sync, 2)).toBe(3);
  });

  it('recordStep ignores non-steps and only applies once ready', () => {
    const sync = createCharacterSync();
    expect(recordStep(sync, undefined)).toEqual({ apply: false, step: null });
    expect(recordStep(sync, 7)).toEqual({ apply: false, step: null });
    expect(recordStep(null, 2)).toEqual({ apply: false, step: null });
    // pendingStep untouched by the bogus calls above.
    expect(sync.pendingStep).toBeNull();
  });

  it('terminal failure: after give-up no step is ever applied, and ready fallback is Step 1', () => {
    const sync = createCharacterSync();
    // Model errors twice → nextLoadAttempt gives up; character.js marks failed.
    expect(nextLoadAttempt({ loaded: false, retried: true }, 'error').action).toBe('give-up');
    markCharacterFailed(sync);
    expect(sync.failed).toBe(true);
    // A step broadcast now must NOT be applied (stage stays empty, no loop).
    expect(recordStep(sync, 2)).toEqual({ apply: false, step: 2 });
    // Even if resolveReadyStep were somehow reached it has no live model to
    // honour a middle step against and there is no pending apply path.
    expect(recordStep(sync, 3).apply).toBe(false);
  });
});

// ── v0.1.15: step-sync wiring guardrails (source-level) ─────────────
describe('character step-sync wiring guardrails', () => {
  const character = readFileSync(join(PREVIEW_DIR, 'character.js'), 'utf8');

  it('character.js applies the resolved step on load, not a hard-coded Step 1', () => {
    expect(character).toContain('resolveReadyStep');
    expect(character).toContain('window.__toriiRestoredStep');
    // The old bug was `applyStep(1)` inside onLoaded; it must be gone.
    expect(character).not.toContain('applyStep(1)');
  });

  it('character.js emits explicit readiness + terminal-failure events', () => {
    expect(character).toContain("'onboarding:model-loaded'");
    expect(character).toContain("'onboarding:model-error'");
    expect(character).toContain('__toriiCharacterReady');
    expect(character).toContain('__toriiCharacterFailed');
  });

  it('character.js routes onboarding:step through the sync state machine', () => {
    expect(character).toContain('createCharacterSync');
    expect(character).toContain('recordStep(sync');
    expect(character).toContain('markCharacterFailed');
  });
});
