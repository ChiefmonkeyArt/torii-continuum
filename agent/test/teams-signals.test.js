/**
 * Teams membership signals, profiles and the hostile-input fetch guard
 * (docs/adr-teams-membership-signals.md).
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { createTeamsState, CLAIM_TTL_SEC } from '../lib/teams-state.mjs';
import { createTeamProfiles, parseKey, parseProfile } from '../lib/team-profiles.mjs';
import { checkUrl, guardedLookup, safeGet, sniffImage } from '../lib/safe-fetch.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const NOW = 1_700_000_000;
const silent = { info() {}, warn() {}, error() {} };
const person = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
const OWNER = person();
const BOB = person();
const VIC = person();
const EVE = person();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const kind0 = (who, content, created_at = NOW) => finalizeEvent({ kind: 0, created_at, tags: [], content: JSON.stringify(content) }, who.sk);

// ── teams-state ───────────────────────────────────────────────────────────

test('teams-state: ready, claim/set/release, added filtered to roster, 0600 file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teams-state-'));
  const clock = { t: NOW };
  try {
    const s = createTeamsState({ dir, now: () => clock.t });
    assert.equal((await s.setReady('nothex')).ok, false);
    assert.equal((await s.setReady(BOB.pk)).ok, true);
    assert.equal(statSync(s.file).mode & 0o777, 0o600);

    assert.equal((await s.chatOp('alpha', 'claim')).ok, true);
    assert.equal((await s.chatOp('alpha', 'claim')).code, 'claimed', 'a second device sees the claim');
    clock.t += CLAIM_TTL_SEC;
    assert.equal((await s.chatOp('alpha', 'claim')).ok, true, 'a stale claim can be taken over');
    assert.equal((await s.chatOp('alpha', 'set', 'bad id!')).code, 'bad_group_id');
    assert.equal((await s.chatOp('alpha', 'set', 'g1')).ok, true);
    assert.equal((await s.chatOp('alpha', 'set', 'g1')).ok, true, 'set is idempotent');
    assert.equal((await s.chatOp('alpha', 'set', 'g2')).code, 'exists');
    assert.equal((await s.chatOp('alpha', 'claim')).code, 'exists');
    await s.chatOp('alpha', 'release');
    assert.equal((await s.forRoster('alpha', [])).chat.group_id, 'g1', 'release never drops a set chat');
    await s.chatOp('beta', 'claim');
    await s.chatOp('beta', 'release');
    assert.equal((await s.forRoster('beta', [])).chat, null);

    const onRoster = (p) => p === BOB.pk || p === VIC.pk;
    assert.equal((await s.markMembers('alpha', { added: ['x'] })).ok, false);
    await s.markMembers('alpha', { added: [BOB.pk, VIC.pk, EVE.pk] }, onRoster);
    await s.markMembers('alpha', { removed: [VIC.pk] }, onRoster);
    const r = await s.forRoster('alpha', [OWNER.pk, BOB.pk, VIC.pk]);
    assert.deepEqual(r.added, [BOB.pk]);
    assert.deepEqual(r.ready, [BOB.pk]);
    assert.deepEqual(r.chat, { group_id: 'g1', claimed: false });
    // Only roster members' signals are visible.
    assert.deepEqual((await s.forRoster('alpha', [VIC.pk])).ready, []);
    const me = await s.forCaller(BOB.pk, ['alpha', 'beta']);
    assert.deepEqual(me, { ready: true, projects: { alpha: { chat: true, added: true }, beta: { chat: false, added: false } } });
    // Concurrent writes are serialised; nothing is lost.
    await Promise.all([VIC, EVE, OWNER].map((w) => s.setReady(w.pk)));
    assert.equal((await s.forRoster('alpha', [OWNER.pk, BOB.pk, VIC.pk, EVE.pk])).ready.length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── safe-fetch ────────────────────────────────────────────────────────────

test('safe-fetch: URL rules refuse http, ports, credentials and private hosts', () => {
  assert.ok(checkUrl('https://example.com/a.png'));
  assert.ok(checkUrl('https://example.com:443/a.png'));
  for (const bad of ['http://example.com/a', 'https://example.com:8443/a', 'https://u:p@example.com/a',
    'https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://[::1]/a', 'https://[::ffff:10.0.0.1]/a',
    'https://localhost/a', 'https://169.254.169.254/latest', 'file:///etc/passwd', 'not a url']) {
    assert.equal(checkUrl(bad), null, bad);
  }
});

test('safe-fetch: the connect-time lookup refuses names that resolve to private addresses', async () => {
  const r = await new Promise((res) => guardedLookup('localhost', { all: true }, (err, a) => res({ err, a })));
  assert.equal(r.err?.code, 'EUNSAFEADDR');
});

function fakeRequest(routes) {
  const seen = [];
  const request = (url, opts, cb) => {
    seen.push(String(url));
    assert.equal(opts.lookup, guardedLookup, 'every request uses the guarded lookup');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const r = routes[String(url)] || { status: 404 };
      const res = new EventEmitter();
      res.statusCode = r.status;
      res.headers = r.headers || {};
      res.resume = () => {};
      res.destroy = () => {};
      cb(res);
      setImmediate(() => { if (r.body) res.emit('data', r.body); res.emit('end'); });
    });
    return req;
  };
  return { request, seen };
}

test('safe-fetch: redirects are re-checked, capped, and bodies are size-limited', async () => {
  const f = fakeRequest({
    'https://a.example/x': { status: 302, headers: { location: 'https://10.0.0.5/y' } },
    'https://b.example/x': { status: 302, headers: { location: '/z' } },
    'https://b.example/z': { status: 200, body: PNG, headers: { 'content-type': 'image/png' } },
    'https://c.example/big': { status: 200, body: Buffer.alloc(2048) },
    'https://d.example/1': { status: 302, headers: { location: 'https://d.example/1' } },
  });
  assert.equal((await safeGet('https://a.example/x', { request: f.request })).reason, 'unsafe url');
  const ok = await safeGet('https://b.example/x', { request: f.request });
  assert.equal(ok.ok, true);
  assert.equal(sniffImage(ok.body), 'image/png');
  assert.equal((await safeGet('https://c.example/big', { request: f.request, maxBytes: 1024 })).reason, 'too large');
  assert.equal((await safeGet('https://d.example/1', { request: f.request })).reason, 'too many redirects');
  assert.equal(f.seen.filter((u) => u === 'https://d.example/1').length, 4, 'first request + 3 redirects');
});

test('safe-fetch: image sniffing accepts raster formats only', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(12).fill(0)])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>')), null);
});

// ── profiles ──────────────────────────────────────────────────────────────

function fakeRelays({ profiles = [], follows = null, search = [] } = {}) {
  const calls = [];
  const query = async (relays, filter) => {
    calls.push({ relays, filter });
    if (filter.search) return search;
    if (filter.kinds[0] === 3) return follows ? [follows] : [];
    return profiles.filter((e) => filter.authors.includes(e.pubkey));
  };
  return { query, calls };
}

test('profiles: newest kind-0 wins, fields are cleaned, results are cached', async () => {
  const relays = fakeRelays({ profiles: [
    kind0(BOB, { name: 'old' }, NOW - 10),
    kind0(BOB, { name: 'bob\u202e', display_name: 'Bob B', nip05: 'bob@example.com', picture: 'https://img.example/b.png' }),
    kind0(VIC, { name: 'vic', picture: 'javascript:alert(1)' }),
  ] });
  const p = createTeamProfiles({ query: relays.query, searchRelays: [] });
  const out = await p.getProfiles([BOB.pk, VIC.pk, EVE.pk, 'junk']);
  assert.deepEqual(Object.keys(out).sort(), [BOB.pk, VIC.pk, EVE.pk].sort());
  assert.equal(out[BOB.pk].name, 'bob');
  assert.equal(out[BOB.pk].display_name, 'Bob B');
  assert.equal(out[BOB.pk].avatar, true);
  assert.equal(out[BOB.pk].event.content.includes('Bob B'), true, 'the signed event is returned unmodified');
  assert.equal(out[VIC.pk].avatar, false, 'non-https pictures are ignored');
  assert.equal(out[EVE.pk].event, null);
  const n = relays.calls.length;
  await p.getProfiles([BOB.pk, EVE.pk]);
  assert.equal(relays.calls.length, n, 'hits and misses are cached');
  assert.equal(parseProfile({ content: '{bad' }).name, '');
});

test('profiles: avatars come only from the fetched kind-0 and must be raster images', async () => {
  const relays = fakeRelays({ profiles: [
    kind0(BOB, { picture: 'https://img.example/b.png' }),
    kind0(VIC, { picture: 'https://img.example/v.svg' }),
  ] });
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    return url.endsWith('.png') ? { ok: true, body: PNG } : { ok: true, body: Buffer.from('<svg></svg>              ') };
  };
  const p = createTeamProfiles({ query: relays.query, fetcher });
  const a = await p.avatar(BOB.pk);
  assert.equal(a.type, 'image/png');
  assert.equal(await p.avatar(VIC.pk), null, 'SVG is refused');
  assert.equal(await p.avatar(EVE.pk), null);
  assert.equal(await p.avatar('../../etc'), null);
  await p.avatar(BOB.pk);
  assert.deepEqual(fetched, ['https://img.example/b.png', 'https://img.example/v.svg'], 'avatars are cached');
});

test('people search: exact npub, NIP-05, follows by name, then NIP-50', async () => {
  const relays = fakeRelays({
    profiles: [kind0(BOB, { name: 'bobby' }), kind0(VIC, { display_name: 'Victoria' }), kind0(EVE, { name: 'eve' })],
    follows: finalizeEvent({ kind: 3, created_at: NOW, tags: [['p', BOB.pk], ['p', VIC.pk]], content: '' }, OWNER.sk),
    search: [kind0(EVE, { name: 'vicious eve' }), kind0(person(), {})],
  });
  const fetcher = async (url) => (url === 'https://example.com/.well-known/nostr.json?name=bob'
    ? { ok: true, body: Buffer.from(JSON.stringify({ names: { bob: BOB.pk } })) } : { ok: false });
  const p = createTeamProfiles({ query: relays.query, fetcher });

  assert.equal(parseKey(nip19.npubEncode(BOB.pk)), BOB.pk);
  assert.equal(parseKey(`nostr:${nip19.nprofileEncode({ pubkey: VIC.pk })}`), VIC.pk);
  assert.equal(parseKey('npub1nope'), null);

  const byKey = await p.search(nip19.npubEncode(EVE.pk), OWNER.pk);
  assert.deepEqual(byKey.map((r) => [r.pubkey, r.name, r.exact]), [[EVE.pk, 'eve', true]]);
  assert.equal(byKey[0].event, undefined, 'search results carry no events');
  assert.equal((await p.search('Bob@Example.com', OWNER.pk))[0].pubkey, BOB.pk);

  const byName = await p.search('vic', OWNER.pk);
  assert.deepEqual(byName.map((r) => [r.pubkey, r.follows]), [[VIC.pk, true], [EVE.pk, false]],
    'follows first; nameless NIP-50 hits dropped');
  assert.deepEqual(await p.search('x', OWNER.pk), []);
});

// ── routes ────────────────────────────────────────────────────────────────

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
const signed = (auth, who) => {
  const { challenge } = auth.issueChallenge('198.51.100.4');
  return finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, who.sk);
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'teams-routes-'));
  const c = cfg();
  const auth = createAuth(c, { now: () => NOW, log: silent });
  const rosterStore = createRosterStore({ dir: join(dir, 'team'), now: () => NOW });
  const teamsState = createTeamsState({ dir: join(dir, 'teams'), now: () => NOW });
  const relays = fakeRelays({ profiles: [kind0(BOB, { name: 'bob', picture: 'https://img.example/b.png' })] });
  const teamProfiles = createTeamProfiles({ query: relays.query, fetcher: async () => ({ ok: true, body: PNG }) });
  const { app } = await buildApp(c, { auth, rosterStore, teamsState, teamProfiles });
  const owner = await auth.verifyChallenge(signed(auth, OWNER), '198.51.100.4');
  const OH = { authorization: `Bearer ${owner.token}` };
  const rev = finalizeEvent({ kind: ROSTER_KIND, created_at: NOW, tags: [['d', 'alpha'], ['p', BOB.pk, 'maintainer'], ['p', VIC.pk, 'viewer']], content: '' }, OWNER.sk);
  await rosterStore.put('alpha', rev, OWNER.pk);
  const H = async (who) => {
    const r = await app.inject({ method: 'POST', url: '/api/team/auth/verify', payload: { event: signed(auth, who) } });
    return { authorization: `Bearer ${r.json().token}` };
  };
  return { app, OH, H, done: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('route: ready, chat claim/set, added flow through roster and /api/team/me', async () => {
  const { app, OH, H, done } = await setup();
  try {
    const bob = await H(BOB);
    const own = await H(OWNER); // the owner's Teams client uses an m1 token
    assert.equal((await app.inject({ method: 'POST', url: '/api/team/ready' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/team/ready', headers: bob })).statusCode, 200);

    const chat = (h, body) => app.inject({ method: 'POST', url: '/api/projects/alpha/teams/chat', headers: h, payload: body });
    assert.equal((await chat(bob, { op: 'claim' })).statusCode, 403, 'a maintainer cannot manage the chat record');
    assert.equal((await chat(own, { op: 'nope' })).statusCode, 400);
    assert.equal((await chat(own, { op: 'claim' })).statusCode, 200);
    const second = await chat(OH, { op: 'claim' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'claimed');
    assert.equal((await chat(own, { op: 'set', group_id: 'grp1' })).statusCode, 200);
    assert.equal((await chat(own, { op: 'set', group_id: 'grp2' })).statusCode, 409);
    const other = (h) => app.inject({ method: 'POST', url: '/api/projects/nothere/teams/chat', headers: h, payload: { op: 'claim' } });
    assert.equal((await other(own)).statusCode, 403, 'm1 tokens get no project oracle');
    assert.equal((await other(OH)).statusCode, 404);

    const mark = (h, body) => app.inject({ method: 'POST', url: '/api/projects/alpha/teams/members', headers: h, payload: body });
    assert.equal((await mark(bob, { added: [BOB.pk] })).statusCode, 403);
    assert.equal((await mark(own, { added: [BOB.pk, EVE.pk] })).statusCode, 200);

    const roster = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: bob })).json();
    assert.deepEqual(roster.teams, { chat: { group_id: 'grp1', claimed: false }, ready: [BOB.pk], added: [BOB.pk] },
      'strangers never appear, even if posted as added');
    const me = (await app.inject({ method: 'GET', url: '/api/team/me', headers: bob })).json();
    assert.equal(me.ready, true);
    assert.deepEqual(me.projects.map((p) => [p.slug, p.chat, p.added]), [['alpha', true, true]]);
  } finally { await done(); }
});

test('route: profiles and avatar for team callers; people search is owner-session only', async () => {
  const { app, OH, H, done } = await setup();
  try {
    const bob = await H(BOB);
    assert.equal((await app.inject({ method: 'GET', url: `/api/team/profiles?p=${BOB.pk}` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/profiles?p=zz', headers: bob })).statusCode, 400);
    const pr = await app.inject({ method: 'GET', url: `/api/team/profiles?p=${BOB.pk},${VIC.pk}`, headers: bob });
    assert.equal(pr.json().profiles[BOB.pk].name, 'bob');

    const av = await app.inject({ method: 'GET', url: `/api/team/avatar/${BOB.pk}`, headers: bob });
    assert.equal(av.statusCode, 200);
    assert.equal(av.headers['content-type'], 'image/png');
    assert.equal(av.headers['x-content-type-options'], 'nosniff');
    assert.match(av.headers['content-security-policy'], /sandbox/);
    assert.match(av.headers['cache-control'], /^private/);
    assert.equal((await app.inject({ method: 'GET', url: `/api/team/avatar/${VIC.pk}`, headers: bob })).statusCode, 404);

    const q = encodeURIComponent(nip19.npubEncode(BOB.pk));
    assert.equal((await app.inject({ method: 'GET', url: `/api/team/people?q=${q}`, headers: bob })).statusCode, 401,
      'members cannot search people');
    const ppl = await app.inject({ method: 'GET', url: `/api/team/people?q=${q}`, headers: OH });
    assert.equal(ppl.statusCode, 200);
    assert.equal(ppl.json().results[0].pubkey, BOB.pk);
    assert.equal((await app.inject({ method: 'GET', url: '/api/team/people?q=a', headers: OH })).statusCode, 400);
  } finally { await done(); }
});
