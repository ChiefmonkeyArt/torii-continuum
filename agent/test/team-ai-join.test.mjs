import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import {
  joinSealKey, openWithKey, readFloor, decodeJoinProof, verifyExternalJoin,
  inspectExternalCommit, acceptTeamsJoins, ROSTER_KIND, GRANT_KIND, JOIN_BINDING_KIND,
} from '../lib/team-ai-join.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const enc = new TextEncoder();
const seal = (key, bytes) => {
  const nonce = randomBytes(12);
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  return Buffer.concat([nonce, c.update(bytes), c.final(), c.getAuthTag()]).toString('base64');
};

test('joinSealKey matches Teams (torii-teams externalJoin.ts vector)', () => {
  const key = joinSealKey({ groupId: enc.encode('group-abc'), epoch: 3n, confirmedTranscriptHash: new Uint8Array(32).fill(7) });
  assert.equal(hex(key), '073a3141f5bd5fb4796eac924024a5095389c23e3ad6e20519578657bc1bf45d');
});

test('openWithKey: opens its own seal, null on wrong key, short or junk input', () => {
  const k = randomBytes(32);
  assert.deepEqual(Buffer.from(openWithKey(k, seal(k, Buffer.from('hi')))).toString(), 'hi');
  assert.equal(openWithKey(randomBytes(32), seal(k, Buffer.from('hi'))), null);
  assert.equal(openWithKey(k, 'AAAA'), null);
  assert.equal(openWithKey(k, 42), null);
});

test('readFloor and decodeJoinProof', () => {
  assert.equal(readFloor('torii:project=web torii:floor=123'), 123);
  assert.equal(readFloor('torii:floor=-1'), 0);
  assert.equal(decodeJoinProof(enc.encode('nope')), null);
  assert.equal(decodeJoinProof(enc.encode('torii-join/1\n{"allow":{}}')), null);
  assert.equal(decodeJoinProof(new Uint8Array(17000)), null);
});

const ownerSk = generateSecretKey(); const owner = getPublicKey(ownerSk);
const joinSk = generateSecretKey(); const joiner = getPublicKey(joinSk);
const group = { groupId: 'group-1', epoch: 2n, name: 'website', description: 'torii:project=website', adminPubkey: owner };
const leaf = 'ab'.repeat(32);
const now = Math.floor(Date.now() / 1000);
const roster = (p = joiner, d = 'website', sk = ownerSk) => finalizeEvent({ kind: ROSTER_KIND, created_at: now, content: '', tags: [['d', d], ['p', p]] }, sk);
const binding = (o = {}) => finalizeEvent({ kind: JOIN_BINDING_KIND, created_at: now, content: '', tags: [['group', o.group ?? 'group-1'], ['epoch', o.epoch ?? '2'], ['leaf', o.leaf ?? leaf]] }, o.sk ?? joinSk);
const proof = (allow, b = binding()) => enc.encode('torii-join/1\n' + JSON.stringify({ allow, binding: b }));
const commit = (ad, j = joiner) => ({ joinerPubkey: j, leafKeyHex: leaf, authenticatedData: ad });

test('verifyExternalJoin: roster and grant pass; every forgery fails', () => {
  assert.deepEqual(verifyExternalJoin(group, commit(proof(roster())), verifyEvent), { ok: true, via: 'roster' });
  const grant = finalizeEvent({ kind: GRANT_KIND, created_at: now, content: '', tags: [['project', 'website']] }, ownerSk);
  assert.deepEqual(verifyExternalJoin(group, commit(proof(grant)), verifyEvent), { ok: true, via: 'grant' });
  const why = (c, g = group) => verifyExternalJoin(g, c, verifyEvent).reason;
  assert.equal(why(commit(proof(roster(owner)))), 'not on the signed member list');
  assert.equal(why(commit(proof(roster(joiner, 'other')))), 'roster is for another project');
  assert.equal(why(commit(proof(roster(joiner, 'website', joinSk)))), 'not signed by the owner');
  assert.equal(why(commit(proof(roster(), binding({ epoch: '1' })))), 'binding is for another join');
  assert.equal(why(commit(proof(roster(), binding({ sk: ownerSk })))), 'bad binding signature');
  const tampered = { ...roster(), tags: [['d', 'website'], ['p', joiner], ['p', 'cd'.repeat(32)]] };
  assert.equal(why(commit(proof(tampered))), 'not signed by the owner');
  assert.equal(why(commit(proof(roster())), { ...group, description: `torii:floor=${now + 10}` }), 'older than the member-list floor');
  assert.equal(why(commit(undefined)), 'no join proof');
  assert.equal(why(commit(proof(roster()), 'xyz')), 'joiner has no valid identity');
});

