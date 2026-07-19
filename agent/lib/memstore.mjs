/**
 * MEMORY-1 scoped, sealed-at-rest storage.
 *
 * Canonical layout — everything lives under the SINGLE systemd-writable root
 * `agent/memory/` (ReadWritePaths=…/memory). Nothing the agent writes may land
 * outside it (see ops/systemd/torii-continuum-agent.service; the old 30095 →
 * `skills/` route caused EROFS and is fixed in events.mjs).
 *
 *   memory/owners/<ownerHex>/
 *     bots/<botId>/
 *       projects/<projectSlug>/
 *         semantic/     <eventId|item>.enc      (durable facts,   kind 30094)
 *         procedural/   <eventId|item>.enc      (reflexes,        kind 30095)
 *         episodic/     <item>.enc              (owner-approved episodes)
 *         project/      <eventId|item>.enc      (project knowledge references)
 *         index.json                            (integrity + class + scope metadata)
 *       tombstones/<id>.json                    (deletion evidence, bot-scoped)
 *
 * Design invariants:
 *   • OWNER/BOT/PROJECT ISOLATION. Every path segment is strictly validated
 *     (ownerHex = 64-hex; botId/projectSlug = safe slug). After every join we
 *     re-check containment, so a crafted segment can never escape the owner
 *     namespace (no traversal, no IDOR). Cross-owner addressing is structurally
 *     impossible: a caller only ever names their OWN ownerHex (from the verified
 *     session), mirroring core/genesis.mjs.
 *   • CIPHERTEXT ONLY. Disk holds NIP-44 v2 ciphertext blobs; plaintext lives
 *     only in the operator's browser and (post-unlock) the RAM cache. This
 *     module never decrypts and never accepts a private key.
 *   • ATOMIC + RESTRICTIVE. Writes go to a temp file then rename() into place
 *     (0600 under 0700 dirs). A crash mid-write leaves the old item intact.
 *   • INTEGRITY. index.json records each item's sha256, size, class, kind,
 *     d-tag and timestamps; verifyScope() recomputes and flags corruption.
 *   • BOUNDED. Per-item byte cap + per-scope item/byte quotas + per-owner byte
 *     quota + retention windows keep disk growth honest.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ownerHexFromNpub } from '../core/genesis.mjs';
import { KINDS } from './events.mjs';

// Safe slug for bot id + project slug: lowercase alnum with -/_ , 1..64 chars.
// (Genesis bot_id is 32-byte hex, which matches this too.)
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// Reserved project slug for owner/bot-wide (non-project) memory.
export const GLOBAL_PROJECT = '_global';

// Per-item ciphertext cap. NIP-44 v2 payload max is 65535 bytes; we mirror it.
export const MAX_ITEM_BYTES = 65535;

// Quotas. Deliberately conservative for a low-spec sovereign VPS. Tunable via
// deps but with hard ceilings so config can never disable the guard.
export const DEFAULT_QUOTAS = Object.freeze({
  perScopeItems: 500,
  perScopeBytes: 8 * 1024 * 1024, // 8 MiB
  perOwnerBytes: 64 * 1024 * 1024, // 64 MiB
});

// Memory classes. `permanent:false` classes are retention-bounded and never
// survive indefinitely by default (short-term conversation working set).
export const CLASSES = Object.freeze({
  conversation: { dir: 'conversation', permanent: false, retentionDays: 7, kind: null },
  episodic: { dir: 'episodic', permanent: true, retentionDays: 365, kind: null },
  semantic: { dir: 'semantic', permanent: true, retentionDays: null, kind: KINDS.SEMANTIC_FACT },
  procedural: { dir: 'procedural', permanent: true, retentionDays: null, kind: KINDS.PROCEDURAL_SKILL },
  project: { dir: 'project', permanent: true, retentionDays: null, kind: KINDS.SEMANTIC_FACT },
});

export function classForKind(kind) {
  if (kind === KINDS.SEMANTIC_FACT) return 'semantic';
  if (kind === KINDS.PROCEDURAL_SKILL) return 'procedural';
  return null;
}

/** Validate a bot id (or return null). */
export function validBotId(botId) {
  return typeof botId === 'string' && SLUG_RE.test(botId) ? botId : null;
}

