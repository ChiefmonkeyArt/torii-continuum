/**
 * Model router — Routstr→Ollama fallback on 5xx / HTML / timeout
 * (v0.2.90-alpha, CONT-FALLBACK-1).
 *
 * Before this change `routstr_first` only fell through on payment/network prose,
 * so an upstream 5xx, a Cloudflare HTML error page (which can arrive under a 200
 * status), or a wall-clock timeout produced a dead chat turn even with a working
 * local model sitting idle. These tests pin the new behaviour and the guard that
 * keeps a malformed request from triggering a silent paid→free downgrade.
 *
 * Providers are stubbed — no network, no wallet, no sats.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter, shouldFallback } from '../core/model-router.mjs';
import { ERROR_CODES } from '../lib/provider-errors.mjs';

const log = { info() {}, warn() {}, error() {} };

/** Provider double that returns a scripted sequence of results. */
function stubProvider(results, { enabled = true } = {}) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : [results];
  return {
    enabled,
    calls,
    async chat(args) {
      calls.push(args);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  };
}

const OK_OLLAMA = { ok: true, content: 'local answer', model: 'llama3.2:3b', sats_spent: 0 };
const ARGS = { skill: 'chat', messages: [{ role: 'user', content: 'gm' }] };

function routerWith(routstrResult, ollamaResult, { ollamaEnabled = true } = {}) {
  const routstr = stubProvider(routstrResult);
  const ollama = stubProvider(ollamaResult, { enabled: ollamaEnabled });
  const router = createModelRouter({ routstr, ollama, cfg: {}, log });
  return { router, routstr, ollama };
}

test('falls back to ollama on an upstream 5xx', async () => {
  const { router, ollama } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_5XX, reason: 'routstr upstream error http 503', retryable: true },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(r.content, 'local answer');
  assert.equal(r.fell_back_from, 'routstr');
  assert.equal(r.fallback_code, ERROR_CODES.UPSTREAM_5XX);
  assert.equal(ollama.calls.length, 1, 'ollama was actually called');
});

test('falls back to ollama on a non-JSON HTML error page', async () => {
  const { router } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_HTML, reason: 'routstr returned a non-JSON HTML error page (http 200)', retryable: true },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(r.fallback_code, ERROR_CODES.UPSTREAM_HTML);
});

test('falls back to ollama on a wall-clock timeout', async () => {
  const { router } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_TIMEOUT, reason: 'routstr timed out after 45000ms', retryable: true },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'ollama');
  assert.equal(r.fallback_code, ERROR_CODES.UPSTREAM_TIMEOUT);
});

test('falls back on an empty completion stream', async () => {
  const { router } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_EMPTY, reason: 'routstr returned an empty completion stream', retryable: true },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.provider, 'ollama');
});

test('still falls back on the pre-existing payment path', async () => {
  const { router } = routerWith(
    { ok: false, code: ERROR_CODES.INSUFFICIENT_FUNDS, reason: 'wallet: insufficient balance', retryable: true },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.provider, 'ollama');
});

test('does NOT fall back on a malformed request', async () => {
  const { router, ollama } = routerWith(
    { ok: false, code: ERROR_CODES.BAD_REQUEST, reason: 'messages must be a non-empty array', retryable: false },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'routstr');
  assert.equal(r.code, ERROR_CODES.BAD_REQUEST);
  assert.equal(ollama.calls.length, 0, 'must not downgrade paid→free for a bug');
});

test('does not call ollama when it is disabled — returns routstr failure as-is', async () => {
  const { router, ollama } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_5XX, reason: 'http 503', retryable: true },
    OK_OLLAMA,
    { ollamaEnabled: false },
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'routstr');
  assert.equal(ollama.calls.length, 0);
});

test('both providers failing keeps both structured codes and does not leak markup', async () => {
  const { router } = routerWith(
    { ok: false, code: ERROR_CODES.UPSTREAM_HTML, reason: 'routstr returned a non-JSON HTML error page (http 520)', retryable: true },
    { ok: false, code: ERROR_CODES.NETWORK, reason: 'ollama network error: ECONNREFUSED', retryable: true },
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'both');
  assert.equal(r.code, ERROR_CODES.UPSTREAM_HTML, 'primary failure is the actionable one');
  assert.equal(r.routstr_code, ERROR_CODES.UPSTREAM_HTML);
  assert.equal(r.ollama_code, ERROR_CODES.NETWORK);
  assert.equal(r.retryable, false, 'nothing left to try');
  assert.ok(!r.reason.includes('<'), 'combined reason carries no markup');
});

test('a successful routstr call never touches ollama', async () => {
  const { router, ollama } = routerWith(
    { ok: true, content: 'paid answer', model: 'deepseek-chat', sats_spent: 7 },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'routstr');
  assert.equal(r.fell_back_from, undefined);
  assert.equal(ollama.calls.length, 0);
});

test('legacy free-text reasons still route correctly (no code field)', async () => {
  // A provider double / older build that returns prose must not regress.
  const { router } = routerWith(
    { ok: false, reason: 'http 502: bad gateway' },
    OK_OLLAMA,
  );
  const r = await router.chat(ARGS);
  assert.equal(r.provider, 'ollama', 'inferred 5xx from legacy prose');
});

test('shouldFallback is pure and exported for the decision contract', () => {
  assert.equal(shouldFallback({ ok: true }), false);
  assert.equal(shouldFallback(null), false);
  assert.equal(shouldFallback({ ok: false, code: ERROR_CODES.UPSTREAM_TIMEOUT }), true);
  assert.equal(shouldFallback({ ok: false, code: ERROR_CODES.BAD_REQUEST }), false);
  assert.equal(shouldFallback({ ok: false, reason: 'timeout after 1000ms' }), true);
  assert.equal(shouldFallback({ ok: false, reason: 'something inexplicable' }), false);
});

test('ollama_only with ollama disabled returns a structured provider_disabled', async () => {
  const routstr = stubProvider({ ok: true, content: 'x' });
  const ollama = stubProvider(OK_OLLAMA, { enabled: false });
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'ollama_only' } }, log,
  });
  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.PROVIDER_DISABLED);
  assert.equal(routstr.calls.length, 0, 'ollama_only must never spend sats');
});

test('routstr_only never falls back even on a retryable 5xx', async () => {
  const routstr = stubProvider({ ok: false, code: ERROR_CODES.UPSTREAM_5XX, reason: 'http 503', retryable: true });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'routstr_only' } }, log,
  });
  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.provider, 'routstr');
  assert.equal(ollama.calls.length, 0);
});
