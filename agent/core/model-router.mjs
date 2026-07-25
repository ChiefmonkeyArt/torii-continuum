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
 */

import { isRetryableCode, inferCodeFromReason, ERROR_CODES, sanitizeReason } from '../lib/provider-errors.mjs';

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

export function createModelRouter({ routstr, ollama, cfg, log }) {
  const strategy = cfg.model_router?.strategy || 'routstr_first';

  async function chat(args) {
    switch (strategy) {
      case 'routstr_only':
        return withProvider(await routstr.chat(args), 'routstr');

      case 'ollama_only': {
        if (!ollama?.enabled) {
          return { ok: false, code: ERROR_CODES.PROVIDER_DISABLED, reason: 'ollama disabled but ollama_only strategy set', retryable: false };
        }
        return withProvider(await ollama.chat(args), 'ollama');
      }

      case 'ollama_first': {
        if (ollama?.enabled) {
          const first = await ollama.chat(args);
          if (first.ok) return withProvider(first, 'ollama');
          log.info(`[router] ollama_first: ollama failed (${first.reason}), trying routstr`);
        }
        return withProvider(await routstr.chat(args), 'routstr');
      }

      case 'routstr_first':
      default: {
        const first = await routstr.chat(args);
        if (first.ok) return withProvider(first, 'routstr');
        if (!ollama?.enabled) return withProvider(first, 'routstr');
        // Fall through only on retryable transport/payment failures (5xx, HTML
        // error page, timeout, empty stream, network drop, dry wallet). A
        // malformed request must surface, not trigger a paid→free downgrade.
        if (!shouldFallback(first)) {
          log.warn(`[router] routstr failed with non-retryable ${first.code || 'error'}, not falling back: ${first.reason}`);
          return withProvider(first, 'routstr');
        }
        log.info(`[router] routstr ${first.code || 'error'} (${first.reason}) — falling back to ollama`);
        const second = await ollama.chat(args);
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

  return { chat, strategy };
}

function withProvider(result, provider) {
  if (!result || typeof result !== 'object') return result;
  return { ...result, provider: result.provider || provider };
}

// Exported for tests
export const _internals = { shouldFallback };
