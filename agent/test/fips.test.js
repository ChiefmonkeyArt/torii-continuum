import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { createFips, registerFipsRoutes, encodeCard, INTRO_KIND, INTRO_TAG, PEER_REQUEST_KIND, PEER_REQUEST_TAG } from '../core/fips.mjs';

const T = 1800000000;
const keyA = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const keyB = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const adminA = getPublicKey(keyA), adminB = getPublicKey(keyB);
const NPUB_A = 'npub1' + 'q'.repeat(58), NPUB_B = 'npub1' + 'p'.repeat(58);
const beaconB = 'b'.repeat(64);
const peerB = { transportNpub: NPUB_B, beaconPubkey: beaconB, ownerPubkey: adminB, zoneId: 'quest-torii', website: 'https://b.example/quest/' };
const capB = { enabled: true, pubkey: beaconB, adminPubkey: adminB, zoneId: 'quest-torii', website: 'https://b.example/quest/' };

const card = (content, key = keyB, at = T) => encodeCard(finalizeEvent({ kind: INTRO_KIND, created_at: at, tags: [['t', INTRO_TAG]], content: JSON.stringify(content) }, key));
const request = (peers, key = keyA, at = T) => ({ event: finalizeEvent({ kind: PEER_REQUEST_KIND, created_at: at, tags: [['t', PEER_REQUEST_TAG]], content: JSON.stringify({ version: 1, peers }) }, key) });

