// docs/adr-routstr-turns-dont-hang.md — a paid turn watches the stream, not one fixed clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutstr, failureExplanation } from '../core/routstr.mjs';
import { createRoutstrPayment } from '../core/routstr-payment.mjs';
import { createProviderHealth, isProviderFault, REST_BASE_MS, REST_MAX_MS } from '../core/provider-health.mjs';

const A = 'https://a.example', B = 'https://b.example';
const token = 'cashuATESTPAYMENT';
const key = 'sk-' + createHash('sha256').update(token).digest('hex');
const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
const cfg = { session_secret: 'a'.repeat(64), routstr: { payment_mode: 'ephemeral_bearer' } };
const enc = new TextEncoder();
const delay = ms => new Promise(r => setTimeout(r, ms));
const chunk = obj => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const text = t => chunk({ choices: [{ delta: { content: t } }] });
const thinking = () => chunk({ choices: [{ delta: { reasoning_content: '…' } }] });

function paymentFixture({ refund = () => json({ token: 'cashuAREFUND' }) } = {}) {
  const records = new Map();
  let sends = 0, refunds = 0;
  const store = { put: async (n, v) => records.set(n, v), get: async n => records.get(n) || null,
    remove: async n => records.delete(n), list: async () => [...records.keys()] };
  const wallet = { send: async () => { sends++; return { ok: true, token, rollback: async () => {} }; },
    receive: async () => ({ ok: true, added_sats: 5 }) };
  const fetchFn = async url => {
    if (url.endsWith('/create')) return json({ api_key: key, balance: 10000 });
    refunds++;
    return refund(refunds);
  };
  return { records, store, wallet, fetchFn, count: () => ({ sends, refunds }) };
}

// A provider whose stream is scripted: a list of [waitMs, bytes] steps; null bytes = hang.
function streamOf(steps, signal) {
  return new ReadableStream({
    async start(c) {
      signal?.addEventListener('abort', () => { try { c.error(signal.reason); } catch {} }, { once: true });
      for (const [wait, bytes] of steps) {
        await delay(wait);
        if (signal?.aborted) return;
        if (bytes === null) return; // hang forever
        c.enqueue(bytes);
      }
      if (!signal?.aborted) { c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); }
    },
  });
}

async function router(limits, { providers = [A], script, health, refund, refundRetryMs = 5 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-turns-'));
  const pay = paymentFixture({ refund });
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    return new Response(streamOf(script(url, calls.length), init.signal));
  };
  const r = createRoutstr({ ...cfg, routstr: { ...cfg.routstr, discovery: { enabled: false },
    models: { chat: 'm' }, limits: { max_sats_per_request: 10, ...limits } },
    logging: { cost_log: join(dir, 'costs.jsonl') } }, pay.wallet, { info() {}, warn() {} }, {
    fetchCatalog: async () => providers.map(baseUrl => ({ baseUrl, models: [{ id: 'm', max_cost_sats: 10 }] })),
    payment: { store: pay.store, fetchFn: pay.fetchFn }, watchdogTickMs: 5, refundRetryMs, health,
  });
  const done = async () => { globalThis.fetch = saved; await rm(dir, { recursive: true, force: true }); };
  return { r, pay, calls, done };
}
const ask = (r, extra = {}) => r.chat({ messages: [{ role: 'user', content: 'gm' }], ...extra });

test('a reply that keeps streaming past timeout_ms finishes inside the turn budget', async () => {
  const t = await router({ timeout_ms: 60, first_byte_ms: 40, idle_ms: 50 },
    { script: () => [[10, text('one ')], [35, text('two ')], [35, text('three ')], [35, text('four')]] });
  try {
    const res = await ask(t.r, { budget_ms: 10_000 + 400 });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.content, 'one two three four');
  } finally { await t.done(); }
});

test('no first event stops at the first-byte limit and says so', async () => {
  const t = await router({ timeout_ms: 500, first_byte_ms: 30, idle_ms: 50 }, { script: () => [[0, null]] });
  try {
    const started = Date.now();
    const res = await ask(t.r);
    assert.equal(res.ok, false);
    assert.equal(res.failure_kind, 'upstream_timeout');
    assert.ok(Date.now() - started < 400, 'stopped near the first-byte limit, not timeout_ms');
    assert.match(res.reason, /did not start replying/);
    assert.equal(t.pay.count().sends, 1, 'never a second payment');
    assert.doesNotMatch(res.reason, /another provider/, 'no other provider to name');
  } finally { await t.done(); }
});

test('a stream that goes quiet stops as stalled', async () => {
  const t = await router({ timeout_ms: 500, first_byte_ms: 100, idle_ms: 30 },
    { script: () => [[5, text('hi')], [0, null]] });
  try {
    const res = await ask(t.r);
    assert.equal(res.failure_kind, 'upstream_stalled');
    assert.match(res.reason, /went quiet/);
  } finally { await t.done(); }
});

