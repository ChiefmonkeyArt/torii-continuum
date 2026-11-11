/**
 * Opt-in per-request bearer balances. Never share a balance across turns.
 * Recovery records contain bot-owned ecash/API credentials, never human keys.
 * No automatic redeposit, completion retry, or post-dispatch proof rollback.
 */
import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecretStore } from '../lib/secretstore.mjs';
import { safeRemoteBaseUrl } from './routstr-discovery.mjs';
import { isQuarantined } from './provider-quarantine.mjs';

const PREFIX = 'rrefund_';
const MAX_PENDING = 8;
// Open claims at OTHER providers that still allow a new deposit here, so one
// stuck provider cannot block failover (docs/adr-routstr-provider-fallback.md §2).
const MAX_PENDING_ELSEWHERE = 2;
const MAX_JSON = 128 * 1024;
const VERIFIED_DUST_RESPONSE = Symbol('verified-dust-response');
const failure = () => new Error('Streaming payment could not be completed; recovery retained.');

async function readJSON(response) {
  if (!response.body?.getReader) throw failure();
  const reader = response.body.getReader();
  let size = 0, body = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      size += value?.byteLength || 0;
      if (size > MAX_JSON) throw failure();
      body += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (done) break;
    }
    return JSON.parse(body);
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

