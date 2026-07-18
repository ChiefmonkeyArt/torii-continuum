/**
 * Routstr client — OpenAI-compatible model layer, paid per request in Cashu.
 *
 * Flow per request:
 *   1. Pick the model from cfg.routstr.models[skill]. Default "chat" if unknown.
 *   2. Ask wallet.send(estimated_sats) for a Cashu token.
 *   3. POST to `${endpoint}/v1/chat/completions` with:
 *        X-Cashu: <cashuA token>   (Routstr's per-request stateless payment
 *                                   header — see docs.routstr.com/api/overview)
 *      body: { model, messages, max_tokens, ... }
 *   4. Parse OpenAI-shaped response.
 *   5. Reclaim change: Routstr returns the unused sats as a Cashu token in the
 *      `X-Cashu-Refund` response header. We receive() it straight back into the
 *      wallet so the balance only loses what the request actually cost.
 *   6. Log to cost log. Return content + usage (sats_spent net of the refund).
 *
 * If the primary provider fails AND cfg.routstr.fallback.enabled === true,
 * walk the fallback ladder for the skill. Each ladder attempt gets its own
 * Cashu token (rollback the previous one first).
 *
 * We intentionally do NOT stream in v1. Streaming complicates rollback and
 * offers no perceived-latency benefit for the short replies the console
 * needs. Add streaming in a follow-up slice.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { agentRoot } from './config.mjs';

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
 * Read the X-Cashu-Refund token off a fetch Response. Tolerates both a real
 * Headers object (has .get) and a plain-object header bag (test doubles).
 * Returns a trimmed non-empty string or null.
 */
function readRefundHeader(res) {
  const headers = res?.headers;
  let raw = null;
  if (headers && typeof headers.get === 'function') {
    raw = headers.get('x-cashu-refund') ?? headers.get('X-Cashu-Refund');
  } else if (headers && typeof headers === 'object') {
    raw = headers['x-cashu-refund'] ?? headers['X-Cashu-Refund'];
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
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

  async function callOnce(model, messages, sats) {
    const send = await wallet.send(sats);
    if (!send.ok) {
      return { ok: false, reason: `wallet: ${send.reason}` };
    }

    const url = `${endpoint}/v1/chat/completions`;
    const started = Date.now();
    let res, body;
    try {
      res = await fetch(url, {
        method: 'POST',
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
          stream: false,
        }),
      });
      body = await res.text();
    } catch (e) {
      await send.rollback();
      return { ok: false, reason: `network: ${e.message}` };
    }

    if (!res.ok) {
      await send.rollback();
      return { ok: false, reason: `http ${res.status}: ${body.slice(0, 200)}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      // Rollback because we can't confirm the provider consumed the token.
      // In reality Cashu tokens are consumed atomically by the mint, but if
      // the response is malformed we're conservative.
      await send.rollback();
      return { ok: false, reason: `bad response json: ${e.message}` };
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      await send.rollback();
      return { ok: false, reason: 'no content in response' };
    }

    const usage = parsed.usage || {};
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
      return { ok: false, reason: 'messages must be a non-empty array' };
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
    });

    return attempt;
  }

  return { chat };
}
