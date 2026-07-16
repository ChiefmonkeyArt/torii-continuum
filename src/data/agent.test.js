/**
 * Offline tests for the SPA ↔ agent client's pure helpers and the onboarding
 * session handoff. No network, no DOM — localStorage is a tiny in-memory stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveSameOriginBase,
  tokenLooksLive,
  adoptOnboardingSession,
  getStoredToken,
  isLoggedIn,
  errorReason,
  requestChallenge,
  verifyChallenge,
  walletHealth,
  projectSources,
  refreshProjectSources,
} from './agent.js';

// A live token mirrors the agent's `iat.exp.pubkey.sig` shape with a future exp.
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;
const pubkey = 'a'.repeat(64);
const liveToken = `1000.${future}.${pubkey}.deadbeefsig`;
const deadToken = `1000.${past}.${pubkey}.deadbeefsig`;

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

describe('deriveSameOriginBase (subpath-aware same-origin agent base)', () => {
  it('returns /continuum under the /continuum/ mount', () => {
    expect(deriveSameOriginBase('/continuum/')).toBe('/continuum');
    expect(deriveSameOriginBase('/continuum/index.html')).toBe('/continuum');
    expect(deriveSameOriginBase('/continuum')).toBe('/continuum');
  });

  it('returns empty at the site root (calls hit /api/*)', () => {
    expect(deriveSameOriginBase('/')).toBe('');
    expect(deriveSameOriginBase('')).toBe('');
    expect(deriveSameOriginBase('/index.html')).toBe('');
  });

  it('does not treat an unrelated first segment as the agent mount', () => {
    expect(deriveSameOriginBase('/other/')).toBe('');
    expect(deriveSameOriginBase('/projects/thing')).toBe('');
  });
});

describe('tokenLooksLive (HMAC-free liveness gate)', () => {
  it('accepts a well-shaped, not-yet-expired token', () => {
    expect(tokenLooksLive(liveToken)).toBe(true);
  });

  it('rejects an expired token', () => {
    expect(tokenLooksLive(deadToken)).toBe(false);
  });

  it('rejects the wrong shape / non-strings', () => {
    expect(tokenLooksLive('a.b.c')).toBe(false);
    expect(tokenLooksLive('')).toBe(false);
    expect(tokenLooksLive(null)).toBe(false);
    expect(tokenLooksLive(undefined)).toBe(false);
    expect(tokenLooksLive(`1000.notanumber.${pubkey}.sig`)).toBe(false);
  });

  it('honours an injected now', () => {
    expect(tokenLooksLive(liveToken, future + 10)).toBe(false);
    expect(tokenLooksLive(liveToken, future - 10)).toBe(true);
  });
});

describe('adoptOnboardingSession (torii.session → continuum.session.v1)', () => {
  let stub;
  beforeEach(() => {
    stub = makeStorageStub();
    globalThis.localStorage = stub;
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('adopts a live onboarding session when the SPA has none', () => {
    stub.setItem('torii.session', JSON.stringify({ token: liveToken, pubkey, method: 'nip07' }));
    expect(isLoggedIn()).toBe(false);
    expect(adoptOnboardingSession()).toBe(true);
    expect(getStoredToken()).toBe(liveToken);
    expect(isLoggedIn()).toBe(true);
  });

  it('does not overwrite an existing live SPA session', () => {
    stub.setItem('continuum.session.v1', liveToken);
    stub.setItem('torii.session', JSON.stringify({ token: `1000.${future}.${'b'.repeat(64)}.other`, pubkey, method: 'nip07' }));
    expect(adoptOnboardingSession()).toBe(false);
    expect(getStoredToken()).toBe(liveToken); // untouched
  });

  it('ignores a dead onboarding token (fail closed)', () => {
    stub.setItem('torii.session', JSON.stringify({ token: deadToken, pubkey, method: 'nip07' }));
    expect(adoptOnboardingSession()).toBe(false);
    expect(getStoredToken()).toBeNull();
  });

  it('ignores a missing or malformed envelope', () => {
    expect(adoptOnboardingSession()).toBe(false);
    stub.setItem('torii.session', 'not json');
    expect(adoptOnboardingSession()).toBe(false);
    stub.setItem('torii.session', JSON.stringify({ nope: true }));
    expect(adoptOnboardingSession()).toBe(false);
  });
});

describe('errorReason (safe, detailed failure text)', () => {
  it('prefers the specific Fastify message over the generic label', () => {
    // The exact body Fastify v5 returns for an empty JSON body — the root cause
    // of the "Could not reach agent: Bad Request" report.
    expect(errorReason({ error: 'Bad Request', message: "Body cannot be empty when content-type is set to 'application/json'" }, 400))
      .toBe("Bad Request: Body cannot be empty when content-type is set to 'application/json'");
  });

  it('uses the agent handler reason when there is no extra message', () => {
    expect(errorReason({ error: 'unknown or expired challenge' }, 401)).toBe('unknown or expired challenge');
  });

  it('falls back to the bare status when the body has nothing usable', () => {
    expect(errorReason(null, 500)).toBe('http 500');
    expect(errorReason({}, 503)).toBe('http 503');
  });

  it('does not duplicate when error and message are identical', () => {
    expect(errorReason({ error: 'nope', message: 'nope' }, 400)).toBe('nope');
  });

  it('caps runaway strings so a malformed body cannot flood the UI', () => {
    const huge = 'x'.repeat(5000);
    expect(errorReason({ error: huge }, 400).length).toBe(200);
  });
});

describe('req() request shape — bodyless POST must not carry a JSON content-type', () => {
  // Regression for the sidebar/demo Login "Bad Request" bug: the SPA agent
  // client sent `Content-Type: application/json` on the bodyless
  // POST /api/auth/challenge, and Fastify v5 rejected the empty body with 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY, error "Bad Request"). The challenge call must
  // send NO content-type; only calls that carry a JSON body may declare one.
  let stub;
  let calls;

  beforeEach(() => {
    stub = makeStorageStub();
    globalThis.localStorage = stub;
    globalThis.window = { __CONTINUUM_AGENT_URL__: 'https://agent.example' };
    calls = [];
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  const mockFetch = (status, body) => {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    };
  };

  it('requestChallenge posts with no body and no content-type header', async () => {
    mockFetch(200, { challenge: 'c'.repeat(48), expires_in: 300, kind: 22242 });
    const r = await requestChallenge();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, opts } = calls[0];
    expect(url).toBe('https://agent.example/api/auth/challenge');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeUndefined();
    // No content-type at all — this is the whole fix.
    const ctKey = Object.keys(opts.headers).find((k) => k.toLowerCase() === 'content-type');
    expect(ctKey).toBeUndefined();
  });

  it('verifyChallenge posts the exact {event} body with a JSON content-type and stores the token', async () => {
    const token = `1000.${future}.${pubkey}.sig`;
    mockFetch(200, { token, expires_at: future });
    const event = { kind: 22242, pubkey, content: 'c'.repeat(48), tags: [['challenge', 'c'.repeat(48)]], sig: 'ff', id: 'ee' };
    const r = await verifyChallenge(event);
    expect(r.ok).toBe(true);
    const { url, opts } = calls[0];
    expect(url).toBe('https://agent.example/api/auth/verify');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ event });
    // Token adopted into the SPA session slot.
    expect(getStoredToken()).toBe(token);
    expect(isLoggedIn()).toBe(true);
  });

  it('surfaces the detailed reason when the agent 400s the challenge', async () => {
    // Simulates the pre-fix server response so the error mapping is proven
    // end-to-end through req().
    mockFetch(400, { statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY', error: 'Bad Request', message: "Body cannot be empty when content-type is set to 'application/json'" });
    const r = await requestChallenge();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.reason).toContain('Bad Request');
    expect(r.reason).toContain('Body cannot be empty');
  });
});

describe('v0.2.47 client fns — wallet health + project sources', () => {
  let stub;
  let calls;

  beforeEach(() => {
    stub = makeStorageStub();
    globalThis.localStorage = stub;
    globalThis.window = { __CONTINUUM_AGENT_URL__: 'https://agent.example' };
    calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('walletHealth GETs /api/wallet/health with no body', async () => {
    await walletHealth();
    expect(calls[0].url).toBe('https://agent.example/api/wallet/health');
    expect(calls[0].opts.method).toBe('GET');
    expect(calls[0].opts.body).toBeUndefined();
  });

  it('projectSources GETs the per-slug sources endpoint, slug encoded', async () => {
    await projectSources('my-project');
    expect(calls[0].url).toBe('https://agent.example/api/projects/my-project/sources');
    expect(calls[0].opts.method).toBe('GET');
  });

  it('refreshProjectSources POSTs refresh with a JSON body', async () => {
    await refreshProjectSources('my-project');
    expect(calls[0].url).toBe('https://agent.example/api/projects/my-project/sources/refresh');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers['Content-Type']).toBe('application/json');
  });

  it('offline (no agent url) short-circuits without a fetch', async () => {
    delete globalThis.window.__CONTINUUM_AGENT_URL__;
    const r = await walletHealth();
    expect(r.ok).toBe(false);
    expect(r.offline).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
