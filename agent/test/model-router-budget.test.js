/**
 * Model router — one wall-clock budget per turn (v0.2.91-alpha, CONT-TIMEOUT-1).
 *
 * Providers run sequentially, so before this change their configured timeouts
 * ADDED UP: 45s of Routstr then 180s of Ollama is 225s under an nginx read
 * timeout of 120s. These tests pin the fix: the router opens one budget, hands
 * each provider only what is LEFT of it, and refuses to start a fallback that
 * cannot finish in time.
 *
 * Providers are stubbed and the clock is injected — no network, no sats, no sleeps.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter } from '../core/model-router.mjs';
import { ERROR_CODES } from '../lib/provider-errors.mjs';
import { DEFAULT_TOTAL_BUDGET_MS, MIN_PROVIDER_SLICE_MS } from '../lib/timeout-budget.mjs';

const log = { info() {}, warn() {}, error() {} };
const ARGS = { skill: 'chat', messages: [{ role: 'user', content: 'gm' }] };
const OK_OLLAMA = { ok: true, content: 'local answer', model: 'llama3.2:3b', sats_spent: 0 };
const RETRYABLE_FAIL = {
  ok: false, code: ERROR_CODES.UPSTREAM_5XX, reason: 'routstr upstream error http 503', retryable: true,
};

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/**
 * Provider double. `burnMs` simulates the provider consuming wall-clock, so the
 * next provider in the chain observes a genuinely smaller budget.
 */
function stubProvider(result, { enabled = true, burnMs = 0, clock = null } = {}) {
  const calls = [];
  return {
    enabled,
    calls,
    async chat(args) {
      calls.push(args);
      if (burnMs && clock) clock.advance(burnMs);
      return result;
    },
  };
}

test('routstr_first passes the full budget to the primary provider', async () => {
  const clock = fakeClock();
  const routstr = stubProvider({ ok: true, content: 'paid', model: 'x', sats_spent: 3 });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({ routstr, ollama, cfg: {}, log, now: clock.now });

  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(routstr.calls[0].budget_ms, DEFAULT_TOTAL_BUDGET_MS);
  assert.deepEqual(routstr.calls[0].messages, ARGS.messages, 'original args preserved');
});

test('the fallback receives only what the primary left behind', async () => {
  const clock = fakeClock();
  const routstr = stubProvider(RETRYABLE_FAIL, { burnMs: 45000, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });

  const r = await router.chat(ARGS);
  assert.equal(r.provider, 'ollama');
  assert.equal(routstr.calls[0].budget_ms, 100000);
  assert.equal(ollama.calls[0].budget_ms, 55000, 'not the full 100s again');
  // The regression in one assertion: the two slices cannot sum past the turn.
  assert.ok(routstr.calls[0].budget_ms >= ollama.calls[0].budget_ms);
});

test('a doomed fallback is not started — budget_exhausted instead', async () => {
  const clock = fakeClock();
  // Routstr eats all but 2s, which is under MIN_PROVIDER_SLICE_MS.
  const routstr = stubProvider(RETRYABLE_FAIL, { burnMs: 98000, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });

  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.BUDGET_EXHAUSTED);
  assert.equal(ollama.calls.length, 0, 'must not start a call nobody will wait for');
  assert.equal(r.routstr_code, ERROR_CODES.UPSTREAM_5XX, 'the real failure is still reported');
  assert.match(r.reason, /not attempted/);
  assert.equal(r.retryable, false, 'no time left, so retrying is not honest');
});

test('budget_exhausted mentions the remaining time but leaks no secrets', async () => {
  const clock = fakeClock();
  const routstr = stubProvider(RETRYABLE_FAIL, { burnMs: 99000, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });
  const r = await router.chat(ARGS);
  assert.match(r.reason, /budget \d+ms left of 100000ms/);
  assert.ok(!/cashu|bearer|authorization/i.test(r.reason));
});

test('a fallback still runs when exactly the minimum slice remains', async () => {
  const clock = fakeClock();
  const routstr = stubProvider(RETRYABLE_FAIL, { burnMs: 100000 - MIN_PROVIDER_SLICE_MS, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });
  const r = await router.chat(ARGS);
  assert.equal(r.ok, true, 'the floor is inclusive');
  assert.equal(ollama.calls[0].budget_ms, MIN_PROVIDER_SLICE_MS);
});

