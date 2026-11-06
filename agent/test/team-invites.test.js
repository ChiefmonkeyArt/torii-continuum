/**
 * Invite links (torii-teams docs/torii/adr-0009-invite-links.md).
 *
 * Unit: the invite store (hashes only, expiry, uses, requests) and the j1
 * pending token. Routes: the REAL buildApp with temp stores, covering named and
 * open invites end to end, the single refusal body, seats and log hygiene.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { createTeamsState } from '../lib/teams-state.mjs';
import { createTeamInvites, INVITE_ID_RE, INVITE_SECRET_RE, INVITE_GRANT_KIND, verifyInviteGrant } from '../lib/team-invites.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const NOW = 1_700_000_000;
const TTL = 3600;
const silent = { info() {}, warn() {}, error() {} };
const person = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const OWNER = person();
const BOB = person(); // on alpha
const NEWT = person(); // newcomer
const EVE = person(); // forwarded link
const ORIGIN = 'https://teams.example.test';

function cfg(over = {}) {
  return {
    session_secret: 'e'.repeat(64),
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
    teams: { app_url: ORIGIN },
    _config_path: null,
    ...over,
  };
}

const rosterEv = (slug, tags, created_at = NOW) =>
  finalizeEvent({ kind: ROSTER_KIND, created_at, tags: [['d', slug], ...tags], content: '' }, OWNER.sk);

function signed(auth, who) {
  const { challenge } = auth.issueChallenge('198.51.100.9');
  return finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, who.sk);
}

const splitUrl = (url) => {
  const m = url.match(/^https:\/\/teams\.example\.test\/chat\/join\/([A-Za-z0-9_-]{16})#([A-Za-z0-9_-]{22})$/);
  assert.ok(m, `link shape: ${url}`);
  return { id: m[1], secret: m[2] };
};

// ── store ────────────────────────────────────────────────────────────────

test('store: hashes only, one-time secret, expiry, revoke, uses and requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invites-'));
  const clock = { t: NOW };
  try {
    const s = createTeamInvites({ dir, now: () => clock.t });
    assert.equal((await s.create({ slug: 'alpha', kind: 'open', ttl_sec: 60 })).code, 'bad_ttl');
    assert.equal((await s.create({ slug: 'alpha', kind: 'open', role: 'owner' })).code, 'bad_role');
    assert.equal((await s.create({ slug: 'alpha', kind: 'named' })).code, 'bad_pubkey');
    assert.equal((await s.create({ slug: 'Bad', kind: 'open' })).code, 'bad_request');
    const a = await s.create({ slug: 'alpha', kind: 'open', uses: 1 });
    assert.ok(INVITE_ID_RE.test(a.id) && INVITE_SECRET_RE.test(a.secret));
    assert.equal(a.expires_at, NOW + 7 * 86400);
    const raw = readFileSync(join(dir, 'invites.json'), 'utf8');
    assert.ok(!raw.includes(a.secret), 'secret never stored');
    assert.ok(await s.find(a.id, a.secret));
    assert.equal(await s.find(a.id, 'x'.repeat(22)), null);
    assert.equal(await s.find('y'.repeat(16), a.secret), null);
    // Requests, then approval spends the last use and drops the rest.
    assert.equal((await s.request(a.id, a.secret, NEWT.pk)).ok, true);
    assert.equal((await s.request(a.id, a.secret, NEWT.pk)).ok, true, 'idempotent');
    assert.equal((await s.request(a.id, a.secret, EVE.pk)).ok, true);
    assert.deepEqual((await s.list('alpha'))[0].requests.map((r) => r.pubkey), [NEWT.pk, EVE.pk]);
    assert.deepEqual(await s.pendingCounts(), { alpha: 2 });
    assert.equal((await s.requestState(a.id, NEWT.pk)).state, 'pending');
    assert.equal((await s.decide('alpha', a.id, NEWT.pk, true)).ok, true);
    assert.equal((await s.requestState(a.id, EVE.pk)).state, 'gone', 'used up: others dropped');
    assert.equal(await s.find(a.id, a.secret), null, 'no uses left');
    // Revoke and expiry.
    const b = await s.create({ slug: 'alpha', kind: 'open', ttl_sec: 3600 });
    await s.request(b.id, b.secret, EVE.pk);
    assert.equal((await s.revoke('beta', b.id)).ok, false, 'wrong project');
    assert.equal((await s.revoke('alpha', b.id)).ok, true);
    assert.equal(await s.find(b.id, b.secret), null);
    assert.equal((await s.requestState(b.id, EVE.pk)).state, 'gone');
    const c = await s.create({ slug: 'alpha', kind: 'open', ttl_sec: 3600 });
    clock.t = NOW + 3601;
    assert.equal(await s.find(c.id, c.secret), null, 'expired');
    await s.create({ slug: 'beta', kind: 'open' }); // a write prunes expired entries
    assert.ok(!readFileSync(join(dir, 'invites.json'), 'utf8').includes(c.id));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth: j1 pending tokens are their own credential', async () => {
  const clock = { t: NOW };
  const auth = createAuth(cfg(), { now: () => clock.t, log: silent });
  const j = auth.issuePendingToken(NEWT.pk, 'A'.repeat(16), NOW + 600);
  assert.match(j.token, /^j1\./);
  const v = auth.verifyPendingToken(j.token);
  assert.deepEqual([v.ok, v.pubkey, v.inviteId], [true, NEWT.pk, 'A'.repeat(16)]);
  assert.equal(auth.verifyMemberToken(j.token).ok, false, 'never a member token');
  assert.equal(auth.verifySessionToken(j.token).ok, false, 'never an owner session');
  const forged = j.token.replace(NEWT.pk, EVE.pk);
  assert.equal(auth.verifyPendingToken(forged).ok, false);
  const m = await auth.verifyMemberLogin(signed(auth, OWNER), { isMember: async () => true });
  assert.equal(auth.verifyPendingToken(m.token).ok, false, 'a member token is not a pending token');
  clock.t = NOW + 601;
  assert.equal(auth.verifyPendingToken(j.token).reason, 'expired');
  // A claim needs only a valid signature; the challenge is burned.
  clock.t = NOW;
  const ev = signed(auth, NEWT);
  assert.equal((await auth.verifyInviteLogin(ev)).pubkey, NEWT.pk);
  assert.equal((await auth.verifyInviteLogin(ev)).code, 'challenge_expired', 'one use');
});

// ── routes ───────────────────────────────────────────────────────────────

async function setup(over = {}, clock = { t: NOW }) {
  const dir = mkdtempSync(join(tmpdir(), 'invite-routes-'));
  const c = cfg(over);
  const auth = createAuth(c, { now: () => clock.t, log: silent });
  const rosterStore = createRosterStore({ dir: join(dir, 'team'), now: () => clock.t });
  const teamsState = createTeamsState({ dir: join(dir, 'teams'), now: () => clock.t });
  const teamInvites = createTeamInvites({ dir: join(dir, 'teams'), now: () => clock.t });
  const teamProfiles = { getProfiles: async (l) => Object.fromEntries(l.map((pk) => [pk, { pubkey: pk, display_name: pk === OWNER.pk ? 'Olive' : '', name: '' }])), avatar: async () => null, search: async () => [], close() {} };
  const { app } = await buildApp(c, { auth, rosterStore, teamsState, teamInvites, teamProfiles });
  const owner = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
  const OH = { authorization: `Bearer ${owner.token}` };
  await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer']]), OWNER.pk);
  const make = (payload, slug = 'alpha') => app.inject({ method: 'POST', url: `/api/projects/${slug}/invites`, headers: OH, payload });
  const claim = (link, who) => app.inject({ method: 'POST', url: '/api/team/invite/claim', payload: { ...link, event: signed(auth, who) } });
  const peek = (link) => app.inject({ method: 'POST', url: '/api/team/invite/peek', payload: link });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  return {
    app, auth, rosterStore, teamsState, teamInvites, OH, make, claim, peek, bearer, dir,
    done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('route: open invite → request → owner signs roster → approve → refresh swaps j1 for m2 (no signer)', async () => {
  const clock = { t: NOW };
  const { app, rosterStore, teamsState, OH, make, claim, peek, bearer, dir, done } = await setup({}, clock);
  try {
    const r = await make({ kind: 'open', uses: 1 });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const link = splitUrl(r.json().url);
    // Peek: display names only.
    const p = await peek(link);
    assert.equal(p.statusCode, 200);
    assert.deepEqual(p.json(), { kind: 'open', straight_in: false, project_name: 'alpha', owner_name: 'Olive' });
    // Claim by the newcomer: a pending token, no slug.
    const c = await claim(link, NEWT);
    assert.equal(c.statusCode, 200);
    assert.equal(c.json().pending, true);
    assert.equal(c.json().slug, undefined, 'no slug before approval');
    const j1 = c.json().token;
    assert.match(j1, /^j1\./);
    // j1 opens nothing else.
    for (const [method, url] of [['GET', '/api/team/me'], ['GET', '/api/team/files-ok'], ['GET', '/api/team/profiles?p=' + OWNER.pk], ['GET', '/api/projects/alpha/roster'], ['POST', '/api/team/auth/handoff']]) {
      assert.equal((await app.inject({ method, url, headers: bearer(j1) })).statusCode, 401, `${method} ${url}`);
    }
    // It may post ready, and poll status / refresh.
    assert.equal((await app.inject({ method: 'POST', url: '/api/team/ready', headers: bearer(j1) })).statusCode, 200);
    assert.ok((await teamsState.forCaller(NEWT.pk, [])).ready);
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/invite/status', headers: bearer(j1) })).json().state, 'pending');
    const wait = await app.inject({ method: 'POST', url: '/api/team/auth/refresh', headers: bearer(j1) });
    assert.equal(wait.statusCode, 409);
    assert.equal(wait.json().code, 'pending');
    // Owner sees the request.
    const list = (await app.inject({ method: 'GET', url: '/api/projects/alpha/invites', headers: OH })).json().invites;
    assert.deepEqual(list[0].requests.map((x) => x.pubkey), [NEWT.pk]);
    assert.ok(!JSON.stringify(list).includes(link.secret));
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/team/invites/pending', headers: OH })).json().pending, { alpha: 1 });
    // Approve before the roster lists them: refused.
    const decide = (approve) => app.inject({ method: 'POST', url: `/api/projects/alpha/invites/${link.id}/decide`, headers: OH, payload: { pubkey: NEWT.pk, approve } });
    assert.equal((await decide(true)).json().code, 'not_on_roster');
    await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer'], ['p', NEWT.pk, 'contributor']], NOW + 5), OWNER.pk);
    assert.equal((await decide(true)).statusCode, 200);
    clock.t = NOW + 30;
    const swap = await app.inject({ method: 'POST', url: '/api/team/auth/refresh', headers: bearer(j1) });
    assert.equal(swap.statusCode, 200);
    assert.match(swap.json().token, /^m2\./);
    const me = (await app.inject({ method: 'GET', url: '/api/team/me', headers: bearer(swap.json().token) })).json();
    assert.deepEqual(me.projects.map((x) => x.slug), ['alpha']);
    // The single-use link is spent.
    assert.equal((await peek(link)).statusCode, 404);
    // Secrets never at rest.
    assert.ok(!readFileSync(join(dir, 'teams', 'invites.json'), 'utf8').includes(link.secret));
  } finally { await done(); }
});

test('route: forwarded open link → request the owner declines → refused; revoke ends it', async () => {
  const { app, OH, make, claim, bearer, done } = await setup();
  try {
    const link = splitUrl((await make({ kind: 'open', uses: 2 })).json().url);
    const j1 = (await claim(link, EVE)).json().token;
    const d = await app.inject({ method: 'POST', url: `/api/projects/alpha/invites/${link.id}/decide`, headers: OH, payload: { pubkey: EVE.pk, approve: false } });
    assert.equal(d.statusCode, 200);
    const r = await app.inject({ method: 'POST', url: '/api/team/auth/refresh', headers: bearer(j1) });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().code, 'refused');
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/invite/status', headers: bearer(j1) })).json().state, 'refused');
    assert.equal((await app.inject({ method: 'POST', url: '/api/team/ready', headers: bearer(j1) })).statusCode, 403);
    // Revoke: the link stops working for everyone.
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/alpha/invites/${link.id}`, headers: OH })).statusCode, 200);
    assert.equal((await claim(link, NEWT)).statusCode, 404);
  } finally { await done(); }
});

test('route: named invite signs the right person straight in; anyone else gets the generic refusal', async () => {
  const { make, claim, done } = await setup();
  try {
    assert.equal((await make({ kind: 'named', pubkey: NEWT.pk })).json().code, 'not_on_roster');
    const link = splitUrl((await make({ kind: 'named', pubkey: BOB.pk })).json().url);
    const wrong = await claim(link, EVE);
    assert.equal(wrong.statusCode, 404);
    const ok = await claim(link, BOB);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.json().token, /^m2\./);
    assert.equal(ok.json().slug, 'alpha');
    assert.equal((await claim(link, BOB)).statusCode, 404, 'named invites are single use');
  } finally { await done(); }
});

test('route: every failure looks the same; owner-only management; seats are enforced', async () => {
  const { app, rosterStore, OH, make, claim, peek, bearer, auth, done } = await setup();
  try {
    const link = splitUrl((await make({ kind: 'open', ttl_sec: 3600 })).json().url);
    const bodies = new Set();
    for (const bad of [{ id: link.id, secret: 'x'.repeat(22) }, { id: 'z'.repeat(16), secret: link.secret }, { id: 'short', secret: 's' }, {}]) {
      const r = await peek(bad);
      assert.equal(r.statusCode, 404);
      bodies.add(r.body);
      const c = await claim(bad, NEWT);
      assert.equal(c.statusCode, 404);
      bodies.add(c.body);
    }
    assert.equal(bodies.size, 1, 'one refusal body');
    // A bad signature is an auth error, not an invite oracle.
    const ev = signed(auth, NEWT);
    const r = await app.inject({ method: 'POST', url: '/api/team/invite/claim', payload: { ...link, event: { ...ev, sig: '0'.repeat(128) } } });
    assert.equal(r.statusCode, 401);
    // Management is owner-only.
    const member = (await app.inject({ method: 'POST', url: '/api/team/auth/verify', payload: { event: signed(auth, BOB) } })).json().token;
    for (const [method, url] of [['POST', '/api/projects/alpha/invites'], ['GET', '/api/projects/alpha/invites'], ['GET', '/api/team/invites/pending'], ['DELETE', `/api/projects/alpha/invites/${link.id}`]]) {
      assert.equal((await app.inject({ method, url, headers: bearer(member), payload: method === 'POST' ? { kind: 'open' } : undefined })).statusCode, 401, `${method} ${url}`);
    }
    assert.equal((await make({ kind: 'open' }, 'nowhere')).statusCode, 404);
    // Fill alpha to 12 humans: no new open invite, and an outstanding link refuses.
    const ten = Array.from({ length: 10 }, () => ['p', person().pk, 'viewer']);
    await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer'], ...ten], NOW + 9), OWNER.pk);
    assert.equal((await make({ kind: 'open' })).json().code, 'full');
    assert.equal((await claim(link, NEWT)).statusCode, 404);
    assert.equal((await claim(link, OWNER)).statusCode, 200, 'the owner is always let in');
  } finally { await done(); }
});

test('route: no Teams app configured → invites cannot be created', async () => {
  const { make, done } = await setup({ teams: {} });
  try {
    assert.equal((await make({ kind: 'open' })).json().code, 'no_teams_app');
  } finally { await done(); }
  for (const [url, ok] of [['http://teams.example.test', false], ['http://127.0.0.1:8801', true], ['https://teams.example.test/', true]]) {
    const s = await setup({ teams: { app_url: url } });
    try {
      const r = await s.make({ kind: 'open' });
      assert.equal(r.statusCode === 200, ok, url);
    } finally { await s.done(); }
  }
});

test('route: the invite secret never reaches the request log', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'invite-log-'));
  const logFile = join(logDir, 'agent.log');
  const { make, claim, peek, done } = await setup({ logging: { level: 'info', destination: logFile } });
  let link;
  try {
    link = splitUrl((await make({ kind: 'open' })).json().url);
    await peek(link);
    await claim(link, NEWT);
  } finally { await done(); }
  // pino/file flushes on close.
  for (let i = 0; i < 50 && !existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  assert.ok(text.includes('/api/team/invite/claim'), 'the log was written');
  assert.ok(!text.includes(link.secret), 'secret absent from logs');
  rmSync(logDir, { recursive: true, force: true });
});

// ── ADR 0010: group links fill the team; "let them straight in" ─────────────

const grantEv = (o = {}, who = OWNER) => finalizeEvent({
  kind: INVITE_GRANT_KIND,
  created_at: o.created_at ?? Math.floor(Date.now() / 1000),
  tags: [['project', o.project ?? 'alpha'], ['invite', o.invite ?? 'G'.repeat(16)], ['role', o.role ?? 'contributor'], ['uses', String(o.uses ?? 3)], ['expiration', String(o.expiration ?? Math.floor(Date.now() / 1000) + 86400)]],
  content: '',
}, who.sk);

test('grant: only an exact, fresh, owner-signed grant verifies', () => {
  const now = Math.floor(Date.now() / 1000);
  const ctx = { ownerHex: OWNER.pk, slug: 'alpha', now };
  const g = verifyInviteGrant(grantEv(), ctx);
  assert.equal(g.ok, true);
  assert.deepEqual([g.id, g.role, g.uses], ['G'.repeat(16), 'contributor', 3]);
  assert.ok(Math.abs(g.ttl_sec - 86400) <= 1);
  assert.equal(verifyInviteGrant(grantEv({}, EVE), ctx).ok, false, 'not the owner');
  assert.equal(verifyInviteGrant(grantEv({ project: 'beta' }), ctx).ok, false, 'other project');
  assert.equal(verifyInviteGrant(grantEv({ role: 'owner' }), ctx).ok, false, 'bad role');
  assert.equal(verifyInviteGrant(grantEv({ uses: 12 }), ctx).ok, false, 'too many uses');
  assert.equal(verifyInviteGrant(grantEv({ created_at: now - 3600 }), ctx).ok, false, 'stale');
  assert.equal(verifyInviteGrant(grantEv({ expiration: now + 60 }), ctx).ok, false, 'too short');
  assert.equal(verifyInviteGrant(grantEv({ invite: 'bad' }), ctx).ok, false, 'bad id');
  const ev = grantEv();
  assert.equal(verifyInviteGrant({ ...ev, tags: [...ev.tags.slice(0, 3), ['uses', '9'], ev.tags[4]] }, ctx).ok, false, 'tampered');
  assert.equal(verifyInviteGrant({ ...ev, kind: ROSTER_KIND }, ctx).ok, false, 'wrong kind');
});

test('route: a group link defaults to the seats left, so the whole team can use it', async () => {
  const { app, OH, make, claim, done } = await setup();
  try {
    const r = await make({ kind: 'open' });
    const link = splitUrl(r.json().url);
    const list = (await app.inject({ method: 'GET', url: '/api/projects/alpha/invites', headers: OH })).json().invites;
    assert.equal(list[0].uses_left, 10, '12 minus owner and Bob');
    assert.equal(list[0].auto, false);
    assert.equal((await claim(link, NEWT)).json().pending, true);
    assert.equal((await claim(link, EVE)).json().pending, true, 'a second person can ask too');
  } finally { await done(); }
});

test('route: straight-in link admits each claimer at once until its uses run out', async () => {
  const { app, rosterStore, OH, make, claim, bearer, peek, done } = await setup();
  try {
    // Unsigned or mismatched grants are refused.
    assert.equal((await make({ kind: 'open', auto: true })).json().code, 'bad_grant');
    assert.equal((await make({ kind: 'open', auto: true, grant: grantEv({ project: 'beta' }) })).json().code, 'bad_grant');
    const grant = grantEv({ uses: 2, invite: 'H'.repeat(16) });
    const r = await make({ kind: 'open', auto: true, grant });
    assert.equal(r.statusCode, 200);
    const link = splitUrl(r.json().url);
    assert.equal(link.id, 'H'.repeat(16), 'the id the owner signed');
    assert.equal((await peek(link)).json().straight_in, true);
    assert.equal((await make({ kind: 'open', auto: true, grant })).json().code, 'bad_grant', 'one grant, one link');
    // Claim: straight to a member token, no pending step.
    const c = await claim(link, NEWT);
    assert.equal(c.statusCode, 200);
    assert.match(c.json().token, /^m2\./);
    assert.equal(c.json().slug, 'alpha');
    const me = (await app.inject({ method: 'GET', url: '/api/team/me', headers: bearer(c.json().token) })).json();
    assert.deepEqual(me.projects.map((x) => [x.slug, x.role]), [['alpha', 'contributor']]);
    // The owner's roster read lists them (so the owner's client adds them to the chat).
    const ro = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: OH })).json();
    assert.ok(ro.roster.members.some((m) => m.pubkey === NEWT.pk && m.via === 'invite'));
    assert.ok(ro.projection.cordn.includes(NEWT.pk));
    // Claiming again as the same person signs in without spending a use.
    assert.equal((await claim(link, NEWT)).statusCode, 200);
    assert.equal((await claim(link, EVE)).statusCode, 200);
    assert.equal((await peek(link)).statusCode, 404, 'two uses spent');
    assert.equal((await claim(link, person())).statusCode, 404);
    // Never a waiting request on a straight-in link.
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/team/invites/pending', headers: OH })).json().pending, {});
    // The owner's next signed list absorbs them; one left off is removed.
    const later = NOW + 5;
    await rosterStore.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'maintainer'], ['p', NEWT.pk, 'contributor']], later), OWNER.pk);
    const after = (await rosterStore.get('alpha')).roster.members.map((m) => m.pubkey);
    assert.ok(after.includes(NEWT.pk) && !after.includes(EVE.pk));
    assert.equal((await rosterStore.get('alpha')).admitted, undefined, 'nothing left admitted');
  } finally { await done(); }
});

test('roster store: admitted members respect the cap and survive an older signed list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admit-'));
  const clock = { t: NOW };
  try {
    const s = createRosterStore({ dir, now: () => clock.t });
    // A project with no signed roster yet.
    assert.equal((await s.admit('solo', { pubkey: NEWT.pk, role: 'viewer', invite: 'x', ownerHex: OWNER.pk })).ok, true);
    const g = await s.get('solo');
    assert.deepEqual(g.roster.members.map((m) => m.role), ['owner', 'viewer']);
    assert.equal(g.event, null);
    assert.deepEqual((await s.memberships(NEWT.pk)).map((m) => m.slug), ['solo']);
    assert.equal((await s.admit('solo', { pubkey: OWNER.pk, role: 'viewer', ownerHex: OWNER.pk })).already, true);
    assert.equal((await s.admit('solo', { pubkey: 'zz', role: 'viewer', ownerHex: OWNER.pk })).code, 'bad_request');
    // Admitted after the owner's list was signed: kept.
    clock.t = NOW + 10;
    await s.admit('alpha', { pubkey: EVE.pk, role: 'contributor', ownerHex: OWNER.pk });
    await s.put('alpha', rosterEv('alpha', [['p', BOB.pk, 'viewer']], NOW + 5), OWNER.pk);
    assert.ok((await s.get('alpha')).roster.members.some((m) => m.pubkey === EVE.pk));
    // Cap: 12 humans including the owner.
    const ten = Array.from({ length: 10 }, () => ['p', person().pk, 'viewer']);
    await s.put('full', rosterEv('full', ten, NOW + 6), OWNER.pk);
    assert.equal((await s.admit('full', { pubkey: NEWT.pk, role: 'viewer', ownerHex: OWNER.pk })).ok, true);
    assert.equal((await s.admit('full', { pubkey: EVE.pk, role: 'viewer', ownerHex: OWNER.pk })).code, 'full');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
