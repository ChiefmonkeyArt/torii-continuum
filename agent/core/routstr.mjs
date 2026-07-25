/**
 * Routstr client — OpenAI-compatible model layer, paid per request in Cashu.
 *
 * Flow per request:
 *   1. Pick the model from cfg.routstr.models[skill]. Default "chat" if unknown.
 *   2. Ask wallet.send(estimated_sats) for a Cashu token.
 *   3. POST to `${endpoint}/v1/chat/completions` with:
 *        X-Cashu: <cashuA v3 token>  (Routstr's per-request stateless payment
 *                                     header — see docs.routstr.com/api/overview.
 *                                     Must be v3/cashuA: Routstr's melt step
 *                                     crashes on v4/cashuB → Cloudflare 520.)
 *      body: { model, messages, max_tokens, stream: true }
 *   4. Parse the text/event-stream response: accumulate choices[].delta.content
 *      across the SSE `data:` chunks into a single reply string, stopping at the
 *      `data: [DONE]` terminator.
 *   5. Reclaim change: Routstr returns the unused sats as a Cashu token in the
 *      `X-Cashu` (or legacy `X-Cashu-Refund`) response header. We receive() it
 *      straight back into the wallet so the balance only loses what the request
 *      actually cost.
 *   6. Log to cost log. Return content + usage (sats_spent net of the refund).
 *
 * If the primary provider fails AND cfg.routstr.fallback.enabled === true,
 * walk the fallback ladder for the skill. Each ladder attempt gets its own
 * Cashu token (rollback the previous one first).
 *
 * We stream (stream: true) because Routstr's NON-streaming path returns a
 * Cloudflare 520 for every model — the melt succeeds but the response builder
 * crashes. Streaming returns a real SSE reply (HTTP 200). We still buffer the
 * whole stream and hand the chat handler a plain string, so rollback semantics
 * are unchanged: the payment is committed the moment the request is dispatched.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { agentRoot } from './config.mjs';
import {
  ERROR_CODES, classifyHttpFailure, classifyThrownError, providerFailure, looksLikeHtml,
} from '../lib/provider-errors.mjs';

/** Wall-clock deadline for a chat completion when config doesn't set one. */
const DEFAULT_CHAT_TIMEOUT_MS = 45000;

/**
 * Rough estimate — we don't have per-model pricing yet, so we allocate up to
 * cfg.routstr.limits.max_sats_per_request. If the provider charges less, the
 * change comes back in the response body and we credit it (v2). For now we
 * over-allocate and rollback on failure only.
 */
function estimateSats(cfg, _skill) {
  return cfg.routstr.limits?.max_sats_per_request || 50;
}

/**
 * Read the refund Cashu token off a fetch Response. Routstr returns the change
 * from an over-payment in the `X-Cashu` response header; older builds used
 * `X-Cashu-Refund`. We check both. Tolerates a real Headers object (has .get)
 * and a plain-object header bag (test doubles). Returns a trimmed non-empty
 * string or null.
 */