async function harness({ state = 'active', pub = `${NPUB_A}\n`, peers, cap = capB, local = { ...capB, pubkey: 'a'.repeat(64), adminPubkey: adminA, website: 'https://a.example/quest/' } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fips-'));
  const etcDir = join(dir, 'etc');
  await mkdir(etcDir);
  if (pub) await writeFile(join(etcDir, 'fips.pub'), pub);
  if (peers) await writeFile(join(etcDir, 'peers.json'), JSON.stringify({ version: 1, peers }));
  const gets = [];
  const fips = createFips({
    etcDir, requestPath: join(dir, 'memory', 'fips', 'peer-request.json'), adminHex: () => adminA, now: () => T,
    exec: (_cmd, _args, _opts, cb) => cb(state === 'active' ? null : new Error('x'), `${state}\n`),
    fetchFn: async () => new Response(JSON.stringify(local), { status: 200 }),
    get: async (url) => { gets.push(url); return cap ? { ok: true, body: Buffer.from(JSON.stringify(cap)) } : { ok: false, reason: 'timeout' }; },
  });
  return { dir, fips, gets };
}

test('status: running, peers and the npub, never an fd address', async () => {
  const { fips } = await harness({ pub: `fd12:3456::1\n${NPUB_A}\n`, peers: [peerB] });
  const s = await fips.status();
  assert.equal(s.running, true); assert.equal(s.installed, true); assert.equal(s.npub, NPUB_A);
  assert.equal(s.peers.length, 1); assert.equal(s.pending, false);
  assert.doesNotMatch(JSON.stringify(s), /fd12/);
});

test('status: not running, and not installed', async () => {
  assert.equal((await (await harness({ state: 'failed' })).fips.status()).running, false);
  const none = await (await harness({ state: 'inactive', pub: null })).fips.status();
  assert.deepEqual([none.installed, none.running, none.npub, none.peers.length], [false, false, null, 0]);
});

test('introduction: template carries this node and its live heartbeat', async () => {
  const { fips } = await harness();
  const t = await fips.introduction();
  assert.equal(t.kind, INTRO_KIND);
  assert.deepEqual(JSON.parse(t.content), { v: 1, transportNpub: NPUB_A, beaconPubkey: 'a'.repeat(64), ownerPubkey: adminA, zoneId: 'quest-torii', website: 'https://a.example/quest/' });
});

test('introduction: refused when Quest belongs to someone else', async () => {
  const { fips } = await harness({ local: { ...capB } });
  await assert.rejects(fips.introduction(), /not owned/);
});

test('check card: good card is checked against its live heartbeat', async () => {
  const { fips, gets } = await harness();
  assert.deepEqual(await fips.checkCard(card({ v: 1, ...peerB })), peerB);
  assert.deepEqual(gets, ['https://b.example/mp/admin/beacon']);
});

test('check card: bad signature, wrong owner, mismatch, unreachable, own card, old card', async () => {
  const { fips } = await harness();
  const good = card({ v: 1, ...peerB });
  const tampered = good.slice(0, -6) + (good.endsWith('A') ? 'B' : 'A') + good.slice(-5);
  await assert.rejects(fips.checkCard(tampered), /verify|not an introduction/);
  await assert.rejects(fips.checkCard(card({ v: 1, ...peerB }, keyA)), /owner/);
  await assert.rejects((await harness({ cap: { ...capB, pubkey: 'c'.repeat(64) } })).fips.checkCard(good), /does not match/);
  await assert.rejects((await harness({ cap: null })).fips.checkCard(good), /could not be reached/);
  await assert.rejects(fips.checkCard(card({ v: 1, ...peerB, transportNpub: NPUB_A })), /own card/);
  await assert.rejects(fips.checkCard(card({ v: 1, ...peerB }, keyB, T - 31 * 86400)), /too old/);
  await assert.rejects(fips.checkCard(card({ v: 1, ...peerB, website: 'https://localhost/' })), /public https/);
  await assert.rejects(fips.checkCard('hello'), /not an introduction/);
});

test('put peers: admin-signed list is queued; status shows it pending', async () => {
  const { fips, dir } = await harness();
  assert.deepEqual(await fips.putPeers(request([peerB])), { queued: 1 });
  const saved = JSON.parse(await readFile(join(dir, 'memory', 'fips', 'peer-request.json'), 'utf8'));
  assert.equal(saved.event.pubkey, adminA);
  assert.equal((await fips.status()).pending, true);
  assert.deepEqual(await fips.putPeers(request([], keyA, T + 1)), { queued: 0 });
});

test('put peers: non-admin signer, stale time, too many, duplicate, self refused', async () => {
  const { fips } = await harness();
  await assert.rejects(fips.putPeers(request([peerB], keyB)), /admin/);
  await assert.rejects(fips.putPeers(request([peerB], keyA, T - 3600)), /time/);
  await assert.rejects(fips.putPeers(request([peerB, peerB])), /duplicate/);
  await assert.rejects(fips.putPeers(request([{ ...peerB, transportNpub: NPUB_A }])), /itself/);
  const nine = Array.from({ length: 9 }, () => peerB);
  await assert.rejects(fips.putPeers(request(nine)), /at most 8/);
  const forged = request([peerB]); forged.event.content = forged.event.content.replace('b.example', 'c.example');
  await assert.rejects(fips.putPeers(forged), /verify/);
});

test('routes: admin-only, errors become clear status codes', async () => {
  const { fips } = await harness();
  const app = Fastify();
  registerFipsRoutes(app, { fips, requireAdmin: async (req, reply) => { if (req.headers.authorization !== 'ok') return reply.code(401).send({ error: 'no' }); } });
  assert.equal((await app.inject({ url: '/api/fips' })).statusCode, 401);
  const r = await app.inject({ url: '/api/fips', headers: { authorization: 'ok' } });
  assert.equal(r.json().npub, NPUB_A);
  const bad = await app.inject({ method: 'PUT', url: '/api/fips/peers', headers: { authorization: 'ok' }, payload: request([peerB], keyB) });
  assert.equal(bad.statusCode, 403);
  const chk = await app.inject({ method: 'POST', url: '/api/fips/introductions/check', headers: { authorization: 'ok' }, payload: { card: card({ v: 1, ...peerB }) } });
  assert.equal(chk.json().peer.transportNpub, NPUB_B);
  await app.close();
});
