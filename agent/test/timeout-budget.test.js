/**
 * End-to-end chat timeout budget — pure math (v0.2.91-alpha, CONT-TIMEOUT-1).
 *
 * The bug this guards: each layer of the chat path held its own deadline and
 * none knew about the others, so `routstr_first` could spend 45s on Routstr and
 * then 180s on Ollama — 225s — under an nginx `proxy_read_timeout` of 120s. The
 * operator got a 504 while the agent generated into a dead socket.
 *
 * Every assertion here uses an INJECTED clock, so the suite is deterministic
 * and never sleeps.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOTAL_BUDGET_MS,
  MIN_PROVIDER_SLICE_MS,
  resolveTotalBudgetMs,
  createBudget,
  sliceForProvider,
  worthAttempting,
  describeBudget,
} from '../lib/timeout-budget.mjs';

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('the default budget sits under the nginx 120s read timeout', () => {
  assert.ok(DEFAULT_TOTAL_BUDGET_MS < 120000, 'must leave nginx headroom');
  // Enough headroom for the agent's own serialisation + reply write, not a
  // rounding error away from the proxy bound.
  assert.ok(120000 - DEFAULT_TOTAL_BUDGET_MS >= 10000);
});

test('resolveTotalBudgetMs honours config and rejects nonsense', () => {
  assert.equal(resolveTotalBudgetMs({ model_router: { total_budget_ms: 60000 } }), 60000);
  assert.equal(resolveTotalBudgetMs({}), DEFAULT_TOTAL_BUDGET_MS);
  assert.equal(resolveTotalBudgetMs(undefined), DEFAULT_TOTAL_BUDGET_MS);
  assert.equal(resolveTotalBudgetMs({ model_router: { total_budget_ms: 0 } }), DEFAULT_TOTAL_BUDGET_MS);
  assert.equal(resolveTotalBudgetMs({ model_router: { total_budget_ms: -5 } }), DEFAULT_TOTAL_BUDGET_MS);
  assert.equal(resolveTotalBudgetMs({ model_router: { total_budget_ms: 'soon' } }), DEFAULT_TOTAL_BUDGET_MS);
  assert.equal(resolveTotalBudgetMs({ model_router: { total_budget_ms: 1234.9 } }), 1234, 'floored');
});

test('a budget drains with the clock and never reports negative time', () => {
  const clock = fakeClock();
  const b = createBudget(10000, { now: clock.now });
  assert.equal(b.totalMs, 10000);
  assert.equal(b.remainingMs(), 10000);
  assert.equal(b.elapsedMs(), 0);
  assert.equal(b.expired(), false);

  clock.advance(4000);
  assert.equal(b.elapsedMs(), 4000);
  assert.equal(b.remainingMs(), 6000);

  clock.advance(6000);
  assert.equal(b.remainingMs(), 0);
  assert.equal(b.expired(), true, 'exactly at the deadline counts as expired');

  clock.advance(50000);
  assert.equal(b.remainingMs(), 0, 'clamped at zero, never negative');
  assert.equal(b.elapsedMs(), 60000, 'elapsed keeps counting past the deadline');
});

test('an invalid total falls back to the default rather than expiring instantly', () => {
  const clock = fakeClock();
  for (const bad of [undefined, null, 0, -1, NaN, 'later']) {
    const b = createBudget(bad, { now: clock.now });
    assert.equal(b.totalMs, DEFAULT_TOTAL_BUDGET_MS, `bad total: ${String(bad)}`);
    assert.equal(b.expired(), false);
  }
});

test('sliceForProvider caps a configured timeout by the remaining budget', () => {
  // The motivating case: Ollama configured at 180s can never outlive the turn.
  assert.equal(sliceForProvider(180000, 40000), 40000);
  // Plenty of budget left — the provider's own timeout still governs.
  assert.equal(sliceForProvider(45000, 90000), 45000);
  assert.equal(sliceForProvider(45000, 45000), 45000, 'equal values are not truncated');
});

test('sliceForProvider treats a missing budget as "no budget in play"', () => {
  // Providers must remain usable when called directly, outside the router.
  assert.equal(sliceForProvider(45000, null), 45000);
  assert.equal(sliceForProvider(45000, undefined), 45000);
});

test('sliceForProvider degrades safely on missing or junk inputs', () => {
  assert.equal(sliceForProvider(0, 30000), 30000, 'no configured timeout → use the budget');
  assert.equal(sliceForProvider(undefined, 30000), 30000);
  assert.equal(sliceForProvider(45000, 0), 0, 'no budget left → zero slice');
  assert.equal(sliceForProvider(45000, -100), 0, 'never negative');
  assert.equal(sliceForProvider(45000, NaN), 0);
  assert.equal(sliceForProvider(45000.7, 90000), 45000, 'floored');
});

test('worthAttempting refuses a slice too thin to produce a completion', () => {
  assert.equal(worthAttempting(MIN_PROVIDER_SLICE_MS), true, 'the floor itself is allowed');
  assert.equal(worthAttempting(MIN_PROVIDER_SLICE_MS - 1), false);
  assert.equal(worthAttempting(0), false);
  assert.equal(worthAttempting(-1), false);
  assert.equal(worthAttempting(undefined), false, 'unknown time is not worth spending money on');
  assert.equal(worthAttempting(NaN), false);
  assert.equal(worthAttempting(1000, 500), true, 'caller can lower the floor');
});

test('the invariant chain holds: provider slice <= budget < client deadline <= nginx', () => {
  const clock = fakeClock();
  const budget = createBudget(DEFAULT_TOTAL_BUDGET_MS, { now: clock.now });
  const CLIENT_DEADLINE_MS = 115000;   // src/data/agent.js CHAT_CLIENT_TIMEOUT_MS
  const NGINX_READ_TIMEOUT_MS = 120000; // ops/nginx/torii-api.conf

  const slice = sliceForProvider(180000, budget.remainingMs());
  assert.ok(slice <= budget.totalMs);
  assert.ok(budget.totalMs < CLIENT_DEADLINE_MS, 'client must outwait the agent');
  assert.ok(CLIENT_DEADLINE_MS <= NGINX_READ_TIMEOUT_MS, 'client must not outwait nginx');
});

test('two sequential providers cannot together exceed the turn budget', () => {
  // The exact 45s + 180s = 225s regression, replayed against the budget.
  const clock = fakeClock();
  const budget = createBudget(100000, { now: clock.now });

  const first = sliceForProvider(45000, budget.remainingMs());
  assert.equal(first, 45000);
  clock.advance(first);                       // Routstr burned its whole slice

  const second = sliceForProvider(180000, budget.remainingMs());
  assert.equal(second, 55000, 'Ollama gets what is LEFT, not its configured 180s');
  assert.equal(first + second, budget.totalMs, 'the turn cannot overrun');
});

test('a fallback is skipped once the remaining budget is unusable', () => {
  const clock = fakeClock();
  const budget = createBudget(100000, { now: clock.now });
  clock.advance(97000);
  assert.equal(worthAttempting(budget.remainingMs()), false);
  assert.ok(budget.remainingMs() < MIN_PROVIDER_SLICE_MS);
});

test('describeBudget reports durations only — no secrets to leak', () => {
  const clock = fakeClock();
  const b = createBudget(100000, { now: clock.now });
  clock.advance(2500);
  assert.equal(describeBudget(b), 'budget 97500ms left of 100000ms');
  assert.ok(!/cashu|bearer|authorization/i.test(describeBudget(b)));
});
