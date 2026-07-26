/**
 * Model router — decides which provider (Routstr, Ollama) handles a chat call.
 *
 * Routing policy is set by cfg.model_router.strategy:
 *
 *   "routstr_first"  (default)
 *      Try Routstr. Fall through to Ollama on any RETRYABLE structured failure:
 *      an upstream 5xx, a non-JSON HTML error page (Cloudflare 520-style, which
 *      can arrive under a 200 status), a wall-clock timeout, an empty stream, a
 *      network drop, or a payment failure (402 / dry wallet). A malformed
 *      request does NOT fall through — that would hide a bug behind a silent
 *      paid→free downgrade. See lib/provider-errors.mjs for the code set.
 *
 *   "ollama_first"
 *      Try Ollama. If it's disabled, unreachable, or returns an error,
 *      fall through to Routstr.
 *
 *   "ollama_only"
 *      Use Ollama and only Ollama. Never spend sats. Used when the operator
 *      wants to test their character stack against a local model, or when
 *      they're offline.
 *
 *   "routstr_only"
 *      Original behavior. Never call Ollama. Kept so pplx.app builds that
 *      omit the Ollama module still work with the same code path.
 *
 * The router preserves the { ok, content, model, sats_spent, duration_ms }
 * response shape so chat.mjs doesn't need to know which provider replied.
 * A `provider` field is added ("routstr" | "ollama") for logging / UI.
 *
 * Timeout budget (CONT-TIMEOUT-1). Providers run SEQUENTIALLY, so their
 * configured timeouts used to add up: 45s of Routstr plus 180s of Ollama is
 * 225s, well past nginx's 120s `proxy_read_timeout`. The operator got a 504
 * while the agent kept generating into a dead socket. The router now opens ONE
 * budget per turn and passes what's left of it to each provider, so the whole
 * turn — however many providers it touches — stays inside the proxy bound. A
 * fallback with too little time left is not started; it reports
 * `budget_exhausted` instead of producing an answer nobody is waiting for.
 */

import { isRetryableCode, inferCodeFromReason, ERROR_CODES, sanitizeReason } from '../lib/provider-errors.mjs';
import {
  createBudget, resolveTotalBudgetMs, worthAttempting, describeBudget,
} from '../lib/timeout-budget.mjs';

/**
 * Should a failed primary-provider result fall through to the other provider?
 *
 * Decided on the STRUCTURED code, so an upstream 5xx, a Cloudflare HTML error
 * page, or a wall-clock timeout downgrades to the free local model instead of
 * surfacing as a dead chat turn. Previously only payment/network prose matched,
 * which meant every Routstr 520 / HTML 200 / hang was a hard failure.
 *
 * A malformed request (bad_request) is deliberately NOT retryable: silently
 * downgrading paid→free would mask a real bug.
 */
export function shouldFallback(result) {
  if (!result || result.ok) return false;
  const code = result.code || inferCodeFromReason(result.reason);
  if (!code) return false;
  return isRetryableCode(code);
}

export function createModelRouter({ routstr, ollama, cfg, log, now }) {
  const strategy = cfg.model_router?.strategy || 'routstr_first';
  const totalBudgetMs = resolveTotalBudgetMs(cfg);

  async function chat(args) {
    // One wall-clock allowance for the whole turn, shared by every provider
    // attempt below. `now` is injectable so the tests are deterministic.
    const budget = createBudget(totalBudgetMs, now ? { now } : undefined);
    /** Args for the next provider call, carrying whatever time is left. */
    const withBudget = () => ({ ...args, budget_ms: budget.remainingMs() });
    /** The turn ran out before this provider could be given a fair slice. */
    const exhausted = (provider) => ({
      ok: false,
      code: ERROR_CODES.BUDGET_EXHAUSTED,
      reason: sanitizeReason(`${provider} not attempted: ${describeBudget(budget)}`),
      retryable: false,
    });

    switch (strategy) {
      case 'routstr_only':
        return withProvider(await routstr.chat(withBudget()), 'routstr');

      case 'ollama_only': {
        if (!ollama?.enabled) {
          return { ok: false, code: ERROR_CODES.PROVIDER_DISABLED, reason: 'ollama disabled but ollama_only strategy set', retryable: false };
        }
        return withProvider(await ollama.chat(withBudget()), 'ollama');
      }

      case 'ollama_first': {
        if (ollama?.enabled) {
          const first = await ollama.chat(withBudget());
          if (first.ok) return withProvider(first, 'ollama');
          log.info(`[router] ollama_first: ollama failed (${first.reason}), trying routstr`);
          if (!worthAttempting(budget.remainingMs())) {
            log.warn(`[router] not trying routstr: ${describeBudget(budget)}`);
            return withProvider(exhausted('routstr'), 'ollama');
          }
        }
        return withProvider(await routstr.chat(withBudget()), 'routstr');
      }

      case 'routstr_first':
      default: {
        const first = await routstr.chat(withBudget());
        if (first.ok) return withProvider(first, 'routstr');
        if (!ollama?.enabled) return withProvider(first, 'routstr');
        // Fall through only on retryable transport/payment failures (5xx, HTML
        // error page, timeout, empty stream, network drop, dry wallet). A
        // malformed request must surface, not trigger a paid→free downgrade.
        if (!shouldFallback(first)) {
          log.warn(`[router] routstr failed with non-retryable ${first.code || 'error'}, not falling back: ${first.reason}`);
          return withProvider(first, 'routstr');
        }
        // A doomed fallback is worse than an honest failure: the local model
        // would still be loading when nginx hangs up. Report the primary
        // failure and say why we stopped.
        if (!worthAttempting(budget.remainingMs())) {
          log.warn(`[router] routstr ${first.code || 'error'} but no budget for ollama: ${describeBudget(budget)}`);
          return withProvider({
            ...first,
            code: ERROR_CODES.BUDGET_EXHAUSTED,
            reason: sanitizeReason(`routstr: ${first.reason}; ollama not attempted: ${describeBudget(budget)}`, 300),
            routstr_code: first.code || null,
            retryable: false,
          }, 'routstr');
        }
        log.info(`[router] routstr ${first.code || 'error'} (${first.reason}) — falling back to ollama`);
        const second = await ollama.chat(withBudget());
        if (second.ok) {
          // Tell the caller this reply came from the free local model after a
          // paid-provider failure, so the UI can be honest about provenance.
          return withProvider({ ...second, fell_back_from: 'routstr', fallback_code: first.code || null }, 'ollama');
        }
        // Both failed. Keep BOTH structured codes; report the primary's code
        // since that's the failure the operator needs to fix.
        return withProvider({
          ok: false,
          code: first.code || inferCodeFromReason(first.reason) || ERROR_CODES.NETWORK,
          reason: sanitizeReason(`routstr: ${first.reason}; ollama: ${second.reason}`, 300),
          routstr_code: first.code || null,
          ollama_code: second.code || null,
          retryable: false,
        }, 'both');
      }
    }
  }

  return { chat, strategy, totalBudgetMs };
}

function withProvider(result, provider) {
  if (!result || typeof result !== 'object') return result;
  return { ...result, provider: result.provider || provider };
}

// Exported for tests
export const _internals = { shouldFallback };
