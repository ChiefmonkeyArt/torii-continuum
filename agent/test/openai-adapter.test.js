/**
 * HERMES-OWNER-1 — OpenAI-compatible /v1 adapter (agent-side).
 *
 * Contract locked here:
 *   • Fail-closed: no local_token → /v1/* returns 503, without touching router.
 *   • Bearer required: missing/wrong → 401, without touching router.
 *   • Bearer valid: /v1/models returns the advertised catalog.
 *   • Bearer valid: /v1/chat/completions non-stream delegates to router.chat()
 *     and returns an OpenAI ChatCompletion envelope carrying the reply,
 *     Continuum's x_continuum provenance, and finish_reason=stop.
 *   • Bearer valid: /v1/chat/completions stream=true emits ONE content chunk
 *     followed by an empty stop chunk and `data: [DONE]`.
 *   • Router failure with code=insufficient_funds → HTTP 402; other structured
 *     failures → 502; malformed request → 400 (no router call).
 *   • Unknown model id → 404 with type=invalid_request_error.
 *   • Token compare is length-safe (no early-exit leak).
 *
 * The router is stubbed so these tests are pure — no Cashu wallet, no Ollama,
 * no Nostr — and run with `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import {
  registerOpenAIAdapter,
  extractBearer,
  normaliseMessages,
  resolveModel,
  toChatCompletion,
  toOpenAIError,
  chatCompletionChunk,
  _internals,
} from '../core/openai-adapter.mjs';

const TOKEN = 'x'.repeat(64); // matches a 32-byte hex secret
const WRONG = 'y'.repeat(64);

/**
 * Build an app with a stub router. `nextResult` is what router.chat() returns;
 * `nextThrow`, if set, is thrown by router.chat() instead.
 */
async function buildApp({ token = TOKEN, nextResult = null, nextThrow = null } = {}) {
  const app = Fastify({ logger: false });
  const calls = [];
  const router = {
    async chat(args) {
      calls.push(args);
      if (nextThrow) throw nextThrow;
      return nextResult ?? { ok: true, content: 'hello world', model: 'deepseek-v3.2', provider: 'routstr', sats_spent: 3, duration_ms: 120 };
    },
  };
  const cfg = { openai_adapter: { local_token: token } };
  const log = { info() {}, warn() {}, error() {} };
  registerOpenAIAdapter({ app, cfg, router, log });
  await app.ready();
  return { app, router, calls };
}

// ─── pure helpers ────────────────────────────────────────────────────────

test('extractBearer parses Authorization: Bearer <token> case-insensitively', () => {
  assert.equal(extractBearer('Bearer abc123'), 'abc123');
  assert.equal(extractBearer('bearer abc123'), 'abc123');
  assert.equal(extractBearer('BEARER   abc123  '), 'abc123');
  assert.equal(extractBearer(''), null);
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer('Basic abc123'), null);
  assert.equal(extractBearer('abc123'), null);
});

test('tokensEqual is length-safe', () => {
  const { tokensEqual } = _internals;
  assert.equal(tokensEqual('abc', 'abc'), true);
  assert.equal(tokensEqual('abc', 'abd'), false);
  // Different lengths must return false BEFORE any character compare so a
  // length-side-channel can't leak the token length.
  assert.equal(tokensEqual('abc', 'abcd'), false);
  assert.equal(tokensEqual('', ''), true);
  assert.equal(tokensEqual(null, 'abc'), false);
  assert.equal(tokensEqual('abc', null), false);
});

test('normaliseMessages rejects non-object body / bad shape', () => {
  assert.ok(normaliseMessages(null).error);
  assert.ok(normaliseMessages('str').error);
  assert.ok(normaliseMessages({}).error);
  assert.ok(normaliseMessages({ messages: [] }).error);
  assert.ok(normaliseMessages({ messages: [{ role: 'nope', content: 'x' }] }).error);
  assert.ok(normaliseMessages({ messages: [{ role: 'user', content: '' }] }).error);
  assert.ok(normaliseMessages({ messages: [{ role: 'user', content: 'x'.repeat(32001) }] }).error);
});

test('normaliseMessages accepts valid system/user/assistant chain', () => {
  const out = normaliseMessages({
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
    ],
  });
  assert.equal(out.error, undefined);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[1].role, 'user');
});

test('resolveModel accepts chat / chat-local, defaults to chat, rejects unknown', () => {
  assert.equal(resolveModel(undefined).requested, 'chat');
  assert.equal(resolveModel('').requested, 'chat');
  assert.equal(resolveModel('chat').requested, 'chat');
  assert.equal(resolveModel('chat-local').requested, 'chat-local');
  const bad = resolveModel('gpt-5');
  assert.equal(bad.error.status, 404);
  assert.equal(bad.error.body.error.code, 'model_not_found');
});

