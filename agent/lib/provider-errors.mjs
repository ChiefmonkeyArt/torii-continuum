/**
 * Structured, sanitised model-provider errors (CONT-FALLBACK-1).
 *
 * Providers used to return free-text reasons that spliced up to 200 chars of the
 * raw upstream body straight into a client-visible string. A Cloudflare 520
 * therefore leaked an HTML error page into the chat dock, and the router could
 * only pattern-match that prose to decide whether a retry was safe.
 *
 * This module gives every provider failure one shape:
 *
 *   { ok: false, code, reason, status?, retryable }
 *
 * `code` is a stable machine token (the router and the SPA branch on it),
 * `reason` is a short operator-readable string that has been scrubbed of
 * secrets and never contains upstream markup, and `retryable` says whether a
 * different provider is worth trying.
 *
 * Sanitisation invariants:
 *   - Upstream response bodies are NEVER forwarded verbatim. We classify them
 *     and emit our own sentence; only a JSON `error.message` is quoted, and
 *     only after scrubbing + truncation.
 *   - Long hex runs and Cashu tokens are redacted (a token in an echoed error
 *     body must not reach a log or a browser).
 *   - HTML is reported as "non-JSON HTML error page", never rendered.
 */

/** Stable failure codes. */
export const ERROR_CODES = Object.freeze({
  UPSTREAM_5XX: 'upstream_5xx',
  UPSTREAM_HTML: 'upstream_html',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  UPSTREAM_EMPTY: 'upstream_empty',
  NETWORK: 'network',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  TOKEN_ALREADY_SPENT: 'token_already_spent',
  UPSTREAM_4XX: 'upstream_4xx',
  BAD_REQUEST: 'bad_request',
  PROVIDER_DISABLED: 'provider_disabled',
  UPSTREAM_BAD_JSON: 'upstream_bad_json',
});

/**
 * Codes worth re-trying on a DIFFERENT provider. A transport/availability
 * failure (5xx, HTML error page, timeout, empty stream, network drop) or a
 * payment-path failure is retryable: the local Ollama path costs nothing and
 * may well succeed. A malformed request (bad_request) is NOT — falling back
 * would mask a real bug behind a silent paid→free downgrade.
 */
const RETRYABLE = new Set([
  ERROR_CODES.UPSTREAM_5XX,
  ERROR_CODES.UPSTREAM_HTML,
  ERROR_CODES.UPSTREAM_TIMEOUT,
  ERROR_CODES.UPSTREAM_EMPTY,
  ERROR_CODES.NETWORK,
  ERROR_CODES.INSUFFICIENT_FUNDS,
  ERROR_CODES.TOKEN_ALREADY_SPENT,
  ERROR_CODES.UPSTREAM_BAD_JSON,
]);

export function isRetryableCode(code) {
  return RETRYABLE.has(code);
}

const MAX_REASON_CHARS = 180;

/**
 * Scrub secrets out of a reason fragment and bound its length. Redacts Cashu
 * tokens (cashuA…/cashuB…), nostr+walletconnect URIs, bearer-ish values and
 * long hex runs, mirroring lib/scrub.mjs but applied to provider prose.
 */
