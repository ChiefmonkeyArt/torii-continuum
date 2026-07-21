/**
 * Pending top-up recovery — list endpoint (v0.2.89-alpha, Item 3).
 *
 * listPendingQuotes returns every on-disk quote marker with minted:false that
 * belongs to the CALLER's session, and nothing else. It never leaks another
 * session's quotes. Uses the same offline fake-mint + temp-walletDir seams as
 * wallet-mint-quote.test.js.
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

// A fake mint whose quote id is derived per-call so multiple quotes coexist.
function fakeMintFactory(state = { value: MintQuoteState.UNPAID, mintCalls: 0 }) {
  let n = 0;
  return () => ({
    async loadMint() {},
    async createMintQuoteBolt11(amount) {
      n += 1;
      return {
        quote: `quote-${n}-${amount}`,
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

test('listPendingQuotes returns [] when no quotes exist yet', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    const r = await w.listPendingQuotes({ sessionId: 'npub-alice' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.quotes, []);
  });
});

test('listPendingQuotes returns the caller\'s unminted quotes with the expected fields', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    await w.createMintQuote({ amountSats: 369, sessionId: 'npub-alice' });
    await w.createMintQuote({ amountSats: 1000, sessionId: 'npub-alice' });

    const r = await w.listPendingQuotes({ sessionId: 'npub-alice' });
    assert.equal(r.ok, true);
    assert.equal(r.quotes.length, 2);
    const q = r.quotes[0];
    for (const f of ['quote', 'mint', 'amount_sats', 'created_at', 'age_seconds']) {
      assert.ok(Object.prototype.hasOwnProperty.call(q, f), `missing field ${f}`);
    }
    assert.equal(q.mint, 'https://mint.example');
    assert.ok(Number.isFinite(q.age_seconds) && q.age_seconds >= 0);
  });
});

test('listPendingQuotes never returns another session\'s quotes', async () => {
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory() }, async (w) => {
    await w.createMintQuote({ amountSats: 369, sessionId: 'npub-alice' });
    await w.createMintQuote({ amountSats: 500, sessionId: 'npub-bob' });

    const alice = await w.listPendingQuotes({ sessionId: 'npub-alice' });
    const bob = await w.listPendingQuotes({ sessionId: 'npub-bob' });
    assert.equal(alice.quotes.length, 1);
    assert.equal(alice.quotes[0].amount_sats, 369);
    assert.equal(bob.quotes.length, 1);
    assert.equal(bob.quotes[0].amount_sats, 500);
  });
});

test('a minted quote drops out of the pending list', async () => {
  const state = { value: MintQuoteState.PAID, mintCalls: 0 };
  await withTempWallet(oneMintCfg, { walletFactory: fakeMintFactory(state) }, async (w) => {
    const q = await w.createMintQuote({ amountSats: 2100, sessionId: 'npub-alice' });
    let list = await w.listPendingQuotes({ sessionId: 'npub-alice' });
    assert.equal(list.quotes.length, 1);

    await w.checkMintQuote({ quote: q.quote, sessionId: 'npub-alice' }); // mints it
    list = await w.listPendingQuotes({ sessionId: 'npub-alice' });
    assert.equal(list.quotes.length, 0, 'a minted quote is no longer pending');
  });
});
