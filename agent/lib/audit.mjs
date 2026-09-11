/**
 * Append-only, tamper-evident audit log (GENESIS-1).
 *
 * The agent already reserves `memory/audit.jsonl` (config.mjs). This module
 * turns it into a hash-CHAINED append-only ledger: every entry carries the
 * hash of the previous entry (`prev`) plus its own content hash (`hash`). To
 * silently rewrite history an attacker would have to recompute every hash from
 * the edited entry onward — a single edited or removed line breaks the chain
 * and is detectable by a linear verify pass.
 *
 * This is tamper EVIDENCE, not tamper PROOFING: the machine's owner can always
 * rewrite the whole file (and re-chain it). What the chain buys is that a
 * partial edit — the realistic attack, e.g. a compromised process deleting one
 * incriminating line — cannot go unnoticed. Consistent with the constitution's
 * honesty boundary (see lib/constitution.mjs).
 *
 * Concurrency: appends are serialized through an in-process promise queue so
 * two concurrent callers cannot interleave a read-last-hash / write-new-line
 * race and fork the chain. The recovered tail (last hash + sequence) is cached
 * in memory after the first read, so append cost is constant instead of growing
 * with log history; a failed append invalidates the cache and the next append
 * re-reads the real file.
 *
 * Format: one JSON object per line (JSONL). Fields:
 *   { seq, at, event, prev, hash, ...payload }
 * where `hash = sha256(canonical({ seq, at, event, prev, ...payload }))` — the
 * `hash` field itself is never part of its own pre-image.
 */

import { createHash } from 'node:crypto';
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalize } from './constitution.mjs';

// Seed for the very first entry's `prev`. A fixed, published constant so an
// empty log has a well-defined genesis link rather than null.
const CHAIN_SEED = 'torii.continuum.audit/1/genesis';

export function createAudit(auditPath, deps = {}) {
  const log = deps.log || { info() {}, warn() {}, error() {} };
  // Injectable for tests: readFile so a caller can count read calls/bytes (the
  // perf benchmark), appendFile to simulate a transient write failure.
  const readFileImpl = deps.readFile || readFile;
  const appendFileImpl = deps.appendFile || appendFile;
  // Serialize all appends. Each append awaits the previous one's completion.
  // The internal `tail` chain is kept recovered (never carries a caller's
  // rejection), so one failed append cannot poison every later append.
  let tail = Promise.resolve();

  // Cached tail state so appends don't re-read the whole log. `null` means
  // "unloaded" — the real file is read once on the first append (or after a
  // failed append invalidated the cache) and then trusted as this process's
  // authority over the append-only ledger.
  let seq = null;
  let lastHashValue = null;

  function hashEntry(entry) {
    return createHash('sha256').update(canonicalize(entry), 'utf8').digest('hex');
  }

  async function readLines() {
    let raw;
    try {
      raw = await readFileImpl(auditPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return raw.split('\n').filter((l) => l.trim().length > 0);
  }

  async function lastHash() {
    const lines = await readLines();
    if (lines.length === 0) return CHAIN_SEED;
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      return typeof last.hash === 'string' && last.hash ? last.hash : CHAIN_SEED;
    } catch {
      // A corrupt tail line means we cannot honestly chain onto it. Fail
      // closed by refusing to guess — surface it to the caller.
      throw new Error('audit: last line is not valid JSON (chain integrity unknown)');
    }
  }

  // Read the log ONCE to recover the tail (last hash + sequence count) into the
  // cache. Used to initialize or refresh the cache, never on the append hot path.
  async function loadTailState() {
    const lines = await readLines();
    if (lines.length === 0) {
      seq = 0;
      lastHashValue = CHAIN_SEED;
      return;
    }
    let last;
    try {
      last = JSON.parse(lines[lines.length - 1]);
    } catch {
      // A corrupt tail line means we cannot honestly chain onto it. Fail closed.
      throw new Error('audit: last line is not valid JSON (chain integrity unknown)');
    }
    seq = lines.length;
    lastHashValue = (typeof last.hash === 'string' && last.hash) ? last.hash : CHAIN_SEED;
  }

  /**
   * Append one entry. `event` is a short string tag; `payload` is any
   * JSON-serializable object (no secrets — this file is plaintext).
   * @param {string} event
   * @param {object} payload
   * @returns {Promise<{ ok: true, seq: number, hash: string, prev: string }>}
   */
  function append(event, payload = {}) {
    const run = tail.then(async () => {
      if (typeof event !== 'string' || !event) throw new Error('audit: event tag required');
      if (seq === null || lastHashValue === null) {
        await loadTailState();
      }
      const thisSeq = seq;
      const thisPrev = lastHashValue;
      const body = {
        seq: thisSeq,
        at: new Date().toISOString(),
        event,
        prev: thisPrev,
        ...payload,
      };
      const hash = hashEntry(body);
      const line = JSON.stringify({ ...body, hash }) + '\n';
      await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
      await appendFileImpl(auditPath, line, { mode: 0o600 });
      seq = thisSeq + 1;
      lastHashValue = hash;
      log.info(`[audit] ${event} seq=${thisSeq} hash=${hash.slice(0, 12)}`);
      return { ok: true, seq: thisSeq, hash, prev: thisPrev };
    });
    // Keep the internal chain alive even when this append fails: the next
    // append starts from a recovered chain and re-reads the real file, while
    // this caller still sees this append's own rejection.
    tail = run.catch(() => {
      seq = null;
      lastHashValue = null;
    });
    return run;
  }

  /**
   * Verify the whole chain: every entry's recomputed hash must match its stored
   * `hash`, and each `prev` must equal the previous entry's `hash` (or the seed
   * for the first). Returns the break point if any.
   * @returns {Promise<{ ok: boolean, count: number, reason?: string, seq?: number }>}
   */
  async function verify() {
    const lines = await readLines();
    let prev = CHAIN_SEED;
    for (let i = 0; i < lines.length; i++) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        return { ok: false, count: lines.length, reason: 'line is not valid JSON', seq: i };
      }
      const { hash, ...body } = obj;
      if (body.prev !== prev) {
        return { ok: false, count: lines.length, reason: 'prev-link mismatch', seq: i };
      }
      if (hashEntry(body) !== hash) {
        return { ok: false, count: lines.length, reason: 'content hash mismatch', seq: i };
      }
      prev = hash;
    }
    return { ok: true, count: lines.length };
  }

  return { append, verify, _lastHash: lastHash, _path: auditPath };
}