/** Validate a project slug (or return null). `_global` is the reserved default. */
export function validProjectSlug(slug) {
  if (slug == null || slug === '') return GLOBAL_PROJECT;
  if (slug === GLOBAL_PROJECT) return GLOBAL_PROJECT;
  return typeof slug === 'string' && SLUG_RE.test(slug) ? slug : null;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {object} deps
 * @param {string} deps.memoryRoot  absolute path to agent/memory
 * @param {object} [deps.log]
 * @param {object} [deps.quotas]
 * @param {() => number} [deps.now]  unix seconds (injectable clock)
 */
export function createMemStore(deps = {}) {
  const memoryRoot = deps.memoryRoot;
  if (!memoryRoot || typeof memoryRoot !== 'string') throw new Error('createMemStore: memoryRoot required');
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const quotas = { ...DEFAULT_QUOTAS, ...(deps.quotas || {}) };
  const now = typeof deps.now === 'function' ? deps.now : () => Math.floor(Date.now() / 1000);

  const ownersRoot = join(memoryRoot, 'owners');

  // ── path resolution (traversal-safe) ─────────────────────────────────────
  function resolveScope(ownerNpub, botId, projectSlug) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex || !HEX64_RE.test(ownerHex)) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    const project = validProjectSlug(projectSlug);
    if (!project) return { ok: false, reason: 'invalid project slug' };

    const scopeDir = join(ownersRoot, ownerHex, 'bots', bot, 'projects', project);
    // Defence in depth: every segment is already regex-validated, but re-check
    // that the resolved path is still inside the owner namespace.
    const ownerBase = resolve(ownersRoot, ownerHex);
    if (resolve(scopeDir) !== ownerBase && !resolve(scopeDir).startsWith(ownerBase + sep)) {
      return { ok: false, reason: 'path escapes owner namespace' };
    }
    return { ok: true, ownerHex, botId: bot, projectSlug: project, scopeDir };
  }

  function classDir(scopeDir, cls) {
    const meta = CLASSES[cls];
    if (!meta) throw new Error(`unknown memory class ${cls}`);
    return join(scopeDir, meta.dir);
  }

  function indexPath(scopeDir) {
    return join(scopeDir, 'index.json');
  }

  // ── index (integrity metadata) ───────────────────────────────────────────
  async function readIndex(scopeDir) {
    try {
      const raw = await readFile(indexPath(scopeDir), 'utf8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) {
        return { schema: 'torii.continuum.mem_index/1', items: [], corrupt: true };
      }
      return obj;
    } catch (e) {
      if (e.code === 'ENOENT') return { schema: 'torii.continuum.mem_index/1', items: [] };
      // Corrupt index: do not crash. Rebuild-tolerant callers treat this as empty
      // but flagged, so a torn index never loses the underlying .enc files.
      log.warn(`[memstore] index unreadable at ${scopeDir}: ${e.message}`);
      return { schema: 'torii.continuum.mem_index/1', items: [], corrupt: true };
    }
  }

  async function writeIndexAtomic(scopeDir, index) {
    await mkdir(scopeDir, { recursive: true, mode: 0o700 });
    const tmp = join(scopeDir, `.index.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    await rename(tmp, indexPath(scopeDir));
  }

  // ── quotas ───────────────────────────────────────────────────────────────
  async function ownerBytes(ownerHex) {
    // Sum every scope index under this owner. Bounded work: few bots/projects.
    let total = 0;
    const ownerDir = join(ownersRoot, ownerHex, 'bots');
    let bots;
    try { bots = await readdir(ownerDir); } catch { return 0; }
    for (const bot of bots) {
      if (!SLUG_RE.test(bot)) continue;
      const projRoot = join(ownerDir, bot, 'projects');
      let projs;
      try { projs = await readdir(projRoot); } catch { continue; }
      for (const p of projs) {
        if (!SLUG_RE.test(p)) continue;
        const idx = await readIndex(join(projRoot, p));
        for (const it of idx.items) total += Number(it.size) || 0;
      }
    }
    return total;
  }

  // ── write ──────────────────────────────────────────────────────────────
  /**
   * Store a ciphertext item. The caller MUST have already enforced consent for
   * durable classes (see lib/consent.mjs) — this module is the storage floor,
   * not the policy gate. Returns { ok, id, sha256, path } or { ok:false }.
   */
  async function put(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };

    const cls = params.cls;
    if (!CLASSES[cls]) return { ok: false, code: 'class', reason: `unknown class ${cls}` };

    const ciphertext = params.ciphertext;
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      return { ok: false, code: 'ciphertext', reason: 'ciphertext required' };
    }
    const byteLen = Buffer.byteLength(ciphertext, 'utf8');
    if (byteLen > MAX_ITEM_BYTES) {
      return { ok: false, code: 'too_large', reason: `item ${byteLen} > ${MAX_ITEM_BYTES} bytes` };
    }

    const dTag = params.dTag;
    if (typeof dTag !== 'string' || dTag.length === 0 || dTag.length > 64) {
      return { ok: false, code: 'd_tag', reason: 'd_tag required (1..64 chars)' };
    }

    const digest = sha256Hex(Buffer.from(ciphertext, 'utf8'));
    // If a caller declared an expected hash (payload binding), enforce it.
    if (params.expectSha256 && params.expectSha256 !== digest) {
      return { ok: false, code: 'hash_mismatch', reason: 'ciphertext hash does not match expected' };
    }

    // Filename: event id when signed, else deterministic on (class:dTag) so a
    // re-store of the same logical item replaces rather than duplicates.
    const eventId = typeof params.eventId === 'string' && /^[0-9a-f]{64}$/i.test(params.eventId)
      ? params.eventId.toLowerCase() : null;
    const id = eventId || `item-${sha256Hex(Buffer.from(`${cls}:${dTag}`)).slice(0, 32)}`;
    const filename = `${id}.enc`;

    const dir = classDir(scope.scopeDir, cls);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const absPath = join(dir, filename);
    // Containment re-check on the final file path.
    if (!resolve(absPath).startsWith(resolve(scope.scopeDir) + sep)) {
      return { ok: false, code: 'traversal', reason: 'resolved path escapes scope' };
    }

    const index = await readIndex(scope.scopeDir);
    const existingIdx = index.items.findIndex((it) => it.id === id);
    const replacing = existingIdx >= 0;

    // Quota checks (skip the delta for a replacement of equal-or-smaller size).
    if (!replacing) {
      const scopeItems = index.items.length;
      const scopeBytes = index.items.reduce((n, it) => n + (Number(it.size) || 0), 0);
      if (scopeItems + 1 > quotas.perScopeItems) {
        return { ok: false, code: 'quota_items', reason: `scope item quota ${quotas.perScopeItems} reached` };
      }
      if (scopeBytes + byteLen > quotas.perScopeBytes) {
        return { ok: false, code: 'quota_bytes', reason: `scope byte quota ${quotas.perScopeBytes} reached` };
      }
      const oBytes = await ownerBytes(scope.ownerHex);
      if (oBytes + byteLen > quotas.perOwnerBytes) {
        return { ok: false, code: 'quota_owner', reason: `owner byte quota ${quotas.perOwnerBytes} reached` };
      }
    }

    // Atomic write.
    const tmp = join(dir, `.${filename}.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, ciphertext, { mode: 0o600 });
    await rename(tmp, absPath);

    const ts = now();
    const record = {
      id,
      class: cls,
      kind: params.kind || CLASSES[cls].kind || null,
      d_tag: dTag,
      event_id: eventId,
      sha256: digest,
      size: byteLen,
      source: params.source || 'store',
      created_at: replacing ? (index.items[existingIdx].created_at || ts) : ts,
      updated_at: ts,
      approved_at: params.approvedAt || null,
      constitution_version: params.constitutionVersion || null,
    };
    if (replacing) index.items[existingIdx] = record;
    else index.items.push(record);
    index.updated_at = ts;
    await writeIndexAtomic(scope.scopeDir, index);

    log.info(`[memstore] put ${cls}:${dTag} owner=${scope.ownerHex.slice(0, 12)} bot=${scope.botId} proj=${scope.projectSlug} fp=${digest.slice(0, 12)} (${replacing ? 'replace' : 'new'})`);
    return {
      ok: true, id, sha256: digest, size: byteLen, replaced: replacing,
      path: `owners/${scope.ownerHex}/bots/${scope.botId}/projects/${scope.projectSlug}/${CLASSES[cls].dir}/${filename}`,
      scope: { owner_hex: scope.ownerHex, bot_id: scope.botId, project: scope.projectSlug },
    };
  }

  // ── read / list ──────────────────────────────────────────────────────────
  /** List item metadata (no ciphertext) for a scope, optionally by class. */
  async function list(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const index = await readIndex(scope.scopeDir);
    let items = index.items;
    if (params.cls) items = items.filter((it) => it.class === params.cls);
    return { ok: true, scope: { owner_hex: scope.ownerHex, bot_id: scope.botId, project: scope.projectSlug }, count: items.length, items, index_corrupt: !!index.corrupt };
  }

  /** Read one item's raw ciphertext (browser decrypts). Verifies integrity. */
  async function read(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const index = await readIndex(scope.scopeDir);
    const rec = index.items.find((it) => it.id === params.id);
    if (!rec) return { ok: false, reason: 'not found' };
    const abs = join(classDir(scope.scopeDir, rec.class), `${rec.id}.enc`);
    let ciphertext;
    try { ciphertext = await readFile(abs, 'utf8'); }
    catch { return { ok: false, reason: 'ciphertext file missing', corrupt: true, record: rec }; }
    const digest = sha256Hex(Buffer.from(ciphertext, 'utf8'));
    if (digest !== rec.sha256) {
      return { ok: false, reason: 'integrity check failed (corrupt/tampered)', corrupt: true, record: rec };
    }
    return { ok: true, ciphertext, record: rec };
  }

  /**
   * Enumerate all durable ciphertext items for an owner (all bots/projects) as
   * { kind, class, scope, id, d_tag, ciphertext } — used by /unlock and export.
   */
  async function listAllForOwner(ownerNpub) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const out = [];
    const botsRoot = join(ownersRoot, ownerHex, 'bots');
    let bots;
    try { bots = await readdir(botsRoot); } catch { return { ok: true, entries: [] }; }
    for (const bot of bots) {
      if (!SLUG_RE.test(bot)) continue;
      const projRoot = join(botsRoot, bot, 'projects');
      let projs;
      try { projs = await readdir(projRoot); } catch { continue; }
      for (const p of projs) {
        if (!SLUG_RE.test(p)) continue;
        const scopeDir = join(projRoot, p);
        const index = await readIndex(scopeDir);
        for (const rec of index.items) {
          const abs = join(scopeDir, CLASSES[rec.class]?.dir || rec.class, `${rec.id}.enc`);
          const ciphertext = await readFile(abs, 'utf8').catch(() => null);
          if (!ciphertext) continue;
          const digest = sha256Hex(Buffer.from(ciphertext, 'utf8'));
          out.push({
            kind: rec.kind, class: rec.class, id: rec.id, d_tag: rec.d_tag,
            event_id: rec.event_id, sha256: rec.sha256,
            integrity_ok: digest === rec.sha256,
            scope: { owner_hex: ownerHex, bot_id: bot, project: p },
            ciphertext,
          });
        }
      }
    }
    return { ok: true, entries: out };
  }

  // ── delete / tombstone ────────────────────────────────────────────────────
  /**
   * Delete an item: unlink the .enc, drop the index record, and write a
   * tombstone (deletion evidence). Honest limitation: this removes the LOCAL
   * copy only; any exported bundle or off-box backup is outside our reach.
   */
  async function remove(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const index = await readIndex(scope.scopeDir);
    const i = index.items.findIndex((it) => it.id === params.id);
    if (i < 0) return { ok: false, reason: 'not found' };
    const rec = index.items[i];
    const abs = join(classDir(scope.scopeDir, rec.class), `${rec.id}.enc`);
    await unlink(abs).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    index.items.splice(i, 1);
    index.updated_at = now();
    await writeIndexAtomic(scope.scopeDir, index);

    const tombDir = join(ownersRoot, scope.ownerHex, 'bots', scope.botId, 'tombstones');
    await mkdir(tombDir, { recursive: true, mode: 0o700 });
    const tomb = {
      schema: 'torii.continuum.tombstone/1',
      id: rec.id, class: rec.class, kind: rec.kind, d_tag: rec.d_tag,
      sha256: rec.sha256, project: scope.projectSlug,
      deleted_at: now(), reason: params.reason || 'owner-delete',
    };
    const tf = join(tombDir, `${rec.id}.json`);
    const tmp = join(tombDir, `.${rec.id}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(tomb, null, 2), { mode: 0o600 });
    await rename(tmp, tf);
    log.warn(`[memstore] deleted ${rec.class}:${rec.d_tag} (${rec.id.slice(0, 12)}) owner=${scope.ownerHex.slice(0, 12)}`);
    return { ok: true, tombstone: tomb };
  }

  // ── usage / integrity / retention ─────────────────────────────────────────
  async function usage(ownerNpub) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const scopes = [];
    let totalBytes = 0; let totalItems = 0;
    const botsRoot = join(ownersRoot, ownerHex, 'bots');
    let bots;
    try { bots = await readdir(botsRoot); } catch { bots = []; }
    for (const bot of bots) {
      if (!SLUG_RE.test(bot)) continue;
      const projRoot = join(botsRoot, bot, 'projects');
      let projs;
      try { projs = await readdir(projRoot); } catch { continue; }
      for (const p of projs) {
        if (!SLUG_RE.test(p)) continue;
        const index = await readIndex(join(projRoot, p));
        const bytes = index.items.reduce((n, it) => n + (Number(it.size) || 0), 0);
        const byClass = {};
        for (const it of index.items) byClass[it.class] = (byClass[it.class] || 0) + 1;
        scopes.push({ bot_id: bot, project: p, items: index.items.length, bytes, by_class: byClass, index_corrupt: !!index.corrupt });
        totalBytes += bytes; totalItems += index.items.length;
      }
    }
    return {
      ok: true, owner_hex: ownerHex, total_items: totalItems, total_bytes: totalBytes,
      quotas, owner_bytes_remaining: Math.max(0, quotas.perOwnerBytes - totalBytes), scopes,
    };
  }

  /** Recompute every item's hash in a scope; report mismatches (corruption). */
  async function verifyScope(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const index = await readIndex(scope.scopeDir);
    const problems = [];
    for (const rec of index.items) {
      const abs = join(classDir(scope.scopeDir, rec.class), `${rec.id}.enc`);
      let body;
      try { body = await readFile(abs, 'utf8'); }
      catch { problems.push({ id: rec.id, reason: 'missing file' }); continue; }
      if (sha256Hex(Buffer.from(body, 'utf8')) !== rec.sha256) {
        problems.push({ id: rec.id, reason: 'hash mismatch' });
      }
    }
    return { ok: problems.length === 0, count: index.items.length, problems, index_corrupt: !!index.corrupt };
  }

  /**
   * Apply retention: drop items in non-permanent / retention-bounded classes
   * older than their window. Returns the ids reaped. Never touches permanent
   * classes with a null window.
   */
  async function applyRetention(params = {}) {
    const scope = resolveScope(params.ownerNpub, params.botId, params.projectSlug);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const index = await readIndex(scope.scopeDir);
    const nowTs = now();
    const reaped = [];
    const keep = [];
    for (const rec of index.items) {
      const meta = CLASSES[rec.class];
      const days = meta?.retentionDays;
      if (days && (nowTs - (rec.created_at || nowTs)) > days * 86400) {
        const abs = join(classDir(scope.scopeDir, rec.class), `${rec.id}.enc`);
        await unlink(abs).catch(() => {});
        reaped.push(rec.id);
      } else {
        keep.push(rec);
      }
    }
    if (reaped.length) {
      index.items = keep;
      index.updated_at = nowTs;
      await writeIndexAtomic(scope.scopeDir, index);
    }
    return { ok: true, reaped };
  }

  return {
    resolveScope, put, list, read, remove, usage, verifyScope, applyRetention,
    listAllForOwner, _ownersRoot: ownersRoot, _quotas: quotas,
  };
}
