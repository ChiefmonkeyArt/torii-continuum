/**
 * OWNER-UI-1 — server-side sealed session store.
 *
 * Moves the owner's chat sessions off browser localStorage and onto the agent,
 * under the SAME trust model as MEMORY-1 (`lib/memstore.mjs`): the browser
 * NIP-44-seals each session's messages to the owner's npub, and the agent
 * stores only ciphertext. The agent never sees plaintext at rest and never
 * holds or derives a key (see `lib/crypto.mjs` for the invariant).
 *
 * Layout under the agent's systemd-writable memory root:
 *
 *   memory/owners/<ownerHex>/sessions/
 *     index.json     — per-session metadata (id, created_at, updated_at, bytes,
 *                      sha256 of the ciphertext) — non-secret, so the browser
 *                      can list sessions without decrypting.
 *     <id>.enc       — one NIP-44-v2 blob per session (the sealed message list).
 *
 * The session title and message content live INSIDE the sealed blob, never in
 * the index. A "rename" is a browser-side re-seal + `upsert` with the same id.
 *
 * Isolation + safety mirror `memstore.mjs`: ownerHex is 64-hex, the session id
 * is a validated slug, every resolved path is re-checked for containment after
 * joining (no traversal / IDOR), writes are atomic (temp + rename), and the
 * payload is bounded (65535 bytes, NIP-44 v2's ceiling) with a per-owner
 * session-count quota.
 */
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ownerHexFromNpub } from '../core/genesis.mjs';

const HEX64_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const MAX_SESSION_BYTES = 65535; // NIP-44 v2 payload ceiling
export const DEFAULT_SESSION_QUOTA = 200; // per-owner session count cap

const INDEX_SCHEMA = 'torii.continuum.sessions_index/1';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {string} id  candidate session id from the client
 * @returns {string|null}  the validated id, or null when it is unsafe
 */
export function validSessionId(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  return SLUG_RE.test(s) && !s.startsWith('.') ? s : null;
}

/**
 * @param {object} deps
 * @param {string} deps.memoryRoot  absolute path to agent/memory
 * @param {object} [deps.log]
 * @param {number} [deps.maxSessions]  per-owner session-count quota
 * @param {() => number} [deps.now]  unix seconds (injectable clock)
 */