// A stand-in for the bundle's ts-mls pieces: messages are JSON.
const registry = new Map();
const mls = {
  wireformats: { mls_public_message: 1 }, senderTypes: { new_member_commit: 4 }, defaultProposalTypes: { external_init: 6 },
  verifyEvent,
  mlsMessageDecoder: (bytes) => [registry.get(Buffer.from(bytes).toString()), bytes.length],
  decryptGroupPayload: async ({ encryptedBase64 }) => { if (!encryptedBase64.startsWith('EPOCH:')) throw new Error('invalid tag'); return {}; },
  encryptGroupPayload: async ({ serializedMlsMessage }) => ({ encryptedBase64: 'EPOCH:' + Buffer.from(serializedMlsMessage).toString('base64') }),
};
const extCommit = (ad, proposals = [{ proposal: { proposalType: 6 } }]) => ({
  wireformat: 1,
  publicMessage: { content: { sender: { senderType: 4 }, contentType: 3, authenticatedData: ad,
    commit: { proposals, path: { leafNode: { credential: { identity: enc.encode(joiner) }, signaturePublicKey: Buffer.from(leaf, 'hex') } } } } },
});

test('inspectExternalCommit: only an ExternalInit-only new-member commit', () => {
  const c = inspectExternalCommit(extCommit(new Uint8Array([1])), mls);
  assert.equal(c.joinerPubkey, joiner); assert.equal(c.leafKeyHex, leaf);
  assert.equal(inspectExternalCommit(extCommit(null, [{ proposal: { proposalType: 6 } }, { proposal: { proposalType: 1 } }]), mls), null);
  assert.equal(inspectExternalCommit({ ...extCommit(null), wireformat: 2 }, mls), null);
});

test('acceptTeamsJoins: re-seals a valid join, passes others through untouched', async () => {
  const state = { groupContext: { groupId: enc.encode('group-1'), epoch: 2n, confirmedTranscriptHash: new Uint8Array(32).fill(9) } };
  const g = { state, metadata: { name: 'website', description: 'torii:project=website', adminPubkeys: [owner] } };
  const key = joinSealKey(state.groupContext);
  const wire = (msg) => { const id = 'm' + registry.size; registry.set(id, extCommit(msg.ad)); return seal(key, Buffer.from(id)); };
  let seen;
  const session = { applyIncomingMessages: async (_g, msgs) => { seen = msgs; return { received: [], issues: [] }; } };
  const logs = [];
  acceptTeamsJoins(session, mls, { info: (o) => logs.push(o), warn: (o) => logs.push(o) });
  const good = { cursor: 2, msg_64: wire({ ad: proof(roster()) }) };
  const forged = { cursor: 3, msg_64: wire({ ad: proof(roster(owner)) }) };
  const normal = { cursor: 4, msg_64: 'EPOCH:abc' };
  const junk = { cursor: 5, msg_64: seal(randomBytes(32), Buffer.from('x')) };
  await session.applyIncomingMessages(g, [good, forged, normal, junk]);
  assert.ok(seen[0].msg_64.startsWith('EPOCH:'), 'valid join re-sealed under the epoch key');
  assert.equal(seen[1], forged); assert.equal(seen[2], normal); assert.equal(seen[3], junk);
  assert.deepEqual(logs.map((l) => l.evt), ['team_ai.join_accepted', 'team_ai.join_rejected']);
});
