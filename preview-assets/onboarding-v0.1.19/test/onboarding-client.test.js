/**
 * Offline tests for the onboarding step-1 auth client (v0.1.15-preview).
 * All network + signer + relay behaviour is mocked; no sockets, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AUTH_KIND,
  SESSION_KEY,
  ANIM,
  selectAnimation,
  FORBIDDEN_CLIP_TOKENS,
  isForbiddenClip,
  filterForbidden,
  IDLE_CLIP,
  STEP_CLIPS,
  CLICK_POOL,
  selectStepClip,
  pickClickReaction,
  shouldReactToClick,
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
  validateNwcUriShape,
  validateRoutstrKeyShape,
  validateTopupAmount,
  bearerFromSession,
  connectWallet,
  connectRoutstrKey,
  quoteRoutstrTopup,
  payRoutstrInvoice,
  recoverRoutstrInvoice,
  ONBOARD_PHASES,
  PHASE_META,
  phaseMeta,
  classifyPayResult,
  classifyRecoverResult,
  shouldResumeClaim,
  formatCountdown,
  formatSats,
  buildRecoveryKit,
  RECOVERY_KIT_FILENAME,
  fetchRecoveryState,
  fetchRecoveryKit,
  exportRoutstrKey,
  CONTINUUM_HOME,
  resolveContinuumDestination,
  planCurtainTransition,
  MASK_EVENTS,
  shouldMaskReveal,
  REVEAL_TIMEOUT_MS,
  CURTAIN_STEP,
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

// ── GLB inspection helper (dependency-free) ─────────────────────────
// Reads the JSON chunk of a binary glTF and returns the parsed glTF object.
// Draco compresses only mesh geometry (bufferViews/accessors); the glTF JSON
// still lists every animation/skin/mesh/material/texture by name, so this is
// enough to prove clip names survive and structural counts are non-zero
// without pulling a glTF library into the test runtime.
function parseGlbJson(buf) {
  // 12-byte header: magic, version, length. Then chunks: [len(4) type(4) data].
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = buf.toString('utf8', 20, 20 + chunkLen);
  return JSON.parse(json);
}

const GLB_PATH = join(PREVIEW_DIR, 'assets', 'chiefmonkey-onboarding.glb');
const MANIFEST_PATH = GLB_PATH + '.manifest.json';
const GLB_BUF = readFileSync(GLB_PATH);
const GLB = parseGlbJson(GLB_BUF);
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const GLB_CLIPS = new Set((GLB.animations || []).map((a) => a.name));

// ── animation selection ─────────────────────────────────────────────
describe('selectAnimation', () => {
  it('maps phases to dedicated, non-forbidden clips that exist in the GLB', () => {
    expect(ANIM.prompting.clip).toBe('Talk_with_Hands_Open');
    expect(ANIM.success.clip).toBe('Agree_Gesture');
    expect(ANIM.failure.clip).toBe('Stand_Talking_Angry');
    for (const phase of ['prompting', 'success', 'failure']) {
      expect(isForbiddenClip(ANIM[phase].clip)).toBe(false);
      expect(GLB_CLIPS.has(ANIM[phase].clip)).toBe(true);
    }
  });

  it('returns the primary clip when it is present', () => {
    const all = new Set(['Talk_with_Hands_Open', 'Agree_Gesture', 'Stand_Talking_Angry']);
    expect(selectAnimation('prompting', all)).toBe('Talk_with_Hands_Open');
    expect(selectAnimation('success', all)).toBe('Agree_Gesture');
    expect(selectAnimation('failure', all)).toBe('Stand_Talking_Angry');
  });

  it('falls back to an available clip when the primary is missing', () => {
    // Success falls back to Victory_Cheer, then the idle floor.
    expect(selectAnimation('success', new Set(['Victory_Cheer', IDLE_CLIP]))).toBe('Victory_Cheer');
    expect(selectAnimation('success', new Set([IDLE_CLIP]))).toBe(IDLE_CLIP);
    expect(selectAnimation('prompting', new Set([IDLE_CLIP]))).toBe(IDLE_CLIP);
  });

  it('returns null (keep current) when nothing matches — graceful fallback', () => {
    expect(selectAnimation('failure', new Set(['Walking']))).toBeNull();
    expect(selectAnimation('bogus', new Set([IDLE_CLIP]))).toBeNull();
  });

  it('never returns a forbidden clip even if one is (mis)configured as primary', () => {
    // Defence in depth: filtering happens inside selectAnimation regardless of
    // what a caller lists. A forbidden "available" clip is unselectable.
    expect(selectAnimation('success', new Set(['Walking', 'Running']))).toBeNull();
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
    const glbLine = preloadLines.find((l) => l.includes('chiefmonkey-onboarding.glb'));
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
    // Step 2's dedicated clip is resolved from STEP_CLIPS[2] — asserted so the
    // restored authenticated pose is a suitable, non-forbidden clip that exists
    // in the GLB, per the dedicated-step contract.
    expect(STEP_CLIPS[2].clip).toBe('Agree_Gesture');
    expect(isForbiddenClip(STEP_CLIPS[2].clip)).toBe(false);
    expect(GLB_CLIPS.has(selectStepClip(2, GLB_CLIPS))).toBe(true);
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

// ── v0.1.16: Step 2 (wallet/NWC) + Step 3 (Routstr) admin-API client ──
// The NWC connection string and the Routstr sk- key are operator secrets the
// agent must USE. The browser sends them once over the authenticated API and
// must NEVER persist them, echo them, or leak them. These offline tests prove
// the shape guards, the Bearer wiring, the redacted-only returns, and the
// hard confirmation boundary on payment — with no sockets and no DOM.

const WP = 'ab'.repeat(32); // 64-hex wallet pubkey
const NWC_SECRET = 'cd'.repeat(32); // 64-hex NWC secret
const NWC_URI = `nostr+walletconnect://${WP}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${NWC_SECRET}`;

// A fetch mock that records the Authorization header + parsed body per call.
function makeAdminFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, opts = {}) => {
    calls.push({
      path,
      method: opts.method,
      auth: opts.headers?.Authorization,
      body: opts.body ? JSON.parse(opts.body) : undefined,
      rawBody: opts.body,
    });
    const r = routes[`${opts.method} ${path}`] || routes[path];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'no route' }) };
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const SESSION = { token: 'sess-tok', pubkey: PUBKEY, method: 'nip07', expires_at: 9999 };

describe('validateNwcUriShape', () => {
  it('accepts a well-formed NWC URI and returns ONLY non-secret shape facts', () => {
    const out = validateNwcUriShape(NWC_URI);
    expect(out.ok).toBe(true);
    expect(out.relay_count).toBe(1);
    expect(out.wallet_pubkey_prefix).toHaveLength(12);
    // The secret must never be echoed back in the result.
    expect(JSON.stringify(out)).not.toContain(NWC_SECRET);
    expect(JSON.stringify(out)).not.toContain(WP); // full pubkey, only prefix returned
  });

  it('fails closed on scheme, pubkey, relay, and secret defects', () => {
    expect(validateNwcUriShape('').ok).toBe(false);
    expect(validateNwcUriShape('not-a-uri').ok).toBe(false);
    expect(validateNwcUriShape(`nostr+walletconnect://${WP}?secret=${NWC_SECRET}`).ok).toBe(false); // no relay
    expect(validateNwcUriShape(`nostr+walletconnect://${WP}?relay=wss://x`).ok).toBe(false); // no secret
    expect(validateNwcUriShape(`nostr+walletconnect://zz?relay=wss://x&secret=${NWC_SECRET}`).ok).toBe(false); // bad pubkey
    expect(validateNwcUriShape(NWC_URI.replace(/secret=[0-9a-f]+/, 'secret=zz')).ok).toBe(false); // bad secret
    expect(validateNwcUriShape(`nostr+walletconnect://${WP}?relay=http://x&secret=${NWC_SECRET}`).ok).toBe(false); // non-ws relay
  });
});

describe('validateRoutstrKeyShape / validateTopupAmount', () => {
  it('accepts sk- and cashu keys, rejects junk — never echoes the key', () => {
    expect(validateRoutstrKeyShape('sk-livekey999').ok).toBe(true);
    expect(validateRoutstrKeyShape('cashuABC123').ok).toBe(true);
    expect(validateRoutstrKeyShape('has spaces').ok).toBe(false);
    const bad = validateRoutstrKeyShape('nope!');
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('nope');
  });

  it('enforces integer sats within bounds', () => {
    expect(validateTopupAmount(100, { min: 10, max: 10000 }).ok).toBe(true);
    expect(validateTopupAmount(5, { min: 10, max: 10000 }).ok).toBe(false);
    expect(validateTopupAmount(99999, { min: 10, max: 10000 }).ok).toBe(false);
    expect(validateTopupAmount(10.5, { min: 10, max: 10000 }).ok).toBe(false);
    expect(validateTopupAmount('abc').ok).toBe(false);
  });
});

describe('bearerFromSession', () => {
  it('builds a Bearer header from a session token, null when absent', () => {
    expect(bearerFromSession({ token: 'abc' })).toBe('Bearer abc');
    expect(bearerFromSession(null)).toBeNull();
    expect(bearerFromSession({})).toBeNull();
  });
});

describe('connectWallet (Step 2)', () => {
  const routes = () => ({
    'POST /api/onboarding/wallet/connect': {
      body: {
        ok: true,
        wallet: { wallet_pubkey_prefix: WP.slice(0, 12), relay_count: 1 },
        capabilities: { can_pay_invoice: true, can_fund_routstr: true },
        can_fund_routstr: true,
        notice: null,
      },
    },
  });

  it('sends nwc_uri with the Bearer token and returns the redacted body', async () => {
    const fetchImpl = makeAdminFetch(routes());
    const res = await connectWallet({ nwcUri: NWC_URI, fetch: fetchImpl, token: 'Bearer sess-tok' });
    expect(res.ok).toBe(true);
    expect(res.can_fund_routstr).toBe(true);
    const call = fetchImpl.calls[0];
    expect(call.path).toBe('/api/onboarding/wallet/connect');
    expect(call.auth).toBe('Bearer sess-tok');
    expect(call.body.nwc_uri).toBe(NWC_URI);
    // The response must never carry the raw secret back to the UI.
    expect(JSON.stringify(res)).not.toContain(NWC_SECRET);
  });

  it('rejects a malformed URI before any network call (secret never sent)', async () => {
    const fetchImpl = makeAdminFetch(routes());
    const res = await connectWallet({ nwcUri: 'garbage', fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('does NOT persist the NWC URI or secret to storage', async () => {
    const store = fakeStorage();
    // A session must exist so the token is resolvable from storage.
    storeSession(SESSION, store);
    const fetchImpl = makeAdminFetch(routes());
    await connectWallet({ nwcUri: NWC_URI, fetch: fetchImpl, storage: store });
    // Only the session key is present; the URI/secret appear nowhere in storage.
    const dump = JSON.stringify([...store._map.entries()]);
    expect(dump).not.toContain(NWC_SECRET);
    expect(dump).not.toContain(NWC_URI);
    expect(dump).not.toContain('walletconnect');
    // The Bearer was pulled from the stored session token.
    expect(fetchImpl.calls[0].auth).toBe('Bearer sess-tok');
  });

  it('fails closed when there is no admin session', async () => {
    const fetchImpl = makeAdminFetch(routes());
    const res = await connectWallet({ nwcUri: NWC_URI, fetch: fetchImpl, storage: fakeStorage() });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });
});

describe('connectRoutstrKey (Step 3A)', () => {
  it('sends the key with Bearer and returns redacted status, never the key', async () => {
    const fetchImpl = makeAdminFetch({
      'POST /api/onboarding/routstr/key': {
        body: { ok: true, routstr: { key_preview: 'sk-…9999' }, balance_sats: 500, models_available: 3 },
      },
    });
    const res = await connectRoutstrKey({ key: 'sk-livekey999999', fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(true);
    expect(res.balance_sats).toBe(500);
    expect(fetchImpl.calls[0].body.key).toBe('sk-livekey999999');
    expect(JSON.stringify(res)).not.toContain('livekey999999');
  });

  it('rejects a malformed key before any network call', async () => {
    const fetchImpl = makeAdminFetch({});
    const res = await connectRoutstrKey({ key: 'bad key', fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });
});

describe('quoteRoutstrTopup / payRoutstrInvoice (Step 3B, hard confirmation)', () => {
  it('surfaces the blocked quote with guidance (501) only when the provider path is disabled', async () => {
    const fetchImpl = makeAdminFetch({
      'POST /api/onboarding/routstr/quote': {
        status: 501,
        body: { ok: false, blocked: true, reason: 'provider_invoice_disabled', guidance: 'use an existing key' },
      },
    });
    const res = await quoteRoutstrTopup({ amountSats: 100, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toBe('provider_invoice_disabled');
    expect(res.guidance).toMatch(/existing key/);
  });

  it('returns an invoice + quote_id + requires_confirmation by default', async () => {
    const fetchImpl = makeAdminFetch({
      'POST /api/onboarding/routstr/quote': {
        body: { ok: true, invoice: 'lnbc1...', quote_id: 'inv_abc', amount_sats: 100, provider_host: 'https://api.routstr.com', requires_confirmation: true },
      },
    });
    const res = await quoteRoutstrTopup({ amountSats: 100, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(true);
    expect(res.requires_confirmation).toBe(true);
    expect(res.invoice).toBe('lnbc1...');
    expect(res.quote_id).toBe('inv_abc');
    expect(fetchImpl.calls[0].body.amount_sats).toBe(100);
  });

  it('quote enforces amount bounds before any network call', async () => {
    const fetchImpl = makeAdminFetch({});
    const res = await quoteRoutstrTopup({ amountSats: 2, bounds: { min: 10, max: 10000 }, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('payRoutstrInvoice REFUSES without confirm:true and never calls the API', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/pay': { body: { ok: true, preimage: 'x' } } });
    const res = await payRoutstrInvoice({ invoice: 'lnbc1...', confirm: false, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('payRoutstrInvoice pays with confirm:true and forwards quote_id to claim the key', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/pay': { body: { ok: true, preimage: 'deadbeef', key_stored: true, routstr: { key_preview: 'sk-…5678' } } } });
    const res = await payRoutstrInvoice({ invoice: 'lnbc1...', quoteId: 'inv_abc', confirm: true, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(true);
    expect(res.preimage).toBe('deadbeef');
    expect(res.key_stored).toBe(true);
    expect(fetchImpl.calls[0].body).toEqual({ invoice: 'lnbc1...', confirm: true, quote_id: 'inv_abc' });
  });

  it('payRoutstrInvoice surfaces a RECOVERABLE state (paid, key not yet minted) without losing the invoice', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/pay': { body: { ok: true, preimage: 'deadbeef', key_stored: false, recoverable: true, bolt11: 'lnbc1...' } } });
    const res = await payRoutstrInvoice({ invoice: 'lnbc1...', quoteId: 'inv_abc', confirm: true, fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(true);
    expect(res.key_stored).toBe(false);
    expect(res.recoverable).toBe(true);
    expect(res.bolt11).toBe('lnbc1...');
  });

  it('recoverRoutstrInvoice claims the minted key (200) via /lightning/recover', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/recover': { body: { ok: true, key_stored: true, routstr: { key_preview: 'sk-…0000' } } } });
    const res = await recoverRoutstrInvoice({ bolt11: 'lnbc1...', fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(true);
    expect(res.key_stored).toBe(true);
    expect(fetchImpl.calls[0].body).toEqual({ bolt11: 'lnbc1...' });
  });

  it('recoverRoutstrInvoice treats 202 as non-terminal (recoverable), not an error', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/recover': { status: 202, body: { ok: false, recoverable: true, status: 'pending', reason: 'invoice not yet settled' } } });
    const res = await recoverRoutstrInvoice({ bolt11: 'lnbc1...', fetch: fetchImpl, token: 'Bearer t' });
    expect(res.ok).toBe(false);
    expect(res.recoverable).toBe(true);
    expect(res.status).toBe('pending');
  });
});

// ── v0.1.16: Step 2/3 UI copy + secret-field guardrails (source-level) ──
describe('Step 2/3 markup: NWC-only wallet + password secret fields', () => {
  const html = readFileSync(join(PREVIEW_DIR, 'index.html'), 'utf8');
  const step2 = html.slice(html.indexOf('data-panel="2"'), html.indexOf('data-panel="3"'));
  const step3 = html.slice(html.indexOf('data-panel="3"'), html.indexOf('data-panel="4"'));

  it('Step 2 is existing-wallet connection only (no local-wallet / LNbits paths)', () => {
    expect(step2).toContain('Connect your Lightning wallet');
    expect(step2).toContain('data-nwc-input');
    expect(step2).not.toMatch(/Spin up a local wallet/i);
    expect(step2).not.toMatch(/LNbits/i);
    expect(step2).not.toMatch(/Import.*admin key/i);
  });

  it('the NWC input is a password field with an opt-in reveal toggle', () => {
    // The secret input must default to password type (never plain text at rest).
    expect(step2).toMatch(/data-nwc-input[\s\S]*?type="password"|type="password"[\s\S]*?data-nwc-input/);
    expect(step2).toContain('data-nwc-reveal');
  });

  it('Step 3 offers both an existing key (password) and a fund-a-session path', () => {
    expect(step3).toContain('Use an existing Routstr key');
    expect(step3).toContain('Fund a new Routstr session');
    expect(step3).toContain('data-routstr-key-input');
    expect(step3).toContain('data-topup-input');
    expect(step3).toContain('data-routstr-confirm'); // the confirmation boundary container
    expect(step3).toMatch(/data-routstr-key-input[\s\S]*?type="password"|type="password"[\s\S]*?data-routstr-key-input/);
  });

  it('neither secret ever appears in a localStorage/sessionStorage write in the client', () => {
    const client = readFileSync(join(PREVIEW_DIR, 'onboarding-client.js'), 'utf8');
    // No setItem call anywhere near the NWC/key inputs — the only storage
    // writer is storeSession (session token metadata), never a secret.
    expect(client).not.toMatch(/setItem\([^)]*nwc/i);
    expect(client).not.toMatch(/setItem\([^)]*routstr/i);
    // The connect helpers clear the input after submit (no echo).
    expect(client).toContain("input.value = ''");
  });
});

// ── v0.1.17: forbidden-clip semantic filter ─────────────────────────
// Locomotion (walk/run/jog/sprint) and knock-down / fall-down clips must be
// unselectable everywhere. The predicate normalises to bare lowercase
// alphanumerics so spaces / underscores / camelCase can never smuggle one in.
describe('isForbiddenClip / filterForbidden (locomotion + knock-down ban)', () => {
  it('flags every walk/run/jog/sprint/knock-down/fall-down spelling', () => {
    const forbidden = [
      'Walking', 'walk', 'Stylish_Walk_inplace', 'WALK', 'walk cycle',
      'Running', 'run', 'Clapping_Run', 'Run_Fast', 'sprint', 'Sprinting',
      'jog', 'Jogging', 'Knock_Down', 'knockdown', 'knock down', 'KnockDown',
      'Knocked_Down', 'Fall_Down', 'fallingdown',
    ];
    for (const name of forbidden) {
      expect(isForbiddenClip(name)).toBe(true);
    }
  });

  it('does NOT flag suitable gesture / dance / idle clips', () => {
    const allowed = [
      'Idle_10', 'Agree_Gesture', 'Talk_with_Hands_Open', 'Gentlemans_Bow',
      'Victory_Cheer', 'FunnyDancing_02', 'Gangnam_Groove', 'Hip_Hop_Dance_2',
      'Indoor_Swing', 'Boxing_Practice', 'mage_soell_cast_3', 'Stand_Talking_Angry',
    ];
    for (const name of allowed) {
      expect(isForbiddenClip(name)).toBe(false);
    }
  });

  it('handles nullish / empty names without throwing', () => {
    expect(isForbiddenClip(undefined)).toBe(false);
    expect(isForbiddenClip(null)).toBe(false);
    expect(isForbiddenClip('')).toBe(false);
  });

  it('filterForbidden strips only the forbidden names, order preserved', () => {
    const input = ['Agree_Gesture', 'Walking', 'Victory_Cheer', 'Clapping_Run', 'Idle_10'];
    expect(filterForbidden(input)).toEqual(['Agree_Gesture', 'Victory_Cheer', 'Idle_10']);
    expect(filterForbidden(null)).toEqual([]);
  });

  it('the token list covers the required semantic families', () => {
    const joined = FORBIDDEN_CLIP_TOKENS.join(' ');
    for (const tok of ['walk', 'run', 'jog', 'sprint', 'knockdown', 'falldown']) {
      expect(joined).toContain(tok);
    }
  });
});

// ── v0.1.17: optimized production GLB is well-formed + forbidden-free ──
// The tests PARSE the shipped optimized asset (not a fixture) so a bad rebuild
// or a hand-edit that drops a clip, renames one, or reintroduces locomotion is
// caught before it can ship.
describe('optimized GLB asset (chiefmonkey-onboarding.glb)', () => {
  it('parses and has non-zero meshes / skins / joints / animations', () => {
    expect((GLB.meshes || []).length).toBeGreaterThan(0);
    expect((GLB.skins || []).length).toBeGreaterThan(0);
    expect((GLB.animations || []).length).toBeGreaterThan(0);
    // A skinned rig must retain its joints so skin weights don't drift.
    const joints = (GLB.skins || []).reduce((n, s) => n + (s.joints ? s.joints.length : 0), 0);
    expect(joints).toBeGreaterThan(0);
  });

  it('every retained clip has a name and NONE is forbidden (build dropped them)', () => {
    for (const a of GLB.animations) {
      expect(typeof a.name).toBe('string');
      expect(a.name.length).toBeGreaterThan(0);
      expect(isForbiddenClip(a.name)).toBe(false);
    }
  });

  it('the clips the runtime references (steps / phases / clicks) all exist', () => {
    const referenced = new Set();
    for (const step of Object.keys(STEP_CLIPS)) {
      referenced.add(selectStepClip(Number(step), GLB_CLIPS));
    }
    for (const phase of ['prompting', 'success', 'failure']) {
      referenced.add(selectAnimation(phase, GLB_CLIPS));
    }
    // The click pool, once filtered to available, must be non-empty and present.
    const clickAvail = CLICK_POOL.filter((c) => GLB_CLIPS.has(c));
    expect(clickAvail.length).toBeGreaterThan(0);
    for (const c of clickAvail) referenced.add(c);
    for (const name of referenced) {
      expect(name).toBeTruthy();
      expect(GLB_CLIPS.has(name)).toBe(true);
    }
    // IDLE_CLIP (the universal floor) must ship.
    expect(GLB_CLIPS.has(IDLE_CLIP)).toBe(true);
  });

  it('matches the manifest: retained names, dropped-forbidden names, counts', () => {
    const retained = MANIFEST.animations_retained.map((a) => a.name).sort();
    expect([...GLB_CLIPS].sort()).toEqual(retained);
    // Every clip the build claims to have dropped IS forbidden, and none of
    // them survived into the shipped asset.
    for (const d of MANIFEST.animations_dropped_forbidden) {
      expect(isForbiddenClip(d.name)).toBe(true);
      expect(GLB_CLIPS.has(d.name)).toBe(false);
    }
    expect(MANIFEST.meshes).toBe((GLB.meshes || []).length);
    expect(MANIFEST.skins).toBe((GLB.skins || []).length);
    expect(MANIFEST.animations_retained.length).toBe(GLB.animations.length);
    // Durations were preserved by resample (all positive, finite).
    for (const a of MANIFEST.animations_retained) {
      expect(a.duration).toBeGreaterThan(0);
      expect(Number.isFinite(a.duration)).toBe(true);
    }
  });

  it('meets the size budget and reduction target, and the SHA is reproducible', () => {
    const bytes = GLB_BUF.length;
    // Regression ceiling: the shipped asset must stay small. Current build is
    // ~2.35MB; 3MB leaves headroom for minor re-encodes without silent bloat.
    expect(bytes).toBeLessThanOrEqual(3_000_000);
    expect(bytes).toBe(MANIFEST.bytes_optimized);
    // The task target is >=60% reduction; the build reports ~74.75%.
    expect(MANIFEST.reduction_pct).toBeGreaterThanOrEqual(60);
    // Deterministic build: the on-disk bytes hash to the manifest's SHA-256.
    const sha = createHash('sha256').update(GLB_BUF).digest('hex');
    expect(sha).toBe(MANIFEST.sha256);
  });
});

// ── v0.1.17: dedicated per-step clip mapping (deterministic) ─────────
describe('selectStepClip (dedicated step animations)', () => {
  it('resolves each live step to a distinct, suitable, present clip', () => {
    const expected = {
      1: 'Talk_with_Hands_Open',
      2: 'Agree_Gesture',
      3: 'mage_soell_cast_3',
      4: 'Gentlemans_Bow',
      5: IDLE_CLIP,
      6: 'Victory_Cheer',
    };
    for (const [step, clip] of Object.entries(expected)) {
      expect(selectStepClip(Number(step), GLB_CLIPS)).toBe(clip);
      expect(isForbiddenClip(clip)).toBe(false);
    }
  });

  it('falls back through the ordered list when the primary is missing', () => {
    // Step 3 primary missing → Talk_with_Hands_Open → idle floor.
    expect(selectStepClip(3, new Set(['Talk_with_Hands_Open', IDLE_CLIP]))).toBe('Talk_with_Hands_Open');
    expect(selectStepClip(3, new Set([IDLE_CLIP]))).toBe(IDLE_CLIP);
  });

  it('optimistically returns the primary clip when availability is unknown', () => {
    expect(selectStepClip(4, null)).toBe('Gentlemans_Bow');
  });

  it('returns null for a non-step', () => {
    expect(selectStepClip(0, GLB_CLIPS)).toBeNull();
    expect(selectStepClip(99, GLB_CLIPS)).toBeNull();
  });
});

// ── v0.1.17: click-reaction pool selection ──────────────────────────
describe('pickClickReaction (curated one-shot pool)', () => {
  it('the static pool is forbidden-free and never includes the base idle', () => {
    for (const c of CLICK_POOL) expect(isForbiddenClip(c)).toBe(false);
    expect(CLICK_POOL).not.toContain(IDLE_CLIP);
  });

  it('only ever returns a clip present in the model', () => {
    const avail = new Set(CLICK_POOL.slice(0, 3));
    for (let i = 0; i < 50; i++) {
      const pick = pickClickReaction({ available: avail, rand: Math.random });
      expect(avail.has(pick)).toBe(true);
    }
  });

  it('avoids an immediate repeat of the last reaction when >1 option exists', () => {
    const avail = new Set(['Agree_Gesture', 'Victory_Cheer', 'Gentlemans_Bow']);
    for (let i = 0; i < 50; i++) {
      const pick = pickClickReaction({ available: avail, last: 'Victory_Cheer', rand: Math.random });
      expect(pick).not.toBe('Victory_Cheer');
    }
  });

  it('may repeat only when the pool collapses to a single option', () => {
    const pick = pickClickReaction({ available: new Set(['Agree_Gesture']), last: 'Agree_Gesture' });
    expect(pick).toBe('Agree_Gesture');
  });

  it('is deterministic under an injected RNG', () => {
    const pool = ['A', 'B', 'C'];
    expect(pickClickReaction({ pool, rand: () => 0 })).toBe('A');
    expect(pickClickReaction({ pool, rand: () => 0.99 })).toBe('C');
  });

  it('never selects a forbidden clip even if the pool is polluted', () => {
    const pick = pickClickReaction({ pool: ['Walking', 'Running'], rand: () => 0 });
    expect(pick).toBeNull();
  });

  it('returns null when nothing suitable is available (caller keeps current)', () => {
    expect(pickClickReaction({ available: new Set([]) })).toBeNull();
    expect(pickClickReaction({ available: new Set(['Idle_10']) })).toBeNull(); // idle not in pool
  });
});

// ── v0.1.17: click gate (hit-test / spam / reduced motion) ──────────
describe('shouldReactToClick (raycast gate)', () => {
  it('fires only on a model hit while idle and motion is allowed', () => {
    expect(shouldReactToClick({ hit: true, active: false, reducedMotion: false })).toBe(true);
  });

  it('ignores a click that did not hit the model (no click stealing)', () => {
    expect(shouldReactToClick({ hit: false, active: false, reducedMotion: false })).toBe(false);
  });

  it('ignores clicks while a reaction is already playing (spam guard)', () => {
    expect(shouldReactToClick({ hit: true, active: true, reducedMotion: false })).toBe(false);
  });

  it('respects prefers-reduced-motion', () => {
    expect(shouldReactToClick({ hit: true, active: false, reducedMotion: true })).toBe(false);
  });

  it('defaults are permissive only when a hit is not explicitly false', () => {
    // hit omitted (undefined) is treated as allowed; only an explicit false blocks.
    expect(shouldReactToClick({})).toBe(true);
  });
});

// ── v0.1.17: character.js wiring guardrails (source-level) ──────────
describe('character.js v0.1.17 wiring', () => {
  const character = readFileSync(join(PREVIEW_DIR, 'character.js'), 'utf8');

  it('loads the optimized asset, not the old model', () => {
    expect(character).toContain("GLB_URL = './assets/chiefmonkey-onboarding.glb'");
    expect(character).not.toContain('chiefmonkey6.glb');
  });

  it('resolves step / phase / click clips through the shared helpers', () => {
    expect(character).toContain('selectStepClip');
    expect(character).toContain('selectAnimation');
    expect(character).toContain('pickClickReaction');
    expect(character).toContain('shouldReactToClick');
  });

  it('hardcodes no forbidden clip name and no per-step anim literal in the frames', () => {
    // The old STEP_FRAMES embedded anim names (incl. Walking / Stylish_Walk).
    // The clip is now resolved from STEP_CLIPS, so no anim literal should live
    // in the frame tables and no forbidden literal anywhere.
    expect(character).not.toMatch(/anim:\s*'/);
    // Match only quoted clip LITERALS so we don't false-positive on method
    // names like `isRunning()`.
    for (const bad of ['Walking', 'Stylish_Walk_inplace', 'Running', 'Knock_Down', 'Clapping_Run']) {
      expect(character).not.toContain(`'${bad}'`);
      expect(character).not.toContain(`"${bad}"`);
    }
  });

  it('hit-tests clicks with a raycaster and does not steal UI-control clicks', () => {
    expect(character).toContain('Raycaster');
    expect(character).toContain('intersectObject');
    expect(character).toContain("addEventListener('pointerdown'");
    // Guards against stealing clicks aimed at buttons/inputs/links etc.
    expect(character).toMatch(/closest\(['"][^'"]*button/);
  });

  it('returns a finished one-shot reaction to the current step clip', () => {
    expect(character).toContain("mixer.addEventListener('finished'");
    expect(character).toContain('currentStepClip');
    expect(character).toContain('reducedMotion');
  });
});

// ── v0.1.18: payment/claim state machine, resume, recovery kit, export ──
// These pure reducers are the safety core of the incident fix: SUCCESS is
// reached ONLY when the agent reports key_stored === true. A bare "paid" or
// "recoverable" result must NEVER read as success (that was the live bug —
// the UI said "confirmed" while the key was unissued).
describe('classifyPayResult / classifyRecoverResult (success only when key_stored)', () => {
  it('pay: key_stored:true => SUCCESS with balance + redacted key', () => {
    const out = classifyPayResult({ ok: true, key_stored: true, balance_sats: 10000, routstr: { key_preview: 'sk-…1234' } });
    expect(out.phase).toBe(ONBOARD_PHASES.SUCCESS);
    expect(out.balance_sats).toBe(10000);
    expect(out.routstr.key_preview).toBe('sk-…1234');
  });

  it('pay: ok but NOT key_stored => PAID_UNCLAIMED (never success), preserves bolt11', () => {
    const out = classifyPayResult({ ok: true, key_stored: false, recoverable: true, bolt11: 'lnbc1...' });
    expect(out.phase).toBe(ONBOARD_PHASES.PAID_UNCLAIMED);
    expect(out.bolt11).toBe('lnbc1...');
  });

  it('pay: failure => ERROR with reason', () => {
    expect(classifyPayResult({ ok: false, reason: 'nope' }).phase).toBe(ONBOARD_PHASES.ERROR);
    expect(classifyPayResult(null).phase).toBe(ONBOARD_PHASES.ERROR);
  });

  it('recover: ok && key_stored => SUCCESS; recoverable => PAID_UNCLAIMED; else ERROR', () => {
    expect(classifyRecoverResult({ ok: true, key_stored: true, balance_sats: 10000 }).phase).toBe(ONBOARD_PHASES.SUCCESS);
    expect(classifyRecoverResult({ ok: false, recoverable: true, status: 'pending' }).phase).toBe(ONBOARD_PHASES.PAID_UNCLAIMED);
    expect(classifyRecoverResult({ ok: false, reason: 'gone' }).phase).toBe(ONBOARD_PHASES.ERROR);
  });

  it('recover: ok but key_stored:false is NOT success', () => {
    // Defensive: an ok:true with no key must not slip through as done.
    expect(classifyRecoverResult({ ok: true, key_stored: false }).phase).not.toBe(ONBOARD_PHASES.SUCCESS);
  });
});

describe('phaseMeta / formatCountdown / shouldResumeClaim', () => {
  it('every phase has frozen label+pct+busy metadata; success is 100% and not busy', () => {
    for (const p of Object.values(ONBOARD_PHASES)) {
      const m = phaseMeta(p);
      expect(typeof m.label).toBe('string');
      expect(typeof m.pct).toBe('number');
      expect(typeof m.busy).toBe('boolean');
    }
    expect(phaseMeta(ONBOARD_PHASES.SUCCESS).pct).toBe(100);
    expect(phaseMeta(ONBOARD_PHASES.SUCCESS).busy).toBe(false);
    expect(Object.isFrozen(PHASE_META)).toBe(true);
  });

  it('unknown phase falls back to idle', () => {
    expect(phaseMeta('nonsense')).toBe(PHASE_META.idle);
  });

  it('formatCountdown floors at zero and renders whole seconds', () => {
    expect(formatCountdown(3.2)).toBe('4s');
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(-5)).toBe('0s');
  });

  it('shouldResumeClaim is true ONLY when claimable === true', () => {
    expect(shouldResumeClaim({ claimable: true })).toBe(true);
    expect(shouldResumeClaim({ claimable: false })).toBe(false);
    expect(shouldResumeClaim({})).toBe(false);
    expect(shouldResumeClaim(null)).toBe(false);
  });
});

describe('buildRecoveryKit (default excludes ALL secrets)', () => {
  const kitBody = {
    generated_at: '2026-07-14T00:00:00Z',
    agent_version: '0.2.37-alpha',
    admin_npub: 'npub1demo',
    provider_host: 'https://api.routstr.com',
    routstr: { connected: true, key_preview: 'sk-…9abc', key_fingerprint: 'fp123', balance_sats: 10000 },
    wallet: { connected: true, wallet: { wallet_pubkey_prefix: '02aa', relays: ['wss://relay'] } },
    instructions: ['Re-pair your wallet from its app.'],
    notes: 'Keep this safe.',
  };

  it('default kit carries redacted preview + instructions but NO secret key and NO NWC secret', () => {
    const kit = buildRecoveryKit(kitBody);
    expect(kit.filename).toBe(RECOVERY_KIT_FILENAME);
    expect(kit.includes_secret_key).toBe(false);
    expect(kit.text).toContain('sk-…9abc');
    expect(kit.text).toContain('Re-pair your wallet');
    // Never the full key or a connection secret.
    expect(kit.text).not.toMatch(/nostr\+walletconnect/);
    expect(kit.text).toContain('Connection secret: NOT included');
  });

  it('includes the full key ONLY when revealedKey is explicitly passed', () => {
    const withKey = buildRecoveryKit(kitBody, { revealedKey: 'sk-FULLSECRETKEY' });
    expect(withKey.includes_secret_key).toBe(true);
    expect(withKey.text).toContain('sk-FULLSECRETKEY');
    expect(withKey.text).toMatch(/explicitly revealed/i);
  });
});

describe('recovery/export client fns (auth-gated, no implicit secrets)', () => {
  it('fetchRecoveryState returns the redacted snapshot from the agent', async () => {
    const fetchImpl = makeAdminFetch({ 'GET /api/onboarding/recovery/state': { body: { ok: true, claimable: true } } });
    const out = await fetchRecoveryState({ fetch: fetchImpl, token: 'Bearer t' });
    expect(out.claimable).toBe(true);
    expect(fetchImpl.calls[0].path).toBe('/api/onboarding/recovery/state');
  });

  it('fetchRecoveryState fails safe (no crash) without an admin session', async () => {
    const out = await fetchRecoveryState({ fetch: null, token: null });
    expect(out.ok).toBe(false);
  });

  it('exportRoutstrKey REFUSES without an explicit confirm and never calls the API', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/export-key': { body: { ok: true, key: 'sk-x' } } });
    const out = await exportRoutstrKey({ confirm: false, fetch: fetchImpl, token: 'Bearer t' });
    expect(out.ok).toBe(false);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('exportRoutstrKey returns the one-time full key only when confirm:true', async () => {
    const fetchImpl = makeAdminFetch({ 'POST /api/onboarding/routstr/export-key': { body: { ok: true, one_time: true, no_store: true, key: 'sk-FULL', export_count: 1 } } });
    const out = await exportRoutstrKey({ confirm: true, fetch: fetchImpl, token: 'Bearer t' });
    expect(out.ok).toBe(true);
    expect(out.key).toBe('sk-FULL');
    expect(fetchImpl.calls[0].body).toEqual({ confirm: true });
  });
});

// ── v0.1.18: DOM wiring guards (source-level) ───────────────────────────
describe('Step 3/5 markup: progress region + real download (no data-advance no-op)', () => {
  const html = readFileSync(join(PREVIEW_DIR, 'index.html'), 'utf8');
  const step3 = html.slice(html.indexOf('data-panel="3"'), html.indexOf('data-panel="4"'));
  const step5 = html.slice(html.indexOf('data-panel="5"'), html.indexOf('data-panel="6"'));

  it('Step 3 has an accessible live progress region with a scanning bar', () => {
    expect(step3).toContain('data-routstr-progress');
    expect(step3).toMatch(/role="status"/);
    expect(step3).toMatch(/aria-live="polite"/);
    expect(step3).toContain('data-op-fill');
    expect(step3).toContain('data-op-scan');
  });

  it('Step 5 download button triggers a real download, not a deck advance', () => {
    expect(step5).toContain('data-download-kit');
    // The download button must NOT be a bare data-advance no-op anymore.
    expect(step5).not.toMatch(/data-advance[^>]*>\s*<span>Download recovery kit/);
  });

  it('Step 5 no longer statically prints secret-adjacent values', () => {
    expect(step5).not.toMatch(/nostr\+walletconnect/);
    expect(step5).toContain('data-kit-preview');
  });

  // v0.1.19: the old one-time "Reveal full Routstr key" button (which drove a
  // browser confirm() and never actually revealed the key) is gone; the key is
  // now revealed inline in the ROUTSTR KEY row via branded eye/copy controls,
  // and the download itself is the explicit confirmation.
  it('Step 5 removed the unbranded reveal button and its confirm-based flow', () => {
    expect(step5).not.toContain('data-reveal-key');
    expect(step5).not.toMatch(/Reveal full Routstr key/i);
  });

  it('curtain panel ships a real same-origin "Open Continuum now" fallback link', () => {
    const curtain = html.slice(html.indexOf('data-panel="6"'), html.indexOf('</section>'));
    expect(curtain).toContain('data-curtain-open');
    expect(curtain).toMatch(/href="\/continuum\/"/);
    expect(curtain).toMatch(/Open Continuum now/i);
  });
});

// ── v0.1.19: msat→sat display, curtain navigation, reveal masking ──────────
describe('formatSats (msats must display as human sats)', () => {
  it('groups thousands and rounds to whole sats', () => {
    expect(formatSats(10000)).toBe('10,000');
    expect(formatSats(500)).toBe('500');
    expect(formatSats(1234567)).toBe('1,234,567');
    expect(formatSats(4200.6)).toBe('4,201');
  });

  it('returns null for non-finite input so callers can say "unknown"', () => {
    expect(formatSats(null)).toBeNull();
    expect(formatSats(undefined)).toBeNull();
    expect(formatSats('abc')).toBeNull();
  });

  // The screenshot bug: the provider returns millisats (10,000,000) but the UI
  // printed it verbatim as "10000000 sats". The conversion happens in the agent
  // (msats → sats), so by the time formatSats sees it, 10000 must render 10,000.
  it('renders the funded key balance as 10,000 sats (not 10,000,000)', () => {
    expect(formatSats(10000)).toBe('10,000');
    expect(formatSats(10000)).not.toBe('10,000,000');
  });
});

describe('resolveContinuumDestination (deterministic, same-origin only)', () => {
  it('defaults to the /continuum/ SPA home', () => {
    expect(CONTINUUM_HOME).toBe('/continuum/');
    expect(resolveContinuumDestination({ location: { origin: 'https://chiefmonkey.art' } })).toBe('/continuum/');
  });

  it('accepts a same-origin bare-path override', () => {
    const win = { __toriiContinuumHome: '/continuum/dashboard', location: { origin: 'https://chiefmonkey.art' } };
    expect(resolveContinuumDestination(win)).toBe('/continuum/dashboard');
  });

  it('accepts a same-origin absolute-URL override (reduced to path+query+hash)', () => {
    const win = { __toriiContinuumHome: 'https://chiefmonkey.art/continuum/?x=1#/projects', location: { origin: 'https://chiefmonkey.art' } };
    expect(resolveContinuumDestination(win)).toBe('/continuum/?x=1#/projects');
  });

  it('REJECTS a cross-origin override (open-redirect guard) and falls back', () => {
    const win = { __toriiContinuumHome: 'https://evil.example/steal', location: { origin: 'https://chiefmonkey.art' } };
    expect(resolveContinuumDestination(win)).toBe('/continuum/');
  });

  it('REJECTS a protocol-relative //host override', () => {
    const win = { __toriiContinuumHome: '//evil.example/x', location: { origin: 'https://chiefmonkey.art' } };
    expect(resolveContinuumDestination(win)).toBe('/continuum/');
  });
});

describe('planCurtainTransition (bounded, never hangs; honours reduced motion)', () => {
  it('returns finite, bounded timings by default', () => {
    const p = planCurtainTransition();
    expect(Number.isFinite(p.navigateAfterMs)).toBe(true);
    expect(Number.isFinite(p.fallbackAfterMs)).toBe(true);
    expect(p.navigateAfterMs).toBeGreaterThan(0);
    expect(p.navigateAfterMs).toBeLessThanOrEqual(3000);
    // Fallback link appears before (or at) the navigation attempt.
    expect(p.fallbackAfterMs).toBeLessThanOrEqual(p.navigateAfterMs);
  });

  it('navigates almost immediately under reduced motion', () => {
    const p = planCurtainTransition({ reducedMotion: true });
    expect(p.navigateAfterMs).toBeLessThanOrEqual(500);
    expect(p.fallbackAfterMs).toBe(0);
  });

  it('CURTAIN_STEP is the sixth panel', () => {
    expect(CURTAIN_STEP).toBe(6);
  });
});

describe('shouldMaskReveal (inline key re-mask policy)', () => {
  it('masks on every listed lifecycle event', () => {
    for (const ev of ['toggle', 'leave-step', 'visibility-hidden', 'session-expired', 'timeout']) {
      expect(shouldMaskReveal(ev)).toBe(true);
    }
    expect(MASK_EVENTS.length).toBe(5);
  });

  it('does NOT mask on unrelated events', () => {
    expect(shouldMaskReveal('scroll')).toBe(false);
    expect(shouldMaskReveal('')).toBe(false);
    expect(shouldMaskReveal(undefined)).toBe(false);
  });

  it('uses a conservative (finite, non-trivial) auto-hide timeout', () => {
    expect(Number.isFinite(REVEAL_TIMEOUT_MS)).toBe(true);
    expect(REVEAL_TIMEOUT_MS).toBeGreaterThan(5000);
  });
});

describe('no unbranded browser modal APIs in the onboarding client (source guard)', () => {
  const src = readFileSync(join(PREVIEW_DIR, 'onboarding-client.js'), 'utf8');

  it('never calls window.confirm / prompt / alert', () => {
    expect(src).not.toMatch(/\b(window\.)?confirm\s*\(/);
    expect(src).not.toMatch(/\b(window\.)?prompt\s*\(/);
    expect(src).not.toMatch(/\b(window\.)?alert\s*\(/);
  });

  it('never persists a revealed key in web storage, the URL, or logs', () => {
    // The full key only ever lives in a local variable or a Blob download.
    expect(src).not.toMatch(/localStorage\.setItem\([^)]*key/i);
    expect(src).not.toMatch(/sessionStorage\.setItem\([^)]*key/i);
    expect(src).not.toMatch(/console\.(log|info|warn|error)\([^)]*revealedKey/);
  });

  it('curtain navigation is deterministic (assigns a resolved destination)', () => {
    expect(src).toContain('location.assign(dest)');
    expect(src).toContain('resolveContinuumDestination');
  });
});

describe('Step 3 claimed-state: single Continue CTA, no countdown (source guard)', () => {
  const src = readFileSync(join(PREVIEW_DIR, 'onboarding-client.js'), 'utf8');

  it('collapses every setup control once the key is verified', () => {
    for (const sel of [
      '.routstr-paths',
      '[data-routstr-key-form]',
      '[data-routstr-fund-form]',
      '[data-routstr-confirm]',
      '[data-routstr-progress]',
      '[data-routstr-key-connect]',
      '[data-routstr-quote]',
      '[data-routstr-disconnect]',
    ]) {
      expect(src).toContain(sel);
    }
  });

  it('renders exactly one Continue action and no auto-advance timer', () => {
    expect(src).toContain('data-routstr-continue');
    // The success renderer explicitly ignores its legacy seconds arg — no timer.
    expect(src).toMatch(/renderSuccessAdvance\(statusEl, region, fromStep, body, _seconds\)/);
    expect(src).toContain('hideProgress(region)');
  });
});
