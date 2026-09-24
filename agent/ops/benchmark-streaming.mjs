// Explicit, operator-approved diagnostic. Never invoked by normal chat/startup.
import { pathToFileURL } from 'node:url';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, agentRoot } from '../core/config.mjs';
import { createWallet } from '../core/wallet.mjs';
import { createRoutstr } from '../core/routstr.mjs';
import { createRoutstrPayment } from '../core/routstr-payment.mjs';
import { discoverProviders, fetchProviderCatalog, estimateSatsForModel, safeRemoteBaseUrl } from '../core/routstr-discovery.mjs';
import { createChatTelemetry } from '../lib/chat-stream.mjs';

export const MESSAGES = [
  { role: 'system', content: 'You are a helpful assistant. Answer the request directly.' },
  { role: 'user', content: 'In about 120 words, explain how to plan a small vegetable garden. Use plain paragraphs, no lists or code, and no preamble.' },
];
const quiet = { info() {}, warn() {}, error() {} };
const MAX_REQUESTS = 6;
const MAX_SATS = 12;

export function boundedWallet(wallet, requestCap) {
  let calls = 0, allocated = 0, funded = 0;
  return {
    ...wallet,
    stats: () => ({ allocation_attempts: calls, allocation_budget_reserved_sats: allocated, funded_sats: funded }),
    async send(sats) {
      if (!Number.isSafeInteger(sats) || sats < 1 || sats > requestCap ||
          calls >= MAX_REQUESTS || allocated + sats > MAX_SATS) {
        return { ok: false, code: 'benchmark_budget', reason: 'Benchmark budget reached.' };
      }
      // Reserve even if the allocation throws: no ambiguous automatic retry.
      calls++;
      allocated += sats;
      const result = await wallet.send(sats);
      if (result.ok) funded += sats;
      return result;
    },
  };
}

export function selectPlan(catalog, maxTokens, cap) {
  const candidates = model => catalog.flatMap(p => p.models
    .filter(m => m.id === model)
    .map(m => ({ base: p.baseUrl, model: m, sats: estimateSatsForModel(m, maxTokens, MESSAGES) })))
    .filter(c => safeRemoteBaseUrl(c.base) === c.base && !new URL(c.base).search &&
      !new URL(c.base).hash && Number.isSafeInteger(c.sats) && c.sats >= 1 && c.sats <= cap)
    .sort((a, b) => a.sats - b.sats || (a.model.max_cost_sats ?? Infinity) -
      (b.model.max_cost_sats ?? Infinity) || a.base.localeCompare(b.base));
  const unique = list => [...new Map(list.map(c => [c.base, c])).values()];
  return {
    deepseek: unique(candidates('deepseek-v3.2')).slice(0, 2),
    alternative: unique(candidates('llama-3.1-8b-instruct')).slice(0, 1),
  };
}

