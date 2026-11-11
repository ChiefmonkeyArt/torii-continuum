// docs/adr-routstr-provider-fallback.md — automatic, labelled fallback across
// Routstr providers and models, mint-aware payment, and no failover after the
// owner has seen part of a reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutstr } from '../core/routstr.mjs';
import { fetchProviderMints } from '../core/routstr-discovery.mjs';
import { mintKey, mintsOverlap } from '../lib/mint-url.mjs';
import { loadConfig } from '../core/config.mjs';

const A = 'https://a.example', B = 'https://b.example';
const MINIBITS = 'https://mint.minibits.cash/Bitcoin', COINOS = 'https://mint.coinos.io';
const token = 'cashuATESTPAYMENT';
const key = 'sk-' + createHash('sha256').update(token).digest('hex');
const json = (d, status = 200) => new Response(JSON.stringify(d), { status });
const enc = new TextEncoder();
const sse = (...parts) => new Response(parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n');

function payFixture() {
  const records = new Map();
  const sent = [];
  const store = { put: async (n, v) => records.set(n, v), get: async n => records.get(n) || null,
    remove: async n => records.delete(n), list: async () => [...records.keys()] };
  const wallet = { mints: [MINIBITS, COINOS],
    send: async (sats, opts) => { sent.push(opts?.mints || null); return { ok: true, token, rollback: async () => {} }; },
    receive: async () => ({ ok: true, added_sats: 5 }) };
  const fetchFn = async url => url.endsWith('/create') ? json({ api_key: key }) : json({ token: 'cashuAREFUND' });
  return { records, store, wallet, fetchFn, sent };
}

async function setup({ catalog, provider, chatModel = 'm', ownerModel = null, fallback = { enabled: true, chat: ['f'] }, mode = 'ephemeral_bearer' }) {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-fallback-'));
  const pay = payFixture();
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ base: url.replace('/v1/chat/completions', ''), model: body.model, cashu: init.headers['X-Cashu'] });
    return provider(url, body, init);
  };
  const r = createRoutstr({ session_secret: 'a'.repeat(64), routstr: { payment_mode: mode,
    discovery: { enabled: false }, models: { chat: chatModel }, fallback,
    limits: { max_sats_per_request: 10, timeout_ms: 500, first_byte_ms: 200, idle_ms: 200 } },
    logging: { cost_log: join(dir, 'costs.jsonl') } }, pay.wallet, { info() {}, warn() {} }, {
    fetchCatalog: async () => catalog, getChatModel: () => ownerModel,
    payment: { store: pay.store, fetchFn: pay.fetchFn }, watchdogTickMs: 5, refundRetryMs: 5,
  });
  return { r, pay, calls, done: async () => { globalThis.fetch = saved; await rm(dir, { recursive: true, force: true }); } };
}
const ask = (r, extra = {}) => r.chat({ messages: [{ role: 'user', content: 'gm' }], ...extra });
const prov = (baseUrl, ids, mints = null) => ({ baseUrl, name: baseUrl.slice(8), mints,
  models: ids.map(id => ({ id, max_cost_sats: 10 })) });

test('mint keys normalise and unknown lists never exclude', () => {
  assert.equal(mintKey('https://Mint.Minibits.cash/Bitcoin/'), 'https://mint.minibits.cash/Bitcoin');
  assert.equal(mintKey('ftp://x'), null);
  assert.equal(mintsOverlap([COINOS], [MINIBITS + '/']), false);
  assert.equal(mintsOverlap([COINOS, MINIBITS], [MINIBITS + '/']), true);
  assert.equal(mintsOverlap(null, [MINIBITS]), true);
  assert.equal(mintsOverlap([MINIBITS], null), true);
});

test('provider mints are read from /v1/info, bounded and never throw', async () => {
  const ok = await fetchProviderMints(A, { fetchFn: async () => json({ mints: [MINIBITS, MINIBITS + '/', 'javascript:x', 7] }) });
  assert.deepEqual(ok, [MINIBITS]);
  assert.equal(await fetchProviderMints(A, { fetchFn: async () => json({}, 404) }), null);
  assert.equal(await fetchProviderMints(A, { fetchFn: async () => new Response('x'.repeat(70_000)) }), null);
  assert.equal(await fetchProviderMints(A, { fetchFn: async () => { throw new Error('down'); } }), null);
});

