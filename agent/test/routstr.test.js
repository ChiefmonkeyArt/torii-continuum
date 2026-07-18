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
import { getEncodedToken, getDecodedToken, CheckStateEnum } from '@cashu/cashu-ts';
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
      models: { chat: 'deepseek-chat' },
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

// A non-2xx / non-JSON response double (Cloudflare 520, upstream 5xx, etc.).
function httpResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    async text() { return body; },
  };
}

// Route a fake fetch by path: the completions call vs the refund-reclaim POST.
function routedFetch({ onCompletion, onRefund }) {
  return async (url, opts) => {
    if (String(url).endsWith('/v1/wallet/refund')) {
      return (onRefund || (() => httpResponse(404, '')))(url, opts);
    }
    return onCompletion(url, opts);
  };
}

// ── post-dispatch rollback / recovery semantics (v0.2.76-alpha) ──

test('a 520 after dispatch never rolls back and the next send uses fresh proofs', async () => {
  const cfg = await baseCfg();
  const tokens = ['cashuTOK1', 'cashuTOK2'];
  let rollbackCalls = 0;
  const seenPaymentTokens = [];
  const wallet = {
    async send() {
      return {
        ok: true, token: tokens.shift(), mint: 'm', sats: 50,
        rollback: async () => { rollbackCalls++; },
        markSpent: async () => {},
      };
    },
    async receive() { return { ok: true, added_sats: 0 }; },
  };
  const fake = routedFetch({
    onCompletion: async (_url, opts) => {
      seenPaymentTokens.push(opts.headers['X-Cashu']);
      // Cloudflare 520 with an HTML (non-JSON) body — the lost-refund scenario.
      return httpResponse(520, '<html>520 upstream</html>');
    },
  });
  await withFetch(fake, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    const first = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
    const second = await routstr.chat({ messages: [{ role: 'user', content: 'yo again' }] });
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
  });
  assert.equal(rollbackCalls, 0, 'must NEVER roll back a token after it was handed to fetch()');
  assert.deepEqual(
    seenPaymentTokens, ['cashuTOK1', 'cashuTOK2'],
    'each request must use a fresh payment token — never reuse the spent one',
  );
});

