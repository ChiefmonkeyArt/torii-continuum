/**
 * MEMORY-1 owner-consent state machine.
 *
 * Constitutional floor (lib/constitution.mjs, clause `explicit-command-only`):
 * the bot "writes no permanent memory … without explicit consent". So every
 * durable memory begins life as a PROPOSAL — never silently persisted — and
 * only an explicit, authenticated owner approval turns a proposal into a stored
 * ciphertext (via lib/memstore.mjs). Rejection is equally explicit.
 *
 * A proposal carries the exact plaintext payload the operator will see, plus a
 * `payload_sha256` over its canonical form. Approval is BOUND to that hash: the
 * client must echo the hash it approved, so an owner can only ever ratify the
 * precise payload they reviewed — a swapped payload after review fails closed.
 *
 * Anti-replay / anti-CSRF: each proposal gets a single-use `approval_nonce`.
 * Approve/reject consume it; a second attempt with a spent nonce is rejected.
 * The API itself is Bearer-token authenticated (no ambient cookie), so this is
 * defence-in-depth against a replayed approval body. Approval is idempotent:
 * re-approving an already-approved proposal returns the same result without a
 * second store or a second audit line.
 *
 * Proposals live under the single writable memory root, bot-scoped:
 *   memory/owners/<ownerHex>/bots/<botId>/pending/<proposalId>.json
 * Plaintext here is a transient PROPOSAL, not stored memory: on approval the
 * browser NIP-44-encrypts the payload and only the ciphertext is persisted;
 * the proposal file is then retired.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ownerHexFromNpub } from '../core/genesis.mjs';
import { canonicalize } from './constitution.mjs';
import { validBotId, validProjectSlug, classForKind, CLASSES } from './memstore.mjs';

const HEX64_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' });

export function payloadHash(payload) {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
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
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
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

  /**
   * Create a pending proposal. `source` distinguishes an AI reflection
   * ('reflect') from an explicit owner "remember this" ('owner-command') — both
   * become proposals; neither is auto-persisted.
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
    if (typeof dTag !== 'string' || dTag.length === 0 || dTag.length > 64) {
      return { ok: false, code: 'd_tag', reason: 'd_tag required (1..64 chars)' };
    }
    if (params.payload == null || typeof params.payload !== 'object') {
      return { ok: false, code: 'payload', reason: 'payload object required' };
    }

    const id = randomBytes(16).toString('hex');
    const ph = payloadHash(params.payload);
    const prop = {
      schema: 'torii.continuum.memory_proposal/1',
      id,
      status: STATUS.PENDING,
      owner_hex: scope.ownerHex,
      bot_id: scope.botId,
      project,
      kind: kind || CLASSES[cls].kind || null,
      class: cls,
      d_tag: dTag,
      payload: params.payload,
      payload_sha256: ph,
      evidence: Array.isArray(params.evidence) ? params.evidence.slice(0, 10) : [],
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
        payload_sha256: ph, source: prop.source,
      }).catch((e) => log.error(`[consent] audit propose failed: ${e.message}`));
    }
    log.info(`[consent] proposal ${id.slice(0, 12)} (${cls}:${dTag}) pending for owner ${scope.ownerHex.slice(0, 12)}`);
    return { ok: true, proposal: publicView(prop) };
  }

  /** Public (owner-facing) view of a proposal — includes payload for review. */
  function publicView(p) {
    return {
      id: p.id, status: p.status, project: p.project, kind: p.kind, class: p.class,
      d_tag: p.d_tag, payload: p.payload, payload_sha256: p.payload_sha256,
      evidence: p.evidence, source: p.source, proposed_at: p.proposed_at,
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
    return { ok: true, proposal: publicView(p) };
  }

  /**
   * Approve a proposal. Requires:
   *   - the owner's session (ownerNpub) matching the proposal owner
   *   - `expectPayloadSha256` === proposal.payload_sha256 (payload binding)
   *   - `approvalNonce` === proposal.approval_nonce (single-use, anti-replay)
   *   - a valid NIP-44 `ciphertext` of the approved payload (stored sealed)
   * Idempotent: re-approving an APPROVED proposal returns the prior result.
   */
  async function approve(params = {}) {
    const scope = scopeOf(params.ownerNpub, params.botId);
    if (!scope.ok) return { ok: false, code: 'scope', reason: scope.reason };
    const p = await readProposal(scope.ownerHex, scope.botId, params.id);
    if (!p) return { ok: false, code: 'not_found', reason: 'proposal not found' };
    if (p.owner_hex !== scope.ownerHex) return { ok: false, code: 'forbidden', reason: 'cross-owner denied' };

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

    const stored = await memstore.put({
      ownerNpub: params.ownerNpub, botId: scope.botId, projectSlug: p.project,
      cls: p.class, kind: p.kind, dTag: p.d_tag, eventId: params.eventId || null,
      ciphertext: params.ciphertext, source: `approved:${p.source}`,
      approvedAt: now(), constitutionVersion: params.constitutionVersion || null,
    });
    if (!stored.ok) return { ok: false, code: `store_${stored.code}`, reason: stored.reason };

    p.status = STATUS.APPROVED;
    p.decided_at = now();
    p.approval_nonce = null; // consume the nonce
    p.stored = { id: stored.id, sha256: stored.sha256, path: stored.path };
    delete p.payload; // sealed now — drop the transient plaintext proposal body
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

  /** Reject a proposal. Explicit, audited, one-time (nonce consumed). */
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
    p.status = STATUS.REJECTED;
    p.decided_at = now();
    p.approval_nonce = null;
    delete p.payload;
    await writeProposalAtomic(scope.ownerHex, scope.botId, p);
    if (audit) {
      await audit.append('memory.reject', {
        proposal_id: p.id, owner_pubkey_prefix: scope.ownerHex.slice(0, 12),
        bot_id: scope.botId, project: p.project, class: p.class, d_tag: p.d_tag,
        payload_sha256: p.payload_sha256,
      }).catch((e) => log.error(`[consent] audit reject failed: ${e.message}`));
    }
    log.info(`[consent] rejected ${p.id.slice(0, 12)}`);
    return { ok: true, status: p.status };
  }

  return { propose, listPending, get, approve, reject, payloadHash, STATUS };
}