export function createRoutstrPayment(cfg, wallet, deps = {}) {
  const store = deps.store || createSecretStore(cfg, {
    dir: deps.dir || join(process.cwd(), 'memory', 'secrets'),
  });
  const fetchFn = deps.fetchFn || ((...args) => fetch(...args));
  const active = new Set();
  const settling = new Map();
  let gate = Promise.resolve();
  let timer = null;
  let recovering = null;
  let stopped = true;
  const validName = name => /^rrefund_[a-f0-9]{20}$/.test(name);
  const keyFor = token => `sk-${createHash('sha256').update(token).digest('hex')}`;

  async function persist(name, record) {
    await store.put(name, JSON.stringify(record), { atomic: true });
    // Production store writes once before any remote dispatch; flush the file
    // and directory before handing off funds. Injected stores are test seams.
    if (!deps.store) {
      for (const path of [join(store._dir, `${name}.enc`), store._dir]) {
        const fh = await open(path, 'r');
        try { await fh.sync(); } finally { await fh.close(); }
      }
    }
  }

  async function request(base, path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deps.timeoutMs || 5000);
    try {
      const response = await fetchFn(`${base}${path}`, {
        ...options, redirect: 'error', signal: controller.signal,
      });
      const body = await readJSON(response);
      if (!response.ok) {
        // Current Routstr uses machine-readable refund errors. Accept the
        // documented nested envelope or its top-level alias, not fuzzy text.
        const nested = body?.detail?.error, alias = body?.error;
        const structured = nested ?? alias;
        const conflict = nested && alias &&
          (nested.code !== alias.code || nested.type !== alias.type);
        const code = !conflict && structured?.type === 'invalid_request_error'
          ? structured.code : null;
        const legacy = structured == null ? body?.detail : null;
        if (path === '/v1/balance/refund' && response.status === 400 &&
            (code === 'no_balance_to_refund' || legacy === 'No balance to refund')) return { empty: true };
        if (path === '/v1/balance/refund' && response.status === 400 &&
            (code === 'balance_too_small_to_refund' || legacy === 'Balance too small to refund')) return VERIFIED_DUST_RESPONSE;
        throw failure();
      }
      return body;
    } finally { clearTimeout(timeout); }
  }

  function validate(record) {
    if (!record || safeRemoteBaseUrl(record.base) !== record.base ||
        new URL(record.base).search || new URL(record.base).hash ||
        typeof record.token !== 'string' || !/^cashu[AB][A-Za-z0-9_+=/-]+$/.test(record.token) ||
        record.token.length > MAX_JSON || record.key !== keyFor(record.token) ||
        !Number.isSafeInteger(record.sats) || record.sats < 1) throw failure();
    return record;
  }

  async function settle(name) {
    if (!validName(name)) throw failure();
    if (settling.has(name)) return settling.get(name);
    const task = (async () => {
      try {
        const raw = await store.get(name);
        if (!raw) return { pending: false, refunded: 0 };
        const record = validate(JSON.parse(raw));
        // Explicit operator hold: preserve the encrypted claim byte-for-byte.
        // Do not poll, spend again, write it off or call it recovered.
        if (isQuarantined(cfg, record.base)) return { pending: true, refunded: 0, quarantined: true };
        const refund = await request(record.base, '/v1/balance/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.key}` },
          body: '{}',
        });
        if (refund.empty === true) {
          await store.remove(name);
          return { pending: false, refunded: 0 };
        }
        if (refund === VERIFIED_DUST_RESPONSE) {
          // Whole-satoshi Cashu cannot withdraw a fractional satoshi. Confirm
          // the exact balance and absence of reservations before taking it out
          // of the active recovery queue. Keep the encrypted claim permanently;
          // never top it up, reuse it, or report it as money returned to wallet.
          const info = await request(record.base, '/v1/balance/info', {
            headers: { Authorization: `Bearer ${record.key}` },
          });
          if (info.api_key !== record.key || info.reserved !== 0 ||
              !Number.isSafeInteger(info.balance) || info.balance < 1 ||
              info.balance >= 1000) throw failure();
          await persist(name.replace(PREFIX, 'rdust_'), {
            ...record, dust_msats: info.balance, archived_at: new Date().toISOString(),
          });
          await store.remove(name);
          return { pending: false, refunded: 0, dust_msats: info.balance };
        }
        if (typeof refund.token !== 'string' || !/^cashu[AB][A-Za-z0-9_+=/-]+$/.test(refund.token)) throw failure();
        // Provider refund endpoint is replayable. If receive fails or the
        // process exits, keep the original encrypted claim and retry later.
        const received = await wallet.receive(refund.token);
        if (!received.ok) throw failure();
        await store.remove(name);
        return { pending: false, refunded: received.added_sats || 0 };
      } catch {
        return { pending: true, refunded: 0 };
      }
    })();
    settling.set(name, task);
    try { return await task; } finally { settling.delete(name); }
  }

  async function begin(base, sats, { mints } = {}) {
    const prior = gate;
    let unlock;
    gate = new Promise(resolve => { unlock = resolve; });
    await prior;
    let name, sent, dispatched = false;
    try {
      if (safeRemoteBaseUrl(base) !== base || new URL(base).search || new URL(base).hash ||
          !Number.isSafeInteger(sats) || sats < 1) throw failure();
      const names = (await store.list()).filter(n => n.startsWith(PREFIX));
      if (isQuarantined(cfg, base)) return { ok: false, code: 'payment_recovery_required', safe_to_retry: true,
        reason: 'This provider is isolated by the owner. No payment was sent.' };
      let unresolvedHere = false;
      let unresolvedElsewhere = 0;
      // Settle up to two pending claims now rather than waiting for the
      // minute tick (docs/adr-routstr-turns-dont-hang.md §3).
      let tries = 0;
      let left = names.length;
      for (const n of names) {
        if (active.has(n)) continue;
        if (!validName(n)) throw failure();
        const raw = await store.get(n);
        if (!raw) { left--; continue; }
        const record = validate(JSON.parse(raw));
        // Only an explicit quarantine may lift the global guard for a claim.
        // Unknown/corrupt claims and non-quarantined failures still fail closed.
        if (isQuarantined(cfg, record.base)) continue;
        if (tries < 2) {
          tries++;
          const settled = await settle(n);
          if (!settled.pending) { left--; continue; }
        }
        if (record.base === base) unresolvedHere = true;
        else unresolvedElsewhere++;
      }
      // An open claim at this provider blocks deposits here. Open claims at
      // other providers are tolerated up to a small bound, so failover still
      // works while custody stays capped. No payment is sent either way, so
      // the caller may try another provider (safe_to_retry).
      if (left >= MAX_PENDING || unresolvedHere || unresolvedElsewhere > MAX_PENDING_ELSEWHERE) {
        return { ok: false, code: 'payment_recovery_required', safe_to_retry: unresolvedHere && left < MAX_PENDING && unresolvedElsewhere <= MAX_PENDING_ELSEWHERE,
          reason: 'An earlier payment is awaiting recovery. No new payment was sent.' };
      }
      sent = await wallet.send(sats, Array.isArray(mints) && mints.length ? { mints } : undefined);
      if (!sent.ok) return { ok: false, code: sent.code || 'insufficient_funds', safe_to_retry: true,
        reason: 'Wallet cannot fund this request.' };
      name = PREFIX + randomBytes(10).toString('hex');
      const record = validate({ base, sats, token: sent.token, key: keyFor(sent.token) });
      active.add(name);
      await persist(name, record);
      dispatched = true;
      // POST body only: never put ecash tokens in URLs or use a long-lived key.
      const created = await request(base, '/v1/balance/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_balance_token: record.token }),
      });
      if (created.api_key !== record.key) throw failure();
      return { ok: true, name, key: record.key };
    } catch {
      let safe = false;
      if (!dispatched && sent?.ok) {
        // This is the ONLY rollback boundary: no provider request was sent.
        try {
          if (typeof sent.rollback !== 'function') throw failure();
          await sent.rollback();
          if (name) await store.remove(name);
          safe = true;
        } catch { /* Retain any existing record; never claim rolled-back funds. */ }
      } else if (name) {
        // Deposit reached the provider: only a confirmed settle (refund or
        // verified-empty) makes another provider safe to try.
        safe = (await settle(name)).pending === false;
      }
      if (name) active.delete(name);
      return { ok: false, code: 'payment_recovery_required', safe_to_retry: safe,
        reason: safe ? 'Payment setup failed and was settled.'
          : 'Payment setup failed. No second payment was sent; recovery is retained.' };
    } finally { unlock(); }
  }

  async function finish(handle) {
    try { return await settle(handle.name); }
    finally { active.delete(handle.name); }
  }

  /** One more refund try for a claim this turn just finished (ADR §3). */
  async function settleAgain(handle) {
    return settle(handle.name);
  }

  async function recover() {
    if (recovering) return recovering;
    recovering = (async () => {
      const names = (await store.list()).filter(validName).slice(0, MAX_PENDING);
      for (const name of names) if (!active.has(name)) await settle(name);
    })().catch(() => { /* Fail closed: begin still sees the pending record. */ });
    try { await recovering; } finally { recovering = null; }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    const tick = () => { void recover().finally(() => {
      if (!stopped) { timer = setTimeout(tick, 60000); timer.unref?.(); }
    }); };
    tick();
  }
  function stop() { stopped = true; clearTimeout(timer); timer = null; }
  // Read-only, owner-facing summary. Never expose credentials, proofs, tokens,
  // claim identifiers or a provider-supplied error. No network or recovery.
  async function status() {
    const summary = { pending: 0, held: 0, active: 0, blocked: false, available: true };
    try {
      const names = (await store.list()).filter(n => n.startsWith(PREFIX));
      for (const name of names) {
        if (!validName(name)) throw failure();
        const raw = await store.get(name);
        if (!raw) continue; // settlement removed it between list/read
        const record = validate(JSON.parse(raw));
        if (active.has(name)) summary.active++;
        else if (isQuarantined(cfg, record.base)) summary.held++;
        else summary.pending++;
      }
      summary.blocked = summary.pending > 0 || names.length >= MAX_PENDING;
    } catch { summary.available = false; summary.blocked = true; }
    return summary;
  }
  return { begin, finish, settleAgain, recover, start, stop, status };
}
