import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutstrPayment } from '../core/routstr-payment.mjs';
import { createRoutstr } from '../core/routstr.mjs';
import { createChatTelemetry } from '../lib/chat-stream.mjs';

const base = 'https://provider.example';
const token = 'cashuATESTPAYMENT';
const key = 'sk-' + createHash('sha256').update(token).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const cfg = { session_secret: 'a'.repeat(64), routstr: { payment_mode: 'ephemeral_bearer' } };

test('config accepts explicit modes and fails closed on misspellings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-mode-'));
  const path = join(dir, 'config.yaml');
  try {
    for (const mode of ['x_cashu', 'ephemeral_bearer', 'typo']) {
      await writeFile(path, JSON.stringify({ session_secret: 'a'.repeat(64),
        server: { host: '127.0.0.1', port: 8787 }, routstr: { payment_mode: mode } }));
      const code = `import {loadConfig} from ${JSON.stringify(new URL('../core/config.mjs', import.meta.url).href)}; loadConfig(process.argv[1]);`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code, path], { encoding: 'utf8' });
      assert.equal(run.status, mode === 'typo' ? 1 : 0, run.stderr);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fixture(options = {}) {
  const records = new Map(), calls = [];
  let sends = 0, receives = 0, rollbacks = 0;
  const store = {
    async put(name, value) { if (options.writeFails) throw new Error('disk'); records.set(name, value); },
    async get(name) { return records.get(name) || null; },
    async remove(name) { records.delete(name); },
    async list() { return [...records.keys()]; },
  };
  const wallet = {
    async send(sats) { sends++; return { ok: true, token, rollback: async () => { rollbacks++; } }; },
    async receive() { receives++; return options.receiveFails ? { ok: false } : { ok: true, added_sats: 9 }; },
  };
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(!url.includes('cashu'));
    if (url.endsWith('/create')) {
      assert.equal(records.size, 1, 'durable recovery before deposit');
      if (options.createThrows) throw new Error('network echo ' + token);
      return options.createResponse?.() || json({ api_key: key, balance: 10000 });
    }
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    return options.refundResponse?.() || json({ token: 'cashuAREFUND' });
  };
  const payment = createRoutstrPayment(cfg, wallet, { store, fetchFn });
  return { payment, records, calls, wallet, store, fetchFn, count: () => ({ sends, receives, rollbacks }) };
}

test('one bounded deposit, bearer refund, no URLs/separate approval/reusable funded key', async () => {
  const f = fixture();
  const handle = await f.payment.begin(base, 10);
  assert.equal(handle.ok, true);
  assert.equal(handle.key, key);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { initial_balance_token: token });
  const settled = await f.payment.finish(handle);
  assert.deepEqual(settled, { pending: false, refunded: 9 });
  assert.equal(f.records.size, 0);
  assert.deepEqual(f.count(), { sends: 1, receives: 1, rollbacks: 0 });
});

test('journal failure rolls back only before provider dispatch', async () => {
  const f = fixture({ writeFails: true });
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.count().rollbacks, 1);
});

test('ambiguous deposit never rolls back or redeposits and keeps recovery', async () => {
  const f = fixture({ createThrows: true, refundResponse: () => json({ detail: 'not yet known' }, 401) });
  const result = await f.payment.begin(base, 10);
  assert.equal(result.code, 'payment_recovery_required');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(f.records.size, 1);
  assert.equal(f.count().rollbacks, 0);
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.count().sends, 1, 'pending recovery blocks more deposits');
});

test('provider must return the deterministic original-token balance identity', async () => {
  const f = fixture({ createResponse: () => json({ api_key: 'sk-other' }) });
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.count().rollbacks, 0);
  assert.equal(f.count().receives, 1);
});

test('refund failure is retained and a restarted adapter can recover it without paying', async () => {
  let unavailable = true;
  const f = fixture({ refundResponse: () => unavailable ? json({}, 503) : json({ token: 'cashuAREFUND' }) });
  const handle = await f.payment.begin(base, 10);
  assert.equal((await f.payment.finish(handle)).pending, true);
  unavailable = false;
  const restarted = createRoutstrPayment(cfg, f.wallet, { store: f.store, fetchFn: f.fetchFn });
  await restarted.recover();
  assert.equal(f.records.size, 0);
  assert.equal(f.count().sends, 1);
});

test('active inference is not refunded by the recovery sweep; settlement is single-flight', async () => {
  const f = fixture();
  const h = await f.payment.begin(base, 10);
  await f.payment.recover();
  assert.equal(f.calls.length, 1);
  await Promise.all([f.payment.finish(h), f.payment.finish(h)]);
  assert.equal(f.count().receives, 1);
});

test('fully spent balance can close, but pending/dust/unknown errors cannot', async () => {
  for (const detail of ['No balance to refund', 'Balance too small to refund', 'Cannot refund key. There are ongoing requests for this api key.']) {
    const f = fixture({ refundResponse: () => json({ detail }, 400) });
    const h = await f.payment.begin(base, 10);
    const result = await f.payment.finish(h);
    assert.equal(result.pending, detail !== 'No balance to refund');
    assert.equal(f.count().receives, 0);
  }
});

test('rejected mint refund remains recoverable and blocks more deposits', async () => {
  const f = fixture({ receiveFails: true });
  const h = await f.payment.begin(base, 10);
  assert.equal((await f.payment.finish(h)).pending, true);
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.count().sends, 1);
});

