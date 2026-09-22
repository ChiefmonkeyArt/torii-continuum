import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeSSE, createRoutstr } from '../core/routstr.mjs';
import { createOllama } from '../core/ollama.mjs';
import { createChatTelemetry, createPreviewFilter } from '../lib/chat-stream.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const encode = text => new TextEncoder().encode(text);
const frame = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const log = { info() {}, warn() {}, error() {} };

test('SSE emits text before completion across byte boundaries, excludes reasoning', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const deltas = [];
  const task = consumeSSE(stream, { onDelta: text => deltas.push(text) });
  const bytes = encode(frame('gm café'));
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(deltas.join(''), 'gm café');
  controller.enqueue(encode('data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n'));
  controller.enqueue(encode('data: {"usage":{"completion_tokens":4}}\n\ndata: [DONE]\n\n'));
  const result = await task;
  assert.equal(result.content, 'gm café');
  assert.equal(result.usage.completion_tokens, 4);
  assert.ok(result.first_token_ms >= 0);
});

for (const [name, text] of [
  ['truncated', frame('partial')],
  ['malformed', 'data: {broken}\n\n'],
  ['upstream error', 'data: {"error":{"message":"secret"}}\n\n'],
]) test(`SSE rejects ${name} instead of completing actions`, async () => {
  await assert.rejects(consumeSSE(new Response(text).body));
});

test('SSE accepts finish_reason at EOF and isolates preview callback errors', async () => {
  const result = await consumeSSE(new Response(frame('ok') +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n').body,
  { onDelta() { throw new Error('UI closed'); } });
  assert.equal(result.content, 'ok');
});

test('SSE bounds bytes and cancels its reader on failure', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(consumeSSE(stream), /limit/);
  assert.equal(cancelled, true);
});

test('preview holds split action fences, releases no JSON, resets on fallback', () => {
  let visible = '';
  const filter = createPreviewFilter(t => { visible += t; });
  for (const part of ['Hello ', '`', '`', '`json\n', '{"action":"add_todo"}', '``` done']) filter.push(part);
  assert.equal(visible, 'Hello ');
  filter.reset(); visible = '';
  filter.push('Fallback reply');
  assert.equal(visible, 'Fallback reply');
});

test('timings are deterministic, aggregate failed attempts and contain no content', async () => {
  let clock = 0;
  const events = [];
  const telemetry = createChatTelemetry(e => events.push(e), () => clock);
  telemetry.attempt('routstr');
  await telemetry.measure('payment', async () => { clock = 10; });
  await assert.rejects(telemetry.measure('provider_wait', async () => { clock = 40; throw new Error('failed'); }));
  telemetry.attempt('ollama');
  clock = 50; telemetry.firstText();
  clock = 70; telemetry.firstText();
  const result = telemetry.snapshot();
  assert.equal(result.payment_ms, 10);
  assert.equal(result.provider_wait_ms, 30);
  assert.equal(result.first_text_ms, 50);
  assert.equal(result.total_ms, 70);
  assert.equal(result.attempts, 2);
  assert.equal(events.filter(e => e.type === 'reset').length, 2);
  assert.ok(!JSON.stringify(result).includes('failed'));
});

test('real Routstr path streams once and preserves one payment/refund', async () => {
  const savedFetch = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'chat-stream-'));
  let sends = 0, refunds = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cfg = { routstr: { endpoint: 'https://example.invalid', providers: [], discovery: { enabled: false }, models: { chat: 'test' }, limits: {} }, logging: { cost_log: join(dir, 'costs.jsonl') } };
  const wallet = {
    async send() { sends++; return { ok: true, token: 'cashuA-test' }; },
    async receive() { refunds++; return { ok: true, added_sats: 2 }; },
  };
  const seen = [];
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(encode(frame('hello')));
        await gate;
        c.enqueue(encode('data: [DONE]\n\n')); c.close();
      },
    }), { headers: { 'X-Cashu-Refund': 'cashuA-refund' } });
    const provider = createRoutstr(cfg, wallet, log, {
      discover: async () => [], fetchCatalog: async () => [],
    });
    const resultPromise = provider.chat({ messages: [{ role: 'user', content: 'gm' }], onDelta: d => seen.push(d) });
    // Wait for the first delta, NOT the completed paid response.
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(seen.join(''), 'hello');
    assert.equal(refunds, 0);
    release();
    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(sends, 1);
    assert.equal(refunds, 1);
    assert.equal(result.sats_spent, 48);
  } finally {
    release(); globalThis.fetch = savedFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Ollama streaming mode delivers content and keeps cost zero', async () => {
  const original = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'ollama-stream-'));
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return new Response(frame('local hello') + 'data: [DONE]\n\n');
    };
    const seen = [];
    const result = await createOllama({ ollama: { enabled: true }, logging: { cost_log: join(dir, 'costs') } }, log)
      .chat({ messages: [{ role: 'user', content: 'gm' }], onDelta: d => seen.push(d) });
    assert.equal(result.ok, true);
    assert.equal(result.sats_spent, 0);
    assert.equal(seen.join(''), 'local hello');
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});

test('trace distinguishes batched upstream text from incremental arrivals', async () => {
  for (const batched of [true, false]) {
    let clock = 0;
    const chunks = batched
      ? [[100, frame('one') + frame('two') + 'data: [DONE]\n\n']]
      : [[100, frame('one')], [350, frame('two')], [400, 'data: [DONE]\n\n']];
    let trace;
    const source = { getReader() { return {
      async read() {
        const item = chunks.shift();
        if (!item) return { done: true };
        clock = item[0];
        return { done: false, value: encode(item[1]) };
      }, async cancel() {}, releaseLock() {},
    }; } };
    await consumeSSE(source, { now: () => clock, started: 0, onTrace: t => { trace = t; } });
    assert.equal(trace.content_events, 2);
    assert.equal(trace.transport_chunks, batched ? 1 : 3);
    assert.equal(trace.first_content_ms, 100);
    assert.equal(trace.content_span_ms, batched ? 0 : 250);
    assert.equal(trace.completed, true);
  }
});

test('telemetry keeps bounded numeric traces and excludes upstream secrets', () => {
  const t = createChatTelemetry();
  t.attempt('routstr');
  for (let i = 0; i < 20; i++) t.upstream({ content_events: 5, token: 'secret', endpoint: 'private', completed: true });
  const result = t.snapshot();
  assert.equal(result.upstream_attempts.length, 16);
  assert.equal(result.upstream_attempts[0].content_events, 5);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('private'));
});