test('thinking-only events count as activity', async () => {
  const t = await router({ timeout_ms: 60, first_byte_ms: 40, idle_ms: 30 },
    { script: () => [[10, thinking()], [20, thinking()], [20, thinking()], [20, thinking()], [10, text('answer')]] });
  try {
    const res = await ask(t.r, { budget_ms: 10_000 + 400 });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.content, 'answer');
  } finally { await t.done(); }
});

test('a stopped stream retries the refund once', async () => {
  let n = 0;
  const t = await router({ timeout_ms: 500, first_byte_ms: 20 }, {
    script: () => [[0, null]],
    refund: () => (++n === 1 ? new Response('busy', { status: 503 }) : json({ token: 'cashuAREFUND' })),
  });
  try {
    const res = await ask(t.r);
    assert.equal(res.refund_pending, false);
    assert.equal(t.pay.count().refunds, 2);
    assert.match(res.reason, /refund was returned/);
  } finally { await t.done(); }
});

test('the refund retry happens only once, then stays honest', async () => {
  const t = await router({ timeout_ms: 500, first_byte_ms: 20 }, {
    script: () => [[0, null]], refund: () => new Response('busy', { status: 503 }),
  });
  try {
    const res = await ask(t.r);
    assert.equal(res.refund_pending, true);
    assert.equal(t.pay.count().refunds, 2);
    assert.match(res.reason, /Payment recovery is pending/);
  } finally { await t.done(); }
});

// docs/adr-routstr-provider-fallback.md §2: a silent, settled provider hands
// the same turn to the next one, labelled; the slow one rests.
test('a slow provider rests and the same turn moves to another one, labelled', async () => {
  const health = createProviderHealth();
  const t = await router({ timeout_ms: 500, first_byte_ms: 20 }, {
    providers: [A, B], health,
    script: url => (url.startsWith(A) ? [[0, null]] : [[1, text('from b')]]),
  });
  try {
    const first = await ask(t.r);
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.content, 'from b');
    assert.ok(t.calls.at(-1).startsWith(B));
    assert.equal(first.routstr_fallback.from_provider, 'a.example');
    assert.equal(first.routstr_fallback.provider, 'b.example');
    assert.equal(health.resting(A, 'm'), true);
    const n = t.calls.length;
    const second = await ask(t.r);
    assert.equal(second.ok, true);
    assert.ok(t.calls[n].startsWith(B), 'the resting provider goes last next time');
  } finally { await t.done(); }
});

test('health: rest doubles to a cap, success clears, and resting providers stay usable last', () => {
  let clock = 0;
  const h = createProviderHealth({ now: () => clock });
  const c = (baseUrl) => ({ baseUrl, model: { id: 'm' } });
  h.fail(A, 'm');
  assert.equal(h.resting(A, 'm'), true);
  clock = REST_BASE_MS + 1;
  assert.equal(h.resting(A, 'm'), false);
  h.fail(A, 'm'); clock += 2 * REST_BASE_MS - 2;
  assert.equal(h.resting(A, 'm'), true, 'second strike rests twice as long');
  for (let i = 0; i < 10; i++) h.fail(A, 'm');
  clock += REST_MAX_MS + 1;
  assert.equal(h.resting(A, 'm'), false, 'never more than the cap');
  h.fail(A, 'm');
  assert.deepEqual(h.order([c(A), c(B)]).map(x => x.baseUrl), [B, A]);
  assert.deepEqual(h.order([c(A)]).map(x => x.baseUrl), [A], 'the only provider is still used');
  h.ok(A, 'm');
  assert.equal(h.resting(A, 'm'), false);
  assert.equal(h.size(), 0);
  assert.equal(isProviderFault('upstream_stalled'), true);
  assert.equal(isProviderFault('upstream_4xx'), false);
});

test('begin settles a pending claim then pays; an unresolved claim still blocks', async () => {
  const ok = paymentFixture();
  const p = createRoutstrPayment(cfg, ok.wallet, { store: ok.store, fetchFn: ok.fetchFn });
  const h1 = await p.begin(A, 3);
  assert.equal(h1.ok, true);
  // Simulate a restart: the old claim is no longer active in this process.
  const p2 = createRoutstrPayment(cfg, ok.wallet, { store: ok.store, fetchFn: ok.fetchFn });
  const h2 = await p2.begin(A, 3);
  assert.equal(h2.ok, true);
  assert.equal(ok.count().sends, 2);
  await p2.finish(h2);

  const stuck = paymentFixture({ refund: () => new Response('busy', { status: 503 }) });
  const q = createRoutstrPayment(cfg, stuck.wallet, { store: stuck.store, fetchFn: stuck.fetchFn });
  await q.begin(A, 3);
  const q2 = createRoutstrPayment(cfg, stuck.wallet, { store: stuck.store, fetchFn: stuck.fetchFn });
  const blocked = await q2.begin(A, 3);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'payment_recovery_required');
  assert.equal(stuck.count().sends, 1, 'no new payment while a claim is unresolved');
});

test('errors name the phase', () => {
  assert.match(failureExplanation('upstream_timeout', { firstByteMs: 30000 }), /30 s/);
  assert.notEqual(failureExplanation('upstream_stalled'), failureExplanation('upstream_too_long'));
});
