// docs/adr-routstr-provider-fallback.md §3: pay only from a mint the provider accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';
const A = 'https://mint-a.example', B = 'https://mint-b.example/Bitcoin';
const proof = (n) => ({ id: '009a1f293253e41e', amount: 8, secret: 'test-only-' + n, C: '02' + 'ab'.repeat(32) });

test('send({mints}) skips mints the receiver does not accept and fails clearly when none fit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cashu-mints-'));
  const used = [];
  try {
    const wallet = await createWallet({ cashu: { mints: [A, B] } }, { info() {}, warn() {}, error() {} }, {
      walletDir: dir, walletFactory: (url) => ({
        async loadMint() {}, async receive(token) { return getDecodedToken(token).proofs; },
        getFeesForProofs() { return 0; },
        async send() { used.push(url); return { send: [{ ...proof(1), amount: 1 }], keep: [{ ...proof(2), amount: 7 }] }; },
      }),
    });
    await wallet.receive(getEncodedToken({ mint: A, proofs: [proof('a')] }));
    await wallet.receive(getEncodedToken({ mint: B, proofs: [proof('b')] }));
    const r = await wallet.send(1, { mints: [B + '/'] });
    assert.equal(r.ok, true, r.reason);
    assert.equal(String(used.at(-1)).replace(/\/$/, ''), B);
    const none = await wallet.send(1, { mints: ['https://elsewhere.example'] });
    assert.equal(none.ok, false);
    assert.match(none.reason, /mints this provider accepts/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
