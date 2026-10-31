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

test('member login: members get an m1 token; owner, strangers and replays are refused', async () => {
  const clock = { t: NOW };
  const auth = mkAuth(clock);
  const isMember = async (pk) => pk === BOB.pk;

  const ev = signed(auth, BOB);
  const ok = await auth.verifyMemberLogin(ev, { isMember });
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^m1\.\d+\.\d+\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.equal(ok.expires_at, NOW + TTL);
  // Replay of the same signed challenge: consumed.
  assert.equal((await auth.verifyMemberLogin(ev, { isMember })).code, 'challenge_expired');

  assert.equal((await auth.verifyMemberLogin(signed(auth, OWNER), { isMember: async () => true })).code, 'use_owner_login');
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

async function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'team-routes-'));
  const c = { ...cfg(), ...over };
  const auth = createAuth(c, { now: () => NOW, log: silent });
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

test('route: member sign-in returns a token without a cookie; owner and strangers get 403 codes', async () => {
  const { login, done } = await setup();
  try {
    const ok = await login(BOB);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.json().token, /^m1\./);
    assert.equal(ok.headers['set-cookie'], undefined, 'member tokens must never reach nginx auth_request');
    const own = await login(OWNER);
    assert.equal(own.statusCode, 403);
    assert.equal(own.json().code, 'use_owner_login');
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
