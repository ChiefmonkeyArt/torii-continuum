import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';
const mint = 'https://mint.example';
const proof = { id: '009a1f293253e41e', amount: 8, secret: 'test-only', C: '02' + 'ab'.repeat(32) };
for (const fee of [0, 1, 2, NaN, 'unknown']) test(`total debit cap includes mint fees: ${fee}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashu-cap-'));
  let sends = 0;
  try {
    const wallet = await createWallet({ cashu: { mints: [mint] } }, { info() {}, warn() {}, error() {} }, {
      walletDir: dir, walletFactory: () => ({
        async loadMint() {}, async receive(token) { return getDecodedToken(token).proofs; },
        getFeesForProofs(inputs) {
          assert.equal(inputs[0].amount, 8);
          if (fee === 'unknown') throw new Error('unknown keyset');
          return fee;
        },
        async send() { sends++; return { send: [{ ...proof, amount: 1 }], keep: [{ ...proof, amount: 7 - fee }] }; },
      }),
    });
    await wallet.receive(getEncodedToken({ mint, proofs: [proof] }));
    const result = await wallet.send(1, { maxDebitSats: 2 });
    assert.equal(result.ok, fee < 2);
    assert.equal(sends, fee < 2 ? 1 : 0);
    assert.equal((await wallet.balance()).total, fee < 2 ? 7 - fee : 8);
    assert.match((await wallet.send(1, { maxDebitSats: 0 })).reason, /invalid total/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
