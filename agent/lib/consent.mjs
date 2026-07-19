/**
 * MEMORY-1 owner-consent state machine (ciphertext-only at rest).
 *
 * Constitutional floor (lib/constitution.mjs, clause `explicit-command-only`):
 * the bot "writes no permanent memory … without explicit consent". So every
 * durable memory begins life as a PROPOSAL — never silently persisted — and
 * only an explicit, authenticated owner approval promotes that proposal into
 * the durable scoped store (via lib/memstore.mjs). Rejection is equally explicit.
 *
 * PRIVACY INVARIANT (ciphertext-only from proposal creation onward):
 * A proposal NEVER contains memory plaintext. The browser receives the proposed
 * text transiently (from chat), seals it with NIP-44 v2 to the owner's own key,
 * and sends the agent ONLY:
 *   - `ciphertext`      the sealed payload (agent can never decrypt it)
 *   - `payload_sha256`  a deterministic hash over the canonical plaintext,
 *                        computed in the browser — the review/approval binding
 *   - minimal validated metadata (scope, class, kind, slug d_tag)
 * The agent persists ciphertext + hash + nonce + scope/status metadata only.
 * There is no `payload` field on disk, in the API, in logs, or in audit lines.
 * Pending review decrypts the ciphertext client-side; the server stays blind.
 *
 * Approval is BOUND to the reviewed hash: the client echoes the `payload_sha256`
 * it approved, so an owner can only ratify the precise payload they reviewed.
 * Promotion re-checks the stored ciphertext's own digest (`ciphertext_sha256`)
 * against memstore's `expectSha256`, so a swapped ciphertext also fails closed.
 *
 * Anti-replay / anti-CSRF: each proposal gets a single-use `approval_nonce`.
 * Approve/reject consume it; a second attempt with a spent nonce is rejected.
 * The API itself is Bearer-token authenticated (no ambient cookie). Approval is
 * idempotent: re-approving an already-approved proposal returns the same result
 * without a second store or a second audit line.
 *
 * Proposals live under the single writable memory root, bot-scoped:
 *   memory/owners/<ownerHex>/bots/<botId>/pending/<proposalId>.json
 * On approval the already-sealed ciphertext is promoted into the durable scoped
 * store and the pending ciphertext is removed. On rejection the pending file is
 * unlinked outright. Neither path ever handles plaintext.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ownerHexFromNpub } from '../core/genesis.mjs';
import { canonicalize } from './constitution.mjs';
import { validBotId, validProjectSlug, classForKind, CLASSES } from './memstore.mjs';

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX32ID_RE = /^[a-f0-9]{32}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Proposal schema. v2 is ciphertext-only; v1 (plaintext `payload`) is retired
// and actively migrated out on startup — see migratePlaintextProposals().
const PROPOSAL_SCHEMA = 'torii.continuum.memory_proposal/2';
const LEGACY_PROPOSAL_SCHEMA = 'torii.continuum.memory_proposal/1';
const MAX_CIPHERTEXT_BYTES = 131072; // sealed envelope ceiling (> MAX_ITEM_BYTES plaintext)
const STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' });

/**
 * Deterministic hash over a canonical plaintext payload. Retained for callers
 * that still hold plaintext transiently (e.g. tests / the browser mirrors this
 * exact computation). The agent itself never invokes this on stored data — it
 * only ever sees the client-supplied `payload_sha256`.
 */
