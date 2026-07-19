/**
 * Character-tree Nostr event helpers — draft only. Never sign.
 *
 * This module knows the shape of every event kind in the CONT-CHARACTER-1
 * stack and produces `unsigned` JSON that the operator's signer (Plebeian
 * Signer via NIP-07) turns into real events. The agent NEVER signs.
 *
 * Event kinds (all parameterized-replaceable, NIP-01):
 *
 *   30092  character_root
 *     ONE per operator. `d`-tag = "root". Content (after operator NIP-44
 *     encrypts to their own npub) is the SHA-256 fingerprint of the current
 *     CHARACTER.md plus a version string. Lets the operator prove which
 *     character version was active at time T without leaking the character.
 *
 *   30094  semantic_fact
 *     One durable belief / preference / fact per event.
 *     `d`-tag = stable slug (e.g. "pseudonym-only", "ancap-agorist-stance").
 *     Content = { fact, why, source, confidence, added_at }.
 *
 *   30095  procedural_skill
 *     A reflex or reusable how-to that runs before the model speaks.
 *     `d`-tag = skill slug (e.g. "right-speech-filter", "refusal-with-law").
 *     Content = { name, trigger, action, guard, added_at }.
 *
 *   30096  destructive_intent
 *     A PROPOSAL to wipe or rewrite memory. Requires:
 *       - 60s cooldown between propose and enact
 *       - double signature (operator + operator-on-second-device)
 *     UNLESS a 30097 (panic key) is currently loaded, in which case
 *     single signature is sufficient.
 *
 *   30097  emergency_wipe_authority
 *     The panic key. Published ONCE from a cold device and stored offline.
 *     Its mere presence (as a decrypt-known event) collapses the 30096
 *     double-sig requirement to single-sig. Runbook: agent/PANIC_KEY_SETUP.md.
 *
 * Every event we draft here is:
 *   - unsigned (`id`, `sig`, `pubkey` absent)
 *   - has plaintext `content` that the operator's signer will NIP-44 v2
 *     encrypt to their OWN npub before signing
 *   - tagged with `["encrypted"]` per the informal community convention
 *     for sealed replaceable events, plus `["d", <slug>]`
 *
 * Nothing in this module signs, publishes, or generates a key.
 */

const CHARACTER_ROOT = 30092;
const SEMANTIC_FACT = 30094;
const PROCEDURAL_SKILL = 30095;
const DESTRUCTIVE_INTENT = 30096;
const EMERGENCY_WIPE = 30097;

/**
 * Slug validator — d-tags must be stable, short, and URL-safe. We accept
 * ASCII letters, digits, hyphen; length 1..64.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertSlug(dTag) {
  if (typeof dTag !== 'string' || !SLUG_RE.test(dTag)) {
    throw new Error(`bad d-tag slug: ${JSON.stringify(dTag)} (expect lowercase-hyphen, 1..64 chars)`);
  }
}

function assertJsonSafe(obj) {
  // JSON.stringify will throw on cycles; we also cap size.
  const str = JSON.stringify(obj);
  if (str.length > 32 * 1024) throw new Error(`content too large: ${str.length} > 32768`);
  return str;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Common unsigned-event shape. The operator's signer will:
 *   1. NIP-44 v2 encrypt `content` to their own npub
 *   2. Fill in `pubkey`, `created_at` (if missing), compute `id`, and sign
 *
 * @param {number} kind
 * @param {string} dTag
 * @param {object} content   plaintext payload (to be encrypted by signer)
 * @param {Array<Array<string>>} extraTags
 */
function unsignedEvent(kind, dTag, content, extraTags = []) {
  assertSlug(dTag);
  const plaintextJson = assertJsonSafe(content);
  return {
    unsigned: true, // sentinel — the signer must strip this before signing
    kind,
    created_at: now(),
    tags: [
      ['d', dTag],
      ['encrypted'],
      ['client', 'torii-continuum-agent'],
      ...extraTags,
    ],
    // NOTE: `content` here is *plaintext JSON*. The signer will NIP-44
    // encrypt it before it becomes an id / signature. We do NOT ship this
    // to disk; only `agent/pending/*.draft.json` holds this shape.
    content_plaintext: plaintextJson,
  };
}

// ─────────────────────────────────────────────────────────────
// Drafters (never sign, never publish)
// ─────────────────────────────────────────────────────────────

/**
 * Draft a character_root event. There is only ever one, keyed d="root".
 *
 * @param {object} params
 * @param {string} params.characterHash    hex sha256 of CHARACTER.md
 * @param {string} params.characterVersion e.g. "v2-2026-07-06"
 * @param {string} params.sourcesHash      hex sha256 of SOURCES.md
 */
export function draftCharacterRoot({ characterHash, characterVersion, sourcesHash }) {
  if (!/^[0-9a-f]{64}$/i.test(characterHash)) throw new Error('characterHash must be 32-byte hex');
  if (!/^[0-9a-f]{64}$/i.test(sourcesHash)) throw new Error('sourcesHash must be 32-byte hex');
  if (typeof characterVersion !== 'string' || characterVersion.length > 64) {
    throw new Error('characterVersion must be string ≤ 64 chars');
  }
  const content = {
    schema: 'torii.continuum.character_root/1',
    character_hash: characterHash.toLowerCase(),
    character_version: characterVersion,
    sources_hash: sourcesHash.toLowerCase(),
    stance: 'ancap-agorist maxi-builder, shinto-buddhist register',
    laws_version: 'asimov-3-adapted-v1',
    created_at: now(),
  };
  return unsignedEvent(CHARACTER_ROOT, 'root', content);
}

/**
 * Draft a semantic_fact event.
 */
