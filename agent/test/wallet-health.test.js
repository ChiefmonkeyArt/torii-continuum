/**
 * wallet.health() — CONT-HEALTH-2 non-mutating wallet + mint health.
 *
 * Offline by construction: the wallet is built with zero configured mints, so
 * no cashu-ts network call is reached. These pin the disabled path, the exact
 * public shape, and the info-disclosure guarantee (no proofs / secrets / tokens
 * in the output). The mutation-free guarantee is structural: health() only ever
 * calls readProofs() + read-only cashu-ts probes, never send()/receive().
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWallet } from '../core/wallet.mjs';

function silentLog() { return { info() {}, warn() {}, error() {} }; }

test('health() with no mints reports disabled, not a fake green light', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const h = await w.health();
  assert.equal(h.configured, false);
  assert.equal(h.overall, 'disabled');
  assert.deepEqual(h.mints, []);
  assert.ok(typeof h.checked_at === 'string' && h.checked_at.length > 0);
});

test('health() is exposed alongside the existing wallet surface', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  assert.equal(typeof w.health, 'function');
  assert.equal(typeof w.balance, 'function');
  assert.equal(typeof w.receive, 'function');
  assert.equal(typeof w.send, 'function');
});

test('health() output never carries proofs, secrets, or tokens', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const blob = JSON.stringify(await w.health()).toLowerCase();
  for (const forbidden of ['secret', 'proof', '"c"', 'token', 'privkey', 'private']) {
    assert.ok(!blob.includes(forbidden), `health output must not include "${forbidden}"`);
  }
});

test('health() does not mutate balance (read-only)', async () => {
  const w = await createWallet({ cashu: { mints: [] } }, silentLog());
  const before = await w.balance();
  await w.health();
  const after = await w.balance();
  assert.deepEqual(before, after);
});
