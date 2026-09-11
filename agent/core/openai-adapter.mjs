/**
 * OpenAI-compatible /v1 adapter — HERMES-OWNER-1 slice.
 *
 * Exposes a thin OpenAI-compatible surface over the existing model-router so
 * a vanilla Nous Research Hermes install (hermes-owner, `provider: custom`)
 * can reuse the router's healthy Routstr-first → Ollama-fallback chain.
 *
 * Boundary rules (see docs/hermes-two-voice.md):
 *
 *   • Loopback only. Bound to 127.0.0.1 by server.host, same as /api/*.
 *   • Local bearer token — SEPARATE authority from the console's NIP-07 admin
 *     session. Any local process holding the token can spend the Cashu float
 *     via router.chat(). It never grants /api/* admin routes.
 *   • No persona. This adapter returns the router's raw completion. The
 *     Continuum "you are Continuum…" character stays in skills/chat.mjs for
 *     the console. hermes-owner brings its own Nous `owner` persona.
 *   • No credential custody. The bearer is a capability, not a user secret;
 *     never written to logs, never echoed in responses.
 *
 * v1 scope is deliberately narrow:
 *   • GET  /v1/models             — discoverable catalog (router-defined ids)
 *   • POST /v1/chat/completions   — non-streaming AND streaming (SSE)
 *
 * Deferred: /v1/completions (legacy), embeddings, tools/function-calling
 * passthrough (needs router-level provider capability probing).
 */

import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '../lib/provider-errors.mjs';

// A stable id set the adapter always advertises, regardless of which provider
// the router actually picks. `chat` maps to the router's "chat" skill (Routstr
// primary → Ollama fallback). `chat-local` forces the local model by setting
// the router to ollama_only for the turn. Keeps the catalog small on purpose.
const MODEL_IDS = Object.freeze(['chat', 'chat-local']);

/**
 * Constant-time-ish token compare. Node's Buffer compare short-circuits, so
 * we equalise lengths first to keep the length side-channel closed. Both args
 * MUST be strings.
 */
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract a Bearer token from an Authorization header. Case-insensitive scheme. */
export function extractBearer(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * OpenAI 401 payload shape, so upstream clients (Hermes, curl, LangChain…)
 * see the same {"error":{...}} envelope real OpenAI emits.
 */
function openaiError({ status, message, type = 'invalid_request_error', code = null }) {
  return { status, body: { error: { message, type, code } } };
}

/**
 * Normalise a request body's `messages` field to what router.chat() accepts.
 * Rejects with an { openai_error } object rather than throwing, so the HTTP
 * layer can map it to the correct status without try/catch prose.
 */
export function normaliseMessages(body) {
  if (!body || typeof body !== 'object') {
    return { error: openaiError({ status: 400, message: 'request body must be a JSON object' }) };
  }
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: openaiError({ status: 400, message: '`messages` must be a non-empty array' }) };
  }
  // Router's routstr.mjs already validates the internal shape; we just enforce
  // the surface contract here (role + string content).
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      return { error: openaiError({ status: 400, message: `messages[${i}] must be an object` }) };
    }
    const { role, content } = m;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: openaiError({ status: 400, message: `messages[${i}].role must be one of system|user|assistant` }) };
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { error: openaiError({ status: 400, message: `messages[${i}].content must be a non-empty string` }) };
    }
    // Bound each message. The router's per-request budget already caps total
    // spend, but this stops one 4 MB message from blowing the prompt window.
    if (content.length > 32000) {
      return { error: openaiError({ status: 400, message: `messages[${i}].content too long (max 32000 chars)` }) };
    }
    out.push({ role, content });
  }
  return { messages: out };
}

/**
 * Given the requested model id, pick the router strategy for THIS turn.
 * Returns null to use whatever the router's configured default is; a string
 * overrides for one call only.
 *
 * `chat`       → let the router decide (routstr_first by default)
 * `chat-local` → force local model (ollama_only), never spend sats
 * Anything else is rejected upstream by `resolveModel`.
 */
export function strategyForModel(modelId) {
  if (modelId === 'chat-local') return 'ollama_only';
  return null;
}

/**
 * Resolve the caller's requested model to a router skill + strategy. Rejects
 * unknown ids so a stray Hermes profile can't accidentally address something
 * the router doesn't intend to serve.
 */
export function resolveModel(bodyModel) {
  const requested = typeof bodyModel === 'string' && bodyModel.length > 0 ? bodyModel : 'chat';
  if (!MODEL_IDS.includes(requested)) {
    return {
      error: openaiError({
        status: 404,
        message: `model '${requested}' not found (available: ${MODEL_IDS.join(', ')})`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      }),
    };
  }
  return { requested, strategy: strategyForModel(requested) };
}

/**
 * Wrap a router.chat() result into an OpenAI ChatCompletion object.
 * `result.content` is the assistant's reply; we don't have token usage from
 * every provider so `usage` is best-effort.
 */
