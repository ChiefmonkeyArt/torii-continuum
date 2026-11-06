/**
 * TEAMS-2a-2: roster-member sign-in and role-scoped project access.
 *
 * Unit: verifyMemberLogin / verifyMemberToken (separate credential from the
 * owner session). Routes: the REAL buildApp with a temp roster store.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';
import { normalizeTeamsAppUrl, loadConfig } from '../core/config.mjs';

const NOW = 1_700_000_000;
const TTL = 3600;
const silent = { info() {}, warn() {}, error() {} };
const person = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const OWNER = person();
const BOB = person(); // maintainer
const VIC = person(); // viewer
const BOT = person(); // agent of BOB
const EVE = person(); // nobody

function cfg() {
  return {
    session_secret: 'd'.repeat(64),
    session_ttl_sec: TTL,
    session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(OWNER.pk),
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

const rosterEv = (slug, tags, created_at = NOW) =>
  finalizeEvent({ kind: ROSTER_KIND, created_at, tags: [['d', slug], ...tags], content: '' }, OWNER.sk);

function signed(auth, who, ip = '198.51.100.4') {
  const { challenge } = auth.issueChallenge(ip);
  return finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, who.sk);
}

function mkAuth(clock) {
  return createAuth(cfg(), { now: () => clock.t, log: silent });
}

// ── unit ──────────────────────────────────────────────────────────────────

test('member login: members get an m2 token; owner, strangers and replays are refused', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const isMember = async (pk) => pk === BOB.pk;

  const ev = signed(auth, BOB);
  const ok = await auth.verifyMemberLogin(ev, { isMember });
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^m2\.\d+\.\d+\.\d+\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.equal(ok.expires_at, NOW + TTL);
  // Replay of the same signed challenge: consumed.
  assert.equal((await auth.verifyMemberLogin(ev, { isMember })).code, 'challenge_expired');

  // The owner gets a scoped member token even when isMember says no (no rosters yet).
  const own = await auth.verifyMemberLogin(signed(auth, OWNER), { isMember: async () => false });
  assert.equal(own.ok, true);
  assert.equal(auth.verifyMemberToken(own.token).pubkey, OWNER.pk);
  assert.equal(auth.verifySessionToken(own.token).ok, false, 'owner member token is not an admin session');
  assert.equal((await auth.verifyMemberLogin(signed(auth, EVE), { isMember })).code, 'not_member');
  // A refused stranger still burns the challenge (no free retries on one sig).
  const eveEv = signed(auth, EVE);
  await auth.verifyMemberLogin(eveEv, { isMember });
  assert.equal((await auth.verifyMemberLogin(eveEv, { isMember: async () => true })).code, 'challenge_expired');

  const bad = signed(auth, BOB);
  bad.sig = bad.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await auth.verifyMemberLogin(bad, { isMember })).code, 'bad_signature');
  assert.equal((await auth.verifyMemberLogin({ ...signed(auth, BOB), kind: 1 }, { isMember })).code, 'wrong_kind');
  assert.equal((await auth.verifyMemberLogin(signed(auth, BOB), {})).code, 'not_member');
});

test('member and owner tokens are not interchangeable', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const member = await auth.verifyMemberLogin(signed(auth, BOB), { isMember: async () => true });
  const owner = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
  assert.equal(owner.ok, true);

  assert.equal(auth.verifyMemberToken(member.token).ok, true);
  assert.equal(auth.verifyMemberToken(member.token).pubkey, BOB.pk);
  assert.equal(auth.verifySessionToken(member.token).ok, false, 'member token must never pass as owner');
  assert.equal(auth.verifyMemberToken(owner.token).ok, false, 'owner token is not a member token');

  // An m1 token MACed with the raw session secret (the owner key) is refused.
  const payload = `m1.${NOW}.${NOW + TTL}.${BOB.pk}`;
  const forged = `${payload}.${createHmac('sha256', 'd'.repeat(64)).update(payload).digest('hex')}`;
  assert.equal(auth.verifyMemberToken(forged).reason, 'bad signature');
  // Pubkey swap breaks the MAC.
  const swapped = member.token.replace(BOB.pk, EVE.pk);
  assert.equal(auth.verifyMemberToken(swapped).ok, false);
  // Over-long lifetime is refused even with a valid-looking shape.
  assert.equal(auth.verifyMemberToken(`m1.${NOW}.${NOW + TTL * 2}.${BOB.pk}.${'0'.repeat(64)}`).ok, false);

  clock.t = NOW + TTL + 1;
  assert.equal(auth.verifyMemberToken(member.token).reason, 'expired');
});

test('rotating session_secret revokes member tokens', async () => {
  const clock = { t: NOW };
  const a = mkAuth(clock);
  const { token } = await a.verifyMemberLogin(signed(a, BOB), { isMember: async () => true });
  const b = createAuth({ ...cfg(), session_secret: 'e'.repeat(64) }, { now: () => clock.t, log: silent });
  assert.equal(b.verifyMemberToken(token).ok, false);
});

test('store.memberships lists projects with effective role and skips junk files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-mem-'));
  try {
    const store = createRosterStore({ dir, now: () => NOW });
    assert.deepEqual(await createRosterStore({ dir: join(dir, 'missing') }).memberships(BOB.pk), []);
    await store.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer'], ['p', BOT.pk, 'agent', BOB.pk]]), OWNER.pk);
    await store.put('beta', rosterEv('beta', [['p', BOB.pk, 'viewer']]), OWNER.pk);
    writeFileSync(join(dir, 'gamma.json'), '{not json');
    writeFileSync(join(dir, 'Bad Slug.json'), '{}');
    assert.deepEqual(await store.memberships(BOB.pk), [
      { slug: 'alpha', role: 'maintainer', caps: ['read', 'chat', 'propose', 'merge'] },
      { slug: 'beta', role: 'viewer', caps: ['read', 'chat'] },
    ]);
    assert.deepEqual((await store.memberships(BOT.pk)).map((m) => m.role), ['contributor']);
    assert.deepEqual(await store.memberships(EVE.pk), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── routes ────────────────────────────────────────────────────────────────

async function setup(over = {}, clock = { t: NOW }) {
  const dir = mkdtempSync(join(tmpdir(), 'team-routes-'));
  const c = { ...cfg(), ...over };
  const auth = createAuth(c, { now: () => clock.t, log: silent });
  const rosterStore = createRosterStore({ dir, now: () => NOW });
  const { app } = await buildApp(c, { auth, rosterStore });
  const owner = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
  const OH = { authorization: `Bearer ${owner.token}` };
  await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer'], ['p', VIC.pk, 'viewer']]), OWNER.pk);
  await rosterStore.put('beta', rosterEv('beta', [['p', BOB.pk, 'contributor']]), OWNER.pk);
  const login = async (who) => app.inject({ method: 'POST', url: '/api/team/auth/verify', payload: { event: signed(auth, who) } });
  const H = async (who) => ({ authorization: `Bearer ${(await login(who)).json().token}` });
  return { app, auth, rosterStore, OH, login, H, done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('route: member and owner sign-in return m2 tokens without a cookie; strangers get 403', async () => {
  const { login, done } = await setup();
  try {
    const ok = await login(BOB);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.json().token, /^m2\./);
    assert.equal(ok.headers['set-cookie'], undefined, 'member tokens must never reach nginx auth_request');
    const own = await login(OWNER);
    assert.equal(own.statusCode, 200);
    assert.match(own.json().token, /^m2\./);
    assert.equal(own.headers['set-cookie'], undefined);
    const eve = await login(EVE);
    assert.equal(eve.statusCode, 403);
    assert.equal(eve.json().code, 'not_member');
  } finally { await done(); }
});

test('route: /api/team/me lists the caller projects; owner sees owner role', async () => {
  const { app, OH, H, done } = await setup();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/me' })).statusCode, 401);
    const me = (await app.inject({ method: 'GET', url: '/api/team/me', headers: await H(BOB) })).json();
    assert.equal(me.pubkey, BOB.pk);
    assert.equal(me.owner, false);
    assert.deepEqual(me.projects.map((p) => [p.slug, p.role]), [['alpha', 'maintainer'], ['beta', 'contributor']]);
    const ow = (await app.inject({ method: 'GET', url: '/api/team/me', headers: OH })).json();
    assert.equal(ow.owner, true);
    assert.deepEqual(ow.projects.map((p) => p.role), ['owner', 'owner']);
  } finally { await done(); }
});

test('route: roster GET is role-scoped; projections owner-only; PUT owner-only', async () => {
  const { app, OH, H, done } = await setup();
  try {
    const vic = await H(VIC);
    const r = await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: vic });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().role, 'viewer');
    assert.equal(r.json().projection, undefined, 'members do not see service projections');
    assert.equal(r.json().roster.members.length, 3);
    // Not on beta: same 403 as "too low", and same for a missing project.
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/beta/roster', headers: vic })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/nope/roster', headers: vic })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/Bad!/roster', headers: vic })).statusCode, 400);
    // Owner still gets projections.
    const o = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: OH })).json();
    assert.equal(o.role, 'owner');
    assert.equal(o.projection.cordn.length, 3);
    // A maintainer cannot replace the roster, even with an owner-signed event.
    const put = await app.inject({
      method: 'PUT', url: '/api/projects/alpha/roster', headers: await H(BOB),
      payload: { event: rosterEv('alpha', [['p', BOB.pk, 'maintainer']], NOW + 1) },
    });
    assert.equal(put.statusCode, 401);
  } finally { await done(); }
});

test('route: removal from the roster takes effect on the next request, token still valid', async () => {
  const { app, OH, H, done } = await setup();
  try {
    const vic = await H(VIC);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: vic })).statusCode, 200);
    const put = await app.inject({
      method: 'PUT', url: '/api/projects/alpha/roster', headers: OH,
      payload: { event: rosterEv('alpha', [['p', BOB.pk, 'maintainer']], NOW + 1) },
    });
    assert.equal(put.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: vic })).statusCode, 403);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/team/me', headers: vic })).json().projects, []);
  } finally { await done(); }
});

test('route: a member token does not open owner-only routes', async () => {
  const { app, H, done } = await setup();
  try {
    const bob = await H(BOB);
    for (const url of ['/api/auth/session', '/api/genesis']) {
      const res = await app.inject({ method: 'GET', url, headers: bob });
      assert.notEqual(res.statusCode, 200, `${url} must refuse a member token`);
    }
    const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: bob });
    assert.equal(refresh.statusCode, 401);
  } finally { await done(); }
});

test('teams.app_url: only a bare https origin survives', () => {
  assert.equal(normalizeTeamsAppUrl('https://teams.example.org'), 'https://teams.example.org');
  assert.equal(normalizeTeamsAppUrl('https://teams.example.org/'), 'https://teams.example.org');
  assert.equal(normalizeTeamsAppUrl('HTTPS://Teams.Example.org:8443/'), 'https://teams.example.org:8443');
  for (const bad of [undefined, null, '', 42, 'http://teams.example.org', 'javascript:alert(1)',
    'https://u:p@teams.example.org', 'https://teams.example.org/chat', 'https://teams.example.org/?x=1',
    'https://teams.example.org/#a', 'not a url', `https://${'a'.repeat(300)}.org`]) {
    assert.equal(normalizeTeamsAppUrl(bad), null, String(bad));
  }
});

test('route: /api/team/me carries teams_app_url (null when unset)', async () => {
  const a = await setup();
  try {
    assert.equal((await a.app.inject({ method: 'GET', url: '/api/team/me', headers: a.OH })).json().teams_app_url, null);
  } finally { await a.done(); }
  const b = await setup({ teams: { app_url: 'https://teams.example.org' } });
  try {
    const me = (await b.app.inject({ method: 'GET', url: '/api/team/me', headers: await b.H(BOB) })).json();
    assert.equal(me.teams_app_url, 'https://teams.example.org');
  } finally { await b.done(); }
});

test('loadConfig wires teams.app_url through the normaliser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teams-cfg-'));
  const base = ['admin_npub: ""', `session_secret: "${'a'.repeat(64)}"`, 'server:', '  host: "127.0.0.1"', '  port: 8787',
    'routstr:', '  endpoint: "https://api.example.test"'];
  try {
    const p1 = join(dir, 'a.yaml');
    writeFileSync(p1, [...base, 'teams:', '  app_url: "https://teams.example.org/"'].join('\n'), { mode: 0o600 });
    assert.equal(loadConfig(p1).teams.app_url, 'https://teams.example.org');
    const p2 = join(dir, 'b.yaml');
    writeFileSync(p2, [...base, 'teams:', '  app_url: "http://teams.example.org"'].join('\n'), { mode: 0o600 });
    assert.equal(loadConfig(p2).teams.app_url, null);
    const p3 = join(dir, 'c.yaml');
    writeFileSync(p3, base.join('\n'), { mode: 0o600 });
    assert.equal(loadConfig(p3).teams.app_url, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('route: the owner m1 token is scoped: owner role on rosters, never admin', async () => {
  const { app, login, done } = await setup();
  try {
    const H = { authorization: `Bearer ${(await login(OWNER)).json().token}` };
    const me = (await app.inject({ method: 'GET', url: '/api/team/me', headers: H })).json();
    assert.equal(me.owner, false);
    assert.deepEqual(me.projects.map((p) => [p.slug, p.role]), [['alpha', 'owner'], ['beta', 'owner']]);
    const r = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: H })).json();
    assert.equal(r.role, 'owner');
    assert.equal(r.projection, undefined, 'no service projections on a scoped token');
    const put = await app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H,
      payload: { event: rosterEv('alpha', [['p', BOB.pk, 'maintainer']], NOW + 1) } });
    assert.equal(put.statusCode, 401);
    for (const url of ['/api/auth/session', '/api/genesis']) {
      assert.notEqual((await app.inject({ method: 'GET', url, headers: H })).statusCode, 200, url);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: H })).statusCode, 401);
  } finally { await done(); }
});

// ── ADR 0008: lasting member sessions and the owner handoff ────────────────

const legacyM1 = (pk, iat, exp) => {
  const key = createHmac('sha256', 'd'.repeat(64)).update('continuum-member-session-v1').digest();
  const payload = `m1.${iat}.${exp}.${pk}`;
  return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
};

test('m2 renewal keeps the original sign-in and stops at the absolute cap', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock); // TTL 3600, max lifetime 86400
  const isMember = async (pk) => pk === BOB.pk;
  let { token } = await auth.verifyMemberLogin(signed(auth, BOB), { isMember });
  assert.equal(auth.verifyMemberToken(token).oiat, NOW);
  for (let i = 1; i <= 23; i++) {
    clock.t = NOW + i * 3600 - 60;
    const r = await auth.refreshMemberSession(token, { isMember });
    assert.equal(r.ok, true, `renewal ${i}`);
    assert.equal(auth.verifyMemberToken(r.token).oiat, NOW);
    assert.ok(r.expires_at <= NOW + 86400);
    token = r.token;
  }
  clock.t = NOW + 86340 - 30; // last token still live, cap within one TTL
  const last = await auth.refreshMemberSession(token, { isMember });
  assert.equal(last.expires_at, NOW + 86400, 'clamped to the cap, not the TTL');
  clock.t = NOW + 86400;
  assert.equal((await auth.refreshMemberSession(last.token, { isMember })).code, 'max_lifetime_reached');
  // A forged oiat is caught by the MAC; an exp past the cap by the shape check.
  assert.equal(auth.verifyMemberToken(token.replace(`m2.${NOW}.`, `m2.${NOW + 50}.`)).ok, false);
  clock.t = NOW;
  assert.equal(auth.verifyMemberToken(`m2.${NOW - 86400}.${NOW}.${NOW + 60}.${BOB.pk}.${'0'.repeat(64)}`).reason, 'bad timestamps');
});

test('renewal is refused off every roster, expired or malformed; owner always renews', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const bob = await auth.verifyMemberLogin(signed(auth, BOB), { isMember: async () => true });
  assert.equal((await auth.refreshMemberSession(bob.token, { isMember: async () => false })).code, 'not_member');
  const own = await auth.verifyMemberLogin(signed(auth, OWNER), { isMember: async () => false });
  assert.equal((await auth.refreshMemberSession(own.token, { isMember: async () => false })).ok, true);
  assert.equal((await auth.refreshMemberSession('nope', { isMember: async () => true })).code, 'invalid_session');
  clock.t = NOW + TTL + 1;
  assert.equal((await auth.refreshMemberSession(bob.token, { isMember: async () => true })).code, 'expired');
});

test('legacy m1 tokens verify until expiry and renew into m2', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const m1 = legacyM1(BOB.pk, NOW, NOW + TTL);
  const v = auth.verifyMemberToken(m1);
  assert.equal(v.ok, true);
  assert.equal(v.oiat, NOW);
  const r = await auth.refreshMemberSession(m1, { isMember: async () => true });
  assert.match(r.token, /^m2\./);
  assert.equal(auth.verifyMemberToken(r.token).oiat, NOW);
});

test('handoff: an admin session yields the owner member token, capped by the admin login', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const admin = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
  clock.t = NOW + 600;
  const h = auth.handoffOwnerToken(admin.token);
  assert.equal(h.ok, true);
  assert.equal(h.pubkey, OWNER.pk);
  const v = auth.verifyMemberToken(h.token);
  assert.equal(v.pubkey, OWNER.pk);
  assert.equal(v.oiat, NOW, 'inherits the admin sign-in time');
  assert.equal(auth.verifySessionToken(h.token).ok, false, 'never an admin session');
  const member = await auth.verifyMemberLogin(signed(auth, BOB), { isMember: async () => true });
  assert.equal(auth.handoffOwnerToken(member.token).ok, false, 'a member token cannot hand off');
});

test('route: /api/team/auth/refresh renews, refuses removed members, keeps codes', async () => {
  const clock = { t: NOW };
  const { app, rosterStore, login, done } = await setup({}, clock);
  try {
    const vic = (await login(VIC)).json().token;
    const bob = (await login(BOB)).json().token;
    const refresh = (t) => app.inject({ method: 'POST', url: '/api/team/auth/refresh', headers: t ? { authorization: `Bearer ${t}` } : {} });
    clock.t = NOW + 1800;
    const r = await refresh(bob);
    assert.equal(r.statusCode, 200);
    assert.match(r.json().token, /^m2\./);
    assert.equal(r.json().expires_at, NOW + 1800 + TTL);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal((await refresh('')).statusCode, 401);
    assert.equal((await refresh('m2.x')).json().code, 'invalid_session');
    // VIC dropped from alpha (their only roster): renewal is refused.
    await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer']], NOW + 10), OWNER.pk);
    const gone = await refresh(vic);
    assert.equal(gone.statusCode, 403);
    assert.equal(gone.json().code, 'not_member');
  } finally { await done(); }
});

test('route: /api/team/auth/handoff is admin-only and returns a scoped owner token', async () => {
  const { app, OH, H, done } = await setup();
  try {
    const url = '/api/team/auth/handoff';
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: await H(BOB) })).statusCode, 401);
    const r = await app.inject({ method: 'POST', url, headers: OH });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().pubkey, OWNER.pk);
    assert.equal(r.headers['cache-control'], 'no-store');
    const me = await app.inject({ method: 'GET', url: '/api/team/me', headers: { authorization: `Bearer ${r.json().token}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().pubkey, OWNER.pk);
    // The handed-off token never opens admin routes.
    assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${r.json().token}` } })).statusCode, 401);
  } finally { await done(); }
});