function readRefundHeader(res) {
  const headers = res?.headers;
  if (!headers) return null;
  // A real Headers object is case-insensitive; a plain-object / Map bag (test
  // doubles) is not, so we probe each canonical casing explicitly.
  const candidates = ['x-cashu-refund', 'X-Cashu-Refund', 'x-cashu', 'X-Cashu'];
  const pick = (name) => {
    if (typeof headers.get === 'function') return headers.get(name);
    if (typeof headers === 'object') return headers[name];
    return null;
  };
  let raw = null;
  for (const name of candidates) {
    raw = pick(name);
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/**
 * Parse a text/event-stream chat-completions body. Reads each SSE `data:` line,
 * JSON-parses the chunk, and accumulates choices[0].delta.content into a single
 * reply string. Stops at the `data: [DONE]` terminator. A trailing chunk may
 * carry `usage`; we surface it when present. Non-JSON or non-data lines (event:,
 * comments, blank keep-alives, a Cloudflare HTML error body) are skipped, so a
 * garbage 200 body simply yields empty content.
 */
function parseSSE(body) {
  let content = '';
  let usage = null;
  if (typeof body !== 'string') return { content, usage };
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') {
      if (data === '[DONE]') break;
      continue;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const delta = chunk.choices?.[0]?.delta;
    if (delta && typeof delta.content === 'string') content += delta.content;
    if (chunk.usage) usage = chunk.usage;
  }
  return { content, usage };
}

/**
 * Detect Routstr's `token_already_spent` rejection (HTTP 400). Routstr returns
 * { error: { message, type: "token_already_spent", code: "cashu_token_already_spent" } }.
 * We match on the structured code/type first, then fall back to a text probe.
 */
function isTokenAlreadySpent(status, body) {
  if (status !== 400) return false;
  try {
    const j = JSON.parse(body);
    const code = j?.error?.code || j?.code;
    const type = j?.error?.type || j?.type;
    if (code === 'cashu_token_already_spent' || type === 'token_already_spent') return true;
  } catch { /* fall through to text probe */ }
  return /token[_ ]already[_ ]spent/i.test(body || '');
}

/**
 * fetch() with a hard wall-clock timeout via AbortController. Used for the
 * best-effort refund reclaim so a hung Routstr can't stall the caller.
 */
function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

/**
 * Env-gated 520-diagnosis probe (OFF by default; set ROUTSTR_DEBUG=1 to enable).
 * Logs ONLY non-sensitive response metadata: HTTP status, Cloudflare cf-ray,
 * whether a refund header rode back, the token PREFIX (e.g. "cashuA"/"cashuB",
 * never the full token), and the first ~200 chars of the body. NEVER logs the
 * full token, proofs, or message contents.
 */
function debugProbe(log, res, body, token) {
  if (process.env.ROUTSTR_DEBUG !== '1') return;
  let cfRay = null;
  const h = res?.headers;
  if (h && typeof h.get === 'function') cfRay = h.get('cf-ray') ?? h.get('CF-Ray');
  else if (h && typeof h === 'object') cfRay = h['cf-ray'] ?? h['CF-Ray'];
  log.info(`[routstr:debug] status=${res?.status} cf-ray=${cfRay || 'none'} ` +
    `refund_hdr=${readRefundHeader(res) ? 'yes' : 'no'} ` +
    `token_prefix=${typeof token === 'string' ? token.slice(0, 7) : 'n/a'} ` +
    `body="${typeof body === 'string' ? body.slice(0, 200) : ''}"`);
}

function modelForSkill(cfg, skill) {
  const explicit = cfg.routstr.models?.[skill];
  if (explicit) return explicit;
  return cfg.routstr.models?.chat || 'auto';
}

function fallbackLadder(cfg, skill) {
  if (!cfg.routstr.fallback?.enabled) return null;
  const ladder = cfg.routstr.fallback?.[skill];
  return Array.isArray(ladder) && ladder.length > 0 ? ladder : null;
}

async function appendCostLog(cfg, entry) {
  const path = resolve(agentRoot(), cfg.logging?.cost_log || 'memory/costs.jsonl');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function createRoutstr(cfg, wallet, log) {
  const endpoint = cfg.routstr.endpoint.replace(/\/$/, '');
  const maxTokens = cfg.routstr.limits?.max_tokens_out || 2048;
  // Without a deadline a hung Routstr edge holds the chat request open forever
  // and the operator sees a spinner instead of the local-model fallback.
  const chatTimeoutMs = cfg.routstr.limits?.timeout_ms || DEFAULT_CHAT_TIMEOUT_MS;

  /**
   * Best-effort refund reclaim for a payment token whose change we may have
   * lost. Called when the request was dispatched but no X-Cashu-Refund came
   * back (network drop, 5xx/520, non-JSON body). Asks Routstr to refund the
   * original payment token; if it hands back a Cashu token, we claim it through
   * wallet.receive (a real mint swap). Any failure is swallowed — and crucially
   * we NEVER re-add the original payment token to spendable balance, since after
   * dispatch it is spent/unknown.
   */
  async function tryRefundReclaim(paymentToken) {
    if (!paymentToken) return;
    let res, body;
    try {
      res = await fetchWithTimeout(`${endpoint}/v1/wallet/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cashu': paymentToken },
      }, 10000);
      body = await res.text();
    } catch (e) {
      log.warn(`[routstr] refund reclaim request failed: ${e.message}`);
      return;
    }
    if (!res.ok) {
      log.warn(`[routstr] refund reclaim http ${res.status}`);
      return;
    }
    // The refunded token may ride in the X-Cashu-Refund header or a JSON body.
    let refundToken = readRefundHeader(res);
    if (!refundToken) {
      try {
        const j = JSON.parse(body);
        const t = j?.token || j?.cashu || j?.refund;
        refundToken = typeof t === 'string' && t.trim() ? t.trim() : null;
      } catch { /* no token in body */ }
    }
    if (!refundToken) {
      log.info('[routstr] refund reclaim: nothing to reclaim');
      return;
    }
    try {
      const claim = await wallet.receive(refundToken);
      if (claim.ok) log.info(`[routstr] refund reclaim recovered ${claim.added_sats || 0} sats`);
      else log.warn(`[routstr] refund reclaim rejected: ${claim.reason}`);
    } catch (e) {
      log.warn(`[routstr] refund reclaim claim failed: ${e.message}`);
    }
  }

  async function callOnce(model, messages, sats, allowRetry = true) {
    const send = await wallet.send(sats);
    if (!send.ok) {
      // A dry / floor-blocked wallet is a payment-path failure: structured so the
      // router can downgrade to the free local model and the SPA can offer top-up.
      return {
        ok: false,
        code: send.code || ERROR_CODES.INSUFFICIENT_FUNDS,
        reason: `wallet: ${send.reason}`,
        retryable: true,
      };
    }

    // Retained for refund reclaim. NOT used to roll back into spendable balance.
    const paymentToken = send.token;
    const url = `${endpoint}/v1/chat/completions`;
    const started = Date.now();
    let res, body;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), chatTimeoutMs);
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          // Routstr's stateless per-request payment: the Cashu eCash token
          // rides in X-Cashu, NOT Authorization. Sending it as an Authorization
          // scheme yields http 401 "API key or Cashu token required".
          'X-Cashu': send.token,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          // Routstr's non-streaming path 520s for every model (the melt
          // succeeds, then the response builder crashes). Streaming returns a
          // real SSE reply. We buffer the whole stream below.
          stream: true,
        }),
      });
      body = await res.text();
      debugProbe(log, res, body, send.token);
    } catch (e) {
      // AFTER dispatch: the token is spent/unknown — NEVER roll it back into
      // spendable balance. Try to reclaim a lost refund instead.
      await tryRefundReclaim(paymentToken);
      return classifyThrownError(e, { timeoutMs: chatTimeoutMs, provider: 'routstr' });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // AFTER dispatch: NEVER roll back.
      if (isTokenAlreadySpent(res.status, body)) {
        // The proofs we paid with were already spent (stale wallet state).
        // Quarantine them by exact identity and retry ONCE with fresh proofs.
        if (typeof send.markSpent === 'function') await send.markSpent();
        if (allowRetry) {
          log.warn('[routstr] token_already_spent — quarantined stale proofs, retrying once with fresh');
          return callOnce(model, messages, sats, false);
        }
        return providerFailure(
          ERROR_CODES.TOKEN_ALREADY_SPENT,
          'routstr rejected the payment token as already spent',
          { status: res.status },
        );
      }
      // A 5xx/520 (or an HTML edge error page) likely dropped the X-Cashu-Refund
      // — attempt refund reclaim before reporting.
      if (res.status >= 500 || looksLikeHtml(body)) await tryRefundReclaim(paymentToken);
      // Structured + sanitised: the raw upstream body (often a Cloudflare HTML
      // page) is classified, never spliced into the client-visible reason.
      return classifyHttpFailure({ status: res.status, body, provider: 'routstr' });
    }

    // Streaming: the 200 body is a text/event-stream. Accumulate the delta
    // content into a single reply string (the chat handler expects a plain
    // string). We buffer the full body via res.text() rather than reading the
    // stream incrementally — replies are short and buffering keeps the payment
    // rollback contract unchanged (the token is committed at dispatch time).
    const { content, usage: streamUsage } = parseSSE(body);
    if (!content) {
      // 200 with no usable SSE content. Two distinct cases, both retryable but
      // worth telling apart: a proxy served an HTML error page under a 200
      // status, or the stream really was empty. The token is already handed off
      // — do NOT roll back; try to reclaim any lost refund instead.
      await tryRefundReclaim(paymentToken);
      if (looksLikeHtml(body)) {
        return classifyHttpFailure({ status: res.status, body, provider: 'routstr' });
      }
      return providerFailure(
        ERROR_CODES.UPSTREAM_EMPTY,
        'routstr returned an empty completion stream',
        { status: res.status },
      );
    }

    const usage = streamUsage || {};
    const durationMs = Date.now() - started;

    // Reclaim change. Routstr consumes only what the request cost and returns
    // the unused sats as a Cashu token in X-Cashu-Refund. We receive() it back
    // into the wallet so over-allocation isn't lost. A refund failure must NOT
    // fail an otherwise-successful request — the completion already happened;
    // we log and move on, treating the whole allocation as spent.
    let refundedSats = 0;
    const refundToken = readRefundHeader(res);
    if (refundToken) {
      try {
        const claim = await wallet.receive(refundToken);
        if (claim.ok) {
          refundedSats = claim.added_sats || 0;
          if (refundedSats > 0) log.info(`[routstr] reclaimed ${refundedSats} sats of change`);
        } else {
          log.warn(`[routstr] refund reclaim rejected: ${claim.reason}`);
        }
      } catch (e) {
        log.warn(`[routstr] refund reclaim failed: ${e.message}`);
      }
    }

    return {
      ok: true,
      content,
      model,
      tokens_in: usage.prompt_tokens || 0,
      tokens_out: usage.completion_tokens || 0,
      sats_spent: Math.max(0, sats - refundedSats),
      sats_refunded: refundedSats,
      duration_ms: durationMs,
    };
  }

  /**
   * Public: chat({ skill, messages })
   * skill selects the model + fallback ladder.
   */
  async function chat({ skill = 'chat', messages }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      // Non-retryable: a malformed call is a bug, not an outage. The router must
      // NOT downgrade to the free local model and hide it.
      return providerFailure(ERROR_CODES.BAD_REQUEST, 'messages must be a non-empty array');
    }

    const primary = modelForSkill(cfg, skill);
    const sats = estimateSats(cfg, skill);

    // Primary attempt
    let attempt = await callOnce(primary, messages, sats);
    let attemptedModels = [primary];

    if (!attempt.ok) {
      log.warn(`[routstr] primary ${primary} failed: ${attempt.reason}`);
      const ladder = fallbackLadder(cfg, skill);
      if (ladder) {
        for (const model of ladder) {
          if (model === primary) continue;
          attemptedModels.push(model);
          log.info(`[routstr] falling back to ${model}`);
          attempt = await callOnce(model, messages, sats);
          if (attempt.ok) break;
          log.warn(`[routstr] fallback ${model} failed: ${attempt.reason}`);
        }
      }
    }

    // Cost log — one line per attempt outcome
    await appendCostLog(cfg, {
      at: new Date().toISOString(),
      skill,
      model: attempt.ok ? attempt.model : attemptedModels[attemptedModels.length - 1],
      ok: attempt.ok,
      tokens_in: attempt.tokens_in || 0,
      tokens_out: attempt.tokens_out || 0,
      sats_spent: attempt.ok ? attempt.sats_spent : 0,
      duration_ms: attempt.duration_ms || 0,
      attempted_models: attemptedModels,
      reason: attempt.ok ? null : attempt.reason,
      code: attempt.ok ? null : attempt.code || null,
    });

    return attempt;
  }

  return { chat };
}
