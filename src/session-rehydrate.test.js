/**
 * Session rehydrate contract (SESSION-REHYDRATE-1).
 *
 * A second tab opened after the first — and a back-forward-cache restore — must
 * rebuild the authenticated shell from PERSISTENT storage, never from a stale
 * per-tab snapshot, so the right-hand region never renders blank. Two layers,
 * both jsdom-free:
 *   1. Behavioural: rehydrateSession() reads the persisted token + marker and
 *      reconciles a stale marker (marker present, token gone) to a clean
 *      logged-out state. A live token loads normally; a missing token bounces.
 *   2. Source-structure: the guarded route wrapper rehydrates BEFORE deciding
 *      the redirect, and the bfcache pageshow path re-runs the guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  rehydrateSession,
  writeSessionMarker,
  readSessionMarker,
  SESSION_MARKER_KEY,
} from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

const TOKEN_KEY = 'continuum.session.v1';
// A token whose exp (2nd field of iat.exp.pubkey.sig) is far in the future.
const LIVE_TOKEN = '1.9999999999.deadbeefpub.1.sig';

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

beforeEach(() => {
  global.localStorage = new FakeStorage();
});
afterEach(() => {
  delete global.localStorage;
});

describe('rehydrateSession — fresh tab / bfcache restore reads persistent storage', () => {
  it('present token + marker → live, marker returned (guarded route loads, no blank)', () => {
    localStorage.setItem(TOKEN_KEY, LIVE_TOKEN);
    writeSessionMarker({ npub: 'deadbeefpub', connected_at: 100 });
    const r = rehydrateSession();
    expect(r.live).toBe(true);
    expect(r.marker).toEqual({ npub: 'deadbeefpub', connected_at: 100 });
  });

  it('missing token → not live, no marker (guard bounces to login)', () => {
    const r = rehydrateSession();
    expect(r.live).toBe(false);
    expect(r.marker).toBeNull();
  });

  it('stale marker without a live token is reconciled away', () => {
    writeSessionMarker({ npub: 'x', connected_at: 1 });
    const r = rehydrateSession();
    expect(r.live).toBe(false);
    expect(r.marker).toBeNull();
    // …and persisted, so a subsequent read is also clean.
    expect(readSessionMarker()).toBeNull();
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
  });

  it('an expired token (exp in the past) is treated as logged out', () => {
    localStorage.setItem(TOKEN_KEY, '1.1000000000.pub.sig'); // exp ~2001
    writeSessionMarker({ npub: 'pub', connected_at: 1 });
    const r = rehydrateSession();
    expect(r.live).toBe(false);
    expect(r.marker).toBeNull();
  });
});

describe('src/main.js — guarded routes rehydrate before deciding, pageshow re-runs guard', () => {
  const main = read('main.js');

  it('the guarded() wrapper rehydrates session before the redirect decision', () => {
    const guardedIdx = main.indexOf('function guarded(');
    const rehydrateIdx = main.indexOf('rehydrateSession()', guardedIdx);
    const guardRedirectIdx = main.indexOf('guardRedirect(', guardedIdx);
    expect(rehydrateIdx).toBeGreaterThan(guardedIdx);
    expect(guardRedirectIdx).toBeGreaterThan(rehydrateIdx);
  });

  it('a bfcache pageshow (event.persisted) re-runs the auth guard', () => {
    expect(main).toMatch(/addEventListener\('pageshow'/);
    expect(main).toContain('e.persisted');
    expect(main).toContain('enforceRouteAuth');
  });
});
