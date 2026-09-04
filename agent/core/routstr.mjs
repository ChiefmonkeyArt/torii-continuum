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
import {
  createBudget, sliceForProvider, worthAttempting, describeBudget,
} from '../lib/timeout-budget.mjs';
import {
  discoverProviders, fetchProviderCatalog, estimateSatsForModel,
} from './routstr-discovery.mjs';

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

export function createRoutstr(cfg, wallet, log, deps = {}) {
  const maxTokens = cfg.routstr.limits?.max_tokens_out || 2048;
  // Without a deadline a hung Routstr edge holds the chat request open forever
  // and the operator sees a spinner instead of the local-model fallback.
  const chatTimeoutMs = cfg.routstr.limits?.timeout_ms || DEFAULT_CHAT_TIMEOUT_MS;

  // Routstr Core v0.1.0 (RIP-03): providers are discovered, not hard-coded.
  // Deterministic bootstrap endpoints lead (explicit `providers`, then
  // `discovery.bootstrap_endpoints`, then the legacy single `endpoint`); live
  // Nostr kind-38421 announcements are merged in. `endpoint` is kept only for
  // backwards compatibility and as an offline fallback.
  const discovery = cfg.routstr.discovery || {};
  const legacyEndpoint = typeof cfg.routstr.endpoint === 'string'
    ? cfg.routstr.endpoint.replace(/\/$/, '')
    : null;
  const bootstrap = [];
  for (const b of [
    ...(Array.isArray(cfg.routstr.providers) ? cfg.routstr.providers : []),
    ...(Array.isArray(discovery.bootstrap_endpoints) ? discovery.bootstrap_endpoints : []),
    ...(legacyEndpoint ? [legacyEndpoint] : []),
  ]) {
    if (typeof b === 'string' && b.trim() && !bootstrap.includes(b)) bootstrap.push(b.trim());
  }
  const relays = Array.isArray(discovery.relays) && discovery.relays.length ? discovery.relays : undefined;

  // Provider + model registry, lazily populated on first chat and refreshed
  // every `refresh_minutes` (default 10) so model churn doesn't hard-code us to
  // a stale catalog. `deps` seams keep `node --test` hermetic.
  let catalog = [];
  let catalogAt = 0;
  let catalogPromise = null;
  const refreshMs = (discovery.refresh_minutes ?? 10) * 60 * 1000;

  async function ensureCatalog() {
    if (catalog.length && Date.now() - catalogAt < refreshMs) return catalog;
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      try {
        let providers;
        if (discovery.enabled === false) {
          providers = bootstrap.map((u) => ({ baseUrl: u, name: u, npub: null }));
        } else {
          providers = await (deps.discoverProviders || discoverProviders)({
            bootstrapEndpoints: bootstrap,
            relays,
            timeoutMs: discovery.timeout_ms,
            pool: deps.pool,
          });
        }
        const fetched = await (deps.fetchCatalog || fetchProviderCatalog)(providers, {
          timeoutMs: discovery.catalog_timeout_ms,
          fetchFn: deps.fetchFn || fetch,
        });
        catalog = fetched.filter((e) => Array.isArray(e.models) && e.models.length > 0);
        catalogAt = Date.now();
        const modelCount = catalog.reduce((n, p) => n + p.models.length, 0);
        if (catalog.length) {
          log.info(`[routstr] discovery: ${catalog.length} reachable provider(s), ${modelCount} model(s)`);
        } else {
          log.warn('[routstr] discovery: no reachable providers');
        }
      } catch (e) {
        log.warn(`[routstr] discovery failed: ${e.message}`);
      } finally {
        catalogPromise = null;
      }
      return catalog;
    })();
    return catalogPromise;
  }

  /**
   * Best-effort refund reclaim for a payment token whose change we may have
   * lost. Called when the request was dispatched but no X-Cashu-Refund came
   * back (network drop, 5xx/520, non-JSON body). Asks Routstr to refund the
   * original payment token; if it hands back a Cashu token, we claim it through
   * wallet.receive (a real mint swap). Any failure is swallowed — and crucially
   * we NEVER re-add the original payment token to spendable balance, since after
   * dispatch it is spent/unknown.
   */
  async function tryRefundReclaim(baseUrl, paymentToken) {
    if (!paymentToken) return;
    let res, body;
    try {
      res = await fetchWithTimeout(`${baseUrl}/v1/balance/refund`, {
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

  async function callOnceAt(baseUrl, model, messages, sats, timeoutMs = chatTimeoutMs, allowRetry = true) {
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
    const url = `${baseUrl}/v1/chat/completions`;
    const started = Date.now();
    let res, body;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
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
      await tryRefundReclaim(baseUrl, paymentToken);
      return classifyThrownError(e, { timeoutMs, provider: 'routstr' });
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
          return callOnceAt(baseUrl, model, messages, sats, timeoutMs, false);
        }
        return providerFailure(
          ERROR_CODES.TOKEN_ALREADY_SPENT,
          'routstr rejected the payment token as already spent',
          { status: res.status },
        );
      }
      // A 5xx/520 (or an HTML edge error page) likely dropped the X-Cashu-Refund
      // — attempt refund reclaim before reporting.
      if (res.status >= 500 || looksLikeHtml(body)) await tryRefundReclaim(baseUrl, paymentToken);
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
      await tryRefundReclaim(baseUrl, paymentToken);
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
   * Resolve the candidate list for `modelId` — ordered cheapest first by each
   * provider's declared max_cost_sats — so a primary failure fails over to the
   * next-cheapest provider. `modelId === null` means "auto": the cheapest model
   * across every reachable provider (a sensible default when config doesn't pin
   * one). Returns [{ baseUrl, model, providerName }].
   */
  async function resolveCandidates(modelId) {
    await ensureCatalog();
    const matches = [];
    for (const provider of catalog) {
      for (const m of provider.models) {
        if (modelId && m.id !== modelId) continue;
        matches.push({ baseUrl: provider.baseUrl, model: m, providerName: provider.name });
      }
    }
    matches.sort((a, b) => {
      const ac = a.model.max_cost_sats ?? Infinity;
      const bc = b.model.max_cost_sats ?? Infinity;
      if (ac !== bc) return ac - bc;
      return String(a.model.id).localeCompare(String(b.model.id));
    });
    return matches;
  }

  /** Sats to over-allocate: model-priced when the catalog exposes sats_pricing, else the config floor. */
  function satsFor(model, messages) {
    const est = estimateSatsForModel(model, maxTokens, messages);
    if (est != null) return est;
    return estimateSats(cfg, 'chat');
  }

  /**
   * Public: chat({ skill, messages, budget_ms })
   * Resolves the requested model to reachable providers (cheapest first) and
   * fails over across them within the turn budget. A config-pinned model that no
   * provider serves (stale config, e.g. the retired deepseek-v3.2) degrades to
   * the cheapest available model — loudly — rather than dead-ending chat.
   */
  async function chat({ skill = 'chat', messages, budget_ms = null }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return providerFailure(ERROR_CODES.BAD_REQUEST, 'messages must be a non-empty array');
    }

    const wanted = modelForSkill(cfg, skill);
    const requested = wanted === 'auto' ? null : wanted;
    const budget = budget_ms === null || budget_ms === undefined ? null : createBudget(budget_ms);
    const remaining = () => (budget ? budget.remainingMs() : null);
    const sliceNow = () => sliceForProvider(chatTimeoutMs, remaining());

    let candidates = await resolveCandidates(requested);
    if (requested && candidates.length === 0) {
      log.warn(`[routstr] configured model "${requested}" is not served by any reachable provider — degrading to cheapest available`);
      candidates = await resolveCandidates(null);
    }

    if (candidates.length === 0) {
      if (budget && !worthAttempting(budget.remainingMs())) {
        return providerFailure(ERROR_CODES.BUDGET_EXHAUSTED, `routstr skipped: ${describeBudget(budget)}`);
      }
      // Nothing reachable. Fall back to a directly-configured legacy endpoint
      // (offline / discovery-disabled operator) before failing closed.
      if (legacyEndpoint) {
        const attempt = await callOnceAt(legacyEndpoint, wanted, messages, satsFor(null, messages), sliceNow());
        await appendCostLog(cfg, {
          at: new Date().toISOString(), skill, model: wanted,
          ok: attempt.ok,
          tokens_in: attempt.tokens_in || 0, tokens_out: attempt.tokens_out || 0,
          sats_spent: attempt.ok ? attempt.sats_spent : 0, duration_ms: attempt.duration_ms || 0,
          attempted_models: [wanted],
          reason: attempt.ok ? null : attempt.reason, code: attempt.ok ? null : attempt.code || null,
        });
        return attempt;
      }
      return providerFailure(
        ERROR_CODES.PROVIDER_DISABLED,
        requested
          ? `no reachable Routstr provider serves model "${requested}"`
          : 'no reachable Routstr providers',
      );
    }

    const attemptedModels = [];
    let attempt = null;
    for (const cand of candidates) {
      attemptedModels.push(cand.model.id);
      if (budget && !worthAttempting(budget.remainingMs())) {
        attempt = providerFailure(ERROR_CODES.BUDGET_EXHAUSTED, `routstr skipped: ${describeBudget(budget)}`);
        break;
      }
      const sats = satsFor(cand.model, messages);
      attempt = await callOnceAt(cand.baseUrl, cand.model.id, messages, sats, sliceNow());
      if (attempt.ok) break;
      log.warn(`[routstr] ${cand.model.id}@${cand.baseUrl} failed: ${attempt.reason}`);
    }

    await appendCostLog(cfg, {
      at: new Date().toISOString(), skill,
      model: attempt && attempt.ok ? attempt.model : (attemptedModels[attemptedModels.length - 1] || wanted),
      ok: attempt ? !!attempt.ok : false,
      tokens_in: attempt ? attempt.tokens_in || 0 : 0,
      tokens_out: attempt ? attempt.tokens_out || 0 : 0,
      sats_spent: attempt && attempt.ok ? attempt.sats_spent : 0,
      duration_ms: attempt ? attempt.duration_ms || 0 : 0,
      attempted_models: attemptedModels,
      reason: attempt && !attempt.ok ? attempt.reason : null,
      code: attempt && !attempt.ok ? attempt.code || null : null,
    });

    return attempt;
  }

  return { chat, refreshCatalog: ensureCatalog };
}
