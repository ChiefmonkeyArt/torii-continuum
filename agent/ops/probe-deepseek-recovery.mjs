/**
 * One explicitly approved recovery probe. No fallback, top-up, auto-recovery or
 * secret output. The wallet enforces the 2-sat gross debit cap including fees.
 * Caller must stop the daemon and hold the durable benchmark run-id guard.
 */
import { discoverProviders, fetchProviderCatalog, estimateSatsForModel } from '../core/routstr-discovery.mjs';
import { createRoutstr } from '../core/routstr.mjs';
import { createWallet } from '../core/wallet.mjs';
import { isQuarantined } from '../core/provider-quarantine.mjs';

export const PROBE_MODEL = 'deepseek-v4-flash';
const known = new Set(`missing_api_key invalid_api_key key_not_found expired_api_key api_key_expired invalid_token unauthorized authentication_error authentication_failed invalid_authentication_error insufficient_balance insufficient_quota payment_required model_not_found invalid_request_error rate_limit_exceeded upstream_unavailable upstream_rate_limit`.split(' '));
// Never return free text, headers, tokens, or an unknown provider-supplied string.
export async function safeProviderCode(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let bytes=0, parts=[];
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      bytes+=value.byteLength;
      if (bytes>8192) return null;
      parts.push(value);
    }
    const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
    const code=(body?.detail?.error ?? body?.error ?? body?.detail ?? body)?.code;
    if (Number.isInteger(code) && code>=400 && code<=599) return code;
    return typeof code==='string' && known.has(code.toLowerCase()) ? code : null;
  } catch { return null; }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
export async function runRecoveryProbe(cfg, { approved = false, log, emit = console.log,
  walletFactory = createWallet, routerFactory = createRoutstr, discover = discoverProviders,
  catalog = fetchProviderCatalog, now = Date.now } = {}) {
  if (!approved) throw new Error('explicit 2-sat test approval required');
  if (cfg.routstr?.payment_mode !== 'ephemeral_bearer') throw new Error('probe requires bearer payments');
  const providers = await discover({ bootstrapEndpoints: [...(cfg.routstr?.providers || []),
    ...(cfg.routstr?.discovery?.bootstrap_endpoints || []), cfg.routstr?.endpoint].filter(Boolean), timeoutMs: 4000 });
  const candidates = await catalog(providers.filter(p => !isQuarantined(cfg, p.baseUrl)),
    { timeoutMs: 8000, modelIds: [PROBE_MODEL] });
  const messages = [{ role: 'user', content: 'GM! Reply with a friendly greeting in one short sentence.' }];
  const provider = candidates.find(p => !isQuarantined(cfg, p.baseUrl) && !/staging/i.test(p.baseUrl) &&
    p.models.some(m => m.id === PROBE_MODEL && estimateSatsForModel(m, 128, messages) === 1));
  if (!provider) throw new Error('no compatible one-sat DeepSeek V4 Flash provider');
  const probeCfg = { ...cfg, routstr: { ...cfg.routstr, fallback: { enabled: false },
    providers: [provider.baseUrl], endpoint: provider.baseUrl, models: { chat: PROBE_MODEL },
    discovery: { ...cfg.routstr.discovery, enabled: false },
    limits: { ...cfg.routstr.limits, max_tokens_out: 128, max_sats_per_request: 1, timeout_ms: 45000 } } };
  const wallet = await walletFactory(probeCfg, log);
  const before = (await wallet.balance()).total;
  let attempts = 0, deposits = 0, firstDelta = null;
  const guardedWallet = { ...wallet, send: async (sats, options) => {
    if (attempts || sats !== 1) throw new Error('approved single-deposit test limit reached');
    attempts++;
    const sent = await wallet.send(sats, { ...(options?.mints ? {mints:options.mints} : {}), maxDebitSats: 2 });
    if (sent?.ok) deposits++;
    return sent;
  } };
  let httpStatus=null, providerCode=null;
  const router = routerFactory(probeCfg, guardedWallet, log, { fetchCatalog: async () => [provider],
    observeRejectedCompletion: async res => { httpStatus=res.status; providerCode=await safeProviderCode(res); } });
  const started = now();
  try {
    const result = await router.chat({ messages, max_tokens: 128, onDelta() { firstDelta ??= now() - started; } });
    const after = (await wallet.balance()).total;
    const report = { event: 'approved_deepseek_recovery_probe', model: PROBE_MODEL,
      provider: provider.baseUrl, ok: result.ok, code: result.code || null,
      http_status: httpStatus, provider_error_code: providerCode,
      failure_kind: result.failure_kind || null, duration_ms: now() - started,
      first_delta_ms: firstDelta, response_chars: result.ok ? String(result.content || '').length : 0,
      deposit_attempts: attempts, deposits, max_total_debit_sats: 2, net_wallet_change_sats: after - before,
      refund_pending: result.refund_pending === true };
    emit(JSON.stringify(report));
    return report;
  } finally { router.stopDiscovery(); router.stopPaymentRecovery(); }
}
