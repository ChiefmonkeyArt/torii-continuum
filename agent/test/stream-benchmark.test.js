import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmark, boundedWallet, selectPlan, observeReasoning, needsAlternative, claimRun } from '../ops/benchmark-streaming.mjs';
const model = id => ({ id, max_cost_sats: 10, pricing_sats: { request: 0, prompt: 0.000001, completion: 0.00001 } });
const catalog = ['https://a.example', 'https://b.example'].map(baseUrl => ({
  baseUrl, models: [model('deepseek-v3.2'), model('llama-3.1-8b-instruct')],
}));

test('a workflow run is claimed durably once with private permissions and no path traversal', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'benchmark-claim-'));
  const dir = join(parent, 'private');
  try {
    await assert.rejects(claimRun(dir, '../bad'));
    await claimRun(dir, '123');
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, '123.started'))).mode & 0o777, 0o600);
    await assert.rejects(claimRun(dir, '123'), { code: 'EEXIST' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('plan includes at most two DeepSeek providers and one cheap alternative, rejecting unsafe/unpriced/expensive offers', () => {
  const result = selectPlan([...catalog, { baseUrl: 'http://localhost', models: [model('deepseek-v3.2')] },
    { baseUrl: 'https://unknown.example', models: [{ id: 'deepseek-v3.2' }] },
    { baseUrl: 'https://expensive.example', models: [{ ...model('deepseek-v3.2'), pricing_sats: { request: 10, prompt: 0, completion: 0 } }] }], 2048, 2);
  assert.equal(result.deepseek.length, 2);
  assert.equal(result.alternative.length, 1);
  assert.deepEqual(result.deepseek.map(c => c.base), ['https://a.example', 'https://b.example']);
});

test('wallet wrapper limits attempts, individual amounts and aggregate allocation even if send throws', async () => {
  let calls = 0;
  const wallet = boundedWallet({ send: async () => { calls++; return { ok: true }; } }, 2);
  for (const amount of [0, 3, -1, 1.5, Infinity]) assert.equal((await wallet.send(amount)).ok, false);
  for (let i = 0; i < 6; i++) assert.equal((await wallet.send(2)).ok, true);
  assert.equal((await wallet.send(1)).ok, false);
  assert.equal(calls, 6);
  assert.equal(wallet.stats().allocation_budget_reserved_sats, 12);
  assert.equal(wallet.stats().funded_sats, 12);
  const broken = boundedWallet({ send: async () => { throw new Error('unknown'); } }, 1);
  await assert.rejects(broken.send(1));
  assert.deepEqual(broken.stats(), { allocation_attempts: 1, allocation_budget_reserved_sats: 1, funded_sats: 0 });
});

test('reasoning observer passes every byte unchanged and stores only counts and times', async () => {
  const text = 'data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_REASONING"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  const row = { reasoning_events: 0, first_reasoning_ms: null };
  const response = observeReasoning(new Response(new ReadableStream({
    pull(c) { index < bytes.length ? c.enqueue(bytes.slice(index, ++index)) : c.close(); },
  })), row, 100, () => 150);
  assert.equal(await response.text(), text);
  assert.equal(row.reasoning_events, 1);
  assert.equal(row.first_reasoning_ms, 50);
  assert.ok(!JSON.stringify(row).includes('PRIVATE_REASONING'));
});

test('no alternative is needed when a tested DeepSeek provider delivers promptly and progressively', () => {
  assert.equal(needsAlternative([{ ok: true, first_text_ms: 1500, text_span_ms: 1000 }]), false);
  assert.equal(needsAlternative([{ ok: true, first_text_ms: 20000, text_span_ms: 0 }]), true);
});

const cfg = { routstr: { payment_mode: 'ephemeral_bearer', endpoint: 'https://a.example',
  models: { chat: 'deepseek-v3.2' }, limits: { max_sats_per_request: 50, max_tokens_out: 2048, timeout_ms: 45000 } } };
function seams(fail = false) {
  let sends = 0, requests = 0;
  return {
    count: () => ({ sends, requests }),
    wallet: { balance: async () => ({ total: 100 }), send: async () => { sends++; return { ok: true }; } },
    recover: async () => {}, discover: async () => [], catalog: async () => catalog,
    router: (_cfg, wallet) => ({
      async chat() {
        requests++;
        await wallet.send(1);
        return { ok: !fail, code: fail ? 'payment_recovery_required' : null, content: 'synthetic response',
          model: _cfg.routstr.models.chat, sats_spent: 1, refund_pending: fail };
      },
    }),
  };
}
test('benchmark runs bounded sequential trials, preserves configuration and never saves responses', async () => {
  const copy = JSON.stringify(cfg), deps = seams();
  const result = await benchmark(cfg, deps);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(deps.count(), { sends: 6, requests: 6 });
  assert.equal(JSON.stringify(cfg), copy);
  assert.ok(!JSON.stringify(result).includes('synthetic response'));
  assert.equal(result.rows[0].model, 'deepseek-v3.2');
  assert.equal(result.rows[4].model, 'llama-3.1-8b-instruct');
});
test('first failure halts all subsequent tests rather than risking repeat payments', async () => {
  const deps = seams(true);
  const result = await benchmark(cfg, deps);
  assert.equal(result.halted, true);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(deps.count(), { sends: 1, requests: 1 });
});
test('fast control runs only the cheap alternative twice and never mutates the saved DeepSeek config', async () => {
  const copy = JSON.stringify(cfg), deps = { ...seams(), target: 'fast_control' };
  const result = await benchmark(cfg, deps);
  assert.equal(result.benchmark_target, 'fast_control');
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.model === 'llama-3.1-8b-instruct'));
  assert.deepEqual(deps.count(), { sends: 2, requests: 2 });
  assert.equal(JSON.stringify(cfg), copy);
});
test('unknown benchmark targets fail before allocating funds', async () => {
  const deps = { ...seams(), target: 'anything' };
  await assert.rejects(benchmark(cfg, deps), /invalid_target/);
  assert.deepEqual(deps.count(), { sends: 0, requests: 0 });
});
test('workflow makes benchmark opt-in, stops the daemon for wallet isolation and restores it on exit', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-continuum-vps.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: inputs\.benchmark == true/);
  assert.match(workflow, /benchmark_target/);
  assert.match(workflow, /trap 'systemctl start continuum-agent\.service' EXIT/);
  assert.match(workflow, /systemctl stop continuum-agent\.service/);
  assert.match(workflow, /runuser -u continuum/);
  assert.match(workflow, /timeout --signal=TERM --kill-after=10s 360s/);
});
