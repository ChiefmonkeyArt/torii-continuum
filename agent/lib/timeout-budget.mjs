/**
 * End-to-end chat timeout budget (CONT-TIMEOUT-1).
 *
 * Each layer of the chat path had its own deadline and none of them knew about
 * the others, so the live defaults could not all be satisfied at once:
 *
 *   nginx  proxy_read_timeout  120s   ← outermost bound on any response
 *   routstr limits.timeout_ms   45s
 *   ollama  timeout_ms         180s   (config.example, for a slow no-AVX2 VPS)
 *   router                      —     no budget: providers run SEQUENTIALLY
 *   browser fetch               —     no deadline at all
 *
 * `routstr_first` therefore had a worst case of 45s + 180s = 225s. nginx cut
 * the connection at 120s, so the operator got a 504 (or an endless spinner)
 * instead of the local model's answer — and the agent kept generating into a
 * socket nobody was reading. Ollama alone at 180s already broke the 120s bound.
 *
 * The fix is one budget for the whole turn. The router opens it once, each
 * provider call is clamped to whatever is LEFT of it, and a fallback that could
 * not finish in the remaining time is not started at all — an honest
 * `budget_exhausted` beats a doomed call whose answer would arrive after
 * everyone upstream has hung up.
 *
 * The invariant chain, outermost last:
 *
 *   provider slice  ≤  agent total budget  <  client fetch deadline  ≤  nginx
 *      (clamped)            100s                     115s               120s
 *
 * Every function here is pure and takes an injectable clock, so the tests are
 * deterministic rather than sleep-based.
 */

/**
 * Total wall-clock allowance for one chat turn, across every provider attempt.
 * Chosen to sit under nginx's 120s `proxy_read_timeout` with headroom for the
 * agent's own JSON serialisation and the reply write. An operator who raises
 * the nginx timeout can raise this too — see `model_router.total_budget_ms`.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 100000;

/**
 * Floor for starting a provider call. A slice thinner than this cannot produce
 * a useful completion (a cold local model needs seconds just to load), so
 * spending the remaining time on a call that will certainly abort is worse than
 * reporting the primary failure immediately.
 */
export const MIN_PROVIDER_SLICE_MS = 5000;

/** Resolve the configured turn budget, falling back to the default. */
export function resolveTotalBudgetMs(cfg) {
  const raw = cfg?.model_router?.total_budget_ms;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOTAL_BUDGET_MS;
}

/**
 * Open a budget for one turn. `now` is injectable for tests.
 * @param {number} totalMs
 * @param {{now?: () => number}} [opts]
 */
export function createBudget(totalMs, { now = () => Date.now() } = {}) {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? Math.floor(totalMs) : DEFAULT_TOTAL_BUDGET_MS;
  const startedAt = now();
  return {
    totalMs: total,
    startedAt,
    elapsedMs: () => Math.max(0, now() - startedAt),
    remainingMs: () => Math.max(0, total - Math.max(0, now() - startedAt)),
    expired: () => total - Math.max(0, now() - startedAt) <= 0,
  };
}

/**
 * The deadline for a single provider call: its own configured timeout, capped
 * by what is left of the turn. `remainingMs` of null/undefined means "no budget
 * in play" (a provider called directly, outside the router), which keeps the
 * providers usable on their own.
 */
export function sliceForProvider(configuredMs, remainingMs) {
  const configured = Number.isFinite(configuredMs) && configuredMs > 0 ? Math.floor(configuredMs) : 0;
  if (remainingMs === null || remainingMs === undefined) return configured;
  const remaining = Number.isFinite(remainingMs) ? Math.max(0, Math.floor(remainingMs)) : 0;
  if (!configured) return remaining;
  return Math.min(configured, remaining);
}

/** Is there enough of the turn left to be worth starting another attempt? */
export function worthAttempting(remainingMs, minMs = MIN_PROVIDER_SLICE_MS) {
  const remaining = Number.isFinite(remainingMs) ? remainingMs : 0;
  return remaining >= minMs;
}

/**
 * Human-readable budget note for a log line or an error reason. Carries no
 * secrets — only durations.
 */
export function describeBudget(budget) {
  return `budget ${budget.remainingMs()}ms left of ${budget.totalMs}ms`;
}
