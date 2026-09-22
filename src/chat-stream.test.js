import { test, expect, afterEach, vi } from 'vitest';
import { readChatEvents, timingLabel } from './chat-stream.js';
import { chat, CHAT_CLIENT_TIMEOUT_MS } from './data/agent.js';

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const response = text => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
const encode = text => new TextEncoder().encode(text);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('browser receives incremental UTF8 before done and returns final validated reply', async () => {
  let controller;
  const events = [];
  const result = readChatEvents(new Response(new ReadableStream({ start(c) { controller = c; } })), e => events.push(e));
  const bytes = encode(frame({ type: 'delta', delta: 'café' }));
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(events[0].delta).toBe('café');
  controller.enqueue(encode(frame({ type: 'done', reply: 'final', timings: { total_ms: 200 } })));
  expect((await result).data.reply).toBe('final');
});

test('EOF and malformed SSE fail closed, never turn partial into success', async () => {
  await expect(readChatEvents(response(frame({ type: 'delta', delta: 'partial' })))).rejects.toThrow('before completion');
  await expect(readChatEvents(response('data: {oops}\n\n'))).rejects.toThrow();
});

test('structured failure preserves payment error and timings', async () => {
  const result = await readChatEvents(response(frame({ type: 'error', error: 'No funds', code: 'insufficient_funds', timings: { total_ms: 2 } })));
  expect(result.ok).toBe(false);
  expect(result.code).toBe('insufficient_funds');
  expect(result.data.timings.total_ms).toBe(2);
});

function environment() {
  const store = new Map([['continuum.session.v1', 'owner-A']]);
  vi.stubGlobal('localStorage', { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) });
  vi.stubGlobal('window', { __CONTINUUM_AGENT_URL__: '/agent' });
  return store;
}

test('chat transport sends one authenticated streaming POST, preserves legacy JSON mode', async () => {
  environment();
  const fetchMock = vi.fn(async (_url, options) => {
    expect(options.headers.Authorization).toBe('Bearer owner-A');
    expect(JSON.parse(options.body).stream).toBe(true);
    return response(frame({ type: 'done', reply: 'hello' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  expect((await chat({ message: 'gm', onEvent() {} })).data.reply).toBe('hello');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('owner change drops subsequent deltas and completion without retry', async () => {
  const store = environment();
  const events = [];
  const fetchMock = vi.fn(async () => response(frame({ type: 'delta', delta: 'a' }) + frame({ type: 'done', reply: 'private' })));
  vi.stubGlobal('fetch', fetchMock);
  const result = await chat({ message: 'gm', onEvent(e) {
    events.push(e); store.set('continuum.session.v1', 'owner-B');
  } });
  expect(events).toHaveLength(1);
  expect(result.ok).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('stream body remains covered by the existing client deadline', async () => {
  environment(); vi.useFakeTimers();
  vi.stubGlobal('fetch', async (_url, options) => new Response(new ReadableStream({
    start(c) { options.signal.addEventListener('abort', () => c.error(new Error('aborted'))); },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const pending = chat({ message: 'gm', onEvent() {} });
  await vi.advanceTimersByTimeAsync(CHAT_CLIENT_TIMEOUT_MS + 1);
  expect((await pending).code).toBe('client_timeout');
});

test('timing summary labels measured first text, total and stage durations', () => {
  expect(timingLabel({ first_text_ms: 1200, total_ms: 3000, payment_ms: 100, attempts: 1 }))
    .toBe('First text 1.2s · Total 3.0s · Payment 0.1s · Attempts 1');
});

test('browser timings include connection wait and distinguish spaced chunks', async () => {
  let clock = 100;
  const chunks = [
    [100, frame({ type: 'phase', phase: 'prepare' })],
    [200, frame({ type: 'delta', delta: 'one' })],
    [700, frame({ type: 'delta', delta: 'two' })],
    [800, frame({ type: 'done', reply: 'onetwo', timings: { total_ms: 700 } })],
  ];
  const source = { body: { getReader() { return {
    async read() {
      const item = chunks.shift();
      if (!item) return { done: true };
      clock = item[0]; return { done: false, value: encode(item[1]) };
    }, async cancel() {}, releaseLock() {},
  }; } } };
  const result = await readChatEvents(source, () => {}, { started: 0, now: () => clock });
  expect(result.data.timings.browser_first_event_ms).toBe(100);
  expect(result.data.timings.browser_first_text_ms).toBe(200);
  expect(result.data.timings.browser_text_span_ms).toBe(500);
  expect(result.data.timings.browser_delta_events).toBe(2);
  expect(result.data.timings.total_ms).toBe(700);
});
