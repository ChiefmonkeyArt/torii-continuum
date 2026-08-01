/**
 * Sovereign bot genesis (GENESIS-1).
 *
 * A genesis manifest is the birth certificate of a sovereign bot: it binds the
 * bot to exactly one verified Nostr owner, pins the humanitarian constitution
 * version + digest it was born under, and records the explicit-command-only
 * default that is foundational (see lib/constitution.mjs). This module owns the
 * create + read lifecycle with these invariants:
 *
 *   1. OWNER-BOUND FROM THE SESSION, NOT THE BODY. The owner pubkey is always
 *      derived from the caller's VERIFIED session npub. It is never read from
 *      untrusted request JSON, so a caller cannot mint a manifest for someone
 *      else's key (no session spoofing → no IDOR at write time).
 *   2. ONE-TIME + IDEMPOTENT. The first create for an owner writes the manifest;
 *      any later create by the SAME owner returns the existing manifest
 *      unchanged (created:false) — retries never fork a second identity.
 *   3. DEFAULT-DENY CROSS-OWNER. Reads/creates are namespaced by the owner's
 *      pubkey; one owner can never see or overwrite another's manifest.
 *   4. NO KEY MATERIAL. Only the PUBLIC key (npub/hex) is stored. Nothing here
 *      accepts, derives, or persists a private key or secret.
 *   5. ATOMIC + RESTRICTIVE. The manifest is written to a temp file and renamed
 *      into place (no torn writes) with 0600 perms under a 0700 dir.
 *
 * The manifest is provenance data, not a secret, so it is stored as plaintext
 * JSON (unlike the NIP-44 sealed character stack). Its own SHA-256 digest is
 * recorded for tamper evidence, and creation appends a hash-chained audit line.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import {
  getConstitution,
  getConstitutionByVersion,
  constitutionUpgrade,
  digestOf,
  verifyConstitutionDigest,
} from '../lib/constitution.mjs';

const MANIFEST_SCHEMA = 'torii.continuum.genesis_manifest/1';
const MANIFEST_VERSION = 1;
const COMMAND_MODE = 'explicit-command-only';

// Field bounds. Kept tight so a manifest is small, and validated on the way in
// so nothing unbounded reaches disk. All three are rendered client-side via
// textContent (never innerHTML), but we still bound + type-check here.
const DISPLAY_NAME_MAX = 80;
const ARCHETYPE_MAX = 60;
const CREATIVE_INTENT_MAX = 2000;

// Hex pubkey shape (32 bytes). Filenames/dirs use this, so it must be strictly
// validated to prevent any path traversal via the namespace segment.
const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Decode a verified npub to its hex pubkey. Fails closed on anything that is
 * not a well-formed npub. The input comes from the agent's own verified session
 * (auth.mjs), so this is defence-in-depth rather than the primary trust check.
 * @param {string} npub
 * @returns {string|null} 64-char hex, or null if undecodable
 */
