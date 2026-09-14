/**
 * FE-03 + FE-06 regression tests (offline, no network).
 *
 * FE-03: a 401 from a request issued under a superseded token must NOT clear a
 * session that was established (or refreshed) while that old request was in
 * flight. FE-06: an explicit empty agent prefix (root mount) is a VALID
 * configuration, distinct from an absent transport (offline demo).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isAgentConfigured,
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  health,
  versionInfo,
} from './agent.js';

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

describe('FE-03: stale 401 must not clear a newer session', () => {
  beforeEach(() => {
    globalThis.localStorage = makeStorageStub();
    globalThis.window = { __CONTINUUM_AGENT_URL__: 'https://agent.example' };
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  const OLD = 'old.token.0000000000.aaaa.0.sig';
  const NEW = 'new.token.9999999999.bbbb.0.sig';

  it('keeps a newly-rotated token when the old request returns 401', async () => {
    setStoredToken(OLD);

    // A fetch that stays pending until we choose to resolve it, so the stored
    // token can change underneath the in-flight request.
    let resolveFetch;
    const gate = new Promise((res) => { resolveFetch = res; });
    globalThis.fetch = () => gate.then(() => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'expired' }),
    }));

    const request = versionInfo(); // snapshots OLD token, awaits fetch
    setStoredToken(NEW);           // a newer session is established meanwhile
    resolveFetch();                // the OLD request's 401 arrives late
    await request;

    // The old 401 must not erase the newer session.
    expect(getStoredToken()).toBe(NEW);
  });

  it('still clears the token when the 401 belongs to the current session', async () => {
    setStoredToken(OLD);
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'expired' }),
    });
    await versionInfo(); // same token throughout → this 401 legitimately ends it
    expect(getStoredToken()).toBeNull();
  });

  it('does not clear a token that was installed after a logout invalidated writes', async () => {
    // A logout bumps the auth epoch; the OLD request's 401 must be inert against
    // whatever token a subsequent login installed.
    setStoredToken(OLD);
    let resolveFetch;
    const gate = new Promise((res) => { resolveFetch = res; });
    globalThis.fetch = () => gate.then(() => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'expired' }),
    }));

    const request = versionInfo();
    clearStoredToken();   // sign-out path clears the old token
    setStoredToken(NEW);  // then a NEW session is established
    resolveFetch();
    await request;

    expect(getStoredToken()).toBe(NEW);
  });
});

describe('FE-06: empty agent prefix is a valid root mount, not offline', () => {
  beforeEach(() => {
    globalThis.localStorage = makeStorageStub();
  });
  afterEach(() => {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('reports configured for an explicit empty override (root mount)', async () => {
    globalThis.window = { __CONTINUUM_AGENT_URL__: '' };
    expect(isAgentConfigured()).toBe(true);

    globalThis.fetch = async (url) => {
      expect(url).toBe('/api/health'); // root mount → no leading prefix
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'agent' }) };
    };
    const r = await health();
    expect(r.ok).toBe(true);
    expect(r.offline).toBeUndefined();
  });

  it('reports offline when no transport is configured (agent-less demo)', async () => {
    globalThis.window = {}; // no override; test env has no VITE_AGENT_URL
    expect(isAgentConfigured()).toBe(false);
    const r = await health();
    expect(r.ok).toBe(false);
    expect(r.offline).toBe(true);
    expect(r.reason).toBe('offline');
  });
});