export function sanitizeReason(s, max = MAX_REASON_CHARS) {
  const raw = typeof s === 'string' && s.trim() ? s.trim() : 'unknown error';
  return raw
    .replace(/cashu[AB][A-Za-z0-9\-_=+/]+/g, '[cashu-token-redacted]')
    .replace(/nostr\+?walletconnect:\/\/\S+/gi, '[nwc-uri-redacted]')
    // Consume an optional auth scheme after the key, so "Authorization: Bearer
    // <secret>" redacts the secret rather than the word "Bearer".
    .replace(/\b(authorization|bearer|api[-_]?key)\b\s*[:=]?\s*(?:bearer\s+|token\s+)?\S+/gi, '$1 [redacted]')
    .replace(/[0-9a-f]{16,}/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

/**
 * Does this body look like an HTML/XML document rather than JSON or SSE?
 * Cloudflare's 5xx interstitials (and Routstr's 520) are the motivating case:
 * they can arrive with ANY status, including 200, so HTML detection is separate
 * from status classification.
 */
export function looksLikeHtml(body) {
  if (typeof body !== 'string') return false;
  const head = body.slice(0, 1000).trimStart().toLowerCase();
  if (!head) return false;
  return (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<?xml') ||
    /<html[\s>]/.test(head) ||
    /<(head|title|body)[\s>]/.test(head)
  );
}

/** Pull a JSON `error.message` when the upstream returned structured JSON. */
function jsonErrorMessage(body) {
  if (typeof body !== 'string' || !body.trim().startsWith('{')) return null;
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message || j?.error || j?.message;
    return typeof m === 'string' && m.trim() ? m.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Classify a non-OK HTTP response from a model provider into a structured,
 * sanitised failure. The raw `body` is inspected but never echoed wholesale.
 *
 * @param {object} args
 * @param {number} args.status  HTTP status
 * @param {string} [args.body]  raw response body (inspected, not forwarded)
 * @param {string} [args.provider] "routstr" | "ollama"
 * @returns {{ok: false, code: string, reason: string, status: number, retryable: boolean}}
 */
export function classifyHttpFailure({ status, body = '', provider = 'upstream' } = {}) {
  const html = looksLikeHtml(body);
  let code;
  let detail;

  if (html) {
    // An HTML body means we never reached the model API (edge/proxy error page),
    // whatever the status line claims. Treat it as an availability failure.
    code = ERROR_CODES.UPSTREAM_HTML;
    detail = `${provider} returned a non-JSON HTML error page (http ${status})`;
  } else if (status >= 500) {
    code = ERROR_CODES.UPSTREAM_5XX;
    const msg = jsonErrorMessage(body);
    detail = `${provider} upstream error http ${status}${msg ? `: ${msg}` : ''}`;
  } else if (status === 402) {
    code = ERROR_CODES.INSUFFICIENT_FUNDS;
    detail = `${provider} requires payment (http 402)`;
  } else {
    code = ERROR_CODES.UPSTREAM_4XX;
    const msg = jsonErrorMessage(body);
    detail = `${provider} rejected the request http ${status}${msg ? `: ${msg}` : ''}`;
  }

  return { ok: false, code, reason: sanitizeReason(detail), status, retryable: isRetryableCode(code) };
}

/**
 * Classify a thrown fetch error (network drop or AbortController timeout).
 *
 * @param {Error} err
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] the deadline that fired, for the message
 * @param {string} [opts.provider]
 */
export function classifyThrownError(err, { timeoutMs, provider = 'upstream' } = {}) {
  const isAbort = err?.name === 'AbortError' || /aborted|abortederror/i.test(err?.message || '');
  if (isAbort) {
    return {
      ok: false,
      code: ERROR_CODES.UPSTREAM_TIMEOUT,
      reason: sanitizeReason(`${provider} timed out after ${timeoutMs ?? 'the configured'}ms`),
      retryable: true,
    };
  }
  return {
    ok: false,
    code: ERROR_CODES.NETWORK,
    reason: sanitizeReason(`${provider} network error: ${err?.message || 'unknown'}`),
    retryable: true,
  };
}

/** Build a structured failure for a known code with a custom message. */
export function providerFailure(code, reason, extra = {}) {
  return { ok: false, code, reason: sanitizeReason(reason), retryable: isRetryableCode(code), ...extra };
}

/**
 * Back-compat bridge: infer a code from a legacy free-text reason so a provider
 * that hasn't been migrated (or a stubbed test double) still routes correctly.
 */
export function inferCodeFromReason(reason) {
  if (typeof reason !== 'string' || !reason) return null;
  const l = reason.toLowerCase();
  if (/timed out|timeout/.test(l)) return ERROR_CODES.UPSTREAM_TIMEOUT;
  if (/html/.test(l)) return ERROR_CODES.UPSTREAM_HTML;
  if (/^network:|network error|unreachable|econnrefused|enotfound/.test(l)) return ERROR_CODES.NETWORK;
  if (/token[_ ]already[_ ]spent/.test(l)) return ERROR_CODES.TOKEN_ALREADY_SPENT;
  if (/insufficient|payment required|\b402\b|cashu|hard_floor/.test(l)) return ERROR_CODES.INSUFFICIENT_FUNDS;
  if (/no content in stream|empty stream/.test(l)) return ERROR_CODES.UPSTREAM_EMPTY;
  if (/http 5\d\d/.test(l)) return ERROR_CODES.UPSTREAM_5XX;
  return null;
}