// Pass bytes through unchanged. Count reasoning events/times, NEVER their text.
export function observeReasoning(response, result, started, now = performance.now.bind(performance)) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const transform = new TransformStream({
    transform(bytes, controller) {
      controller.enqueue(bytes);
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      if (pending.length > 128 * 1024) pending = '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const d = JSON.parse(line.slice(5)).choices?.[0]?.delta;
          if (typeof d?.reasoning_content === 'string' && d.reasoning_content.length ||
              typeof d?.reasoning === 'string' && d.reasoning.length) {
            result.reasoning_events++;
            result.first_reasoning_ms ??= Math.round(now() - started);
            result.last_reasoning_ms = Math.round(now() - started);
          }
        } catch { /* Diagnostic parsing must not affect the real SSE parser. */ }
      }
    },
  });
  return new Response(response.body.pipeThrough(transform), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export function needsAlternative(rows) {
  const successful = rows.filter(r => r.ok);
  return !successful.length || successful.every(r =>
    r.first_text_ms == null || r.first_text_ms > 3000 || r.text_span_ms < 200);
}

export async function benchmark(cfg, deps = {}) {
  if (cfg.routstr.payment_mode !== 'ephemeral_bearer') throw new Error('benchmark_requires_bearer');
  const cap = Math.min(2, cfg.routstr.limits.max_sats_per_request);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('benchmark_invalid_cap');
  const wallet = boundedWallet(deps.wallet || await createWallet(cfg, quiet), cap);
  const before = (await wallet.balance()).total;
  await (deps.recover || (() => createRoutstrPayment(cfg, wallet).recover()))();
  const providers = await (deps.discover || discoverProviders)({
    bootstrapEndpoints: [...(cfg.routstr.providers || []),
      ...(cfg.routstr.discovery?.bootstrap_endpoints || []), cfg.routstr.endpoint].filter(Boolean),
  });
  const catalog = await (deps.catalog || fetchProviderCatalog)(providers);
  const maxTokens = Math.min(2048, cfg.routstr.limits.max_tokens_out);
  const plan = selectPlan(catalog, maxTokens, cap);
  const rows = [];
  let halted = false;
  const run = async target => {
    if (halted) return;
    const row = { provider: target.base, model: target.model.id,
      estimated_allocation_sats: target.sats, max_tokens_out: maxTokens,
      reasoning_events: 0, first_reasoning_ms: null, last_reasoning_ms: null };
    const telemetry = createChatTelemetry();
    const started = performance.now();
    let first = null, last = null, events = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const response = await savedFetch(url, init);
      const path = new URL(typeof url === 'string' || url instanceof URL ? url : url.url).pathname;
      return path.endsWith('/chat/completions')
        ? observeReasoning(response, row, started) : response;
    };
    const local = { ...cfg, routstr: { ...cfg.routstr, endpoint: target.base,
      providers: [target.base], discovery: { enabled: false },
      models: { ...cfg.routstr.models, chat: target.model.id }, fallback: { enabled: false },
      limits: { ...cfg.routstr.limits, max_tokens_out: maxTokens, max_sats_per_request: cap } } };
    try {
      const router = (deps.router || createRoutstr)(local, wallet, quiet, {
        fetchCatalog: async () => [{ baseUrl: target.base, models: [target.model] }],
      });
      const result = await router.chat({ skill: 'benchmark', messages: MESSAGES, telemetry,
        budget_ms: Math.min(60000, cfg.routstr.limits.timeout_ms),
        onDelta() { first ??= performance.now(); last = performance.now(); events++; } });
      Object.assign(row, { ok: result.ok === true, code: result.code || null,
        total_ms: Math.round(performance.now() - started),
        first_text_ms: first === null ? null : Math.round(first - started),
        text_span_ms: first === null ? 0 : Math.round(last - first), text_events: events,
        answer_chars: result.content?.length || 0, tokens_out: result.tokens_out || 0,
        sats_spent: result.sats_spent ?? null, sats_refunded: result.sats_refunded ?? null,
        refund_pending: result.refund_pending === true, dust_msats: result.refund_dust_msats || 0,
        timings: telemetry.snapshot() });
      if (!row.ok || row.refund_pending) halted = true;
    } catch {
      Object.assign(row, { ok: false, code: 'benchmark_error' });
      halted = true;
    } finally { globalThis.fetch = savedFetch; }
    rows.push(row);
    deps.onRow?.(row);
  };
  // Alternate providers rather than doing every warm run on one node first.
  for (let repeat = 0; repeat < 2; repeat++) for (const target of plan.deepseek) await run(target);
  if (!halted && needsAlternative(rows))
    for (let repeat = 0; repeat < 2; repeat++) for (const target of plan.alternative) await run(target);
  return { schema: 1, max_provider_allocation_sats: MAX_SATS, max_requests: MAX_REQUESTS,
    wallet_before_sats: before, wallet_after_sats: (await wallet.balance()).total,
    ...wallet.stats(), halted, rows };
}

export async function claimRun(dir, runId) {
  if (!/^\d+$/.test(runId || '')) throw new Error('invalid_run');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const claim = await open(join(dir, `${runId}.started`), 'wx', 0o600);
  await claim.sync(); await claim.close();
  const directory = await open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function main() {
  const runId = process.argv[2];
  if (process.env.CONTINUUM_BENCHMARK_APPROVED !== '1' ||
      process.env.CONTINUUM_AGENT_STOPPED !== '1' || !/^\d+$/.test(runId || '')) {
    throw new Error('benchmark_not_authorized_or_isolated');
  }
  const dir = join(agentRoot(), 'memory', 'benchmarks');
  // Same workflow run cannot charge twice, even after a partial failure/rerun.
  await claimRun(dir, runId);
  const report = await benchmark(loadConfig(), { onRow: row => console.log(JSON.stringify({ trial: row })) });
  await writeFile(join(dir, `${runId}.json`), JSON.stringify(report), { mode: 0o600 });
  console.log(JSON.stringify({ benchmark_report: report }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch(() => {
    console.error('benchmark_stopped_safely; inspect sanitized trial results and retained recovery');
    process.exit(1);
  });
}
