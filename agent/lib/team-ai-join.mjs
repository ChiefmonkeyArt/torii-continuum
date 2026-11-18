// Teams' "join while the owner is away" commits, for the project AI.
//
// A newcomer joins a Torii Teams chat with an MLS external commit sealed under
// a join key (Teams ADR 0011 §5), not the epoch key. The stock Cordn library
// can't open that seal, skips the commit, and is then stuck one epoch behind
// for good. This opens the seal, runs the same check every Teams member runs
// (ADR 0011 §3: owner-signed roster or grant, plus the joiner's own binding),
// and hands only commits that pass back to the library, re-sealed under the
// epoch key. Anything that fails is left as it was, so the library skips it
// exactly as the human members' clients reject it.
//
// Mirrors torii-teams src/lib/torii/externalJoin.ts; keep the two in step.
import { createDecipheriv, createHash } from 'node:crypto';

export const ROSTER_KIND = 30098;
export const GRANT_KIND = 27098;
export const JOIN_BINDING_KIND = 27099;
const PROOF_PREFIX = 'torii-join/1\n';
const FLOOR_PREFIX = 'torii:floor=';
const MAX_PROOF_BYTES = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const hex = (b) => Buffer.from(b).toString('hex');
const pubkeyOf = (s) => {
  const v = String(s ?? '').trim().toLowerCase();
  return HEX64.test(v) ? v : '';
};

/** The key the joiner (from the GroupInfo) and every member derive for an epoch. */
export function joinSealKey({ groupId, epoch, confirmedTranscriptHash }) {
  const e = Buffer.alloc(8);
  e.writeBigUInt64BE(BigInt(epoch));
  return sha256(Buffer.from('torii-join-seal/1'), sha256(groupId), e, confirmedTranscriptHash);
}

/** ChaCha20-Poly1305, empty AAD, base64(nonce12 || ct || tag16). Null on failure. */
export function openWithKey(key, sealedBase64) {
  try {
    const buf = Buffer.from(String(sealedBase64), 'base64');
    if (buf.length < 28) return null;
    const d = createDecipheriv('chacha20-poly1305', key, buf.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(buf.subarray(buf.length - 16));
    return new Uint8Array(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]));
  } catch {
    return null;
  }
}

