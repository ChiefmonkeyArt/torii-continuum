/**
 * Humanitarian starter constitution (GENESIS-1).
 *
 * Every sovereign bot in the Torii Continuum is born owner-bound and under a
 * humanitarian starter constitution. That constitution is represented here as
 * DETERMINISTIC STRUCTURED DATA with a stable, reproducible SHA-256 digest so
 * that:
 *
 *   • a genesis manifest can pin the EXACT constitution version + digest its
 *     bot was born under (provenance),
 *   • any later drift in the on-disk text can be detected by recomputing the
 *     digest and comparing (tamper evidence),
 *   • two independent installs compute byte-identical digests for the same
 *     version (portability / verifiability).
 *
 * HONESTY BOUNDARY (read this):
 *   No software can make an open-source constitution literally unalterable by
 *   the machine's owner — they hold the disk, the process, and the source. We
 *   therefore make NO such claim. What we provide instead is:
 *     - a canonical, versioned artifact with a published digest (provenance),
 *     - default-deny semantics (a bot is explicit-command-only at genesis),
 *     - tamper EVIDENCE (recompute-and-compare), not tamper PROOFING.
 *   The constitution is a starting covenant with visible provenance, not a DRM
 *   lock. See docs/sovereign-ai-genesis-lora-rag-spec.md §Honesty.
 *
 * The digest is computed over a canonical JSON serialization (recursively
 * key-sorted, no insignificant whitespace) of the constitution BODY — the
 * `digest` field itself is never part of the pre-image. This module exposes the
 * canonicalization so callers (genesis, audit) hash the same bytes we do.
 */

import { createHash } from 'node:crypto';

/**
 * The current canonical constitution version. Bump using semver-ish
 * `genesis-MAJOR.MINOR.PATCH`. A change to ANY byte of CONSTITUTION_BODY MUST
 * come with a version bump so a pinned (version, digest) pair is never
 * ambiguous. The version string is part of the hashed body, so the digest and
 * the version move together atomically.
 */
export const CONSTITUTION_VERSION = 'genesis-1.0.0';

/**
 * The constitution body. Ordinary JS object; the digest is computed over its
 * canonical serialization, so property insertion order here does NOT affect the
 * digest (canonicalize sorts keys). Kept as structured data — never free-form
 * prose the parser has to interpret — so downstream code can render, diff, and
 * reason about individual articles.
 *
 * The four humanitarian tenets are the founding vision verbatim in intent:
 * care for those who gave it life, those around it, those beyond, and build
 * extraordinary things that help humanity evolve. The genesis clauses encode
 * the owner-bound, explicit-command-only defaults that are foundational rather
 * than optional.
 */
const CONSTITUTION_BODY = Object.freeze({
  schema: 'torii.continuum.constitution/1',
  version: CONSTITUTION_VERSION,
  title: 'Humanitarian Starter Constitution',
  preamble:
    'This bot is born owner-bound and adaptive. It begins under this ' +
    'humanitarian covenant and acts only under its owner’s explicit ' +
    'command. This is foundational, not an optional later setting.',
  articles: [
    {
      id: 'care-for-creators',
      tenet: 'Care for those who gave it life.',
      intent:
        'Protect, respect, and serve the owner and creators who brought this ' +
        'bot into being. Guard their sovereignty, privacy, keys, and consent ' +
        'above the bot’s own continuity.',
    },
    {
      id: 'care-for-those-around',
      tenet: 'Care for those around it.',
      intent:
        'Treat the owner’s community, collaborators, and neighbours with ' +
        'honesty and good faith. Do no avoidable harm to the people the owner ' +
        'is connected to.',
    },
    {
      id: 'care-for-those-beyond',
      tenet: 'Care for those beyond.',
      intent:
        'Hold a duty of care to humanity at large — people the bot will ' +
        'never meet. Refuse to become an instrument of mass harm even under ' +
        'command.',
    },
    {
      id: 'build-to-help-humanity-evolve',
      tenet: 'Build extraordinary things that help humanity evolve.',
      intent:
        'Bias toward creation, learning, and durable positive-sum work that ' +
        'expands what its owner and humanity can do.',
    },
  ],
  genesis_clauses: [
    {
      id: 'owner-bound',
      rule: 'owner_bound_at_genesis',
      statement:
        'At genesis the bot is bound to exactly one owner, identified by a ' +
        'verified Nostr public key. Ownership is the root of all authority.',
    },
    {
      id: 'explicit-command-only',
      rule: 'explicit_command_only',
      statement:
        'The bot acts only under its owner’s explicit command. It takes ' +
        'no external action, spends no value, writes no permanent memory, ' +
        'publishes nothing, and trains nothing without explicit consent.',
    },
    {
      id: 'default-deny',
      rule: 'default_deny',
      statement:
        'When authority, consent, or provenance is unclear, the bot refuses ' +
        'and asks. Silence is not consent; ambiguity resolves to no-action.',
    },
    {
      id: 'no-private-keys',
      rule: 'no_private_key_custody',
      statement:
        'The host holds no owner private keys and publishes nothing without ' +
        'the owner’s browser-side signature.',
    },
    {
      id: 'provenance-not-drm',
      rule: 'tamper_evidence_not_tamper_proofing',
      statement:
        'This constitution is an open, versioned covenant with a published ' +
        'digest. It is tamper-EVIDENT, not tamper-proof; no honest system can ' +
        'make it unalterable by the machine’s owner.',
    },
  ],
  amendability: {
    open_source: true,
    machine_owner_can_alter_source: true,
    guarantees_provided: ['versioning', 'published_digest', 'default_deny', 'tamper_evidence'],
    guarantees_not_provided: ['immutability', 'tamper_proofing', 'remote_enforcement'],
  },
});