export function draftSemanticFact({ slug, fact, why, source, confidence = 'high' }) {
  if (typeof fact !== 'string' || fact.length < 3) throw new Error('fact required');
  if (!['high', 'medium', 'low'].includes(confidence)) throw new Error('confidence must be high|medium|low');
  const content = {
    schema: 'torii.continuum.semantic_fact/1',
    slug,
    fact,
    why: why || null,
    source: source || null, // e.g. "operator utterance 2026-07-06" or "CHARACTER.md §1"
    confidence,
    added_at: now(),
  };
  return unsignedEvent(SEMANTIC_FACT, slug, content);
}

/**
 * Draft a procedural_skill event.
 */
export function draftProceduralSkill({ slug, name, trigger, action, guard = null }) {
  if (typeof name !== 'string' || name.length < 2) throw new Error('name required');
  if (typeof trigger !== 'string' || trigger.length < 2) throw new Error('trigger required');
  if (typeof action !== 'string' || action.length < 2) throw new Error('action required');
  const content = {
    schema: 'torii.continuum.procedural_skill/1',
    slug,
    name,
    trigger,   // e.g. "user message contains real name"
    action,    // e.g. "replace with pseudonym, log a semantic_fact if new"
    guard,     // e.g. "never applies to signed CHARACTER.md quotes"
    added_at: now(),
  };
  return unsignedEvent(PROCEDURAL_SKILL, slug, content);
}

/**
 * Draft a destructive_intent event.
 *
 * `targetKind` + `targetDTag` name what would be wiped. Wildcard `*`
 * matches all d-tags of that kind. Wiping the whole memory tree is
 * `{ targetKind: 0, targetDTag: '*' }`.
 */
export function draftDestructiveIntent({ slug, targetKind, targetDTag, reason }) {
  if (![0, 30092, 30094, 30095].includes(targetKind)) {
    throw new Error(`targetKind must be one of 0, 30092, 30094, 30095 (got ${targetKind})`);
  }
  if (typeof targetDTag !== 'string' || targetDTag.length === 0) {
    throw new Error('targetDTag required (use "*" for all)');
  }
  if (typeof reason !== 'string' || reason.length < 3) {
    throw new Error('reason required — write it down before you burn it down');
  }
  const proposedAt = now();
  const content = {
    schema: 'torii.continuum.destructive_intent/1',
    slug,
    target_kind: targetKind,
    target_d_tag: targetDTag,
    reason,
    proposed_at: proposedAt,
    // Cooldown ends at proposed_at + 60 unless a panic key is loaded, in
    // which case memory.mjs treats this as immediately enactable.
    cooldown_ends_at: proposedAt + 60,
    requires_signatures: 2,
  };
  return unsignedEvent(DESTRUCTIVE_INTENT, slug, content, [
    ['t', 'destructive'],
  ]);
}

/**
 * Draft the panic key event. Only one should ever exist per operator.
 * The runbook (`agent/PANIC_KEY_SETUP.md`) generates this from a cold
 * device; the agent should never draft this on a live VPS, but the
 * function exists for completeness.
 */
export function draftEmergencyWipe({ operatorNpub, generatedAt = now() }) {
  if (typeof operatorNpub !== 'string' || !operatorNpub.startsWith('npub1')) {
    throw new Error('operatorNpub must be bech32 npub');
  }
  const content = {
    schema: 'torii.continuum.emergency_wipe_authority/1',
    operator_npub: operatorNpub,
    generated_at: generatedAt,
    // The mere existence of this event, decrypt-known to the agent, is the
    // authority. There's no per-event challenge — that's the point.
  };
  return unsignedEvent(EMERGENCY_WIPE, 'panic-key', content, [
    ['t', 'panic'],
    ['expiration', String(generatedAt + 10 * 365 * 24 * 3600)], // 10y sanity ceiling
  ]);
}

// ─────────────────────────────────────────────────────────────
// Kind ↔ dir routing (used by memory.mjs to file drafts correctly)
// ─────────────────────────────────────────────────────────────

/**
 * Canonical write dir for a kind. Every path is UNDER `memory/`, the single
 * systemd-writable root (ReadWritePaths=…/memory). This is a hard requirement:
 * the agent tree is mounted read-only under `ProtectSystem=strict` except
 * `memory/`, so a write target anywhere else (the old `skills/` for 30095)
 * failed with EROFS at runtime. See ops/systemd/torii-continuum-agent.service.
 *
 * @param {number} kind
 * @returns {string}  relative dir under agent/, always beginning with `memory/`
 */
export function dirForKind(kind) {
  switch (kind) {
    case CHARACTER_ROOT: return 'memory/character';
    case SEMANTIC_FACT: return 'memory/semantic';
    case PROCEDURAL_SKILL: return 'memory/procedural';
    case DESTRUCTIVE_INTENT: return 'memory/intents';
    case EMERGENCY_WIPE: return 'memory/panic';
    default: throw new Error(`unknown kind ${kind}`);
  }
}

/**
 * Legacy (pre-MEMORY-1) write dir for a kind, used ONLY for read-time
 * migration so ciphertexts written before the EROFS fix are still discovered
 * and re-homed. The single divergence is 30095, which used to be routed to the
 * read-only `skills/` tree. Returns null when there is no distinct legacy path.
 *
 * @param {number} kind
 * @returns {string|null}
 */
export function legacyDirForKind(kind) {
  if (kind === PROCEDURAL_SKILL) return 'skills';
  return null;
}

export const KINDS = {
  CHARACTER_ROOT,
  SEMANTIC_FACT,
  PROCEDURAL_SKILL,
  DESTRUCTIVE_INTENT,
  EMERGENCY_WIPE,
};