test('a provider that cannot redeem our mints is skipped before any payment; payment uses its mints', async () => {
  const t = await setup({
    catalog: [prov(A, ['m'], ['https://other-mint.example']), prov(B, ['m'], [MINIBITS])],
    provider: () => sse('hi'),
  });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(t.calls.map(c => c.base), [B]);
    assert.deepEqual(t.pay.sent, [[MINIBITS]]);
  } finally { await t.done(); }
});

test('when every provider for the model fails, the ladder model answers and is labelled', async () => {
  const t = await setup({
    catalog: [prov(A, ['m']), prov(B, ['f'])],
    provider: (url, body) => body.model === 'm' ? json({ error: 'busy' }, 503) : sse('from f'),
  });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.content, 'from f');
    assert.deepEqual(res.routstr_fallback, { model: 'f', provider: 'b.example', from_model: 'm', from_provider: 'a.example' });
  } finally { await t.done(); }
});

test('an owner-chosen model nobody serves falls to the ladder, labelled; without a ladder it is a clear error', async () => {
  let t = await setup({ catalog: [prov(A, ['f'])], ownerModel: 'gone', provider: () => sse('ok') });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.model, 'f');
    assert.deepEqual(res.routstr_fallback, { model: 'f', provider: 'a.example', from_model: 'gone', from_provider: null });
  } finally { await t.done(); }
  t = await setup({ catalog: [prov(A, ['f'])], ownerModel: 'gone', fallback: { enabled: false }, provider: () => sse('ok') });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, false);
    assert.match(res.reason, /selected chat model is unavailable/);
    assert.equal(t.calls.length, 0);
  } finally { await t.done(); }
});

test('no failover once the owner has seen part of a reply', async () => {
  const t = await setup({
    catalog: [prov(A, ['m']), prov(B, ['m'])],
    provider: (url, body, init) => url.startsWith(A)
      ? new Response(new ReadableStream({ start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\n`));
          init.signal.addEventListener('abort', () => { try { c.error(new Error('stalled')); } catch {} });
        } }))
      : sse('whole'),
  });
  try {
    const seen = [];
    const res = await ask(t.r, { onDelta: d => seen.push(d) });
    assert.equal(res.ok, false);
    assert.deepEqual(t.calls.map(c => c.base), [A]);
    assert.ok(seen.length >= 1);
  } finally { await t.done(); }
});

test('turn attempts are capped across providers and ladder models', async () => {
  const many = Array.from({ length: 5 }, (_, i) => prov(`https://p${i}.example`, ['m', 'f']));
  const t = await setup({ catalog: many, provider: () => json({ error: 'busy' }, 503) });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, false);
    assert.equal(t.calls.length, 6);
  } finally { await t.done(); }
});

test('config: fallback is on by default with a bounded, validated chat ladder', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'routstr-fallback-cfg-'));
  const base = ['admin_npub: ""', 'session_secret: "' + 'a'.repeat(64) + '"', 'server:', '  host: "127.0.0.1"', '  port: 8787'].join('\n');
  try {
    const path = join(dir, 'config.yaml');
    await writeFile(path, base + '\n');
    const cfg = loadConfig(path);
    assert.equal(cfg.routstr.fallback.enabled, true);
    assert.deepEqual(cfg.routstr.fallback.chat, ['deepseek-v4.1-flash', 'deepseek-v4-flash']);
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, base + '\nroutstr:\n  fallback:\n    chat: ["ok", "no spaces allowed"]\n');
    const script = `import(${JSON.stringify(new URL('../core/config.mjs', import.meta.url).href)}).then(m => m.loadConfig(${JSON.stringify(bad)}))`;
    let code = 0, stderr = '';
    try { execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1);
    assert.match(stderr, /routstr.fallback.chat must be a list/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('x_cashu payments are also limited to the provider\'s mints', async () => {
  const t = await setup({ mode: 'x_cashu', catalog: [prov(B, ['m'], [MINIBITS])], provider: () => sse('hi') });
  try {
    const res = await ask(t.r);
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(t.pay.sent, [[MINIBITS]]);
    assert.equal(t.calls[0].cashu, token);
  } finally { await t.done(); }
});