export function payloadHash(payload) {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

function ciphertextHash(ciphertext) {
  return createHash('sha256').update(String(ciphertext), 'utf8').digest('hex');
}

function isSealedString(v) {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= MAX_CIPHERTEXT_BYTES;
}

/**
 * @param {object} deps
 * @param {string} deps.memoryRoot  absolute path to agent/memory
 * @param {object} deps.memstore    createMemStore() instance
 * @param {object} [deps.audit]     createAudit() instance
 * @param {object} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createConsent(deps = {}) {
  const memoryRoot = deps.memoryRoot;
  if (!memoryRoot) throw new Error('createConsent: memoryRoot required');
  const memstore = deps.memstore;
  if (!memstore) throw new Error('createConsent: memstore required');
  const audit = deps.audit || null;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const now = typeof deps.now === 'function' ? deps.now : () => Math.floor(Date.now() / 1000);

  const ownersRoot = join(memoryRoot, 'owners');

  function pendingDir(ownerHex, botId) {
    return join(ownersRoot, ownerHex, 'bots', botId, 'pending');
  }
  function proposalPath(ownerHex, botId, id) {
    return join(pendingDir(ownerHex, botId), `${id}.json`);
  }

  function scopeOf(ownerNpub, botId) {
    const ownerHex = ownerHexFromNpub(ownerNpub);
    if (!ownerHex || !HEX64_RE.test(ownerHex)) return { ok: false, reason: 'invalid owner npub' };
    const bot = validBotId(botId);
    if (!bot) return { ok: false, reason: 'invalid bot id' };
    return { ok: true, ownerHex, botId: bot };
  }

  async function readProposal(ownerHex, botId, id) {
    if (!HEX32ID_RE.test(id)) return null;
    const p = proposalPath(ownerHex, botId, id);
    // Containment check (id is regex-bound, but re-verify the resolved path).
    if (!resolve(p).startsWith(resolve(ownersRoot, ownerHex) + sep)) return null;
    try {
      return JSON.parse(await readFile(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error('consent: proposal on disk is not valid JSON');
    }
  }

  async function writeProposalAtomic(ownerHex, botId, prop) {
    const dir = pendingDir(ownerHex, botId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${prop.id}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(prop, null, 2), { mode: 0o600 });
    await rename(tmp, proposalPath(ownerHex, botId, prop.id));
  }

  // Best-effort secure removal of a pending proposal file. Filesystem semantics
  // limit us to an unlink (+ ENOENT tolerance); the payload was ciphertext only.
  async function removeProposalFile(ownerHex, botId, id) {
    if (!HEX32ID_RE.test(id)) return;
    const p = proposalPath(ownerHex, botId, id);
    if (!resolve(p).startsWith(resolve(ownersRoot, ownerHex) + sep)) return;
    try { await unlink(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  /**
   * Create a pending proposal. `source` distinguishes an AI reflection
   * ('reflect') from an explicit owner "remember this" ('owner-command') — both
   * become proposals; neither is auto-persisted.
   *
   * Ciphertext-only: `ciphertext` (NIP-44 sealed, browser-side) and
   * `payloadSha256` (canonical-plaintext hash, browser-side) are REQUIRED. Any
   * plaintext `payload` is refused — the agent must never receive it.
   */
  async function propose(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };

    const project = validProjectSlug(params.projectSlug);
    if (!project) return { ok: false, code: 'scope', reason: 'invalid project slug' };

    const kind = params.kind;
    const cls = params.cls || classForKind(kind);
    if (!cls || !CLASSES[cls]) return { ok: false, code: 'class', reason: 'unknown/invalid memory class' };

    const dTag = params.dTag;
    // d_tag is owner-facing metadata rendered in the console; constrain it to a
    // slug so it cannot smuggle free-form memory text through the metadata plane.
    if (typeof dTag !== 'string' || !SLUG_RE.test(dTag)) {
      return { ok: false, code: 'd_tag', reason: 'd_tag must be a slug: [a-z0-9][a-z0-9_-]{0,63}' };
    }

    // Refuse any attempt to hand the agent plaintext.
    if ('payload' in params && params.payload != null) {
      return { ok: false, code: 'plaintext_refused', reason: 'plaintext payload is not accepted; send ciphertext only' };
    }
    if (!isSealedString(params.ciphertext)) {
      return { ok: false, code: 'ciphertext', reason: 'ciphertext (sealed string) required' };
    }
    if (typeof params.payloadSha256 !== 'string' || !HEX64_RE.test(params.payloadSha256)) {
      return { ok: false, code: 'payload_sha256', reason: 'payload_sha256 (64-hex) required' };
    }

    const id = randomBytes(16).toString('hex');
    const ciphertext = params.ciphertext;
    const ctHash = ciphertextHash(ciphertext);
    const prop = {
      schema: PROPOSAL_SCHEMA,
      id,
      status: STATUS.PENDING,
      owner_hex: scope.ownerHex,
      bot_id: scope.botId,
      project,
      kind: kind || CLASSES[cls].kind || null,
      class: cls,
      d_tag: dTag,
      ciphertext,                       // NIP-44 sealed — agent cannot decrypt
      ciphertext_sha256: ctHash,        // integrity of the sealed blob
      payload_sha256: params.payloadSha256, // client hash of canonical plaintext (review binding)
      source: params.source === 'owner-command' ? 'owner-command' : 'reflect',
      approval_nonce: randomBytes(16).toString('hex'),
      proposed_at: now(),
      decided_at: null,
    };
    await writeProposalAtomic(scope.ownerHex, scope.botId, prop);
    if (audit) {
      await audit.append('memory.propose', {
        proposal_id: id, owner_pubkey_prefix: scope.ownerHex.slice(0, 12),
        bot_id: scope.botId, project, class: cls, d_tag: dTag,
        payload_sha256: prop.payload_sha256, ciphertext_sha256: ctHash, source: prop.source,
      }).catch((e) => log.error(`[consent] audit propose failed: ${e.message}`));
    }
    log.info(`[consent] proposal ${id.slice(0, 12)} (${cls}:${dTag}) pending for owner ${scope.ownerHex.slice(0, 12)}`);
    return { ok: true, proposal: publicView(prop) };
  }

  /**
   * Public (owner-facing) view of a proposal. Returns the CIPHERTEXT for
   * client-side decrypt+review, plus the review-binding hash and metadata —
   * never plaintext (there is none on disk to return).
   */
  function publicView(p) {
    return {
      id: p.id, status: p.status, project: p.project, kind: p.kind, class: p.class,
      d_tag: p.d_tag, ciphertext: p.ciphertext, ciphertext_sha256: p.ciphertext_sha256,
      payload_sha256: p.payload_sha256, source: p.source, proposed_at: p.proposed_at,
      decided_at: p.decided_at, approval_nonce: p.status === STATUS.PENDING ? p.approval_nonce : null,
    };
  }

  async function listPending(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const dir = pendingDir(scope.ownerHex, scope.botId);
    let files;
    try { files = await readdir(dir); } catch { return { ok: true, count: 0, proposals: [] }; }
    const proposals = [];
    for (const f of files) {
      if (!/^[a-f0-9]{32}\.json$/.test(f)) continue;
      try {
        const p = JSON.parse(await readFile(join(dir, f), 'utf8'));
        // Legacy plaintext proposals are never surfaced through the API.
        if (p.schema === LEGACY_PROPOSAL_SCHEMA || 'payload' in p) continue;
        if (p.status === STATUS.PENDING) proposals.push(publicView(p));
      } catch { /* skip corrupt proposal file */ }
    }
    proposals.sort((a, b) => (b.proposed_at || 0) - (a.proposed_at || 0));
    return { ok: true, count: proposals.length, proposals };
  }

  async function get(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const p = await readProposal(scope.ownerHex, scope.botId, params.id);
    if (!p) return { ok: false, reason: 'not found' };
    // Do not expose retired plaintext proposals through the API.
    if (p.schema === LEGACY_PROPOSAL_SCHEMA || 'payload' in p) return { ok: false, reason: 'not found' };
    return { ok: true, proposal: publicView(p) };
  }

  /**
   * Approve a proposal. Requires:
   *   - the owner's session (ownerNpub) matching the proposal owner
   *   - `expectPayloadSha256` === proposal.payload_sha256 (review binding)
   *   - `approvalNonce` === proposal.approval_nonce (single-use, anti-replay)
   * The ciphertext is ALREADY stored on the proposal — the browser does not
   * re-send it. Promotion moves that exact sealed blob into the durable store,
   * pinned by its own `ciphertext_sha256`, then the pending ciphertext is
   * removed. Idempotent: re-approving an APPROVED proposal returns the prior
   * result without a second store or audit line.
   */
  async function approve(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const p = await readProposal(scope.ownerHex, scope.botId, params.id);
    if (!p) return { ok: false, code: 'not_found', reason: 'proposal not found' };
    if (p.owner_hex !== scope.ownerHex) return { ok: false, code: 'forbidden', reason: 'cross-owner denied' };
    if (p.schema === LEGACY_PROPOSAL_SCHEMA || 'payload' in p) {
      return { ok: false, code: 'legacy', reason: 'retired plaintext proposal cannot be approved' };
    }

    if (p.status === STATUS.APPROVED) {
      // Idempotent replay of a completed approval — no second store/audit.
      return { ok: true, idempotent: true, stored: p.stored || null, status: p.status };
    }
    if (p.status === STATUS.REJECTED) return { ok: false, code: 'rejected', reason: 'proposal already rejected' };

    if (params.expectPayloadSha256 !== p.payload_sha256) {
      return { ok: false, code: 'hash_mismatch', reason: 'approved payload hash does not match proposal' };
    }
    if (params.approvalNonce !== p.approval_nonce) {
      return { ok: false, code: 'bad_nonce', reason: 'approval nonce invalid or already used' };
    }
    if (!isSealedString(p.ciphertext)) {
      return { ok: false, code: 'corrupt', reason: 'proposal ciphertext missing or invalid' };
    }

    const stored = await memstore.put({
      ownerNpub: params.ownerNpub, botId: scope.botId, projectSlug: p.project,
      cls: p.class, kind: p.kind, dTag: p.d_tag, eventId: params.eventId || null,
      ciphertext: p.ciphertext, expectSha256: p.ciphertext_sha256,
      source: `approved:${p.source}`,
      approvedAt: now(), constitutionVersion: params.constitutionVersion || null,
    });
    if (!stored.ok) return { ok: false, code: `store_${stored.code}`, reason: stored.reason };

    p.status = STATUS.APPROVED;
    p.decided_at = now();
    p.approval_nonce = null; // consume the nonce
    p.stored = { id: stored.id, sha256: stored.sha256, path: stored.path };
    delete p.ciphertext; // promoted into the durable store — drop the pending copy
    await writeProposalAtomic(scope.ownerHex, scope.botId, p);

    if (audit) {
      await audit.append('memory.approve', {
        proposal_id: p.id, owner_pubkey_prefix: scope.ownerHex.slice(0, 12),
        bot_id: scope.botId, project: p.project, class: p.class, d_tag: p.d_tag,
        payload_sha256: p.payload_sha256, ciphertext_sha256: stored.sha256,
        stored_id: stored.id, event_id: params.eventId || null,
      }).catch((e) => log.error(`[consent] audit approve failed: ${e.message}`));
    }
    log.info(`[consent] approved ${p.id.slice(0, 12)} → stored ${stored.id.slice(0, 12)}`);
    return { ok: true, stored: p.stored, status: p.status };
  }

  /**
   * Reject a proposal. Explicit, audited, one-time. The pending ciphertext file
   * is unlinked outright (best-effort secure removal per filesystem semantics);
   * only non-sensitive hashes/metadata are recorded in the audit ledger.
   */
  async function reject(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const p = await readProposal(scope.ownerHex, scope.botId, params.id);
    if (!p) return { ok: false, code: 'not_found', reason: 'proposal not found' };
    if (p.owner_hex !== scope.ownerHex) return { ok: false, code: 'forbidden', reason: 'cross-owner denied' };
    if (p.status === STATUS.REJECTED) return { ok: true, idempotent: true, status: p.status };
    if (p.status === STATUS.APPROVED) return { ok: false, code: 'approved', reason: 'proposal already approved' };
    if (params.approvalNonce && params.approvalNonce !== p.approval_nonce) {
      return { ok: false, code: 'bad_nonce', reason: 'approval nonce invalid' };
    }
    // Securely remove the pending ciphertext file rather than leaving a rejected
    // shell on disk. Metadata for the audit line is captured before unlink.
    const meta = {
      proposal_id: p.id, owner_pubkey_prefix: scope.ownerHex.slice(0, 12),
      bot_id: scope.botId, project: p.project, class: p.class, d_tag: p.d_tag,
      payload_sha256: p.payload_sha256, ciphertext_sha256: p.ciphertext_sha256 || null,
    };
    await removeProposalFile(scope.ownerHex, scope.botId, p.id);
    if (audit) {
      await audit.append('memory.reject', meta)
        .catch((e) => log.error(`[consent] audit reject failed: ${e.message}`));
    }
    log.info(`[consent] rejected ${p.id.slice(0, 12)} (pending file removed)`);
    return { ok: true, status: STATUS.REJECTED };
  }

  /**
   * One-shot startup migration: purge any v1 (plaintext-bearing) pending
   * proposals left by v0.2.82-alpha. Detects the retired schema or a stray
   * `payload` field, unlinks the file WITHOUT reading/logging its content, and
   * records a metadata-only audit entry. Production was never deployed, but this
   * runs defensively so no historical plaintext can survive on any host.
   * Returns { scanned, purged }.
   */
  async function migratePlaintextProposals() {
    let scanned = 0;
    let purged = 0;
    let ownerDirs;
    try { ownerDirs = await readdir(ownersRoot); } catch { return { scanned, purged }; }
    for (const ownerHex of ownerDirs) {
      if (!HEX64_RE.test(ownerHex)) continue;
      const botsRoot = join(ownersRoot, ownerHex, 'bots');
      let botDirs;
      try { botDirs = await readdir(botsRoot); } catch { continue; }
      for (const botId of botDirs) {
        const dir = pendingDir(ownerHex, botId);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
          if (!/^[a-f0-9]{32}\.json$/.test(f)) continue;
          const full = join(dir, f);
          scanned++;
          let isLegacy = false;
          try {
            const raw = JSON.parse(await readFile(full, 'utf8'));
            isLegacy = raw && (raw.schema === LEGACY_PROPOSAL_SCHEMA || 'payload' in raw || 'evidence' in raw);
          } catch {
            // Unparseable file in the pending tree — treat as suspect and purge.
            isLegacy = true;
          }
          if (!isLegacy) continue;
          try { await unlink(full); } catch (e) { if (e.code !== 'ENOENT') { log.error(`[consent] migrate unlink failed: ${e.message}`); continue; } }
          purged++;
          if (audit) {
            await audit.append('memory.migrate.purge_plaintext_proposal', {
              proposal_id: f.replace(/\.json$/, ''),
              owner_pubkey_prefix: ownerHex.slice(0, 12), bot_id: botId,
              reason: 'v1_plaintext_proposal_retired',
            }).catch((e) => log.error(`[consent] audit migrate failed: ${e.message}`));
          }
        }
      }
    }
    if (purged) log.warn(`[consent] migration purged ${purged} legacy plaintext proposal(s)`);
    return { scanned, purged };
  }

  return { propose, listPending, get, approve, reject, payloadHash, migratePlaintextProposals, STATUS };
}