export function createSessionStore(deps = {}) {
  const memoryRoot = deps.memoryRoot;
  if (!memoryRoot || typeof memoryRoot !== 'string') {
    throw new Error('createSessionStore: memoryRoot required');
  }
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const maxSessions = deps.maxSessions || DEFAULT_SESSION_QUOTA;
  const now = typeof deps.now === 'function' ? deps.now : () => Math.floor(Date.now() / 1000);

  const ownersRoot = join(memoryRoot, 'owners');

  function resolveOwner(ownerNpub) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex || !HEX64_RE.test(ownerHex)) return { ok: false, reason: 'invalid owner npub' };
    const dir = join(ownersRoot, ownerHex, 'sessions');
    return { ok: true, ownerHex, dir };
  }

  async function readIndex(dir) {
    try {
      const raw = await readFile(join(dir, 'index.json'), 'utf8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.sessions)) {
        return { schema: INDEX_SCHEMA, sessions: [], corrupt: true };
      }
      return obj;
    } catch (e) {
      if (e.code === 'ENOENT') return { schema: INDEX_SCHEMA, sessions: [] };
      log.warn(`[sessions] index unreadable at ${dir}: ${e.message}`);
      return { schema: INDEX_SCHEMA, sessions: [], corrupt: true };
    }
  }

  async function writeIndexAtomic(dir, index) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.index.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    await rename(tmp, join(dir, 'index.json'));
  }

  /** List a single owner's sessions as non-secret metadata. */
  async function list(ownerNpub) {
    const scope = resolveOwner(ownerNpub);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const index = await readIndex(scope.dir);
    const sessions = index.sessions
      .filter((s) => s && typeof s.id === 'string' && typeof s.created_at === 'number')
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return { ok: true, count: sessions.length, sessions, index_corrupt: !!index.corrupt };
  }

  /** Create or replace a session blob + update its index entry. */
  async function upsert(ownerNpub, { id, ciphertext }) {
    const scope = resolveOwner(ownerNpub);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const safeId = validSessionId(id);
    if (!safeId) return { ok: false, code: 'session_id', reason: 'invalid session id' };
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      return { ok: false, code: 'ciphertext', reason: 'ciphertext required' };
    }
    const byteLen = Buffer.byteLength(ciphertext, 'utf8');
    if (byteLen > MAX_SESSION_BYTES) {
      return { ok: false, code: 'too_large', reason: `session ${byteLen} > ${MAX_SESSION_BYTES} bytes` };
    }

    const file = join(scope.dir, `${safeId}.enc`);
    if (resolve(file).startsWith(resolve(scope.dir) + sep) === false && resolve(file) !== resolve(scope.dir)) {
      return { ok: false, code: 'traversal', reason: 'resolved path escapes owner namespace' };
    }

    await mkdir(scope.dir, { recursive: true, mode: 0o700 });
    const tmp = join(scope.dir, `.${safeId}.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, ciphertext, { mode: 0o600 });
    await rename(tmp, file);

    const index = await readIndex(scope.dir);
    const existingCount = index.sessions.filter((s) => s.id !== safeId).length;
    if (existingCount >= maxSessions) {
      await unlink(file).catch(() => {}); // roll back the just-written blob
      return { ok: false, code: 'quota', reason: `session quota ${maxSessions} reached` };
    }

    const digest = sha256Hex(Buffer.from(ciphertext, 'utf8'));
    const ts = now();
    const prev = index.sessions.find((s) => s.id === safeId);
    index.sessions = [
      ...index.sessions.filter((s) => s.id !== safeId),
      { id: safeId, created_at: prev?.created_at ?? ts, updated_at: ts, bytes: byteLen, sha256: digest },
    ];
    await writeIndexAtomic(scope.dir, index);
    return { ok: true, id: safeId, created_at: prev?.created_at ?? ts, updated_at: ts, bytes: byteLen };
  }

  /** Read a session's ciphertext (verified against the stored sha256). */
  async function read(ownerNpub, id) {
    const scope = resolveOwner(ownerNpub);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const safeId = validSessionId(id);
    if (!safeId) return { ok: false, code: 'session_id', reason: 'invalid session id' };
    const index = await readIndex(scope.dir);
    const rec = index.sessions.find((s) => s.id === safeId);
    if (!rec) return { ok: false, code: 'not_found', reason: 'not found' };

    const file = join(scope.dir, `${safeId}.enc`);
    let ciphertext;
    try {
      ciphertext = await readFile(file, 'utf8');
    } catch {
      return { ok: false, code: 'missing', reason: 'session blob missing', corrupt: true, record: rec };
    }
    if (rec.sha256 && sha256Hex(Buffer.from(ciphertext, 'utf8')) !== rec.sha256) {
      return { ok: false, code: 'integrity', reason: 'integrity check failed (corrupt/tampered)', corrupt: true, record: rec };
    }
    return { ok: true, ciphertext, record: rec };
  }

  /** Delete a session blob + its index entry. */
  async function remove(ownerNpub, id) {
    const scope = resolveOwner(ownerNpub);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const safeId = validSessionId(id);
    if (!safeId) return { ok: false, code: 'session_id', reason: 'invalid session id' };

    const index = await readIndex(scope.dir);
    const i = index.sessions.findIndex((s) => s.id === safeId);
    if (i < 0) return { ok: false, code: 'not_found', reason: 'not found' };

    const file = join(scope.dir, `${safeId}.enc`);
    await unlink(file).catch(() => {});
    index.sessions.splice(i, 1);
    await writeIndexAtomic(scope.dir, index);
    return { ok: true, removed: safeId };
  }

  return { list, upsert, read, remove };
}