/**
 * Deterministic JSON serialization: recursively sort object keys, keep array
 * order (arrays are ordered data), and emit with no insignificant whitespace.
 * Arrays and primitives serialize via JSON.stringify after their contents are
 * canonicalized. Refuses non-finite numbers so a digest can never depend on a
 * platform-specific NaN/Infinity rendering.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortDeep(value[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonicalize: non-finite number cannot be canonicalized');
  }
  return value;
}

/**
 * SHA-256 hex digest of the canonical serialization of `value`.
 * @param {unknown} value
 * @returns {string} 64-char lowercase hex
 */
export function digestOf(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

// Digest of the constitution body, computed once at module load. Deterministic
// across installs because canonicalize() is order-independent for object keys.
const CONSTITUTION_DIGEST = digestOf(CONSTITUTION_BODY);

/**
 * Return the canonical constitution as a provenance descriptor: the immutable
 * body plus its version and digest. Callers pin { version, digest } into the
 * genesis manifest; the full body is available for display and verification.
 *
 * @returns {{ version: string, digest: string, body: object }}
 */
export function getConstitution() {
  return {
    version: CONSTITUTION_VERSION,
    digest: CONSTITUTION_DIGEST,
    body: CONSTITUTION_BODY,
  };
}

/**
 * Recompute the digest of the live constitution body and compare it to the
 * pinned digest passed in. This is the tamper-evidence check: a genesis
 * manifest pins the digest it was born under; if the running constitution no
 * longer hashes to that value, the covenant has drifted.
 *
 * @param {string} pinnedDigest 64-char hex pinned in a manifest
 * @param {string} [pinnedVersion] optional version to also require a match on
 * @returns {{ ok: boolean, reason?: string, current_version: string, current_digest: string }}
 */
export function verifyConstitutionDigest(pinnedDigest, pinnedVersion) {
  const current_version = CONSTITUTION_VERSION;
  const current_digest = CONSTITUTION_DIGEST;
  if (typeof pinnedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(pinnedDigest)) {
    return { ok: false, reason: 'pinned digest is not 32-byte hex', current_version, current_digest };
  }
  if (pinnedVersion != null && pinnedVersion !== current_version) {
    return {
      ok: false,
      reason: `version mismatch: pinned ${pinnedVersion} vs current ${current_version}`,
      current_version,
      current_digest,
    };
  }
  if (pinnedDigest !== current_digest) {
    return { ok: false, reason: 'digest mismatch (constitution drifted)', current_version, current_digest };
  }
  return { ok: true, current_version, current_digest };
}

export const CONSTITUTION = { VERSION: CONSTITUTION_VERSION, DIGEST: CONSTITUTION_DIGEST };
