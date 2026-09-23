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

const PREFIX = 'rrefund_';
const MAX_PENDING = 8;
const MAX_JSON = 128 * 1024;
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
    await store.put(name, JSON.stringify(record));
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
        if (path === '/v1/balance/refund' && response.status === 400 &&
            body?.detail === 'No balance to refund') return { empty: true };
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
        const refund = await request(record.base, '/v1/balance/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${record.key}` },
          body: '{}',
        });
        if (refund.empty === true) {
          await store.remove(name);
          return { pending: false, refunded: 0 };
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

  async function begin(base, sats) {
    const prior = gate;
    let unlock;
    gate = new Promise(resolve => { unlock = resolve; });
    await prior;
    let name, sent, dispatched = false;
    try {
      if (safeRemoteBaseUrl(base) !== base || new URL(base).search || new URL(base).hash ||
          !Number.isSafeInteger(sats) || sats < 1) throw failure();
      const names = (await store.list()).filter(n => n.startsWith(PREFIX));
      // Unsettled older requests block further deposits rather than silently
      // accumulating provider custody. Concurrent active turns remain bounded.
      if (names.length >= MAX_PENDING || names.some(n => !active.has(n))) throw failure();
      sent = await wallet.send(sats);
      if (!sent.ok) return { ok: false, code: sent.code || 'insufficient_funds', reason: 'Wallet cannot fund this request.' };
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
      if (!dispatched && sent?.ok) {
        // This is the ONLY rollback boundary: no provider request was sent.
        try {
          if (typeof sent.rollback !== 'function') throw failure();
          await sent.rollback();
          if (name) await store.remove(name);
        } catch { /* Retain any existing record; never claim rolled-back funds. */ }
      } else if (name) {
        await settle(name);
      }
      if (name) active.delete(name);
      return { ok: false, code: 'payment_recovery_required', reason: 'Payment setup failed. No second payment was sent; recovery is retained.' };
    } finally { unlock(); }
  }

  async function finish(handle) {
    try { return await settle(handle.name); }
    finally { active.delete(handle.name); }
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
  return { begin, finish, recover, start, stop };
}
