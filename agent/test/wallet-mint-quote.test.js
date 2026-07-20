/**
 * Cashu mint-quote top-up (v0.2.83-alpha) — validation, quote issuance, and the
 * idempotent double-mint guard on checkMintQuote().
 *
 * These tests inject a fake mint via `walletFactory` and a temp `walletDir`, so
 * they never touch the network or a real mint. The fake mint models the NUT-04
 * lifecycle (UNPAID → PAID → ISSUED) and counts mintProofsBolt11 calls so the
 * guard's "mark minted BEFORE appending proofs, never double-mint" contract is
 * pinned. No proofs/secrets/invoices are logged (dummy fixtures only).
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
  return { info() {}, warn() {}, error() {} };
}

// A fake cashu-ts Wallet that never hits the network. `state` drives what the
// next checkMintQuoteBolt11 reports; `mintCalls` counts real mint attempts.
function fakeMintFactory(state = { value: MintQuoteState.UNPAID, mintCalls: 0 }) {
  return () => ({
    async loadMint() { /* reachable */ },
    async createMintQuoteBolt11(amount) {
      return {
        quote: 'quote-abc123',
        request: 'lnbc10u1p3xtestinvoicexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxend',
        expiry: Math.floor(Date.now() / 1000) + 600,
        amount,
        state: MintQuoteState.UNPAID,
      };
    },
    async checkMintQuoteBolt11(_quote) {
      return { quote: _quote, state: state.value, expiry: null };
    },
    async mintProofsBolt11(amount, _quote) {
      state.mintCalls += 1;
      return [{ id: '009a1f293253e41e', amount, secret: 'deadbeef', C: '02' + 'ab'.repeat(32) }];
    },
  });
}

async function withTempWallet(cfg, deps, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'torii-wallet-'));
  try {
    const wallet = await createWallet(cfg, silentLog(), { walletDir: dir, ...deps });
    return await fn(wallet);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const oneMintCfg = { cashu: { mints: ['https://mint.example'], max_mint_sats: 50_000 } };
const noMintCfg = { cashu: { mints: [] } };

test('createMintQuote rejects a non-positive amount before any mint call', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.createMintQuote({ amountSats: 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /positive integer/);
  });
});

test('createMintQuote enforces the configured max', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.createMintQuote({ amountSats: 50_001 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exceeds the max/);
  });
});

test('createMintQuote with no configured mint reports no healthy mint', async () => {
  await withTempWallet(noMintCfg, {}, async (w) => {
    const r = await w.createMintQuote({ amountSats: 1000 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no healthy whitelisted mint/);
  });
});

test('createMintQuote issues a BOLT11 + quote id for a healthy mint', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.createMintQuote({ amountSats: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.quote, 'quote-abc123');
    assert.ok(r.request.startsWith('lnbc'));
    assert.equal(r.amount_sats, 1000);
    assert.equal(r.mint, 'https://mint.example');
  });
});

test('checkMintQuote rejects a path-unsafe quote id before touching disk', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.checkMintQuote({ quote: '../etc/passwd' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /bad quote id/);
  });
});

test('checkMintQuote reports unknown for a quote with no marker', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.checkMintQuote({ quote: 'never-created' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown quote/);
  });
});

test('checkMintQuote stays UNPAID while the invoice is unpaid', async () => {
  const state = { value: MintQuoteState.UNPAID, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 1000 });
    const r = await w.checkMintQuote({ quote: q.quote });
    assert.equal(r.ok, true);
    assert.equal(r.paid, false);
    assert.equal(r.state, 'UNPAID');
    assert.equal(state.mintCalls, 0);
  });
});

test('checkMintQuote mints exactly once on PAID and never re-mints', async () => {
  const state = { value: MintQuoteState.PAID, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 2100 });

    const first = await w.checkMintQuote({ quote: q.quote });
    assert.equal(first.ok, true);
    assert.equal(first.paid, true);
    assert.equal(first.state, 'PAID');
    assert.equal(first.minted_sats, 2100);
    assert.equal(first.new_balance_sats, 2100);
    assert.equal(state.mintCalls, 1);

    // Second poll after settlement must serve the cached ISSUED result from the
    // marker WITHOUT calling mintProofsBolt11 again (the double-mint guard).
    const second = await w.checkMintQuote({ quote: q.quote });
    assert.equal(second.ok, true);
    assert.equal(second.state, 'ISSUED');
    assert.equal(second.paid, true);
    assert.equal(state.mintCalls, 1, 'must not mint twice for the same quote');
  });
});

test('checkMintQuote does not re-mint when the mint already reports ISSUED', async () => {
  const state = { value: MintQuoteState.ISSUED, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 500 });
    const r = await w.checkMintQuote({ quote: q.quote });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'ISSUED');
    assert.equal(r.paid, true);
    assert.equal(state.mintCalls, 0, 'ISSUED means the mint already issued — never mint again');
  });
});