test('token_already_spent quarantines the exact stale proofs and retries once with fresh', async () => {
  const cfg = await baseCfg();
  const tokens = ['cashuSTALE', 'cashuFRESH'];
  let markSpentCalls = 0;
  const seen = [];
  const wallet = {
    async send() {
      return {
        ok: true, token: tokens.shift(), mint: 'm', sats: 50,
        rollback: async () => { throw new Error('rollback must not run after dispatch'); },
        markSpent: async () => { markSpentCalls++; },
      };
    },
    async receive() { return { ok: true, added_sats: 0 }; },
  };
  const fake = routedFetch({
    onCompletion: async (_url, opts) => {
      const tok = opts.headers['X-Cashu'];
      seen.push(tok);
      if (tok === 'cashuSTALE') {
        return httpResponse(400, JSON.stringify({
          error: { message: 'Cashu token already spent', type: 'token_already_spent', code: 'cashu_token_already_spent' },
        }));
      }
      return completion('recovered');
    },
  });
  let result;
  await withFetch(fake, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(markSpentCalls, 1, 'the stale proofs must be quarantined exactly once');
  assert.deepEqual(seen, ['cashuSTALE', 'cashuFRESH'], 'the retry must use fresh proofs');
  assert.equal(result.ok, true);
  assert.equal(result.content, 'recovered');
});

test('token_already_spent with no fresh proofs left surfaces the insufficient-funds result', async () => {
  const cfg = await baseCfg();
  let call = 0;
  const wallet = {
    async send() {
      call++;
      if (call === 1) return { ok: true, token: 'cashuSTALE', mint: 'm', sats: 50, rollback: async () => {}, markSpent: async () => {} };
      return { ok: false, reason: 'insufficient balance across all mints for 50 sats (need +100 floor)' };
    },
    async receive() { return { ok: true }; },
  };
  const fake = routedFetch({
    onCompletion: async () => httpResponse(400, JSON.stringify({ error: { code: 'cashu_token_already_spent' } })),
  });
  let result;
  await withFetch(fake, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    result = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /insufficient balance/, 'frontend Top-Up detection relies on this reason string');
});

test('a lost refund header triggers a refund reclaim POST and claims it via wallet.receive', async () => {
  const cfg = await baseCfg();
  const received = [];
  let rollbackCalls = 0;
  const wallet = {
    async send() {
      return {
        ok: true, token: 'cashuPAID', mint: 'm', sats: 50,
        rollback: async () => { rollbackCalls++; },
        markSpent: async () => {},
      };
    },
    async receive(token) { received.push(token); return { ok: true, added_sats: 42, mint: 'm' }; },
  };
  let refundReqToken = null;
  const fake = routedFetch({
    // Simulate the upstream drop that loses X-Cashu-Refund.
    onCompletion: async () => httpResponse(520, 'upstream error'),
    onRefund: async (_url, opts) => {
      refundReqToken = opts.headers['X-Cashu'];
      return httpResponse(200, JSON.stringify({ token: 'cashuREFUND' }));
    },
  });
  await withFetch(fake, async () => {
    const routstr = createRoutstr(cfg, wallet, silentLog());
    await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  });
  assert.equal(refundReqToken, 'cashuPAID', 'refund reclaim must send the ORIGINAL payment token');
  assert.deepEqual(received, ['cashuREFUND'], 'the refunded token must be claimed through wallet.receive');
  assert.equal(rollbackCalls, 0, 'refund reclaim must never roll the original token back into spendable balance');
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

// ── wallet recovery: spent-proof sweep + mint-swap on receive (v0.2.76-alpha) ──

// A fake Wallet that can report specific proofs as SPENT via NUT-07, so we can
// exercise the pre-send recovery sweep offline.
function factoryWithStates(spentSecrets) {
  return () => ({
    async loadMint() {},
    async checkProofsStates(proofs) {
      return proofs.map((p) => ({ state: spentSecrets.has(p.secret) ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT }));
    },
    async send(amount, proofs) {
      const total = proofs.reduce((s, p) => s + (p.amount || 0), 0);
      return { keep: [dummyProof(total - amount)], send: [dummyProof(amount)] };
    },
  });
}

test('wallet.send sweeps mint-confirmed spent proofs out of storage before selecting', async () => {
  const cfg = { cashu: { mints: [MINT], hard_floor_sats: 0 } };
  const walletDir = await mkdtemp(join(tmpdir(), 'wallet-'));
  const spentSecret = 'spent-secret-999';
  const good = { id: '009a1f293253e41e', amount: 100, secret: 'good-secret-123', C: '02' + 'ab'.repeat(32) };
  const spent = { id: '009a1f293253e41e', amount: 100, secret: spentSecret, C: '02' + 'cd'.repeat(32) };
  await mkdir(walletDir, { recursive: true });
  // Simulate the polluted live wallet: a spent proof left behind by an old
  // lost-refund rollback still sits in storage alongside a good one.
  await writeFile(join(walletDir, 'mint-example-test.json'), JSON.stringify({ mint: MINT, proofs: [good, spent] }));

  const wallet = await createWallet(cfg, silentLog(), { walletDir, walletFactory: factoryWithStates(new Set([spentSecret])) });
  const r = await wallet.send(50);
  assert.equal(r.ok, true, 'send must succeed using only the unspent proof');

  const persisted = JSON.parse(await readFile(join(walletDir, 'mint-example-test.json'), 'utf8'));
  assert.ok(!persisted.proofs.some((p) => p.secret === spentSecret), 'the spent proof must be quarantined out of storage');
});

test('wallet.receive stores the mint-swapped proofs, not the token decoded proofs', async () => {
  const cfg = { cashu: { mints: [MINT] } };
  const walletDir = await mkdtemp(join(tmpdir(), 'wallet-'));
  const swapped = { id: '009a1f293253e41e', amount: 7, secret: 'fresh-from-mint', C: '02' + 'ef'.repeat(32) };
  const factory = () => ({
    async loadMint() {},
    // A real mint swap: returns brand-new proofs unrelated to the token input.
    async receive() { return [swapped]; },
  });
  const wallet = await createWallet(cfg, silentLog(), { walletDir, walletFactory: factory });

  // The token carries a DIFFERENT (foreign) proof. If receive trusted decoded
  // proofs verbatim we'd store that; instead we must store the swap output.
  const token = getEncodedToken({ mint: MINT, proofs: [{ id: '009a1f293253e41e', amount: 7, secret: 'foreign-untrusted', C: '02' + 'ab'.repeat(32) }] });
  const r = await wallet.receive(token);
  assert.equal(r.ok, true);

  const persisted = JSON.parse(await readFile(join(walletDir, 'mint-example-test.json'), 'utf8'));
  assert.equal(persisted.proofs.length, 1);
  assert.equal(persisted.proofs[0].secret, 'fresh-from-mint', 'must persist the mint-swapped proofs');
  assert.ok(!persisted.proofs.some((p) => p.secret === 'foreign-untrusted'), 'must never trust the token decoded proofs verbatim');
});
