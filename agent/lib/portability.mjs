/**
 * MEMORY-1 manual portable-memory envelope (encrypted, owner-signed).
 *
 * Requirement §4: define+implement a versioned portable bundle that carries
 * CIPHERTEXTS ONLY plus minimal metadata, with a deterministic manifest the
 * owner signs IN THE BROWSER (NIP-07). The server never receives a private key
 * and never publishes to a relay — this is manual download/upload only. Actual
 * relay sync + auto multi-device remain deferred; kind 30092 is NOT touched.
 *
 * Bundle shape (torii.continuum.memory_bundle/1):
 *   {
 *     schema, format_version: 1,
 *     manifest: { … , manifest_digest },     // deterministic, digest self-excluded
 *     signature: <signed Nostr event>,        // owner-signed proof over the digest
 *     items: [ { class, kind, d_tag, scope, sha256, ciphertext } ]
 *   }
 *
 * The manifest pins: owner pubkey, bot id, project scopes, per-item
 * hashes/counts/classes, format/version, constitution (version+digest) + COP
 * version provenance, timestamps, and an integrity_root (hash over the sorted
 * item hashes). The owner signs an event whose `x` tag equals manifest_digest,
 * so the signature binds the exact bundle contents to the owner's key.
 *
 * IMPORT is default-deny and NON-TRUSTING: it verifies signature, exact owner,
 * bot/project scope, format version, every ciphertext hash, the integrity_root,
 * and the manifest digest; rejects malformed/foreign/tampered bundles; dedupes;
 * and QUARANTINES accepted items (never straight into live memory). Imported
 * ciphertext stays sealed and its eventual plaintext is treated as untrusted
 * data until the owner reviews + approves it out of quarantine.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { ownerHexFromNpub } from '../core/genesis.mjs';
import { canonicalize, getConstitution, CODE_OF_PRACTICE_VERSION } from './constitution.mjs';
import { validBotId, validProjectSlug, CLASSES, MAX_ITEM_BYTES } from './memstore.mjs';

export const BUNDLE_SCHEMA = 'torii.continuum.memory_bundle/1';
export const BUNDLE_FORMAT_VERSION = 1;
// Custom app kind for the DETACHED manifest signature. Not a memory event and
// never published — it exists only so the owner's signer can prove the bundle.
export const BUNDLE_SIG_KIND = 30099;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Hard ceiling on an imported bundle so a decompression/enumeration bomb cannot
// exhaust memory/disk. Item count is separately bounded by store quotas.
export const MAX_BUNDLE_ITEMS = 2000;

function sha256Hex(s) {
  return createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).digest('hex');
}

/** Deterministic integrity root over the sorted per-item ciphertext hashes. */
function integrityRoot(items) {
  const sorted = items.map((i) => i.sha256).filter(Boolean).sort();
  return sha256Hex(sorted.join('\n'));
}

/**
 * Build the deterministic manifest for a set of items. `items` each have
 * { class, kind, d_tag, scope:{bot_id,project}, sha256 }.
 */
export function buildManifest({ ownerHex, botId, items, createdAt }) {
  const c = getConstitution();
  const classes = {};
  const projectSet = new Set();
  for (const it of items) {
    classes[it.class] = (classes[it.class] || 0) + 1;
    if (it.scope?.project) projectSet.add(it.scope.project);
  }
  // Deterministic item ordering: by (scope.project, class, d_tag, sha256).
  const orderedItems = [...items]
    .map((it) => ({
      class: it.class, kind: it.kind || null, d_tag: it.d_tag,
      scope: { bot_id: it.scope?.bot_id || botId, project: it.scope?.project || null },
      sha256: it.sha256,
    }))
    .sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));

  const manifest = {
    schema: BUNDLE_SCHEMA,
    format_version: BUNDLE_FORMAT_VERSION,
    owner_pubkey: ownerHex,
    bot_id: botId,
    project_scopes: [...projectSet].sort(),
    item_count: orderedItems.length,
    classes,
    items: orderedItems,
    constitution: { version: c.version, digest: c.digest },
    code_of_practice_version: CODE_OF_PRACTICE_VERSION,
    integrity_root: integrityRoot(orderedItems),
    created_at: createdAt || Math.floor(Date.now() / 1000),
  };
  manifest.manifest_digest = sha256Hex(canonicalize(withoutDigest(manifest)));
  return manifest;
}

