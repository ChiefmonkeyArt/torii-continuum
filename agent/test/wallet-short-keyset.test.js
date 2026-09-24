import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';

const mint = 'https://mint.example';
const fullId = '01' + 'ab'.repeat(32);
const log = { info() {}, warn() {}, error() {} };
const token = (url = mint, unit = 'sat') => getEncodedToken({ mint: url, unit,
  proofs: [{ id: fullId, amount: 2, secret: 'synthetic', C: '02' + 'ab'.repeat(32) }],
}, { version: 4 });

test('valid short-keyset Cashu-B refund reaches the loaded whitelisted wallet and persists received funds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-keyset-'));
  const encoded = token();
  assert.throws(() => getDecodedToken(encoded), /map short keyset ID/);
  let loaded = false, received = 0;
  try {
    const wallet = await createWallet({ cashu: { mints: [mint] } }, log, {
      walletDir: dir, walletFactory: () => ({
        async loadMint() { loaded = true; },
        async receive(value) {
          assert.equal(loaded, true); received++;
          return getDecodedToken(value, [fullId]).proofs;
        },
      }),
    });
    assert.equal((await wallet.receive(encoded)).added_sats, 2);
    assert.equal(received, 1);
    assert.equal((await wallet.balance()).total, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('short-keyset compatibility does not bypass mint whitelist or sat-unit checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-keyset-guards-'));
  let received = 0;
  try {
    const wallet = await createWallet({ cashu: { mints: [mint] } }, log, {
      walletDir: dir, walletFactory: () => ({
        async loadMint() {}, async receive() { received++; return []; },
      }),
    });
    assert.match((await wallet.receive(token('https://unknown.example'))).reason, /not whitelisted/);
    assert.equal((await wallet.receive(token(mint, 'msat'))).reason, 'token unit must be sat');
    assert.equal(received, 0);
    assert.equal((await wallet.balance()).total, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unknown short-keyset mappings remain rejected by the mint wallet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'short-keyset-unknown-'));
  try {
    const wallet = await createWallet({ cashu: { mints: [mint] } }, log, {
      walletDir: dir, walletFactory: () => ({
        async loadMint() {}, async receive(value) { return getDecodedToken(value, []); },
      }),
    });
    assert.equal((await wallet.receive(token())).ok, false);
    assert.equal((await wallet.balance()).total, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
