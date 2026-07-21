/**
 * Pending top-up recovery — resume endpoint (v0.2.89-alpha, Item 3).
 *
 * resumeQuote completes a stuck quote for its OWNER: it verifies
 * marker.session === sessionId (refusing others' quotes with forbidden), calls
 * checkMintQuote to mint, and is fully idempotent — hitting an already-minted
 * quote returns { ok:true, paid:true, already:true } without touching the mint.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MintQuoteState } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';

function silentLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function fakeMintFactory(state = { value: MintQuoteState.UNPAID, mintCalls: 0 }) {
  return () => ({
    async loadMint() {},
    async createMintQuoteBolt11(amount) {
      return {
        quote: `quote-${amount}-abc`,
        request: 'lnbc10u1p3xtestinvoicexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxend',
        expiry: Math.floor(Date.now() / 1000) + 600,
        amount,
        state: MintQuoteState.UNPAID,
      };
    },
    async checkMintQuoteBolt11(_quote) { return { quote: _quote, state: state.value, expiry: null }; },
    async mintProofsBolt11(amount, _quote) {
      state.mintCalls += 1;
      return [{ id: '009a1f293253e41e', amount, secret: 'deadbeef', C: '02' + 'ab'.repeat(32) }];
    },
  });
}

async function withTempWallet(cfg, deps, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'torii-wallet-'));
  try {
    return await fn(await createWallet(cfg, silentLog(), { walletDir: dir, ...deps }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const oneMintCfg = { cashu: { mints: ['https://mint.example'], max_mint_sats: 50_000 } };

test('resumeQuote rejects a path-unsafe quote id before touching disk', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.resumeQuote({ quote: '../etc/passwd', sessionId: 'npub-alice' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /bad quote id/);
  });
});

test('resumeQuote reports unknown for a quote with no marker', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.resumeQuote({ quote: 'never-created', sessionId: 'npub-alice' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown quote/);
  });
});

test('resumeQuote refuses another session\'s quote with a forbidden flag', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 369, sessionId: 'npub-alice' });
    const r = await w.resumeQuote({ quote: q.quote, sessionId: 'npub-mallory' });
    assert.equal(r.ok, false);
    assert.equal(r.forbidden, true);
    assert.equal(r.reason, 'not_yours');
  });
});

test('resumeQuote mints a paid quote for its owner (calls checkMintQuote)', async () => {
  const state = { value: MintQuoteState.PAID, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 369, sessionId: 'npub-alice' });
    const r = await w.resumeQuote({ quote: q.quote, sessionId: 'npub-alice' });
    assert.equal(r.ok, true);
    assert.equal(r.paid, true);
    assert.equal(r.minted_sats, 369);
    assert.equal(state.mintCalls, 1);
  });
});

test('resumeQuote is idempotent on an already-minted quote (no second mint)', async () => {
  const state = { value: MintQuoteState.PAID, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 500, sessionId: 'npub-alice' });
    const first = await w.resumeQuote({ quote: q.quote, sessionId: 'npub-alice' });
    assert.equal(first.paid, true);
    assert.equal(state.mintCalls, 1);

    const second = await w.resumeQuote({ quote: q.quote, sessionId: 'npub-alice' });
    assert.equal(second.ok, true);
    assert.equal(second.paid, true);
    assert.equal(second.already, true, 'idempotent replay is flagged');
    assert.equal(state.mintCalls, 1, 'must not mint twice on resume');
  });
});
