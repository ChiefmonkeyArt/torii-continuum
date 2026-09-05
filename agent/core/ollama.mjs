/**
 * Ollama client — local, free, offline chat completions.
 *
 * Purpose: fallback path when Routstr is unreachable, the Cashu float is dry,
 * or the operator has explicitly opted for local-only inference (e.g. running
 * on a device with a GPU and no desire to pay per token).
 *
 * Public shape matches routstr.chat() so chat.mjs can call either interchangeably:
 *
 *   { ok, content, model, tokens_in, tokens_out, sats_spent, duration_ms }
 *
 * sats_spent is always 0 for Ollama (that's the whole point).
 *
 * Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions since
 * v0.1.14, so we use that instead of the native /api/chat — same request/
 * response shape as Routstr, less mapping code.
 *
 * Config (agent/config.yaml):
 *   ollama:
 *     enabled: true
 *     endpoint: http://127.0.0.1:11434   # default Ollama bind
 *     model: llama3.2:3b                 # default when skill has no override
 *     models:
 *       chat: llama3.2:3b
 *       reflect: qwen2.5:7b              # heavier model for offline work
 *     timeout_ms: 60000
 *
 * On a fresh VPS the installer pulls the configured model with
 * `ollama pull <model>` so the first chat turn isn't a cold-start wait.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { agentRoot } from './config.mjs';
import {
  ERROR_CODES, classifyHttpFailure, classifyThrownError, providerFailure,
} from '../lib/provider-errors.mjs';
import { sliceForProvider, worthAttempting } from '../lib/timeout-budget.mjs';

function modelForSkill(cfg, skill) {
  const explicit = cfg.ollama?.models?.[skill];
  if (explicit) return explicit;
  return cfg.ollama?.model || 'llama3.2:3b';
}

async function appendCostLog(cfg, entry) {
  // Ollama runs cost NOTHING in sats. We still log them so the operator
  // can see model usage patterns in one place. sats_spent will always be 0.
  const path = resolve(agentRoot(), cfg.logging?.cost_log || 'memory/costs.jsonl');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function createOllama(cfg, log) {
  const enabled = cfg.ollama?.enabled === true;
  const endpoint = (cfg.ollama?.endpoint || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const configuredTimeoutMs = cfg.ollama?.timeout_ms || 60000;
  const maxTokens = cfg.ollama?.max_tokens_out || 2048;

  /**
   * Reachability probe. Returns { ok, models?, reason? }.
   * Used by /api/health/models and `torii doctor`.
   */
  async function probe() {
    if (!enabled) return { ok: false, reason: 'disabled' };
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch(`${endpoint}/api/tags`, { signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      const body = await res.json().catch(() => ({}));
      const models = Array.isArray(body.models) ? body.models.map((m) => m.name) : [];
      return { ok: true, endpoint, models };
    } catch (e) {
      return { ok: false, reason: `unreachable: ${e.message}` };
    }
  }

  /**
   * chat({ skill, messages, budget_ms })
   * `budget_ms` is the wall-clock the router has left for the turn. The call is
   * clamped to min(configured timeout, remaining budget) — this is what keeps a
   * 180s `ollama.timeout_ms` from outliving nginx's 120s read timeout. Omitting
   * it keeps the configured timeout, so the provider still works standalone.
   */
  async function chat({ skill = 'chat', messages, budget_ms = null }) {
    if (!enabled) return providerFailure(ERROR_CODES.PROVIDER_DISABLED, 'ollama disabled');
    if (!Array.isArray(messages) || messages.length === 0) {
      return providerFailure(ERROR_CODES.BAD_REQUEST, 'messages must be a non-empty array');
    }
    const hasBudget = budget_ms !== null && budget_ms !== undefined;
    if (hasBudget && !worthAttempting(budget_ms)) {
      return providerFailure(
        ERROR_CODES.BUDGET_EXHAUSTED,
        `ollama skipped: only ${Math.max(0, Math.floor(budget_ms))}ms of the turn budget left`,
      );
    }
    const timeoutMs = sliceForProvider(configuredTimeoutMs, hasBudget ? budget_ms : null);

    const model = modelForSkill(cfg, skill);
    const started = Date.now();

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Ollama's OpenAI-compat endpoint tolerates a missing Authorization
        // header. No need to send a fake bearer.
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          // Deterministic-ish. Chat is not creative writing.
          temperature: cfg.ollama?.temperature ?? 0.4,
          stream: false,
          // Keep the model resident in RAM between requests. On a CPU-only VPS
          // the model load is the slow part (2-8s cold-start); with Routstr
          // as the primary and Ollama as the fallback path, we don't want to
          // pay that cost every time the router degrades. `-1` = keep loaded
          // until Ollama is restarted or evicted for another model. Falls
          // back to the default when config overrides with something else
          // (e.g. `"5m"` on a memory-constrained host).
          keep_alive: cfg.ollama?.keep_alive ?? -1,
          // Cap the KV-cache context window. Ollama's `/v1/chat/completions`
          // ignores model Modelfile context and silently truncates at 4096
          // unless `options.num_ctx` is set. Capping small keeps RAM predictable
          // on the fallback path — the chat skill's turns are short. Bigger
          // skills (e.g. reflect) may override via cfg.ollama.num_ctx.
          options: {
            num_ctx: cfg.ollama?.num_ctx ?? 4096,
          },
        }),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(t);
      const failure = classifyThrownError(e, { timeoutMs, provider: 'ollama' });
      log.warn(`[ollama] ${model} failed: ${failure.reason}`);
      await appendCostLog(cfg, {
        at: new Date().toISOString(),
        provider: 'ollama',
        skill,
        model,
        ok: false,
        sats_spent: 0,
        reason: failure.reason,
        code: failure.code,
        duration_ms: Date.now() - started,
      });
      return failure;
    }
    clearTimeout(t);

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const failure = classifyHttpFailure({ status: res.status, body: bodyText, provider: 'ollama' });
      log.warn(`[ollama] ${model} failed: ${failure.reason}`);
      await appendCostLog(cfg, {
        at: new Date().toISOString(),
        provider: 'ollama',
        skill,
        model,
        ok: false,
        sats_spent: 0,
        reason: failure.reason,
        code: failure.code,
        duration_ms: Date.now() - started,
      });
      return failure;
    }

    let parsed;
    try {
      parsed = await res.json();
    } catch (e) {
      return providerFailure(ERROR_CODES.UPSTREAM_BAD_JSON, `ollama returned malformed JSON: ${e.message}`);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      return providerFailure(ERROR_CODES.UPSTREAM_EMPTY, 'ollama returned an empty completion');
    }

    const usage = parsed.usage || {};
    const durationMs = Date.now() - started;

    await appendCostLog(cfg, {
      at: new Date().toISOString(),
      provider: 'ollama',
      skill,
      model,
      ok: true,
      tokens_in: usage.prompt_tokens || 0,
      tokens_out: usage.completion_tokens || 0,
      sats_spent: 0,
      duration_ms: durationMs,
    });

    return {
      ok: true,
      content,
      model,
      tokens_in: usage.prompt_tokens || 0,
      tokens_out: usage.completion_tokens || 0,
      sats_spent: 0,
      duration_ms: durationMs,
      provider: 'ollama',
    };
  }

  return { chat, probe, enabled };
}
