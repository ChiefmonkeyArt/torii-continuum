/**
 * Project AI member (docs/adr-team-ai-member.md): the answer rules, limits,
 * prompt caps, settings, config, the vendored Cordn bundle and the routes.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
  AI_NAME, MAX_AGE_SEC, CONTEXT_MESSAGES, CONTEXT_CHARS, slugOfGroup, mentions, decide,
  createRateLimiter, plainText, buildPrompt, modelLabel, createAiSettings, createTeamAi,
} from '../lib/team-ai.mjs';
import { normalizeTeamsRelay } from '../core/config.mjs';
import { ROSTER_KIND, createRosterStore } from '../lib/roster.mjs';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000;
const key = () => getPublicKey(generateSecretKey());
const ownerSk = generateSecretKey();
const OWNER = getPublicKey(ownerSk);
const MAINT = key();
const CONTRIB = key();
const BOT = key();
const AI = key();
const AI_NPUB = nip19.npubEncode(AI);
const ROSTER = {
  owner: OWNER,
  members: [
    { pubkey: OWNER, role: 'owner' },
    { pubkey: MAINT, role: 'maintainer' },
    { pubkey: CONTRIB, role: 'contributor' },
    { pubkey: BOT, role: 'agent', of: OWNER },
    { pubkey: AI, role: 'agent', of: OWNER },
  ],
};
const msg = (over = {}) => ({
  id: 'm1', kind: 9, direction: 'inbound', sender: MAINT, createdAt: NOW - 5, cursor: 10,
  content: `nostr:${AI_NPUB} what is next?`, tags: [], ...over,
});
const ask = (over = {}, m = {}) => decide({
  msg: msg(m), aiHex: AI, aiNpub: AI_NPUB, roster: ROSTER, ownerHex: OWNER,
  adminPubkeys: [OWNER], now: NOW, seen: new Set(), ...over,
});

test('decide: owners and maintainers get an answer', () => {
  assert.deepEqual(ask(), { ok: true });
  assert.deepEqual(ask({}, { sender: OWNER }), { ok: true });
  assert.deepEqual(ask({}, { content: 'hi', tags: [['p', AI]] }), { ok: true });
});

test('decide: everyone else, and anything off, is skipped', () => {
  assert.equal(ask({}, { sender: CONTRIB }).why, 'role');
  assert.equal(ask({}, { sender: BOT }).why, 'not_person');
  assert.equal(ask({}, { sender: key() }).why, 'not_person');
  assert.equal(ask({}, { sender: AI }).why, 'not_inbound');
  assert.equal(ask({}, { direction: 'outbound' }).why, 'not_inbound');
  assert.equal(ask({}, { kind: 7 }).why, 'not_text');
  assert.equal(ask({}, { content: 'no mention' }).why, 'not_mentioned');
  assert.equal(ask({ seen: new Set(['m1']) }).why, 'seen');
  assert.equal(ask({}, { createdAt: NOW - MAX_AGE_SEC - 1 }).why, 'old');
  assert.equal(ask({ roster: null }).why, 'no_roster');
  assert.equal(ask({ ownerHex: key() }).why, 'no_roster');
  assert.equal(ask({ adminPubkeys: [MAINT] }).why, 'not_owner_chat');
  assert.equal(ask({ adminPubkeys: undefined }).why, 'not_owner_chat');
  const unlisted = { ...ROSTER, members: ROSTER.members.filter((m) => m.pubkey !== AI) };
  assert.equal(ask({ roster: unlisted }).why, 'not_listed');
});

test('mentions: npub text or p tag only', () => {
  assert.equal(mentions({ content: `hey nostr:${AI_NPUB}` }, AI, AI_NPUB), true);
  assert.equal(mentions({ content: 'hey', tags: [['p', AI]] }, AI, AI_NPUB), true);
  assert.equal(mentions({ content: AI_NPUB, tags: [['e', AI]] }, AI, AI_NPUB), false);
});

test('rate limiter: per minute and per day', () => {
  let t = 0;
  const l = createRateLimiter({ perMinute: 2, perDay: 3, now: () => t });
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), true);
  assert.equal(l.take('a'), false);
  assert.equal(l.take('b'), true);
  t = 61_000;
  assert.equal(l.take('a'), true);
  t = 130_000;
  assert.equal(l.take('a'), false);
  t = 86_400_001 + 61_000;
  assert.equal(l.take('a'), true);
});

test('slugOfGroup reads the project marker only', () => {
  assert.equal(slugOfGroup({ description: 'torii:project=website' }), 'website');
  assert.equal(slugOfGroup({ description: 'x torii:project=a-1 y' }), 'a-1');
  assert.equal(slugOfGroup({ description: 'torii:project=Bad' }), null);
  assert.equal(slugOfGroup(null), null);
});

test('plainText names mentions and drops other nostr refs', () => {
  const names = (pk) => (pk === MAINT ? 'Bekka' : '');
  const text = plainText(`nostr:${AI_NPUB} ask nostr:${nip19.npubEncode(MAINT)} nostr:nevent1abc`, names, AI_NPUB);
  assert.equal(text, `@${AI_NAME} ask @Bekka`);
});

test('buildPrompt keeps the newest lines within the caps', () => {
  const history = Array.from({ length: 50 }, (_, i) => ({ id: `h${i}`, kind: 9, sender: CONTRIB, cursor: i, content: 'x'.repeat(900) }));
  history.push({ id: 'r', kind: 7, sender: CONTRIB, cursor: 9, content: '+' });
  const m = msg({ cursor: 100 });
  const out = buildPrompt({ slug: 'website', history: [...history, m], msg: m, aiHex: AI, aiNpub: AI_NPUB, names: () => 'Carol' });
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /website/);
  const lines = out[1].content.split('\n').slice(1);
  assert.ok(lines.length <= CONTEXT_MESSAGES);
  assert.ok(lines.join('').length <= CONTEXT_CHARS);
  assert.ok(lines.every((l) => l.startsWith('Carol: ')));
  assert.match(out.at(-1).content, /what is next/);
  assert.equal(buildPrompt({ slug: 's', history: [], msg: m, aiHex: AI, aiNpub: AI_NPUB, names: () => '' }).length, 2);
});

test('modelLabel says where the answer comes from', () => {
  assert.equal(modelLabel('local', { localModel: 'llama3.2:1b' }), 'Local · llama3.2:1b');
  assert.equal(modelLabel('routstr', { routstrModel: 'gpt-4o-mini' }), 'Routstr · gpt-4o-mini');
  assert.equal(modelLabel('routstr', {}), 'Routstr · auto');
});

test('settings: default Local, saved per project, private file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-ai-'));
  try {
    const s = createAiSettings({ dir: join(dir, 'ai') });
    assert.deepEqual(await s.get('web'), { model: 'local' });
    assert.equal((await s.set('web', { model: 'nope' })).ok, false);
    assert.equal((await s.set('web', { model: 'routstr' })).ok, true);
    assert.deepEqual(await createAiSettings({ dir: join(dir, 'ai') }).get('web'), { model: 'routstr' });
    assert.equal(statSync(join(dir, 'ai', 'settings.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'ai')).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: teams relay is wss, or ws on loopback only', () => {
  assert.equal(normalizeTeamsRelay('wss://relay.example/'), 'wss://relay.example');
  assert.equal(normalizeTeamsRelay('ws://127.0.0.1:7777'), 'ws://127.0.0.1:7777');
  assert.equal(normalizeTeamsRelay('ws://localhost:7777'), 'ws://localhost:7777');
  assert.equal(normalizeTeamsRelay('ws://relay.example'), null);
  assert.equal(normalizeTeamsRelay('https://relay.example'), null);
  assert.equal(normalizeTeamsRelay(7), null);
});

test('vendored Cordn bundle: pinned version and the two exports', async () => {
  const file = join(HERE, '..', 'vendor', 'cordn-session.mjs');
  const head = readFileSync(file, 'utf8').slice(0, 300);
  assert.match(head, /^\/\/ @cordn\/cli 0\.10\.0 /);
  assert.ok(statSync(file).size < 2_000_000);
  const lib = await import(file);
  assert.equal(typeof lib.openPersistentSession, 'function');
  assert.equal(typeof lib.welcomeIdentifier, 'function');
});

// ── createTeamAi with a fake session ───────────────────────────────────────
function memSecrets() {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
const silent = { info() {}, warn() {}, error() {} };

function fakeSession({ admins = [OWNER] } = {}) {
  const sent = [];
  let handler = null;
  const group = { metadata: { name: 'website', description: 'torii:project=website', adminPubkeys: admins } };
  const session = {
    getGroup: () => group,
    getLastResortKeyPackage: () => null,
    generateKeyPackage: async () => {},
    onGroupEvent: (h) => { handler = h; },
    watchAllGroups: async () => {},
    fetchWelcomes: async () => [],
    listMessages: () => [],
    sendMessage: async (alias, text) => { sent.push({ alias, text }); },
  };
  return {
    sent, session,
    emit: (m) => handler({ type: 'messages-ingested', groupAlias: 'g1', received: [m] }),
    loadSession: async () => ({
      openPersistentSession: async () => ({ session, persist: async () => {}, close: async () => {} }),
      welcomeIdentifier: (w) => w,
    }),
  };
}

async function liveAi({ ollama = true, router, admins } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'team-ai-live-'));
  const fake = fakeSession({ admins });
  const ready = [];
  let rosterAi = null;
  const ai = createTeamAi({
    cfg: { teams: { coordinator: 'c'.repeat(64), relay: 'ws://127.0.0.1:7777' }, ollama: { enabled: ollama, model: 'llama3.2:1b' } },
    secretStore: memSecrets(),
    rosterStore: { get: async () => ({ roster: rosterAi }) },
    teamsState: { setReady: async (pk) => { ready.push(pk); } },
    router: router || { chat: async () => ({ ok: true, content: ' Ship on Friday. ', provider: 'ollama' }) },
    chatModel: () => 'gpt-4o-mini',
    dir, log: silent, loadSession: fake.loadSession, now: () => NOW, pollMs: 60_000,
    profiles: async (pks) => Object.fromEntries(pks.map((pk) => [pk, { pubkey: pk, display_name: pk === MAINT ? 'Bekka' : '' }])),
  });
  await ai.start();
  const me = ai.pubkey;
  rosterAi = { owner: OWNER, members: [{ pubkey: OWNER, role: 'owner' }, { pubkey: MAINT, role: 'maintainer' }, { pubkey: CONTRIB, role: 'contributor' }, { pubkey: me, role: 'agent', of: OWNER }] };
  const m = (over) => ({ id: Math.random().toString(36), kind: 9, direction: 'inbound', sender: MAINT, createdAt: NOW, cursor: 1, content: `nostr:${nip19.npubEncode(me)} when?`, tags: [], ...over });
  const flush = () => new Promise((r) => setTimeout(r, 30));
  return { ai, fake, ready, me, m, flush, done: async () => { await ai.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('createTeamAi: joins ready, answers a maintainer once, ignores a contributor', async () => {
  const calls = [];
  const t = await liveAi({ router: { chat: async (a) => { calls.push(a); return { ok: true, content: 'Friday.', provider: 'ollama' }; } } });
  try {
    assert.deepEqual(t.ready, [t.me]);
    const q = t.m();
    t.fake.emit(q); t.fake.emit(q);
    t.fake.emit(t.m({ sender: CONTRIB }));
    await t.flush();
    assert.deepEqual(t.fake.sent, [{ alias: 'g1', text: 'Friday.' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].strategy, 'ollama_only');
    assert.equal(calls[0].skill, 'chat');
    assert.match(calls[0].messages.at(-1).content, /^Bekka: /);
    const info = await t.ai.info('website');
    assert.equal(info.enabled, true);
    assert.equal(info.ready, true);
    assert.equal(info.label, 'Local · llama3.2:1b');
    const p = t.ai.profileEvent();
    assert.equal(verifyEvent(p), true);
    assert.equal(p.pubkey, t.me);
  } finally { await t.done(); }
});

test('createTeamAi: Routstr when chosen; a fixed note when Local is off', async () => {
  const calls = [];
  const t = await liveAi({ ollama: false, router: { chat: async (a) => { calls.push(a); return { ok: true, content: 'ok', provider: 'routstr' }; } } });
  try {
    t.fake.emit(t.m()); await t.flush();
    assert.equal(calls.length, 0);
    assert.match(t.fake.sent[0].text, /local model is off/);
    await t.ai.settings.set('website', { model: 'routstr' });
    t.fake.emit(t.m()); await t.flush();
    assert.equal(calls[0].strategy, 'routstr_only');
    assert.equal((await t.ai.info('website')).label, 'Routstr · gpt-4o-mini');
  } finally { await t.done(); }
});

test('createTeamAi: silent in a chat the owner does not run', async () => {
  const t = await liveAi({ admins: [MAINT] });
  try { t.fake.emit(t.m()); await t.flush(); assert.equal(t.fake.sent.length, 0); } finally { await t.done(); }
});

test('createTeamAi: off without coordinator and relay', async () => {
  const ai = createTeamAi({ cfg: { teams: {} }, secretStore: memSecrets(), rosterStore: {}, teamsState: {}, router: {}, dir: tmpdir(), log: silent, loadSession: async () => { throw new Error('must not load'); } });
  await ai.start();
  const i = await ai.info('website');
  assert.equal(i.enabled, false);
  assert.equal(i.pubkey, null);
});

// ── routes ────────────────────────────────────────────────────────────────
function cfg() {
  return {
    session_secret: 'c'.repeat(64), session_ttl_sec: 86400, session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(OWNER), admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false, max_challenges: 1000 }, cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' }, ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' }, logging: { level: 'silent' }, _config_path: null,
  };
}

test('routes: GET/PUT ai is owner-only; the roster names a listed AI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-ai-routes-'));
  const c = cfg();
  const auth = createAuth(c, { now: () => NOW, log: silent });
  const rosterStore = createRosterStore({ dir, now: () => NOW });
  const teamAi = createTeamAi({
    cfg: { teams: { coordinator: 'c'.repeat(64), relay: 'ws://127.0.0.1:7777' }, ollama: { enabled: false, model: 'm' } },
    secretStore: memSecrets(), rosterStore, teamsState: {}, router: {}, chatModel: () => 'gpt-x',
    dir: join(dir, 'ai'), log: silent,
  });
  const { app } = await buildApp(c, { auth, rosterStore, teamAi });
  try {
    const { challenge } = auth.issueChallenge('203.0.113.9');
    const login = await auth.verifyChallenge(finalizeEvent({ kind: 22242, created_at: NOW, tags: [['challenge', challenge]], content: challenge }, ownerSk), '203.0.113.9');
    const H = { authorization: `Bearer ${login.token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/alpha/ai' })).statusCode, 401);
    const g = (await app.inject({ method: 'GET', url: '/api/projects/alpha/ai', headers: H })).json();
    assert.equal(g.enabled, true);
    assert.equal(g.model, 'local');
    assert.equal(g.local_available, false);
    assert.match(g.npub, /^npub1/);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/projects/alpha/ai', headers: H, payload: { model: 'x' } })).statusCode, 400);
    const p = (await app.inject({ method: 'PUT', url: '/api/projects/alpha/ai', headers: H, payload: { model: 'routstr' } })).json();
    assert.equal(p.label, 'Routstr · gpt-x');
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/Bad!/ai', headers: H })).statusCode, 400);

    const put = (tags, at) => app.inject({ method: 'PUT', url: '/api/projects/alpha/roster', headers: H, payload: { event: finalizeEvent({ kind: ROSTER_KIND, created_at: at, tags: [['d', 'alpha'], ...tags], content: '' }, ownerSk) } });
    assert.equal((await put([['p', MAINT, 'maintainer']], NOW - 10)).statusCode, 200);
    let r = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: H })).json();
    assert.equal(r.ai, undefined);
    assert.equal((await put([['p', MAINT, 'maintainer'], ['p', g.pubkey, 'agent', OWNER]], NOW - 5)).statusCode, 200);
    r = (await app.inject({ method: 'GET', url: '/api/projects/alpha/roster', headers: H })).json();
    const pr = (await app.inject({ method: 'GET', url: `/api/team/profiles?p=${g.pubkey}`, headers: H })).json();
    assert.equal(pr.profiles[g.pubkey].display_name, AI_NAME);
    assert.equal(verifyEvent(pr.profiles[g.pubkey].event), true);
    assert.deepEqual(r.ai, { pubkey: g.pubkey, name: AI_NAME, model: 'routstr', label: 'Routstr · gpt-x' });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('createTeamAi: start never throws; a down chat server is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-ai-retry-'));
  const fake = fakeSession();
  let tries = 0;
  const warns = [];
  const ai = createTeamAi({
    cfg: { teams: { coordinator: 'c'.repeat(64), relay: 'ws://127.0.0.1:7777' }, ollama: { enabled: true } },
    secretStore: memSecrets(), rosterStore: {}, teamsState: { setReady: async () => {} }, router: {},
    dir, log: { ...silent, warn: (o) => warns.push(o) }, pollMs: 60_000, retryMs: 5,
    loadSession: async () => {
      if (++tries < 3) throw new Error('MCP error -32001: Request timed out');
      return fake.loadSession();
    },
  });
  try {
    await ai.start();
    assert.equal(tries, 3);
    assert.equal(warns.filter((w) => w.evt === 'team_ai.start_retry').length, 2);
    assert.equal((await ai.info()).ready, true);
  } finally { await ai.stop(); rmSync(dir, { recursive: true, force: true }); }
});
