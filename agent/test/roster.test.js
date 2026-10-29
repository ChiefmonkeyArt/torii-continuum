/**
 * TEAMS-2a — owner-signed project roster: trust rules, roles, projections,
 * storage, and the real GET/PUT /api/projects/:slug/roster routes.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
  ROSTER_KIND, MAX_HUMANS, validateRosterEvent, effectiveRole, can, project, createRosterStore,
} from '../lib/roster.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const NOW = 1_700_000_000;
const ownerSk = generateSecretKey();
const OWNER = getPublicKey(ownerSk);
const key = () => getPublicKey(generateSecretKey());
const BOB = key();
const CAROL = key();
const VIC = key();
const BOT = key();

function roster(tags, { sk = ownerSk, created_at = NOW, slug = 'alpha', content = '' } = {}) {
  return finalizeEvent({ kind: ROSTER_KIND, created_at, tags: [['d', slug], ...tags], content }, sk);
}
const ctx = (over = {}) => ({ ownerHex: OWNER, slug: 'alpha', now: NOW, ...over });
const TEAM = [['p', BOB, 'maintainer'], ['p', CAROL, 'contributor'], ['p', VIC, 'viewer'], ['p', BOT, 'agent', CAROL]];

test('accepts a valid owner-signed roster with all roles', () => {
  const v = validateRosterEvent(roster(TEAM), ctx());
  assert.equal(v.ok, true);
  assert.deepEqual(v.roster.members.map((m) => m.role), ['owner', 'maintainer', 'contributor', 'viewer', 'agent']);
  assert.equal(v.roster.members[4].of, CAROL);
});

test('rejects a roster signed by anyone but the owner', () => {
  const ev = roster(TEAM, { sk: generateSecretKey() });
  assert.equal(validateRosterEvent(ev, ctx()).code, 'not_owner');
});

test('rejects a tampered roster (bad signature)', () => {
  const ev = roster(TEAM);
  const forged = { ...ev, tags: [...ev.tags, ['p', key(), 'maintainer']] };
  assert.equal(validateRosterEvent(forged, ctx()).code, 'bad_sig');
});

test('rejects replay into another project (d tag mismatch)', () => {
  assert.equal(validateRosterEvent(roster(TEAM, { slug: 'beta' }), ctx()).code, 'bad_d');
});

test('rejects rollback / replay of an older or equal roster', () => {
  assert.equal(validateRosterEvent(roster(TEAM), ctx({ prevCreatedAt: NOW })).code, 'stale');
  assert.equal(validateRosterEvent(roster(TEAM, { created_at: NOW + 5000 }), ctx()).code, 'future');
});

test('rejects wrong kind, non-empty content, unknown role, owner listed, duplicates', () => {
  const wrongKind = finalizeEvent({ kind: 30093, created_at: NOW, tags: [['d', 'alpha']], content: '' }, ownerSk);
  assert.equal(validateRosterEvent(wrongKind, ctx()).code, 'bad_kind');
  assert.equal(validateRosterEvent(roster([], { content: 'x' }), ctx()).code, 'bad_event');
  assert.equal(validateRosterEvent(roster([['p', BOB, 'admin']]), ctx()).code, 'bad_role');
  assert.equal(validateRosterEvent(roster([['p', OWNER, 'viewer']]), ctx()).code, 'bad_member');
  assert.equal(validateRosterEvent(roster([['p', BOB, 'viewer'], ['p', BOB, 'maintainer']]), ctx()).code, 'duplicate');
  assert.equal(validateRosterEvent(roster([['p', 'npub1xyz', 'viewer']]), ctx()).code, 'bad_member');
});

test('rejects dangling or chained agents', () => {
  assert.equal(validateRosterEvent(roster([['p', BOT, 'agent', BOB]]), ctx()).code, 'dangling_agent');
  const bot2 = key();
  assert.equal(
    validateRosterEvent(roster([['p', CAROL, 'contributor'], ['p', BOT, 'agent', CAROL], ['p', bot2, 'agent', BOT]]), ctx()).code,
    'dangling_agent',
  );
});

test('caps the team at MAX_HUMANS people (owner included)', () => {
  const tags = Array.from({ length: MAX_HUMANS }, () => ['p', key(), 'viewer']);
  assert.equal(validateRosterEvent(roster(tags), ctx()).code, 'too_many');
  assert.equal(validateRosterEvent(roster(tags.slice(1)), ctx()).ok, true);
});

test('roles map to capabilities; agents never merge or manage', () => {
  const { roster: r } = validateRosterEvent(roster(TEAM), ctx());
  assert.equal(can(r, OWNER, 'manage'), true);
  assert.equal(can(r, BOB, 'merge'), true);
  assert.equal(can(r, BOB, 'manage'), false);
  assert.equal(can(r, CAROL, 'propose'), true);
  assert.equal(can(r, CAROL, 'merge'), false);
  assert.equal(can(r, VIC, 'chat'), true);
  assert.equal(can(r, VIC, 'propose'), false);
  assert.equal(effectiveRole(r, BOT), 'contributor');
  assert.equal(can(r, BOT, 'merge'), false);
  assert.equal(can(r, key(), 'read'), false);
});

test("an agent of a viewer is capped at viewer, even an agent of a maintainer can't merge", () => {
  const { roster: r } = validateRosterEvent(
    roster([['p', VIC, 'viewer'], ['p', BOT, 'agent', VIC], ['p', BOB, 'maintainer'], ['p', CAROL, 'agent', BOB]]),
    ctx(),
  );
  assert.equal(effectiveRole(r, BOT), 'viewer');
  assert.equal(effectiveRole(r, CAROL), 'contributor');
  assert.equal(can(r, CAROL, 'merge'), false);
});

test('projections: cordn + ngitPrivate = everyone, maintainers = owner + maintainers', () => {
  const { roster: r } = validateRosterEvent(roster(TEAM), ctx());
  const p = project(r);
  assert.deepEqual(p.cordn, [OWNER, BOB, CAROL, VIC, BOT].sort());
  assert.deepEqual(p.ngitPrivate, p.cordn);
  assert.deepEqual(p.maintainers, [OWNER, BOB].sort());
  assert.deepEqual(project(null), { cordn: [], ngitPrivate: [], maintainers: [] });
});

test('store: persists 0600 atomically, enforces monotonic created_at, audits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-'));
  const audited = [];
  try {
    const store = createRosterStore({ dir, now: () => NOW, audit: { append: async (e, p) => audited.push([e, p]) } });
    assert.equal(await store.get('alpha'), null);
    assert.equal((await store.put('alpha', roster(TEAM), OWNER)).ok, true);
    assert.equal((await store.get('alpha')).roster.members.length, 5);
    assert.equal(statSync(join(dir, 'alpha.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['alpha.json']);
    assert.equal((await store.put('alpha', roster(TEAM), OWNER)).code, 'stale');
    assert.equal((await store.put('alpha', roster([], { created_at: NOW + 1 }), OWNER)).ok, true);
    assert.equal((await store.get('alpha')).roster.members.length, 1);
    assert.equal(audited.length, 2);
    assert.equal(audited[0][0], 'team.roster.set');
    assert.equal(await store.get('../etc'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── routes ────────────────────────────────────────────────────────────────

function cfg() {
  return {
    session_secret: 'c'.repeat(64),
    session_ttl_sec: 86400,
    session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(OWNER),
    admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false, max_challenges: 1000 },
    cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' },
    ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' },
    logging: { level: 'silent' },
    _config_path: null,
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-routes-'));
  const c = cfg();
  const auth = createAuth(c, { now: () => NOW, log: { info() {}, warn() {}, error() {} } });
  const rosterStore = createRosterStore({ dir, now: () => NOW });
  const { app } = await buildApp(c, { auth, rosterStore });
  const { challenge } = auth.issueChallenge('203.0.113.9');
  const login = await auth.verifyChallenge(
    finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, ownerSk),
    '203.0.113.9',
  );
  assert.equal(login.ok, true);
  const H = { authorization: `Bearer ${login.token}` };
  return { app, H, dir, done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('routes: admin required for GET and PUT', async () => {
  const { app, done } = await setup();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/alpha/roster' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', payload: { event: roster(TEAM) } })).statusCode, 401);
  } finally { await done(); }
});

test('routes: PUT verifies + stores, GET returns roster + projections, stale is 409', async () => {
  const { app, H, dir, done } = await setup();
  try {
    const empty = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: H })).body);
    assert.equal(empty.roster, null);
    const ev = roster(TEAM);
    const put = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: { event: ev } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(JSON.parse(put.body).projection.maintainers, [OWNER, BOB].sort());
    const got = JSON.parse((await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: H })).body);
    assert.equal(got.event.id, ev.id);
    assert.equal(got.projection.cordn.length, 5);
    const again = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: { event: ev } });
    assert.equal(again.statusCode, 409);
    // On disk: the public event + derived roster only, no session material.
    const disk = readFileSync(join(dir, 'alpha.json'), 'utf8');
    assert.ok(!disk.includes(H.authorization.slice(7)));
  } finally { await done(); }
});

test('routes: foreign-signed, cross-project and bad-slug rosters are refused', async () => {
  const { app, H, done } = await setup();
  try {
    const foreign = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: { event: roster(TEAM, { sk: generateSecretKey() }) } });
    assert.equal(foreign.statusCode, 400);
    assert.equal(JSON.parse(foreign.body).code, 'not_owner');
    const cross = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: { event: roster(TEAM, { slug: 'beta' }) } });
    assert.equal(JSON.parse(cross.body).code, 'bad_d');
    const bad = await app.inject({ method: 'GET', url: '/api/projects/..%2Fx/roster', headers: H });
    assert.equal(bad.statusCode, 400);
    const none = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: {} });
    assert.equal(none.statusCode, 400);
  } finally { await done(); }
});

test('a tampered copy cannot ride on a cached verification flag; extra fields are dropped on store', async () => {
  const ev = roster(TEAM);
  assert.equal(validateRosterEvent(ev, ctx()).ok, true); // primes nostr-tools' verified symbol
  const forged = { ...ev, tags: [['d', 'alpha'], ['p', key(), 'maintainer']] };
  assert.equal(validateRosterEvent(forged, ctx()).code, 'bad_sig');
  const dir = mkdtempSync(join(tmpdir(), 'roster-x-'));
  try {
    const store = createRosterStore({ dir, now: () => NOW });
    assert.equal((await store.put('alpha', { ...roster(TEAM), extra: 'x' }, OWNER)).ok, true);
    assert.deepEqual(Object.keys((await store.get('alpha')).event).sort(),
      ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
