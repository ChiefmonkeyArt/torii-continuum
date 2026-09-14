/**
 * A09 follow-up — scope-aware unlock cache key.
 *
 * Before this, the RAM cache keyed `${kind}:${dTag}` (flat), so the same
 * kind+d-tag stored under two projects would shadow each other (the second
 * `set` overwrote the first, and a flat `get` could never reach the hidden
 * entry). The cache now keys scoped entries `${kind}:${scope}:${dTag}` and
 * keeps flat identity/intents/panic (no scope) on the legacy flat key.
 *
 * Run: node --test test/memory-cache-scope.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCache } from '../lib/crypto.mjs';

const silentLog = () => ({ info() {}, warn() {}, error() {} });
const NPUB = 'npub1test';

test('A09: same kind+d-tag under two projects do not shadow each other', () => {
  const cache = createMemoryCache(silentLog(), { ttlSec: 3600, now: () => 1_000_000 });
  const r = cache.unlock(NPUB, [
    { kind: 30094, dTag: 'home-city', scope: '_global', content: { city: 'Staverton' }, createdAt: 1 },
    { kind: 30094, dTag: 'home-city', scope: 'basho', content: { city: 'Kyoto' }, createdAt: 2 },
  ]);
  assert.equal(r.count, 2); // both retained — no shadowing
  assert.equal(cache.get(30094, 'home-city', '_global').content.city, 'Staverton');
  assert.equal(cache.get(30094, 'home-city', 'basho').content.city, 'Kyoto');
  // list() surfaces both entries for the kind.
  assert.equal(cache.list(30094).length, 2);
});

test('A09: flat entries (no scope) keep the legacy flat key and never match a scoped lookup', () => {
  const cache = createMemoryCache(silentLog(), { ttlSec: 3600, now: () => 1_000_000 });
  cache.unlock(NPUB, [
    { kind: 30092, dTag: 'root', content: { name: 'Torii' }, createdAt: 1 },
  ]);
  assert.equal(cache.get(30092, 'root').content.name, 'Torii'); // 2-arg flat path
  assert.equal(cache.get(30092, 'root', '_global'), null); // scoped lookup must not match flat
});

test('A09: same kind+d-tag+scope still dedupes to the newer createdAt within a batch', () => {
  const cache = createMemoryCache(silentLog(), { ttlSec: 3600, now: () => 1_000_000 });
  const r = cache.unlock(NPUB, [
    { kind: 30095, dTag: 'greet', scope: '_global', content: { v: 1 }, createdAt: 1 },
    { kind: 30095, dTag: 'greet', scope: '_global', content: { v: 2 }, createdAt: 2 },
  ]);
  assert.equal(r.count, 1);
  assert.equal(cache.get(30095, 'greet', '_global').content.v, 2);
});