test('unsafe endpoints and invalid amounts cannot allocate funds', async () => {
  const f = fixture();
  for (const b of ['http://provider.example', 'https://localhost', 'https://user:pass@provider.example', base + '?x=1'])
    assert.equal((await f.payment.begin(b, 10)).ok, false);
  for (const n of [0, -1, Infinity, 1.5]) assert.equal((await f.payment.begin(base, n)).ok, false);
  assert.equal(f.count().sends, 0);
});

test('oversized or redirected deposit responses never trigger a second payment', async () => {
  for (const createResponse of [() => new Response('x'.repeat(128 * 1024 + 1)), () => json({}, 302)]) {
    const f = fixture({ createResponse });
    assert.equal((await f.payment.begin(base, 10)).ok, false);
    assert.equal(f.count().sends, 1);
    assert.equal(f.count().rollbacks, 0);
  }
});

test('pending-record cap prevents another wallet allocation', async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) f.records.set(`rrefund_${String(i).padStart(20, '0')}`, '{}');
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.count().sends, 0);
});

test('corrupt recovery data never becomes a payment target and blocks new funding', async () => {
  const f = fixture();
  f.records.set('rrefund_' + 'a'.repeat(20), JSON.stringify({
    base: 'https://localhost', token, key, sats: 10,
  }));
  await f.payment.recover();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.payment.begin(base, 10)).ok, false);
  assert.equal(f.count().sends, 0);
});

test('timeout cancels deposit and retains uncertain funds without rollback', async () => {
  const f = fixture();
  const payment = createRoutstrPayment(cfg, f.wallet, { store: f.store, timeoutMs: 5,
    fetchFn: async (_url, init) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  assert.equal((await payment.begin(base, 10)).ok, false);
  assert.equal(f.records.size, 1);
  assert.equal(f.count().rollbacks, 0);
});

test('production recovery records are encrypted with restricted permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-recovery-'));
  const f = fixture();
  const payment = createRoutstrPayment(cfg, f.wallet, { dir, fetchFn: async () => json({ api_key: key }) });
  try {
    const h = await payment.begin(base, 10);
    assert.equal(h.ok, true);
    const [name] = await readdir(dir);
    const path = join(dir, name);
    const raw = await readFile(path, 'utf8');
    assert.ok(!raw.includes(token) && !raw.includes(key) && !raw.includes(base));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { payment.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('real chat adapter emits DeepSeek text before EOF/refund with one funded request', async () => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'routstr-bearer-'));
  const saved = globalThis.fetch;
  const telemetry = createChatTelemetry();
  let controller, completionCalls = 0;
  globalThis.fetch = async (url, init) => {
    completionCalls++;
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.headers['X-Cashu'], undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).model, 'deepseek-v3.2');
    return new Response(new ReadableStream({ start(c) { controller = c; } }));
  };
  const router = createRoutstr({ ...cfg, routstr: { ...cfg.routstr, endpoint: base,
    discovery: { enabled: false }, models: { chat: 'deepseek-v3.2' }, limits: { max_sats_per_request: 10 } },
    logging: { cost_log: join(dir, 'costs.jsonl') } }, f.wallet, { info() {}, warn() {} }, {
    fetchCatalog: async () => [], payment: { store: f.store, fetchFn: f.fetchFn },
  });
  try {
    const deltas = [];
    const task = router.chat({ messages: [{ role: 'user', content: 'gm' }], telemetry, onDelta: d => deltas.push(d) });
    while (!controller) await new Promise(r => setTimeout(r, 1));
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Good "}}]}\n\n'));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(deltas.join(''), 'Good ');
    assert.equal(f.count().receives, 0);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"morning"}}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    const result = await task;
    assert.equal(result.content, 'Good morning');
    assert.equal(result.sats_refunded, 9);
    assert.equal(result.refund_pending, false);
    assert.equal(completionCalls, 1);
    assert.equal(f.count().sends, 1);
    assert.equal(telemetry.snapshot().upstream_attempts[0].content_events, 2);
  } finally { globalThis.fetch = saved; await rm(dir, { recursive: true, force: true }); }
});

test('truncated paid stream never triggers a second deposit; pending refund is surfaced', async () => {
  const f = fixture({ refundResponse: () => json({}, 503) });
  const dir = await mkdtemp(join(tmpdir(), 'routstr-bearer-failure-'));
  const saved = globalThis.fetch;
  const telemetry = createChatTelemetry();
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); };
  const router = createRoutstr({ ...cfg, routstr: { ...cfg.routstr,
    discovery: { enabled: false }, models: { chat: 'deepseek-v3.2' }, limits: { max_sats_per_request: 10 } },
    logging: { cost_log: join(dir, 'costs.jsonl') } }, f.wallet, { info() {}, warn() {} }, {
    fetchCatalog: async () => [base, 'https://other.example'].map(baseUrl => ({
      baseUrl, models: [{ id: 'deepseek-v3.2', max_cost_sats: 10 }],
    })), payment: { store: f.store, fetchFn: f.fetchFn },
  });
  try {
    const result = await router.chat({ messages: [{ role: 'user', content: 'gm' }], telemetry });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(requests, 1);
    assert.equal(f.count().sends, 1);
    assert.equal(f.records.size, 1);
    assert.equal(telemetry.snapshot().refund_pending, true);
    assert.ok(!JSON.stringify(result).includes(token));
  } finally { globalThis.fetch = saved; await rm(dir, { recursive: true, force: true }); }
});
