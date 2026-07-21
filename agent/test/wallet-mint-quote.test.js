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
  return { info() {}, warn() {}, error() {}, debug() {} };
}

// A logger that records every call so we can assert the [wallet] checkMintQuote
// entry + result trace (v0.2.89-alpha, Item 2). Making it structurally
// impossible for a check to leave zero log trace turns future silent bugs loud.
function captureLog() {
  const calls = { info: [], warn: [], error: [], debug: [] };
  const rec = (k) => (...args) => { calls[k].push(args); };
  return { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug'), calls };
}

async function withCapturedWallet(cfg, deps, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'torii-wallet-'));
  const log = captureLog();
  try {
    const wallet = await createWallet(cfg, log, { walletDir: dir, ...deps });
    return await fn(wallet, log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('checkMintQuote logs an entry + result trace on every invocation (Item 2)', async () => {
  const state = { value: MintQuoteState.UNPAID, mintCalls: 0 };
  await withCapturedWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w, log) => {
    const q = await w.createMintQuote({ amountSats: 1000 });

    const before = log.calls.info.length;
    await w.checkMintQuote({ quote: q.quote, sessionId: 'npubdeadbeefsession' });
    const infoLines = log.calls.info.slice(before);

    // At least the entry + result pair.
    assert.ok(infoLines.length >= 2, `expected >=2 info logs, got ${infoLines.length}`);
    const joined = infoLines.map((a) => a[0]).join('\n');
    assert.match(joined, /\[wallet\] checkMintQuote called/);
    assert.match(joined, /\[wallet\] checkMintQuote result/);
  });
});

test('checkMintQuote never logs a full session npub (last 8 chars only) or full quote id', async () => {
  const state = { value: MintQuoteState.UNPAID, mintCalls: 0 };
  await withCapturedWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w, log) => {
    const q = await w.createMintQuote({ amountSats: 1000 });
    const fullNpub = 'npub1a3umadeupsessionidentifierxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await w.checkMintQuote({ quote: q.quote, sessionId: fullNpub });

    const all = log.calls.info.concat(log.calls.debug).map((a) => a.join(' ')).join('\n');
    // The formatted args are the 2nd..Nth positional args (printf-style), so the
    // captured args array holds the truncated forms — assert the full npub and
    // full quote id never appear anywhere in the captured arguments.
    const flat = log.calls.info.concat(log.calls.debug).flat().map(String).join('\n');
    assert.ok(!flat.includes(fullNpub), 'full npub must never be logged');
    assert.ok(!flat.includes(q.quote) || q.quote.length <= 12, 'full quote id must be truncated in logs');
    // The truncated npub marker is present.
    assert.match(flat, /npub…/);
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
