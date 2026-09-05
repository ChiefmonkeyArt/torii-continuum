/**
 * ollama-request-shape.test.js
 *
 * Locks in the request body the agent sends to Ollama's
 * `/v1/chat/completions`. The offline fallback path on the low-spec VPS
 * depends on two Ollama-specific fields being present:
 *
 *   - `keep_alive`  keeps the loaded model resident in RAM so the fallback
 *                   path doesn't pay a 2-8s cold-start every time the
 *                   Routstr primary degrades. Ollama's default is 5m; the
 *                   agent uses -1 (keep until eviction) unless overridden.
 *
 *   - `options.num_ctx`
 *                   caps the KV-cache window. Ollama's OpenAI-compat
 *                   endpoint silently truncates at 4096 tokens without
 *                   this, and blows memory unpredictably if a caller
 *                   bakes 65536 into a Modelfile. The agent pins 4096 by
 *                   default so the low-spec VPS stays stable.
 *
 * If either field disappears from the request body the fallback path
 * degrades silently and this test fails to warn us.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllama } from '../core/ollama.mjs';

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

function stubFetch(captureRef) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captureRef.url = url;
    captureRef.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        };
      },
      async text() { return ''; },
    };
  };
  return () => { globalThis.fetch = original; };
}

const baseCfg = (overrides = {}) => ({
  ollama: {
    enabled: true,
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3:0.6b',
    ...overrides,
  },
  logging: { cost_log: '/tmp/ollama-request-shape-test.jsonl' },
});

test('ollama chat() sends keep_alive at top-level (default -1)', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    const ollama = createOllama(baseCfg(), silentLog());
    const res = await ollama.chat({
      skill: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(res.ok, true);
    assert.ok('keep_alive' in capture.body, 'request body must include keep_alive');
    assert.equal(capture.body.keep_alive, -1, 'default keep_alive must be -1 (keep resident)');
  } finally {
    restore();
  }
});

test('ollama chat() sends options.num_ctx (default 4096)', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    const ollama = createOllama(baseCfg(), silentLog());
    await ollama.chat({
      skill: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.ok(capture.body.options, 'request body must include an options object');
    assert.equal(
      capture.body.options.num_ctx,
      4096,
      'default num_ctx must be 4096 (Ollama /v1 truncates otherwise)',
    );
  } finally {
    restore();
  }
});

test('ollama chat() respects config overrides for keep_alive and num_ctx', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    const ollama = createOllama(
      baseCfg({ keep_alive: '10m', num_ctx: 8192 }),
      silentLog(),
    );
    await ollama.chat({
      skill: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(capture.body.keep_alive, '10m', 'operator override for keep_alive must win');
    assert.equal(capture.body.options.num_ctx, 8192, 'operator override for num_ctx must win');
  } finally {
    restore();
  }
});

test('ollama chat() posts to /v1/chat/completions (OpenAI-compat endpoint)', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    const ollama = createOllama(baseCfg(), silentLog());
    await ollama.chat({
      skill: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(capture.url, 'http://127.0.0.1:11434/v1/chat/completions');
  } finally {
    restore();
  }
});
