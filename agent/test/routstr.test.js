/**
 * Routstr per-request Cashu payment path (v0.2.74-alpha).
 *
 * Covers the live-chat bug fix: the client must pay each completion with a
 * Cashu token in the `X-Cashu` request header (NOT Authorization — that yielded
 * http 401 "API key or Cashu token required"), and must reclaim the change the
 * provider returns in the `X-Cashu-Refund` response header back into the wallet.
 *
 * HTTP is faked by stubbing globalThis.fetch (the client uses the global). The
 * wallet is a light stub for the client-side tests; the spend-produces-token
 * test drives the REAL core/wallet.mjs send() offline via injected seams
 * (walletFactory + walletDir) so no mint or network is touched.
 *
 * No real proofs, secrets, or tokens — all fixtures use dummy material.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createRoutstr } from '../core/routstr.mjs';
import { createWallet } from '../core/wallet.mjs';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

// Minimal OpenAI-shaped completion response with optional headers.
function completion(content, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Map(Object.entries(headers)),
    async text() {
      return JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 7 } });
    },
  };
}

async function baseCfg() {
  // Route the cost log to a throwaway file so tests don't append to the real
  // agent memory dir. appendCostLog resolves absolute paths as-is.
  const dir = await mkdtemp(join(tmpdir(), 'routstr-cost-'));
  return {
    routstr: {
      endpoint: 'https://api.routstr.com',
      models: { chat: 'deepseek-chat-v3' },
      limits: { max_sats_per_request: 50 },
    },
    logging: { cost_log: join(dir, 'costs.jsonl') },
  };
}

function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  return (async () => {
    try { return await fn(); } finally { globalThis.fetch = orig; }
  })();
}

test('chat attaches the Cashu token in the X-Cashu header (not Authorization)', async () => {
  const cfg = await baseCfg();
  const wallet = {
    async send() { return { ok: true, token: 'cashuSENDTOKEN', mint: 'm', sats: 50, rollback: async () => {} }; },
    async receive() { throw new Error('no refund expected'); },
  };
  let seen;
  await withFetch(async (url, opts) => { seen = { url, headers: opts.headers }; return completion('hi'); }, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    const r = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'hi');
  });
  assert.equal(seen.url, 'https://api.routstr.com/v1/chat/completions');
  assert.equal(seen.headers['X-Cashu'], 'cashuSENDTOKEN');
  assert.ok(!('Authorization' in seen.headers), 'must not send an Authorization header');
});

test('chat reclaims the X-Cashu-Refund change back into the wallet', async () => {
  const cfg = await baseCfg();
  const received = [];
  const wallet = {
    async send() { return { ok: true, token: 'cashuSEND', mint: 'm', sats: 50, rollback: async () => {} }; },
    async receive(token) { received.push(token); return { ok: true, added_sats: 30, mint: 'm' }; },
  };
  let result;
  await withFetch(async () => completion('ok', { 'X-Cashu-Refund': 'cashuREFUND' }), async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, ['cashuREFUND'], 'refund token must be received back into the wallet');
  assert.equal(result.sats_refunded, 30);
  assert.equal(result.sats_spent, 20, 'net spend = allocated 50 - reclaimed 30');
});

test('chat without a refund header spends the full allocation and never calls receive', async () => {
  const cfg = await baseCfg();
  let receiveCalled = false;
  const wallet = {
    async send() { return { ok: true, token: 'cashuSEND', mint: 'm', sats: 50, rollback: async () => {} }; },
    async receive() { receiveCalled = true; return { ok: true, added_sats: 0 }; },
  };
  let result;
  await withFetch(async () => completion('ok'), async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(result.ok, true);
  assert.equal(receiveCalled, false);
  assert.equal(result.sats_spent, 50);
  assert.equal(result.sats_refunded, 0);
});

test('a refund reclaim failure does not fail an otherwise-successful completion', async () => {
  const cfg = await baseCfg();
  const wallet = {
    async send() { return { ok: true, token: 'cashuSEND', mint: 'm', sats: 50, rollback: async () => {} }; },
    async receive() { return { ok: false, reason: 'mint refused token' }; },
  };
  let result;
  await withFetch(async () => completion('ok', { 'X-Cashu-Refund': 'cashuBAD' }), async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(result.ok, true);
  assert.equal(result.sats_spent, 50, 'no reclaim → whole allocation counts as spent');
});

test('below hard_floor: wallet.send error surfaces with the insufficient-funds shape and no HTTP call', async () => {
  const cfg = await baseCfg();
  const wallet = {
    // Mirror core/wallet.mjs send() insufficient-balance reason verbatim so the
    // frontend isInsufficientFundsReply classifier keeps firing (PR #81).
    async send() { return { ok: false, reason: 'insufficient balance across all mints for 50 sats (need +100 floor)' }; },
    async receive() { throw new Error('unreachable'); },
  };
  let fetchCalled = false;
  let result;
  await withFetch(async () => { fetchCalled = true; return completion('nope'); }, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(result.ok, false);
  assert.equal(fetchCalled, false, 'must not hit the network when the wallet cannot pay');
  assert.match(result.reason, /wallet: insufficient balance/);
  assert.match(result.reason, /need \+100 floor/);
});

// ── wallet.send() spend-produces-token, offline via injected seams ──

const MINT = 'https://mint.example.test';
function dummyProof(amount) {
  return { id: '009a1f293253e41e', amount, secret: `s${amount}-${Math.random()}`, C: '02' + 'ab'.repeat(32) };
}

// A cashu-ts-shaped fake Wallet: loadMint() is a no-op; send(amount, proofs)
// splits proofs into a single kept remainder proof and a single sent proof of
// `amount`, matching the { keep, send } contract core/wallet.mjs relies on.
function fakeWalletFactory() {
  return () => ({
    async loadMint() {},
    async send(amount, proofs) {
      const total = proofs.reduce((s, p) => s + (p.amount || 0), 0);
      return { keep: [dummyProof(total - amount)], send: [dummyProof(amount)] };
    },
  });
}

async function seededWallet(cfg) {
  const walletDir = await mkdtemp(join(tmpdir(), 'wallet-'));
  return { walletDir, wallet: await createWallet(cfg, silentLog(), { walletDir, walletFactory: fakeWalletFactory() }) };
}

test('wallet.send produces a decodable Cashu token of the requested amount and persists change', async () => {
  const cfg = { cashu: { mints: [MINT], hard_floor_sats: 100 } };
  const { walletDir, wallet } = await seededWallet(cfg);
  // Seed 200 sats so a 50-sat spend stays above the 100-sat floor.
  await mkdir(walletDir, { recursive: true });
  await writeFile(join(walletDir, 'mint-example-test.json'), JSON.stringify({ mint: MINT, proofs: [dummyProof(200)] }));

  const r = await wallet.send(50);
  assert.equal(r.ok, true);
  assert.equal(r.mint, MINT);

  const decoded = getDecodedToken(r.token);
  assert.equal(decoded.mint, MINT);
  const tokenValue = decoded.proofs.reduce((s, p) => s + (p.amount || 0), 0);
  assert.equal(tokenValue, 50, 'the produced token must be worth exactly the requested sats');

  // Change (the "keep" proofs) is persisted as the new wallet state.
  const persisted = JSON.parse(await readFile(join(walletDir, 'mint-example-test.json'), 'utf8'));
  const kept = persisted.proofs.reduce((s, p) => s + (p.amount || 0), 0);
  assert.equal(kept, 150);
});

test('wallet.send refuses a spend that would drop the balance below hard_floor', async () => {
  const cfg = { cashu: { mints: [MINT], hard_floor_sats: 100 } };
  const { walletDir, wallet } = await seededWallet(cfg);
  await mkdir(walletDir, { recursive: true });
  // 200 sats total; spending 150 would leave 50, below the 100-sat floor.
  await writeFile(join(walletDir, 'mint-example-test.json'), JSON.stringify({ mint: MINT, proofs: [dummyProof(200)] }));

  const r = await wallet.send(150);
  assert.equal(r.ok, false);
  assert.match(r.reason, /insufficient balance/);
});