test('toChatCompletion wraps router result in OpenAI envelope with x_continuum', () => {
  const env = toChatCompletion({
    result: { content: 'ok', model: 'deepseek-v3.2', provider: 'routstr', sats_spent: 5, duration_ms: 90, fell_back_from: null },
    modelId: 'chat',
    id: 'chatcmpl-1',
    created: 1_700_000_000,
  });
  assert.equal(env.object, 'chat.completion');
  assert.equal(env.model, 'chat');
  assert.equal(env.choices[0].message.content, 'ok');
  assert.equal(env.choices[0].finish_reason, 'stop');
  assert.equal(env.x_continuum.provider, 'routstr');
  assert.equal(env.x_continuum.sats_spent, 5);
});

test('toOpenAIError maps insufficient_funds→402, other→502', () => {
  const paid = toOpenAIError({ code: 'insufficient_funds', reason: 'dry wallet' });
  assert.equal(paid.status, 402);
  assert.equal(paid.body.error.type, 'insufficient_quota');
  const boom = toOpenAIError({ code: 'network', reason: 'boom' });
  assert.equal(boom.status, 502);
  assert.equal(boom.body.error.type, 'upstream_error');
});

test('chatCompletionChunk shape (delta then stop)', () => {
  const first = chatCompletionChunk({ modelId: 'chat', id: 'x', created: 1, content: 'hello' });
  assert.equal(first.object, 'chat.completion.chunk');
  assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: 'hello' });
  assert.equal(first.choices[0].finish_reason, null);
  const last = chatCompletionChunk({ modelId: 'chat', id: 'x', created: 1, finish_reason: 'stop' });
  assert.deepEqual(last.choices[0].delta, {});
  assert.equal(last.choices[0].finish_reason, 'stop');
});

// ─── HTTP surface ────────────────────────────────────────────────────────

test('chat-local passes ollama_only strategy; chat passes null (no paid shim)', async () => {
  const { app, calls } = await buildApp();
  try {
    const local = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat-local', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(local.statusCode, 200);
    assert.equal(calls[0].strategy, 'ollama_only', 'chat-local must force local-only so the router cannot touch a paid provider');

    const def = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(def.statusCode, 200);
    assert.equal(calls[1].strategy ?? null, null, 'chat passes null so the router keeps its constructed default');
  } finally {
    await app.close();
  }
});

test('fail-closed: no local_token → 503 without calling router', async () => {
  const { app, calls } = await buildApp({ token: '' });
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 503);
    const body = r.json();
    assert.equal(body.error.code, 'adapter_disabled');
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('missing bearer → 401 without calling router', async () => {
  const { app, calls } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'invalid_api_key');
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('wrong bearer → 401 (never reveals which was wrong)', async () => {
  const { app, calls } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${WRONG}` },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'invalid_api_key');
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('/v1/models returns the advertised catalog', async () => {
  const { app } = await buildApp();
  try {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.object, 'list');
    const ids = body.data.map((m) => m.id).sort();
    assert.deepEqual(ids, ['chat', 'chat-local']);
  } finally {
    await app.close();
  }
});

test('POST /v1/chat/completions (non-stream) delegates to router and returns envelope', async () => {
  const { app, calls } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'hello world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.x_continuum.provider, 'routstr');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].skill, 'chat');
    assert.equal(calls[0].messages[0].role, 'user');
  } finally {
    await app.close();
  }
});

test('POST /v1/chat/completions (stream) writes one content chunk then stop + [DONE]', async () => {
  const { app } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    // Streaming path writes directly to reply.raw; light-my-request captures it as payload.
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    const body = r.payload;
    // Two data lines + [DONE], separated by blank lines.
    const events = body.split('\n\n').filter(Boolean);
    assert.ok(events.length >= 3, `expected >=3 SSE events, got ${events.length}: ${body}`);
    const first = JSON.parse(events[0].replace(/^data: /, ''));
    assert.equal(first.choices[0].delta.content, 'hello world');
    const second = JSON.parse(events[1].replace(/^data: /, ''));
    assert.equal(second.choices[0].finish_reason, 'stop');
    assert.equal(events[2].trim(), 'data: [DONE]');
  } finally {
    await app.close();
  }
});

test('router failure with code=insufficient_funds → HTTP 402', async () => {
  const { app } = await buildApp({
    nextResult: { ok: false, code: 'insufficient_funds', reason: 'dry wallet', provider: 'routstr' },
  });
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 402);
    assert.equal(r.json().error.code, 'insufficient_funds');
  } finally {
    await app.close();
  }
});

test('router failure with generic code → HTTP 502', async () => {
  const { app } = await buildApp({
    nextResult: { ok: false, code: 'network', reason: 'timeout', provider: 'routstr' },
  });
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().error.code, 'network');
  } finally {
    await app.close();
  }
});

test('router throws → HTTP 502 with router_exception code', async () => {
  const { app } = await buildApp({ nextThrow: new Error('boom') });
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().error.code, 'router_exception');
  } finally {
    await app.close();
  }
});

test('malformed request (no messages) → 400 without calling router', async () => {
  const { app, calls } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'chat' },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('unknown model → 404 without calling router', async () => {
  const { app, calls } = await buildApp();
  try {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error.code, 'model_not_found');
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});
