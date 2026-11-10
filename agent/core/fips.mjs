/**
 * fips.mjs — the node page's FIPS card and peer introductions
 * (docs/adr-fips-default.md §1 and §4).
 *
 * The agent is unprivileged. It reads only public node files
 * (/etc/torii/fips/fips.pub, peers.json, both 0644) and `systemctl is-active`,
 * and it never writes peers itself: it drops an operator-signed list that the
 * Suite's root helper `torii-fips-peers` checks again (signature against the
 * node admin, newer than the last list, every field) before touching FIPS.
 * No mesh (fd…) address is ever read, returned or logged.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { safeGet } from '../lib/safe-fetch.mjs';

export const INTRO_KIND = 27530;
export const INTRO_TAG = 'torii-fips-intro';
export const INTRO_PREFIX = 'torii-fips-intro:';
export const PEER_REQUEST_KIND = 27532;
export const PEER_REQUEST_TAG = 'torii-fips-peers';
export const MAX_PEERS = 8; // torii-quest ADR-0151
const MAX_CARD_CHARS = 4096;
const CARD_MAX_AGE_S = 30 * 86400;
const HEX64 = /^[0-9a-f]{64}$/;
const NPUB = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const FIELDS = ['transportNpub', 'beaconPubkey', 'ownerPubkey', 'zoneId', 'website'];

const fail = (code, error) => Object.assign(new Error(error), { status: code });

/** Same rules as the Suite renderer, so the agent never queues a list root refuses. */
export function checkPeer(p) {
  if (!p || typeof p !== 'object') throw fail(400, 'invalid peer');
  if (!NPUB.test(p.transportNpub)) throw fail(400, 'invalid FIPS name');
  if (!HEX64.test(p.beaconPubkey) || !HEX64.test(p.ownerPubkey)) throw fail(400, 'invalid heartbeat pin');
  if (typeof p.zoneId !== 'string' || !p.zoneId || p.zoneId.length > 128) throw fail(400, 'invalid zone');
  let url;
  try { url = new URL(p.website); } catch { throw fail(400, 'invalid world address'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname)
    || /\.(local|localhost|internal|test|invalid)$/i.test(url.hostname)) throw fail(400, 'world address must be a public https address');
  return Object.fromEntries(FIELDS.map((k) => [k, p[k]]));
}

