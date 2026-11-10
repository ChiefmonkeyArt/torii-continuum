/**
 * torii-teams ADR 0016: "Your computers" notes and the node mesh file for root.
 * Unit: validateDeviceNote. Routes: the REAL buildApp with temp stores.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { DEVICE_KIND, DEVICE_TAG, validateDeviceNote, createTeamDevices } from '../lib/team-devices.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const NOW = 1_700_000_000;
const silent = { info() {}, warn() {}, error() {} };
const person = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const OWNER = person();
const BOB = person();
const EVE = person();
const dev = () => nip19.npubEncode(person().pk);
const [D1, D2, D3, D4] = [dev(), dev(), dev(), dev()];
const NODE = dev();

const note = (who, devices, created_at = NOW, extra = {}) => finalizeEvent({
  kind: DEVICE_KIND, created_at, tags: [['t', DEVICE_TAG]],
  content: JSON.stringify({ v: 1, devices }), ...extra,
}, who.sk);
const rosterEv = (slug, tags, created_at = NOW) =>
  finalizeEvent({ kind: ROSTER_KIND, created_at, tags: [['d', slug], ...tags], content: '' }, OWNER.sk);

function cfg() {
  return {
    session_secret: 'd'.repeat(64), session_ttl_sec: 3600, session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(OWNER.pk), admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false, max_challenges: 1000 },
    cashu: { mints: [] }, routstr: { endpoint: 'https://example.invalid' },
    ollama: { enabled: false }, model_router: { strategy: 'routstr_first' },
    logging: { level: 'silent' }, _config_path: null,
  };
}

test('validateDeviceNote: accepts a signed list of up to 3, refuses everything else', () => {
  const ctx = { pubkey: BOB.pk, now: NOW };
  const ok = validateDeviceNote(note(BOB, [{ npub: D1, label: 'Laptop' }, { npub: D2 }]), ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.devices, [{ npub: D1, label: 'Laptop' }, { npub: D2, label: '' }]);
  assert.equal(validateDeviceNote(note(BOB, []), ctx).ok, true, 'empty list removes all');
  const code = (e, c = ctx) => validateDeviceNote(e, c).code;
  assert.equal(code(note(EVE, [{ npub: D1 }])), 'not_signer');
  assert.equal(code(note(BOB, [D1, D2, D3, D4].map((npub) => ({ npub })))), 'too_many');
  assert.equal(code(note(BOB, [{ npub: D1 }, { npub: D1 }])), 'duplicate');
  assert.equal(code(note(BOB, [{ npub: 'npub1notreal' }])), 'bad_npub');
  assert.equal(code(note(BOB, [{ npub: D1, label: 'x'.repeat(33) }])), 'bad_label');
  assert.equal(code(note(BOB, [{ npub: D1, label: 'a\nb' }])), 'bad_label');
  assert.equal(code(note(BOB, [{ npub: D1, ip: 'fd00::1' }])), 'bad_device');
  assert.equal(code(note(BOB, [], NOW - 601)), 'clock');
  assert.equal(code(note(BOB, [], NOW), { ...ctx, prevCreatedAt: NOW }), 'stale');
  assert.equal(code(note(BOB, [], NOW, { tags: [] })), 'bad_event');
  const forged = note(BOB, [{ npub: D1 }]);
  forged.content = JSON.stringify({ v: 1, devices: [{ npub: D2 }] });
  assert.equal(code(forged), 'bad_sig');
});

async function setup(clock = { t: NOW }) {
  const dir = mkdtempSync(join(tmpdir(), 'team-devices-'));
  const auth = createAuth(cfg(), { now: () => clock.t, log: silent });
  const rosterStore = createRosterStore({ dir: join(dir, 'team'), now: () => clock.t });
  const teamDevices = createTeamDevices({ dir: join(dir, 'teams'), rosterStore, ownerHex: () => OWNER.pk, now: () => clock.t });
  const { app } = await buildApp(cfg(), { auth, rosterStore, teamDevices, nodeFipsNpub: async () => NODE });
  const challenge = (who) => {
    const { challenge: c } = auth.issueChallenge('198.51.100.4');
    return finalizeEvent({ kind: 22242, created_at: clock.t, tags: [['challenge', c]], content: c }, who.sk);
  };
  const owner = await auth.verifyChallenge(challenge(OWNER), '198.51.100.4');
  const OH = { authorization: `Bearer ${owner.token}` };
  const putRoster = (tags, at) => app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: OH, payload: { event: rosterEv('alpha', tags, at) } });
  assert.equal((await putRoster([['p', BOB.pk, 'contributor']])).statusCode, 200);
  const H = async (who) => {
    const r = await app.inject({ method: 'POST', url: '/api/team/auth/verify', payload: { event: challenge(who) } });
    return { authorization: `Bearer ${r.json().token}` };
  };
  const mesh = () => JSON.parse(readFileSync(join(dir, 'teams', 'mesh.json'), 'utf8'));
  return { app, OH, H, putRoster, mesh, dir, done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('route: a member lists, adds and removes their own computers; the mesh file follows', async () => {
  const clock = { t: NOW };
  const { app, H, mesh, dir, done } = await setup(clock);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/devices' })).statusCode, 401);
    const bob = await H(BOB);
    const g = await app.inject({ method: 'GET', url: '/api/team/devices', headers: bob });
    assert.equal(g.statusCode, 200);
    assert.equal(g.headers['cache-control'], 'no-store');
    assert.deepEqual(g.json(), { devices: [], listed: true, max: 3, node: { npub: NODE, git: 'torii-teams.fips:7334' } });
    // The mesh file exists from the roster put, with the owner-signed list.
    assert.equal(mesh().projects[0].roster.pubkey, OWNER.pk);
    assert.equal(statSync(join(dir, 'teams', 'mesh.json')).mode & 0o777, 0o600);
    const put = (ev) => app.inject({ method: 'PUT', url: '/api/team/devices', headers: bob, payload: { event: ev } });
    const p = await put(note(BOB, [{ npub: D1, label: 'Laptop' }]));
    assert.equal(p.statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/team/devices', headers: bob })).json().devices, [{ npub: D1, label: 'Laptop' }]);
    assert.deepEqual(mesh().devices.map((e) => e.pubkey), [BOB.pk]);
    // Older or same-second note: 409. A fourth computer: 400. Someone else's note: 400.
    assert.equal((await put(note(BOB, []))).statusCode, 409);
    clock.t += 5;
    assert.equal((await put(note(BOB, [D1, D2, D3, D4].map((npub) => ({ npub })), clock.t))).statusCode, 400);
    assert.equal((await put(note(OWNER, [], clock.t))).statusCode, 400);
    // Remove all.
    assert.equal((await put(note(BOB, [], clock.t))).statusCode, 200);
    assert.deepEqual(JSON.parse(mesh().devices[0].content).devices, []);
  } finally { await done(); }
});

test('route: someone not on a project cannot save; removal drops their computers from the mesh file', async () => {
  const clock = { t: NOW };
  const { app, H, putRoster, mesh, done } = await setup(clock);
  try {
    const bob = await H(BOB);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/team/devices', headers: bob, payload: { event: note(BOB, [{ npub: D1 }]) } })).statusCode, 200);
    clock.t += 10;
    assert.equal((await putRoster([], clock.t)).statusCode, 200);
    assert.deepEqual(mesh().devices, [], 'removed person: their note leaves the file');
    const g = await app.inject({ method: 'GET', url: '/api/team/devices', headers: bob });
    assert.equal(g.statusCode, 200);
    assert.deepEqual([g.json().listed, g.json().devices], [false, []]);
    const r = await app.inject({ method: 'PUT', url: '/api/team/devices', headers: bob, payload: { event: note(BOB, [{ npub: D2 }], clock.t) } });
    assert.equal(r.statusCode, 403);
  } finally { await done(); }
});

test('mesh file: owner always listed, admitted grants carried, unchanged bytes not rewritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-mesh-'));
  try {
    const rosterStore = createRosterStore({ dir: join(dir, 'team'), now: () => NOW });
    const td = createTeamDevices({ dir: join(dir, 'teams'), rosterStore, ownerHex: () => OWNER.pk, now: () => NOW });
    assert.deepEqual(await td.writeMesh(), { changed: true, projects: 0, devices: 0 });
    assert.equal((await td.put(OWNER.pk, note(OWNER, [{ npub: D3 }]))).ok, true);
    assert.equal((await td.put(EVE.pk, note(EVE, [{ npub: D4 }]))).code, 'not_listed');
    const grant = finalizeEvent({ kind: 27098, created_at: NOW, tags: [['project', 'site'], ['role', 'viewer'], ['uses', '2']], content: '' }, OWNER.sk);
    await rosterStore.admit('site', { pubkey: EVE.pk, role: 'viewer', invite: 'i1', grant, ownerHex: OWNER.pk });
    await td.writeMesh();
    const m = JSON.parse(readFileSync(join(dir, 'teams', 'mesh.json'), 'utf8'));
    assert.deepEqual(m.projects, [{ slug: 'site', roster: null, admitted: [{ pubkey: EVE.pk, role: 'viewer', grant: JSON.parse(JSON.stringify(grant)) }] }]);
    assert.deepEqual(m.devices.map((e) => e.pubkey), [OWNER.pk]);
    assert.equal((await td.writeMesh()).changed, false);
    assert.equal(existsSync(join(dir, 'teams', 'devices.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
