/**
 * Join cards (torii-teams docs/torii/adr-0011-join-while-owner-away.md).
 *
 * Unit: the GroupInfo store keeps the highest epoch and the first transcript
 * hash per epoch. Routes: the REAL buildApp; members upload, people on the
 * signed list or admitted by a grant fetch the card with their own proof,
 * everyone else is refused.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { createTeamsState } from '../lib/teams-state.mjs';
import { createTeamInvites, INVITE_GRANT_KIND } from '../lib/team-invites.mjs';
import { createTeamGroupInfo, MAX_GROUP_INFO_B64 } from '../lib/team-groupinfo.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const NOW = Math.floor(Date.now() / 1000);
const silent = { info() {}, warn() {}, error() {} };
const person = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const OWNER = person();
const BOB = person(); // on the signed list
const NEWT = person(); // admitted by a straight-in grant
const EVE = person(); // nobody
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const INFO = Buffer.from('group info bytes').toString('base64');

test('store: highest epoch wins, first hash per epoch wins, bounded, 0600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupinfo-'));
  try {
    const s = createTeamGroupInfo({ dir, now: () => NOW });
    assert.equal((await s.put('Bad', {})).code, 'bad_request');
    assert.equal((await s.put('alpha', { group_id: 'g1', epoch: '01', group_info: INFO, transcript_hash: H1 })).code, 'bad_epoch');
    assert.equal((await s.put('alpha', { group_id: 'g1', epoch: '1', group_info: 'not base64!', transcript_hash: H1 })).code, 'bad_group_info');
    assert.equal((await s.put('alpha', { group_id: 'g1', epoch: '1', group_info: 'A'.repeat(MAX_GROUP_INFO_B64 + 4), transcript_hash: H1 })).code, 'bad_group_info');
    assert.equal((await s.put('alpha', { group_id: 'g1', epoch: '1', group_info: INFO, transcript_hash: 'xyz' })).code, 'bad_hash');
    // Epoch 0 has no transcript yet: an empty hash is fine there, nowhere else.
    assert.equal((await s.put('alpha', { group_id: 'g1', epoch: '1', group_info: INFO, transcript_hash: '' })).code, 'bad_hash');
    assert.deepEqual(await s.put('alpha', { group_id: 'g1', epoch: '0', group_info: INFO, transcript_hash: '' }), { ok: true, stored: true });
    assert.deepEqual((await s.get('alpha')).history, {});
    assert.deepEqual(await s.put('alpha', { group_id: 'g1', epoch: '2', group_info: INFO, transcript_hash: H1 }), { ok: true, stored: true });
    assert.equal(statSync(join(dir, 'alpha.json')).mode & 0o777, 0o600);
    // An older epoch adds history but never replaces the card.
    assert.deepEqual(await s.put('alpha', { group_id: 'g1', epoch: '1', group_info: 'QQ==', transcript_hash: H2 }), { ok: true, stored: false });
    assert.equal((await s.get('alpha')).group_info, INFO);
    // A second, different hash for an epoch is ignored (the first landed).
    assert.deepEqual(await s.put('alpha', { group_id: 'g1', epoch: '2', group_info: 'QQ==', transcript_hash: H2 }), { ok: true, stored: false });
    assert.deepEqual((await s.get('alpha')).history, { 2: H1, 1: H2 });
    // A new chat for the project replaces the old card.
    await s.put('alpha', { group_id: 'g2', epoch: '0', group_info: 'QQ==', transcript_hash: H2 });
    assert.deepEqual((await s.get('alpha')).history, { 0: H2 });
    // History is bounded.
    for (let e = 1; e <= 40; e++) await s.put('alpha', { group_id: 'g2', epoch: String(e), group_info: INFO, transcript_hash: H1 });
    const card = await s.get('alpha');
    assert.equal(Object.keys(card.history).length, 32);
    assert.equal(card.epoch, '40');
    // Concurrent writes are serialised.
    await Promise.all([41, 42, 43].map((e) => s.put('alpha', { group_id: 'g2', epoch: String(e), group_info: INFO, transcript_hash: H1 })));
    assert.equal((await s.get('alpha')).epoch, '43');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function cfg() {
  return {
    session_secret: 'e'.repeat(64), session_ttl_sec: 3600, session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(OWNER.pk), admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false, max_challenges: 1000 }, cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' }, ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' }, logging: { level: 'silent' },
    teams: { app_url: 'https://teams.example.test' }, _config_path: null,
  };
}

function signed(auth, who) {
  const { challenge } = auth.issueChallenge('198.51.100.9');
  return finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, who.sk);
}

test('route: members upload; listed and admitted people get the card with their proof; others are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupinfo-routes-'));
  const c = cfg();
  const auth = createAuth(c, { now: () => NOW, log: silent });
  const rosterStore = createRosterStore({ dir: join(dir, 'team'), now: () => NOW });
  const teamsState = createTeamsState({ dir: join(dir, 'teams'), now: () => NOW });
  const teamInvites = createTeamInvites({ dir: join(dir, 'teams'), now: () => NOW });
  const teamGroupInfo = createTeamGroupInfo({ dir: join(dir, 'teams', 'groupinfo'), now: () => NOW });
  const teamProfiles = { getProfiles: async () => ({}), avatar: async () => null, search: async () => [], close() {} };
  const { app } = await buildApp(c, { auth, rosterStore, teamsState, teamInvites, teamProfiles, teamGroupInfo });
  try {
    const owner = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
    const OH = { authorization: `Bearer ${owner.token}` };
    const roster = finalizeEvent({ kind: ROSTER_KIND, created_at: NOW, tags: [['d', 'alpha'], ['p', BOB.pk, 'maintainer']], content: '' }, OWNER.sk);
    await rosterStore.put('alpha', roster, OWNER.pk);
    const bearer = (who) => ({ authorization: `Bearer ${auth.issueMemberSession(who.pk).token}` });
    const put = (headers, payload) => app.inject({ method: 'PUT', url: '/api/projects/alpha/teams/groupinfo', headers, payload });
    const get = (headers) => app.inject({ method: 'GET', url: '/api/projects/alpha/teams/groupinfo', headers });
    const card = { group_id: 'g1', epoch: '3', group_info: INFO, transcript_hash: H1 };

    // No chat yet: nothing to upload to, nothing to fetch.
    assert.equal((await put(bearer(BOB), card)).json().code, 'wrong_group');
    await app.inject({ method: 'POST', url: '/api/projects/alpha/teams/chat', headers: OH, payload: { op: 'set', group_id: 'g1' } });
    assert.equal((await get(bearer(BOB))).statusCode, 404);
    assert.equal((await put(bearer(BOB), { ...card, group_id: 'other' })).statusCode, 409);
    assert.equal((await put(bearer(EVE), card)).statusCode, 403, 'not on the project');
    assert.deepEqual((await put(bearer(BOB), card)).json(), { ok: true, stored: true });

    // Bob (on the signed list) gets the card and the signed list as proof.
    const b = await get(bearer(BOB));
    assert.equal(b.statusCode, 200);
    assert.equal(b.headers['cache-control'], 'no-store');
    assert.equal(b.json().group_info, INFO);
    assert.equal(b.json().epoch, '3');
    assert.deepEqual(b.json().history, { 3: H1 });
    assert.equal(b.json().proof.id, roster.id);
    assert.equal(b.json().proof.sig, roster.sig);

    // Newt, admitted by a straight-in grant, gets that grant as proof.
    const grant = finalizeEvent({
      kind: INVITE_GRANT_KIND, created_at: NOW, content: '',
      tags: [['project', 'alpha'], ['invite', 'H'.repeat(16)], ['role', 'contributor'], ['uses', '2'], ['expiration', String(NOW + 86400)]],
    }, OWNER.sk);
    const made = await app.inject({ method: 'POST', url: '/api/projects/alpha/invites', headers: OH, payload: { kind: 'open', auto: true, grant } });
    assert.equal(made.statusCode, 200);
    const [, id, secret] = made.json().url.match(/\/chat\/join\/([A-Za-z0-9_-]{16})#([A-Za-z0-9_-]{22})$/);
    const claimed = await app.inject({ method: 'POST', url: '/api/team/invite/claim', payload: { id, secret, event: signed(auth, NEWT) } });
    assert.equal(claimed.statusCode, 200);
    const n = await get({ authorization: `Bearer ${claimed.json().token}` });
    assert.equal(n.statusCode, 200);
    assert.equal(n.json().proof.id, grant.id);
    assert.equal(n.json().proof.sig, grant.sig);

    // Eve gets nothing, not even a hint that the card exists.
    assert.equal((await get(bearer(EVE))).statusCode, 403);
    assert.equal((await get({})).statusCode, 401);
    // The owner can read it (no proof: the owner never joins from outside).
    assert.equal((await get(OH)).json().proof, null);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
