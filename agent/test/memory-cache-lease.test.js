/**
 * MEMORY-AUTHORITY-1 (audit A17) — plaintext RAM cache is LEASED, not permanent.
 *
 * The verified admin session is the single authority for the plaintext RAM cache.
 * This tests the lease: unlocked plaintext auto-drops when the lease lapses
 * (injected clock), and drops on explicit clear (lock/panic). No crypto or
 * network — pure Map behaviour with an injected clock.
 *
 * Run: node --test test/memory-cache-lease.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '../lib/crypto.mjs';

const silentLog = () => ({ info() {}, warn() {}, error() {} });

const NPUB = 'npub1test';

function entries() {
  return [
    { kind: 30094, dTag: 'fact-1', content: { fact: 'the sky is red' }, createdAt: 1 },
    { kind: 30095, dTag: 'skill-1', content: { skill: 'be nice' }, createdAt: 2 },
  ];
}

test('A17: unlocked plaintext drops when the lease lapses (injected clock)', () => {
  let t = 1_000_000;
  const cache = createMemoryCache(silentLog(), { ttlSec: 3600, now: () => t });
  const r = cache.unlock(NPUB, entries());
  assert.equal(r.count, 2);
  assert.equal(cache.isUnlocked(), true);
  assert.equal(cache.get(30094, 'fact-1').content.fact, 'the sky is red');

  // Before the lease lapses, entries remain reachable.
  t += 3599;
  assert.equal(cache.get(30094, 'fact-1').content.fact, 'the sky is red');

  // Cross the lease boundary → the next access drops everything.
  t += 2;
  assert.equal(cache.isUnlocked(), false);
  assert.equal(cache.get(30094, 'fact-1'), null);
  assert.equal(cache.list(30095).length, 0);
  assert.equal(cache.unlockedForNpub(), null);
});

test('A17: a fresh unlock restarts the lease; clear() revokes immediately', () => {
  let t = 5_000_000;
  const cache = createMemoryCache(silentLog(), { ttlSec: 100, now: () => t });

  cache.unlock(NPUB, entries());
  assert.equal(cache.isUnlocked(), true);

  cache.clear('operator-lock'); // explicit revocation (lock/panic/shutdown)
  assert.equal(cache.isUnlocked(), false);
  assert.equal(cache.snapshot().total_entries, 0);

  // Re-unlock restarts the lease clock.
  cache.unlock(NPUB, entries());
  assert.equal(cache.isUnlocked(), true);
  t += 99;
  assert.equal(cache.isUnlocked(), true); // still fresh
  t += 1;
  assert.equal(cache.isUnlocked(), false); // lapsed again
});

test('A17: the lease does not fire before a single TTL elapses even across many reads', () => {
  let t = 0;
  const cache = createMemoryCache(silentLog(), { ttlSec: 86400, now: () => t });
  cache.unlock(NPUB, entries());
  for (let i = 0; i < 1000; i++) {
    assert.equal(cache.get(30094, 'fact-1').content.fact, 'the sky is red');
    t += 60; // 60s per read → still under 86400 total
  }
  assert.equal(cache.isUnlocked(), true);
});