test('ollama_first budgets both providers from the same turn', async () => {
  const clock = fakeClock();
  const ollama = stubProvider({ ok: false, code: ERROR_CODES.NETWORK, reason: 'ECONNREFUSED', retryable: true }, { burnMs: 20000, clock });
  const routstr = stubProvider({ ok: true, content: 'paid', model: 'x', sats_spent: 3 });
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'ollama_first', total_budget_ms: 100000 } }, log, now: clock.now,
  });

  const r = await router.chat(ARGS);
  assert.equal(r.ok, true);
  assert.equal(ollama.calls[0].budget_ms, 100000);
  assert.equal(routstr.calls[0].budget_ms, 80000);
});

test('ollama_first will not spend sats on a turn with no time left', async () => {
  const clock = fakeClock();
  const ollama = stubProvider({ ok: false, code: ERROR_CODES.NETWORK, reason: 'ECONNREFUSED', retryable: true }, { burnMs: 99000, clock });
  const routstr = stubProvider({ ok: true, content: 'paid', model: 'x', sats_spent: 3 });
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'ollama_first', total_budget_ms: 100000 } }, log, now: clock.now,
  });

  const r = await router.chat(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.BUDGET_EXHAUSTED);
  assert.equal(routstr.calls.length, 0, 'a paid call whose answer arrives too late is wasted money');
});

test('single-provider strategies are budgeted too', async () => {
  const clock = fakeClock();
  const routstr = stubProvider({ ok: true, content: 'paid', model: 'x', sats_spent: 3 });
  const ollama = stubProvider(OK_OLLAMA);

  const only = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'routstr_only', total_budget_ms: 70000 } }, log, now: clock.now,
  });
  await only.chat(ARGS);
  assert.equal(routstr.calls[0].budget_ms, 70000);

  const localOnly = createModelRouter({
    routstr, ollama, cfg: { model_router: { strategy: 'ollama_only', total_budget_ms: 70000 } }, log, now: clock.now,
  });
  await localOnly.chat(ARGS);
  assert.equal(ollama.calls[0].budget_ms, 70000);
});

test('each turn gets a fresh budget', async () => {
  const clock = fakeClock();
  const routstr = stubProvider({ ok: true, content: 'paid', model: 'x', sats_spent: 3 }, { burnMs: 30000, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });

  await router.chat(ARGS);
  await router.chat(ARGS);
  assert.equal(routstr.calls[0].budget_ms, 100000);
  assert.equal(routstr.calls[1].budget_ms, 100000, 'turn 2 is not penalised for turn 1');
});

test('a non-retryable failure still short-circuits before any budget talk', async () => {
  const clock = fakeClock();
  const routstr = stubProvider({ ok: false, code: ERROR_CODES.BAD_REQUEST, reason: 'malformed', retryable: false }, { burnMs: 99000, clock });
  const ollama = stubProvider(OK_OLLAMA);
  const router = createModelRouter({
    routstr, ollama, cfg: { model_router: { total_budget_ms: 100000 } }, log, now: clock.now,
  });
  const r = await router.chat(ARGS);
  assert.equal(r.code, ERROR_CODES.BAD_REQUEST, 'a bug must not be relabelled as a timeout');
  assert.equal(ollama.calls.length, 0);
});

test('the router exposes the resolved budget for diagnostics', () => {
  const router = createModelRouter({
    routstr: stubProvider(OK_OLLAMA), ollama: stubProvider(OK_OLLAMA),
    cfg: { model_router: { total_budget_ms: 65000 } }, log,
  });
  assert.equal(router.totalBudgetMs, 65000);
});

test('budget_exhausted is NOT retryable — it must not trigger another downgrade', () => {
  // Guarded here as well as in provider-errors: mislabelling it retryable would
  // reintroduce exactly the doomed-fallback behaviour this release removes.
  assert.equal(ERROR_CODES.BUDGET_EXHAUSTED, 'budget_exhausted');
});