export function decodeCard(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith(INTRO_PREFIX) || s.length > MAX_CARD_CHARS) throw fail(400, 'not an introduction card');
  try { return JSON.parse(Buffer.from(s.slice(INTRO_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw fail(400, 'not an introduction card'); }
}

export function encodeCard(event) {
  return INTRO_PREFIX + Buffer.from(JSON.stringify(event), 'utf8').toString('base64url');
}

// Verify a plain copy: nostr-tools caches a "verified" mark on event objects.
const pick = (e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
const verified = (e) => { try { return verifyEvent(pick(e)); } catch { return false; } };

const hasTag = (e, v) => Array.isArray(e?.tags) && e.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === v);

function systemctlActive(exec, unit) {
  return new Promise((resolve) => {
    exec('systemctl', ['is-active', unit], { timeout: 2000 }, (_err, stdout) => resolve(String(stdout || '').trim()));
  });
}

export function createFips({
  etcDir = '/etc/torii/fips',
  requestPath,
  questBase = 'http://127.0.0.1:8788',
  adminHex = () => null,
  exec = execFile,
  fetchFn = fetch,
  get = safeGet,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!requestPath) throw new Error('requestPath required');

  async function ownNpub() {
    try { return (await readFile(`${etcDir}/fips.pub`, 'utf8')).match(/npub1[023456789acdefghjklmnpqrstuvwxyz]{58}/)?.[0] || null; }
    catch { return null; }
  }

  async function readPeers(path, pick) {
    try { const j = JSON.parse(await readFile(path, 'utf8')); return pick(j); } catch { return null; }
  }

  async function status() {
    const [state, npub] = await Promise.all([systemctlActive(exec, 'torii-fips.service'), ownNpub()]);
    const applied = (await readPeers(`${etcDir}/peers.json`, (j) => j?.peers)) || [];
    const requested = await readPeers(requestPath, (j) => JSON.parse(j?.event?.content)?.peers);
    const names = (l) => l.map((p) => p?.transportNpub).sort().join(',');
    return {
      installed: Boolean(npub),
      running: state === 'active',
      npub,
      peers: applied.slice(0, MAX_PEERS).map((p) => ({ transportNpub: p.transportNpub, ownerPubkey: p.ownerPubkey, zoneId: p.zoneId, website: p.website })),
      // A list the operator signed that root hasn't applied yet (or refused).
      pending: Array.isArray(requested) && names(requested) !== names(applied),
      max: MAX_PEERS,
    };
  }

  /** Unsigned card for the operator's browser signer to sign. */
  async function introduction() {
    const admin = adminHex();
    const npub = await ownNpub();
    if (!npub) throw fail(409, 'FIPS is not installed on this node');
    let cap;
    try {
      const res = await fetchFn(`${questBase}/mp/admin/beacon`, { signal: AbortSignal.timeout(2000) });
      cap = res.ok ? await res.json() : null;
    } catch { cap = null; }
    if (!cap || !HEX64.test(cap.pubkey || '')) throw fail(409, 'Quest heartbeat is not running on this node');
    if (!admin || cap.adminPubkey !== admin) throw fail(409, 'Quest is not owned by this node\'s admin');
    const content = checkPeer({ transportNpub: npub, beaconPubkey: cap.pubkey, ownerPubkey: admin, zoneId: cap.zoneId, website: cap.website });
    return { kind: INTRO_KIND, created_at: now(), tags: [['t', INTRO_TAG]], content: JSON.stringify({ v: 1, ...content }) };
  }

  /** Check another node's card: signature, owner, and its live public heartbeat. */
  async function checkCard(text) {
    const e = decodeCard(text);
    if (!e || e.kind !== INTRO_KIND || !hasTag(e, INTRO_TAG) || !verified(e)) throw fail(400, 'card signature does not verify');
    if (e.created_at > now() + 600 || e.created_at < now() - CARD_MAX_AGE_S) throw fail(400, 'card is too old; ask for a new one');
    let c;
    try { c = JSON.parse(e.content); } catch { throw fail(400, 'not an introduction card'); }
    if (c?.v !== 1) throw fail(400, 'not an introduction card');
    const peer = checkPeer(c);
    if (peer.ownerPubkey !== e.pubkey) throw fail(400, 'card is not signed by that node\'s owner');
    if (peer.transportNpub === await ownNpub()) throw fail(400, 'that is this node\'s own card');
    const host = new URL(peer.website).hostname;
    const r = await get(`https://${host}/mp/admin/beacon`, { maxBytes: 8192, timeoutMs: 5000, accept: 'application/json' });
    let cap = null;
    try { cap = r.ok ? JSON.parse(r.body.toString('utf8')) : null; } catch { cap = null; }
    if (!cap) throw fail(502, 'that node\'s heartbeat could not be reached');
    if (cap.pubkey !== peer.beaconPubkey || cap.adminPubkey !== peer.ownerPubkey
      || cap.zoneId !== peer.zoneId || cap.website !== peer.website) throw fail(400, 'card does not match that node\'s heartbeat');
    return peer;
  }

  /** Queue the full operator-signed list for the root helper. */
  async function putPeers(body) {
    const e = body?.event;
    const admin = adminHex();
    if (!e || e.kind !== PEER_REQUEST_KIND || !hasTag(e, PEER_REQUEST_TAG) || !verified(e)) throw fail(400, 'signature does not verify');
    if (!admin || e.pubkey !== admin) throw fail(403, 'not signed by this node\'s admin');
    if (Math.abs(e.created_at - now()) > 600) throw fail(400, 'request time out of range');
    let c;
    try { c = JSON.parse(e.content); } catch { throw fail(400, 'invalid list'); }
    if (c?.version !== 1 || !Array.isArray(c.peers) || c.peers.length > MAX_PEERS) throw fail(400, `at most ${MAX_PEERS} peers`);
    const own = await ownNpub();
    const seen = new Set();
    for (const p of c.peers) {
      checkPeer(p);
      if (p.transportNpub === own) throw fail(400, 'a node cannot peer with itself');
      if (seen.has(p.transportNpub)) throw fail(400, 'duplicate peer');
      seen.add(p.transportNpub);
    }
    const out = JSON.stringify({ event: pick(e) });
    await mkdir(dirname(requestPath), { recursive: true, mode: 0o755 });
    const tmp = `${requestPath}.tmp`;
    await writeFile(tmp, out + '\n', { mode: 0o644 });
    await rename(tmp, requestPath);
    return { queued: c.peers.length };
  }

  return { status, introduction, checkCard, putPeers };
}

export function registerFipsRoutes(app, { requireAdmin, fips, rateLimit = () => ({}) }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req); } catch (err) {
      if (err?.status) return reply.code(err.status).send({ error: err.message });
      req.log?.warn?.({ err: err?.message }, 'fips route failed');
      return reply.code(500).send({ error: 'FIPS request failed' });
    }
  };
  app.get('/api/fips', { preHandler: requireAdmin }, wrap(() => fips.status()));
  app.get('/api/fips/introduction', { preHandler: requireAdmin }, wrap(async () => ({ template: await fips.introduction() })));
  app.post('/api/fips/introductions/check', { preHandler: requireAdmin, config: rateLimit(20, '/api/fips/introductions/check') },
    wrap(async (req) => ({ peer: await fips.checkCard(req.body?.card) })));
  app.put('/api/fips/peers', { preHandler: requireAdmin, config: rateLimit(20, '/api/fips/peers') },
    wrap((req) => fips.putPeers(req.body)));
}
