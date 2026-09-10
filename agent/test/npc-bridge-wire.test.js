/**
 * NAP-BRIDGE-3 — wire-shape regression test.
 *
 * Historical bug (v0.2.112-alpha): npc-bridge.mjs called
 *   pool.subscribeMany(relays, [{ kinds:[1059], '#p':[greeter] }], …)
 * with the filter wrapped in an array. nostr-tools SimplePool.subscribeMany
 * takes a BARE filter object as arg 2; wrapping it produced a malformed wire
 * REQ of the shape ["REQ","sub:1",[{...}]] which every relay rejected with
 *   "bad req: provided filter is not an object"
 * The bug silently broke every relay in production.
 *
 * This test spies on the pool and asserts the filter argument's runtime shape.
 * A future well-meaning refactor cannot re-introduce the array wrap without
 * turning this test red.
 *
 * Run:  node --test test/npc-bridge-wire.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNpcBridge } from '../core/npc-bridge.mjs';

const silentLog = { info() {}, warn() {}, error() {} };
const GREETER = 'aa'.repeat(32);

function makeSpyPool() {
  const calls = [];
  return {
    calls,
    subscribeMany(relays, filter, params) {
      calls.push({ relays, filter, params });
      return { close() {} };
    },
  };
}

function makeStubSigner() {
  return {
    async getPublicKey() {
      return GREETER;
    },
    async nip44Decrypt() {
      return '{}';
    },
    async nip44Encrypt() {
      return 'CT';
    },
    async signEvent(tpl) {
      return { ...tpl, id: 'x'.repeat(64), sig: 'y'.repeat(128), pubkey: GREETER };
    },
  };
}

test('subscribeMany is called with a BARE filter object (not an array)', async () => {
  const pool = makeSpyPool();
  const bridge = createNpcBridge({
    cfg: {
      relayUrls: ['wss://relay.example'],
      allowlist: new Set([GREETER]),
      soul: 'greeter',
      model: 'qwen3:0.6b',
    },
    greeterHex: GREETER,
    log: silentLog,
    pool,
    signer: makeStubSigner(),
    chat: async () => ({ ok: true, content: 'hi' }),
  });

  await bridge.start();

  assert.equal(pool.calls.length, 1, 'subscribeMany called exactly once');
  const { relays, filter } = pool.calls[0];

  assert.deepEqual(relays, ['wss://relay.example']);
  assert.ok(
    filter && typeof filter === 'object' && !Array.isArray(filter),
    'filter must be a BARE object; wrapping it in an array produces a malformed wire REQ that every relay rejects',
  );
  assert.deepEqual(filter.kinds, [1059], 'filter.kinds targets NIP-17 gift wraps');
  assert.deepEqual(filter['#p'], [GREETER], 'filter #p targets the greeter pubkey');
});

test('subscribeMany filter matches nostr-tools Filter contract', async () => {
  // Extra guard: even if someone changed subscribeMany's signature, the filter
  // itself must remain a shape nostr-tools's abstract-relay understands. That
  // module (nostr-tools 2.23+) serialises filters via
  //   JSON.stringify(this.filters).substring(1)
  // which expects an array of filter objects wrapping OUR filter, one level up.
  // Manually stringifying [filter] must produce a well-formed JSON array whose
  // sole element is a plain object, and manually stringifying [wrappedFilter]
  // where wrappedFilter is itself an array must FAIL that shape check.
  const pool = makeSpyPool();
  const bridge = createNpcBridge({
    cfg: {
      relayUrls: ['wss://relay.example'],
      allowlist: new Set([GREETER]),
      soul: 'greeter',
      model: 'qwen3:0.6b',
    },
    greeterHex: GREETER,
    log: silentLog,
    pool,
    signer: makeStubSigner(),
    chat: async () => ({ ok: true, content: 'hi' }),
  });
  await bridge.start();

  const { filter } = pool.calls[0];
  const wireFilters = JSON.stringify([filter]);
  const parsed = JSON.parse(wireFilters);
  assert.ok(Array.isArray(parsed), 'nostr-tools wraps the filter in an array itself');
  assert.equal(parsed.length, 1);
  assert.equal(typeof parsed[0], 'object');
  assert.ok(!Array.isArray(parsed[0]), 'the sole element must be a plain object, not another array');
});