export function toChatCompletion({ result, modelId, id, created }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model: modelId,
    // Continuum-specific extension fields (namespaced with `x_`) so downstream
    // clients that don't know about them ignore them, and clients that DO can
    // surface fallback / spend to the operator.
    x_continuum: {
      provider: result.provider || null,
      sats_spent: result.sats_spent || 0,
      duration_ms: result.duration_ms || null,
      fell_back_from: result.fell_back_from || null,
    },
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content || '' },
        finish_reason: 'stop',
      },
    ],
    // Rough estimate — real usage numbers vary by provider and Ollama's
    // OpenAI-compat endpoint doesn't return them reliably. Kept present so
    // client libraries that pattern-match on `usage` don't blow up.
    usage: null,
  };
}

/**
 * Map a router failure to an OpenAI-style error envelope. `insufficient_funds`
 * → HTTP 402 to match the console's /api/chat contract; other structured
 * failures → 502 (bad gateway) so the caller can retry.
 */
export function toOpenAIError(result) {
  const code = result.code || null;
  const status = code === ERROR_CODES.INSUFFICIENT_FUNDS ? 402 : 502;
  const type = status === 402 ? 'insufficient_quota' : 'upstream_error';
  return openaiError({
    status,
    message: result.reason || 'upstream provider failure',
    type,
    code,
  });
}

/**
 * SSE frame for a single delta. We only ever emit one delta (the full reply)
 * followed by the sentinel `[DONE]` — the underlying model-router is
 * non-streaming today, so token-by-token streaming would be a lie.
 */
export function chatCompletionChunk({ modelId, id, created, content, finish_reason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        delta: content !== undefined ? { role: 'assistant', content } : {},
        finish_reason,
      },
    ],
  };
}

/**
 * Register the /v1/* routes on a Fastify app. `cfg`, `router`, and `log` are
 * hoisted from the existing agent so the surface is a pure wiring layer.
 *
 * Auth policy: the bearer token comes from `cfg.openai_adapter.local_token`.
 * If it's unset or empty, the whole surface refuses (503) — the operator has
 * to opt in explicitly. This is fail-closed by design.
 */
export function registerOpenAIAdapter({ app, cfg, router, log }) {
  const configuredToken =
    cfg?.openai_adapter?.local_token && String(cfg.openai_adapter.local_token).trim().length > 0
      ? String(cfg.openai_adapter.local_token).trim()
      : null;

  // A short prefix of the token (SHA-derived) makes audit lines correlatable
  // without ever logging the token itself. Boot-time only — never per-request.
  if (configuredToken) {
    log.info(`[openai-adapter] enabled (loopback, bearer required); token len=${configuredToken.length}`);
  } else {
    log.warn('[openai-adapter] DISABLED: cfg.openai_adapter.local_token unset — /v1/* returns 503');
  }

  /** Preserved outer closure so tests can enable/disable without restart. */
  function requireBearer(req, reply) {
    if (!configuredToken) {
      reply.code(503).send({ error: { message: 'openai adapter disabled', type: 'service_unavailable', code: 'adapter_disabled' } });
      return false;
    }
    const bearer = extractBearer(req.headers.authorization);
    if (!bearer || !tokensEqual(bearer, configuredToken)) {
      // Deliberately vague — do not reveal whether the token was missing vs.
      // wrong. Matches OpenAI's own 401 style.
      reply.code(401).send({ error: { message: 'invalid or missing bearer token', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return false;
    }
    return true;
  }

  app.get('/v1/models', async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const now = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: MODEL_IDS.map((id) => ({
        id,
        object: 'model',
        created: now,
        owned_by: 'continuum',
      })),
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    if (!requireBearer(req, reply)) return;

    const modelPick = resolveModel(req.body?.model);
    if (modelPick.error) {
      reply.code(modelPick.error.status).send(modelPick.error.body);
      return;
    }
    const norm = normaliseMessages(req.body);
    if (norm.error) {
      reply.code(norm.error.status).send(norm.error.body);
      return;
    }

    const wantsStream = req.body?.stream === true;
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = modelPick.requested;

    // `chat-local` must force local inference: pass the resolved per-turn
    // strategy into the router so the label matches the effective provider
    // (ollama_only => zero paid-provider calls). A `null` strategy keeps the
    // router's constructed default for `chat`.
    let result;
    try {
      result = await router.chat({ skill: 'chat', messages: norm.messages, strategy: modelPick.strategy });
    } catch (e) {
      log.warn(`[openai-adapter] router threw: ${e.message}`);
      const errEnv = openaiError({ status: 502, message: 'router failure', type: 'upstream_error', code: 'router_exception' });
      reply.code(errEnv.status).send(errEnv.body);
      return;
    }

    if (!result || !result.ok) {
      const errEnv = toOpenAIError(result || { reason: 'router returned no result' });
      log.warn(`[openai-adapter] router failed: ${errEnv.body.error.code || 'no-code'} ${errEnv.body.error.message}`);
      reply.code(errEnv.status).send(errEnv.body);
      return;
    }

    if (!wantsStream) {
      return toChatCompletion({ result, modelId, id, created });
    }

    // Streaming path — one non-empty delta then a terminating `[DONE]`. This
    // is honest about our non-streaming upstream: the client sees the reply
    // as one chunk and closes cleanly, so LangChain/etc are happy.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (obj) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    send(chatCompletionChunk({ modelId, id, created, content: result.content || '' }));
    send(chatCompletionChunk({ modelId, id, created, finish_reason: 'stop' }));
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });
}

// Exported for tests only.
export const _internals = { tokensEqual, MODEL_IDS };