function withoutDigest(m) {
  const { manifest_digest, ...rest } = m;
  return rest;
}

/**
 * @param {object} deps
 * @param {string} deps.memoryRoot
 * @param {object} deps.memstore
 * @param {object} [deps.audit]
 * @param {object} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createPortability(deps = {}) {
  const memoryRoot = deps.memoryRoot;
  if (!memoryRoot) throw new Error('createPortability: memoryRoot required');
  const memstore = deps.memstore;
  if (!memstore) throw new Error('createPortability: memstore required');
  const audit = deps.audit || null;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const now = typeof deps.now === 'function' ? deps.now : () => Math.floor(Date.now() / 1000);
  const ownersRoot = join(memoryRoot, 'owners');

  function quarantineDir(ownerHex, botId) {
    return join(ownersRoot, ownerHex, 'bots', botId, 'quarantine');
  }

  /**
   * Assemble an UNSIGNED bundle for an owner from the live store. The browser
   * then signs the manifest and downloads the completed bundle. Export requires
   * explicit confirmation at the route layer.
   */
  async function buildBundle({ ownerNpub, botId }) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    const all = await memstore.listAllForOwner(ownerNpub);
    if (!all.ok) return { ok: false, reason: all.reason };
    const items = all.entries
      .filter((e) => e.scope.bot_id === bot && e.integrity_ok)
      .map((e) => ({
        class: e.class, kind: e.kind, d_tag: e.d_tag,
        scope: { bot_id: e.scope.bot_id, project: e.scope.project },
        sha256: e.sha256, ciphertext: e.ciphertext,
      }));
    const manifest = buildManifest({ ownerHex, botId: bot, items, createdAt: now() });
    if (audit) {
      await audit.append('memory.export', {
        owner_pubkey_prefix: ownerHex.slice(0, 12), bot_id: bot,
        item_count: manifest.item_count, manifest_digest: manifest.manifest_digest,
      }).catch((e) => log.error(`[portability] audit export failed: ${e.message}`));
    }
    return {
      ok: true,
      bundle: {
        schema: BUNDLE_SCHEMA,
        format_version: BUNDLE_FORMAT_VERSION,
        manifest,
        signature: null, // filled by the browser signer
        items: items.map((i) => ({ class: i.class, kind: i.kind, d_tag: i.d_tag, scope: i.scope, sha256: i.sha256, ciphertext: i.ciphertext })),
      },
      // The exact digest the browser must sign (as event `x` tag + content).
      sign_target: { manifest_digest: manifest.manifest_digest, sig_kind: BUNDLE_SIG_KIND },
    };
  }

  /**
   * Verify a bundle end-to-end WITHOUT touching disk. Returns
   * { ok, reason?, manifest?, owner_hex? }.
   */
  function verifyBundle(bundle, { expectedOwnerHex } = {}) {
    if (!bundle || typeof bundle !== 'object') return { ok: false, reason: 'bundle not an object' };
    if (bundle.schema !== BUNDLE_SCHEMA) return { ok: false, reason: 'unknown bundle schema' };
    if (bundle.format_version !== BUNDLE_FORMAT_VERSION) return { ok: false, reason: `unsupported format_version ${bundle.format_version}` };
    const m = bundle.manifest;
    if (!m || typeof m !== 'object') return { ok: false, reason: 'missing manifest' };
    if (!HEX64_RE.test(m.owner_pubkey || '')) return { ok: false, reason: 'manifest owner_pubkey not hex' };
    if (!validBotId(m.bot_id)) return { ok: false, reason: 'manifest bot_id invalid' };
    if (!Array.isArray(bundle.items)) return { ok: false, reason: 'items not an array' };
    if (bundle.items.length > MAX_BUNDLE_ITEMS) return { ok: false, reason: `too many items (> ${MAX_BUNDLE_ITEMS})` };

    // Owner binding: the bundle owner must match the importing session owner.
    if (expectedOwnerHex && m.owner_pubkey !== expectedOwnerHex) {
      return { ok: false, reason: 'foreign owner (bundle not owned by importer)' };
    }

    // Manifest digest integrity.
    const recomputed = sha256Hex(canonicalize(withoutDigest(m)));
    if (recomputed !== m.manifest_digest) return { ok: false, reason: 'manifest digest mismatch (tampered)' };

    // Per-item ciphertext hash + shape validation, and cross-check vs manifest.
    const manifestByKey = new Map();
    for (const mi of m.items || []) manifestByKey.set(`${mi.scope?.project}:${mi.class}:${mi.d_tag}:${mi.sha256}`, mi);
    for (const it of bundle.items) {
      if (typeof it.ciphertext !== 'string' || it.ciphertext.length === 0) return { ok: false, reason: 'item missing ciphertext' };
      if (Buffer.byteLength(it.ciphertext, 'utf8') > MAX_ITEM_BYTES) return { ok: false, reason: 'item exceeds max size' };
      if (!CLASSES[it.class]) return { ok: false, reason: `item unknown class ${it.class}` };
      if (typeof it.d_tag !== 'string' || it.d_tag.length === 0 || it.d_tag.length > 64) return { ok: false, reason: 'item bad d_tag' };
      const proj = it.scope?.project;
      if (proj != null && !validProjectSlug(proj)) return { ok: false, reason: 'item bad project scope' };
      const actual = sha256Hex(it.ciphertext);
      if (actual !== it.sha256) return { ok: false, reason: 'item ciphertext hash mismatch (corrupt/tampered)' };
      if (!manifestByKey.has(`${proj}:${it.class}:${it.d_tag}:${it.sha256}`)) {
        return { ok: false, reason: 'item not listed in manifest' };
      }
    }

    // integrity_root must match the manifest item hashes.
    if (integrityRoot(m.items || []) !== m.integrity_root) return { ok: false, reason: 'integrity_root mismatch' };

    // Signature: owner-signed event over the manifest digest.
    const sig = bundle.signature;
    if (!sig || typeof sig !== 'object') return { ok: false, reason: 'missing manifest signature' };
    if (sig.pubkey !== m.owner_pubkey) return { ok: false, reason: 'signature pubkey != manifest owner' };
    if (Number(sig.kind) !== BUNDLE_SIG_KIND) return { ok: false, reason: 'signature wrong kind' };
    const xTag = Array.isArray(sig.tags) ? sig.tags.find((t) => t[0] === 'x') : null;
    if (!xTag || xTag[1] !== m.manifest_digest) return { ok: false, reason: 'signature does not bind manifest digest' };
    let sigOk = false;
    try { sigOk = verifyEvent(sig); } catch { sigOk = false; }
    if (!sigOk) return { ok: false, reason: 'invalid manifest signature' };

    return { ok: true, manifest: m, owner_hex: m.owner_pubkey };
  }

  /**
   * Import a verified bundle into QUARANTINE (never live memory). Dedupes
   * against existing quarantine + live store by ciphertext sha256. Returns
   * counts of quarantined vs skipped-duplicate.
   */
  async function importToQuarantine({ ownerNpub, bundle }) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const v = verifyBundle(bundle, { expectedOwnerHex: ownerHex });
    if (!v.ok) {
      if (audit) await audit.append('memory.import.reject', { owner_pubkey_prefix: ownerHex.slice(0, 12), reason: v.reason }).catch(() => {});
      return { ok: false, reason: v.reason };
    }
    const botId = v.manifest.bot_id;
    const dir = quarantineDir(ownerHex, botId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // Existing quarantine hashes (dedupe).
    const seen = new Set();
    try {
      for (const f of await readdir(dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(f)) continue;
        seen.add(f.slice(0, 64));
      }
    } catch { /* no quarantine yet */ }
    // Live store hashes (dedupe against already-approved memory).
    const live = await memstore.listAllForOwner(ownerNpub);
    const liveHashes = new Set(live.ok ? live.entries.filter((e) => e.scope.bot_id === botId).map((e) => e.sha256) : []);

    let quarantined = 0; let duplicate = 0;
    for (const it of bundle.items) {
      if (seen.has(it.sha256) || liveHashes.has(it.sha256)) { duplicate++; continue; }
      const rec = {
        schema: 'torii.continuum.quarantine_item/1',
        owner_hex: ownerHex, bot_id: botId, project: it.scope?.project || null,
        class: it.class, kind: it.kind || null, d_tag: it.d_tag,
        sha256: it.sha256, ciphertext: it.ciphertext,
        origin: 'import', manifest_digest: v.manifest.manifest_digest,
        imported_at: now(), status: 'quarantined',
      };
      const f = join(dir, `${it.sha256}.json`);
      if (!resolve(f).startsWith(resolve(ownersRoot, ownerHex) + sep)) continue;
      const tmp = join(dir, `.${it.sha256}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
      await rename(tmp, f);
      seen.add(it.sha256);
      quarantined++;
    }
    if (audit) {
      await audit.append('memory.import', {
        owner_pubkey_prefix: ownerHex.slice(0, 12), bot_id: botId,
        manifest_digest: v.manifest.manifest_digest,
        quarantined, duplicate, item_count: bundle.items.length,
      }).catch((e) => log.error(`[portability] audit import failed: ${e.message}`));
    }
    log.info(`[portability] import owner=${ownerHex.slice(0, 12)} bot=${botId} quarantined=${quarantined} dup=${duplicate}`);
    return { ok: true, quarantined, duplicate, manifest_digest: v.manifest.manifest_digest, bot_id: botId };
  }

  async function listQuarantine({ ownerNpub, botId }) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    const dir = quarantineDir(ownerHex, bot);
    let files;
    try { files = await readdir(dir); } catch { return { ok: true, count: 0, items: [] }; }
    const items = [];
    for (const f of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(await readFile(join(dir, f), 'utf8'));
        items.push({ sha256: r.sha256, class: r.class, kind: r.kind, d_tag: r.d_tag, project: r.project, ciphertext: r.ciphertext, imported_at: r.imported_at, status: r.status });
      } catch { /* skip */ }
    }
    return { ok: true, count: items.length, items };
  }

  /**
   * Approve a quarantined item into live memory. Bound to the exact ciphertext
   * sha256 the owner reviewed; idempotent per sha256 (removing the quarantine
   * file on success). The item stays a durable memory only after this explicit
   * step — import alone never grants trust.
   */
  async function approveQuarantine({ ownerNpub, botId, sha256, expectSha256, projectSlug, dTag }) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    if (!/^[a-f0-9]{64}$/.test(sha256 || '')) return { ok: false, reason: 'bad sha256' };
    if (expectSha256 && expectSha256 !== sha256) return { ok: false, reason: 'approved hash mismatch' };
    const dir = quarantineDir(ownerHex, bot);
    const f = join(dir, `${sha256}.json`);
    if (!resolve(f).startsWith(resolve(ownersRoot, ownerHex) + sep)) return { ok: false, reason: 'path escapes' };
    let rec;
    try { rec = JSON.parse(await readFile(f, 'utf8')); } catch { return { ok: false, reason: 'quarantine item not found' }; }
    const stored = await memstore.put({
      ownerNpub, botId: bot, projectSlug: projectSlug || rec.project,
      cls: rec.class, kind: rec.kind, dTag: dTag || rec.d_tag,
      ciphertext: rec.ciphertext, expectSha256: sha256,
      source: 'import-approved', approvedAt: now(),
    });
    if (!stored.ok) return { ok: false, reason: stored.reason, code: stored.code };
    await unlink(f).catch(() => {});
    if (audit) {
      await audit.append('memory.import.approve', {
        owner_pubkey_prefix: ownerHex.slice(0, 12), bot_id: bot,
        ciphertext_sha256: sha256, stored_id: stored.id,
      }).catch(() => {});
    }
    return { ok: true, stored: { id: stored.id, sha256: stored.sha256, path: stored.path } };
  }

  async function rejectQuarantine({ ownerNpub, botId, sha256 }) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    if (!/^[a-f0-9]{64}$/.test(sha256 || '')) return { ok: false, reason: 'bad sha256' };
    const f = join(quarantineDir(ownerHex, bot), `${sha256}.json`);
    if (!resolve(f).startsWith(resolve(ownersRoot, ownerHex) + sep)) return { ok: false, reason: 'path escapes' };
    await unlink(f).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    if (audit) await audit.append('memory.import.reject_item', { owner_pubkey_prefix: ownerHex.slice(0, 12), bot_id: bot, ciphertext_sha256: sha256 }).catch(() => {});
    return { ok: true };
  }

  return {
    buildBundle, verifyBundle, importToQuarantine,
    listQuarantine, approveQuarantine, rejectQuarantine, buildManifest,
  };
}
