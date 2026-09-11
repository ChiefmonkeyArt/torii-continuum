/**
 * wallet.mjs — mutation coordinator (audit A03).
 *
 * Proves the per-wallet async mutex serialises read-modify-write of the proof
 * store: many concurrent receive() calls must not interleave and lose updates.
 * A single Node process is not a transaction lock by itself — this is the
 * missing coordinator being exercised.
 *
 * Dummy proofs/tokens only. No network, no mint, no real funds.
 *
 * Run: node --test test/wallet-concurrency.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';

const MINT = 'https://mint.example';
const cfg = { cashu: { mints: [MINT] } };

function silentLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

// A mint double whose receive() echoes back the token's own proofs, so each
// concurrent call yields distinct proof material recorded exactly once.
function echoMintFactory() {
  return () => ({
    async loadMint() {},
    async receive(encodedToken) {
      return getDecodedToken(encodedToken).proofs;
    },
  });
}

function token(secret) {
  return getEncodedToken({
    mint: MINT,
    proofs: [{ id: '009a1f293253e41e', amount: 1, secret, C: '02' + 'ab'.repeat(32) }],
  });
}

test('concurrent receive() calls do not lose updates (audit A03)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'torii-wallet-conc-'));
  try {
    const w = await createWallet(cfg, silentLog(), { walletDir: dir, walletFactory: echoMintFactory() });
    const N = 25;
    // Fire N receives at once, each with a distinct proof. Without the mutation
    // lock these interleave between read and write and drop most of them.
    await Promise.all(
      Array.from({ length: N }, (_, i) => w.receive(token(`secret-${i}`))),
    );
    const bal = await w.balance();
    assert.equal(bal.total, N, `expected ${N} sats after ${N} concurrent receives, got ${bal.total}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});