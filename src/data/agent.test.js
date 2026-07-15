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