export function ownerHexFromNpub(npub) {
  if (typeof npub !== 'string' || !npub.startsWith('npub1')) return null;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') return null;
    const hex = decoded.data;
    return HEX64_RE.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

function validateString(value, { field, min = 0, max, required = false }) {
  if (value == null || value === '') {
    if (required) return { ok: false, reason: `${field} required` };
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string` };
  const trimmed = value.trim();
  if (required && trimmed.length < Math.max(1, min)) return { ok: false, reason: `${field} required` };
  if (trimmed.length > max) return { ok: false, reason: `${field} too long (max ${max})` };
  return { ok: true, value: trimmed };
}

/**
 * Compute the manifest's own digest over its canonical serialization with the
 * `manifest_digest` field removed from the pre-image.
 * @param {object} manifest
 * @returns {string}
 */
export function manifestDigest(manifest) {
  const { manifest_digest, ...body } = manifest;
  return digestOf(body);
}

/**
 * @param {object} deps
 * @param {string} deps.agentRoot   absolute agent root (files go under memory/genesis/)
 * @param {object} [deps.audit]     createAudit() instance — append() called on genesis
 * @param {object} [deps.log]
 * @param {() => number} [deps.now] injectable clock (unix seconds) for tests
 */
export function createGenesis(deps = {}) {
  const agentRoot = deps.agentRoot;
  if (!agentRoot || typeof agentRoot !== 'string') {
    throw new Error('createGenesis: agentRoot required');
  }
  const audit = deps.audit || null;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const now = typeof deps.now === 'function' ? deps.now : () => Math.floor(Date.now() / 1000);

  const baseDir = join(agentRoot, 'memory', 'genesis');

  function ownerDir(ownerHex) {
    // ownerHex is strictly validated to 64 hex chars before this is called, so
    // it cannot contain a path separator or traversal segment.
    return join(baseDir, ownerHex);
  }
  function manifestPath(ownerHex) {
    return join(ownerDir(ownerHex), 'manifest.json');
  }

  async function readRaw(ownerHex) {
    let raw;
    try {
      raw = await readFile(manifestPath(ownerHex), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Present-but-corrupt manifest is a hard error, not a silent "absent" —
      // otherwise a corrupt file would let a second create fork the identity.
      throw new Error('genesis: manifest on disk is not valid JSON');
    }
  }

  async function writeManifest(ownerHex, manifest) {
    // Atomic: temp file in the owner dir, then rename over the target, so a
    // crash mid-write never leaves a torn manifest that a later read would
    // treat as corrupt (and refuse).
    const dir = ownerDir(ownerHex);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.manifest.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(tmp, manifestPath(ownerHex));
  }

  /**
   * Read the caller's own manifest. Default-deny: a caller only ever addresses
   * their OWN namespace (derived from their verified npub), so cross-owner
   * reads are structurally impossible.
   * @param {string} ownerNpub verified npub from the session
   * @returns {Promise<{ ok: boolean, exists: boolean, manifest?: object, constitution_ok?: boolean, reason?: string }>}
   */
  async function read(ownerNpub) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex) return { ok: false, exists: false, reason: 'invalid owner npub' };
    const manifest = await readRaw(ownerHex);
    if (!manifest) return { ok: true, exists: false };
    const check = verifyConstitutionDigest(
      manifest?.constitution?.digest,
      manifest?.constitution?.version,
    );
    return {
      ok: true,
      exists: true,
      manifest,
      constitution_ok: check.ok,
      constitution_reason: check.ok ? null : check.reason,
      // Whether the covenant the bot was born under is still the CURRENT version.
      // An older-but-valid version is not tampering — it is honest provenance —
      // so the UI can distinguish "drifted" (constitution_ok:false) from
      // "born under an earlier version" (constitution_ok:true, is_current:false).
      constitution_is_current: check.ok ? check.pinned_is_current === true : false,
      constitution_current_version: check.current_version,
      // Where this bot stands relative to the current covenant: what binds it
      // now, what a newer version would add, and the safety floor that binds
      // regardless of which version it was born under.
      constitution_upgrade: constitutionUpgrade(
        manifest?.constitution?.version,
        manifest?.constitution?.acknowledged_version,
      ),
      manifest_digest_ok: manifestDigest(manifest) === manifest.manifest_digest,
    };
  }

  /**
   * Record the owner's explicit acknowledgement of a newer constitution.
   *
   * The version the bot was BORN under is never rewritten — `constitution.version`
   * and `constitution.digest` stay exactly as minted, so the birth certificate
   * keeps verifying against its frozen bytes forever. Adoption is recorded
   * alongside it as `acknowledged_version`/`acknowledged_digest` plus an append-
   * only history, which is what makes this a migration rather than a forgery.
   *
   * Fails closed on every uncertainty: unknown version, digest that does not
   * match the registry's bytes for that version, or a target that is not the
   * current covenant. An owner can only ever acknowledge something we can show
   * them in full.
   *
   * @param {object} params
   * @param {string} params.ownerNpub VERIFIED npub from the session (authority)
   * @param {string} params.toVersion version being acknowledged
   * @param {string} params.toDigest  digest the client displayed to the owner
   * @returns {Promise<{ ok, code?, reason?, acknowledged?, manifest? }>}
   */
  async function acknowledgeConstitution(params = {}) {
    const ownerHex = ownerHexFromNpub(params.ownerNpub);
    if (!ownerHex) return { ok: false, code: 'bad_owner', reason: 'invalid owner npub' };

    const manifest = await readRaw(ownerHex);
    if (!manifest) return { ok: false, code: 'no_manifest', reason: 'no genesis manifest for this owner' };

    const current = getConstitution();
    const target = getConstitutionByVersion(params.toVersion);
    if (!target) {
      return { ok: false, code: 'unknown_version', reason: `unknown constitution version ${params.toVersion}` };
    }
    if (target.version !== current.version) {
      return {
        ok: false,
        code: 'not_current',
        reason: `only the current constitution (${current.version}) can be acknowledged`,
      };
    }
    // The digest the client showed the owner must be the digest of the bytes we
    // hold. A mismatch means they consented to something other than this text.
    if (params.toDigest !== target.digest) {
      return { ok: false, code: 'digest_mismatch', reason: 'digest does not match the named version' };
    }
    if (manifest?.constitution?.acknowledged_version === target.version) {
      return { ok: true, acknowledged: false, manifest };
    }

    const ts = now();
    const history = Array.isArray(manifest.constitution_acknowledgements)
      ? manifest.constitution_acknowledgements
      : [];
    const next = {
      ...manifest,
      constitution: {
        ...manifest.constitution,
        acknowledged_version: target.version,
        acknowledged_digest: target.digest,
        acknowledged_at: ts,
      },
      constitution_acknowledgements: [
        ...history,
        {
          from_version: manifest?.constitution?.acknowledged_version || manifest?.constitution?.version || null,
          to_version: target.version,
          to_digest: target.digest,
          acknowledged_at: ts,
          acknowledged_at_iso: new Date(ts * 1000).toISOString(),
        },
      ],
      updated_at: ts,
    };
    delete next.manifest_digest;
    next.manifest_digest = manifestDigest(next);

    await writeManifest(ownerHex, next);
    log.info(`[genesis] owner ${ownerHex.slice(0, 12)} acknowledged constitution ${target.version}`);

    if (audit && typeof audit.append === 'function') {
      try {
        await audit.append('genesis.constitution.acknowledge', {
          bot_id: next.bot_id,
          owner_pubkey_prefix: ownerHex.slice(0, 12),
          born_version: next?.constitution?.version || null,
          acknowledged_version: target.version,
          acknowledged_digest: target.digest,
          manifest_digest: next.manifest_digest,
        });
      } catch (e) {
        log.error(`[genesis] audit append failed after acknowledge: ${e.message}`);
      }
    }

    return { ok: true, acknowledged: true, manifest: next };
  }

  /**
   * Create (or idempotently return) the caller's genesis manifest.
   *
   * @param {object} params
   * @param {string} params.ownerNpub  VERIFIED npub from the session (authority)
   * @param {string} params.displayName
   * @param {string} [params.archetype]
   * @param {string} [params.creativeIntent]
   * @param {string} [params.agentVersion] stamped into provenance
   * @returns {Promise<{ ok, created?, manifest?, code?, reason? }>}
   */
  async function create(params = {}) {
    const ownerHex = ownerHexFromNpub(params.ownerNpub);
    if (!ownerHex) return { ok: false, code: 'bad_owner', reason: 'invalid owner npub' };
    const ownerNpub = params.ownerNpub;

    const name = validateString(params.displayName, { field: 'display_name', required: true, max: DISPLAY_NAME_MAX });
    if (!name.ok) return { ok: false, code: 'validation', reason: name.reason };
    const archetype = validateString(params.archetype, { field: 'archetype', max: ARCHETYPE_MAX });
    if (!archetype.ok) return { ok: false, code: 'validation', reason: archetype.reason };
    const intent = validateString(params.creativeIntent, { field: 'creative_intent', max: CREATIVE_INTENT_MAX });
    if (!intent.ok) return { ok: false, code: 'validation', reason: intent.reason };

    // Idempotency: an existing manifest for this owner is returned as-is. We do
    // NOT overwrite with the new (possibly different) display fields — genesis
    // happens once, and a retry must never fork a second identity.
    const existing = await readRaw(ownerHex);
    if (existing) {
      log.info(`[genesis] idempotent read for owner ${ownerHex.slice(0, 12)} (bot ${String(existing.bot_id).slice(0, 8)})`);
      return { ok: true, created: false, manifest: existing };
    }

    const constitution = getConstitution();
    const ts = now();
    const iso = new Date(ts * 1000).toISOString();

    const manifest = {
      schema: MANIFEST_SCHEMA,
      manifest_version: MANIFEST_VERSION,
      bot_id: randomBytes(16).toString('hex'),
      owner: {
        npub: ownerNpub,
        pubkey_hex: ownerHex,
      },
      display_name: name.value,
      archetype: archetype.value || null,
      creative_intent: intent.value || null,
      constitution: {
        schema: constitution.body.schema,
        version: constitution.version,
        digest: constitution.digest,
      },
      policy: {
        command_mode: COMMAND_MODE,
        owner_bound: true,
        default_deny: true,
        consent_required_for: ['external_action', 'paid_inference', 'memory_write', 'publishing', 'training'],
      },
      provenance: {
        genesis_agent_version: typeof params.agentVersion === 'string' ? params.agentVersion : null,
        constitution_provenance: 'lib/constitution.mjs',
        stage: 'genesis-1',
        lora: 'not-started',
        rag: 'not-started',
      },
      // Reserved for safe forward-compatible extension without a schema bump.
      extensions: {},
      created_at: ts,
      created_at_iso: iso,
      updated_at: ts,
    };
    manifest.manifest_digest = manifestDigest(manifest);

    // O_EXCL on the final path is not used because rename is the atomicity
    // primitive; the pre-write existence check above plus the single-writer
    // process make a duplicate-create race a no-op.
    await writeManifest(ownerHex, manifest);

    log.info(`[genesis] created bot ${manifest.bot_id.slice(0, 8)} for owner ${ownerHex.slice(0, 12)} (constitution ${constitution.version})`);

    if (audit && typeof audit.append === 'function') {
      try {
        await audit.append('genesis.create', {
          bot_id: manifest.bot_id,
          owner_pubkey_prefix: ownerHex.slice(0, 12),
          constitution_version: constitution.version,
          constitution_digest: constitution.digest,
          manifest_digest: manifest.manifest_digest,
          command_mode: COMMAND_MODE,
        });
      } catch (e) {
        // A failed audit append must not roll back a successful genesis, but it
        // must be loud — the manifest exists; the ledger just missed a line.
        log.error(`[genesis] audit append failed after create: ${e.message}`);
      }
    }

    return { ok: true, created: true, manifest };
  }

  return { create, read, acknowledgeConstitution, _baseDir: baseDir, _manifestPath: manifestPath };
}