export function readFloor(description) {
  for (const word of String(description ?? '').split(/\s+/)) {
    if (word.startsWith(FLOOR_PREFIX)) {
      const n = Number(word.slice(FLOOR_PREFIX.length));
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
  }
  return 0;
}

function isEvent(v) {
  return !!v && typeof v.id === 'string' && typeof v.pubkey === 'string' && typeof v.sig === 'string' &&
    typeof v.content === 'string' && Number.isInteger(v.kind) && Number.isInteger(v.created_at) &&
    Array.isArray(v.tags) && v.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
}

export function decodeJoinProof(bytes) {
  if (!bytes || bytes.length > MAX_PROOF_BYTES) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (!text.startsWith(PROOF_PREFIX)) return null;
  try {
    const raw = JSON.parse(text.slice(PROOF_PREFIX.length));
    return isEvent(raw?.allow) && isEvent(raw?.binding) ? { allow: raw.allow, binding: raw.binding } : null;
  } catch {
    return null;
  }
}

function oneTag(e, name) {
  const all = e.tags.filter((t) => t[0] === name);
  return all.length === 1 && typeof all[0][1] === 'string' ? all[0][1] : null;
}

/** ADR 0011 §3, the check every member runs. `verify` checks a Nostr signature. */
export function verifyExternalJoin(group, commit, verify) {
  const no = (reason) => ({ ok: false, reason });
  const ok = (e) => { try { return verify({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig }); } catch { return false; } };
  const owner = pubkeyOf(group.adminPubkey);
  const joiner = pubkeyOf(commit.joinerPubkey);
  if (!owner) return no('group has no admin');
  if (!joiner) return no('joiner has no valid identity');
  if (!group.name) return no('group has no project name');
  const proof = decodeJoinProof(commit.authenticatedData);
  if (!proof) return no('no join proof');
  const { allow, binding } = proof;
  if (binding.kind !== JOIN_BINDING_KIND || binding.pubkey !== joiner || !ok(binding)) return no('bad binding signature');
  if (oneTag(binding, 'group') !== group.groupId || oneTag(binding, 'epoch') !== String(group.epoch) ||
      oneTag(binding, 'leaf') !== commit.leafKeyHex) return no('binding is for another join');
  if (allow.pubkey !== owner || !ok(allow)) return no('not signed by the owner');
  if (allow.created_at < readFloor(group.description)) return no('older than the member-list floor');
  if (allow.kind === ROSTER_KIND) {
    if (oneTag(allow, 'd') !== group.name) return no('roster is for another project');
    return allow.tags.some((t) => t[0] === 'p' && t[1] === joiner) ? { ok: true, via: 'roster' } : no('not on the signed member list');
  }
  if (allow.kind === GRANT_KIND) {
    if (oneTag(allow, 'project') !== group.name) return no('grant is for another project');
    return { ok: true, via: 'grant' };
  }
  return no('unknown proof kind');
}

/** Joiner, new leaf key and proof of an external commit that carries only its
 *  ExternalInit (ADR 0011 §3.6); null for anything else. `mls` is the bundle. */
export function inspectExternalCommit(message, mls) {
  if (message?.wireformat !== mls.wireformats.mls_public_message || !message.publicMessage) return null;
  const content = message.publicMessage.content;
  if (content.sender?.senderType !== mls.senderTypes.new_member_commit) return null;
  if (content.contentType !== 3 || !content.commit) return null;
  const proposals = content.commit.proposals || [];
  if (proposals.length !== 1 || proposals[0]?.proposal?.proposalType !== mls.defaultProposalTypes.external_init) return null;
  const leaf = content.commit.path?.leafNode;
  const id = leaf?.credential?.identity;
  return {
    joinerPubkey: id ? pubkeyOf(new TextDecoder().decode(id)) : null,
    leafKeyHex: leaf ? hex(leaf.signaturePublicKey) : '',
    authenticatedData: content.authenticatedData,
  };
}

/**
 * Wrap `session.applyIncomingMessages` so a Teams join commit that passes the
 * check reaches the library under the epoch key. Pure pass-through otherwise.
 */
export function acceptTeamsJoins(session, mls, log = {}) {
  const inner = session.applyIncomingMessages.bind(session);
  session.applyIncomingMessages = async (group, messages, opts) => {
    const out = [];
    for (const m of messages) out.push(await reseal(group, m));
    return inner(group, out, opts);
  };
  async function reseal(group, m) {
    const state = group?.state;
    if (!state?.groupContext || typeof m?.msg_64 !== 'string') return m;
    try {
      await mls.decryptGroupPayload({ state, encryptedBase64: m.msg_64 });
      return m; // the normal epoch seal
    } catch { /* maybe a join seal */ }
    const opened = openWithKey(joinSealKey(state.groupContext), m.msg_64);
    if (!opened) return m;
    try {
      const message = mls.mlsMessageDecoder(opened, 0)?.[0];
      const commit = inspectExternalCommit(message, mls);
      if (!commit) return m;
      const meta = group.metadata || {};
      const verdict = verifyExternalJoin({
        groupId: new TextDecoder().decode(state.groupContext.groupId),
        epoch: state.groupContext.epoch,
        name: meta.name,
        description: meta.description,
        adminPubkey: meta.adminPubkeys?.[0],
      }, commit, mls.verifyEvent);
      if (!verdict.ok) {
        log.warn?.({ evt: 'team_ai.join_rejected', why: verdict.reason });
        return m;
      }
      const { encryptedBase64 } = await mls.encryptGroupPayload({ state, serializedMlsMessage: opened });
      log.info?.({ evt: 'team_ai.join_accepted', via: verdict.via });
      return { ...m, msg_64: encryptedBase64 };
    } catch (e) {
      log.warn?.({ evt: 'team_ai.join_rejected', why: String(e?.message || e).slice(0, 120) });
      return m;
    }
  }
}
