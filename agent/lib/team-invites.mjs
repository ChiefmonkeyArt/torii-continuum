/**
 * team-invites.mjs: project invite links (torii-teams ADR 0009).
 *
 * A link is `<teams origin>/chat/join/<id>#<secret>`. Only SHA-256(secret) is
 * stored; the secret is shown once at creation. Invites never grant access:
 *   named — the person is already on the roster; the link signs them straight in.
 *   open  — whoever claims it becomes a join request; the owner approves by
 *           signing a roster that lists them (the roster stays the authority).
 *   open + auto (ADR 0010) — "let them straight in": the owner signed a grant
 *           for this link when making it; each claim admits one person until
 *           its uses or time run out.
 *
 * Storage: memory/teams/invites.json, 0600, atomic temp+rename, one writer at
 * a time. Pubkeys, hashes and timestamps only; expired entries are pruned on
 * every write.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';

export const INVITE_ID_RE = /^[A-Za-z0-9_-]{16}$/; // 12 bytes base64url
export const INVITE_SECRET_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes base64url
export const INVITE_ROLES = Object.freeze(['maintainer', 'contributor', 'viewer']);
export const TTL_MIN_SEC = 3600;
export const TTL_MAX_SEC = 30 * 86400;
export const TTL_DEFAULT_SEC = 7 * 86400;
const MAX_LIVE_PER_PROJECT = 50;
const MAX_REQUESTS_PER_INVITE = 20;
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DUMMY_HASH = Buffer.alloc(32);

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

export const INVITE_GRANT_KIND = 27098;
const GRANT_SKEW_SEC = 600;

/**
 * The owner's signed "let them straight in" grant for one group link
 * (torii-teams ADR 0010). Never published. Fails closed on anything odd.
 * @returns {{ok:true, id:string, grant_id:string, role:string, uses:number, ttl_sec:number}|{ok:false}}
 */
export function verifyInviteGrant(event, { ownerHex, slug, now }) {
  const no = { ok: false };
  if (!event || typeof event !== 'object' || event.kind !== INVITE_GRANT_KIND) return no;
  if (!HEX64.test(String(ownerHex || '')) || event.pubkey !== ownerHex) return no;
  if (!Number.isInteger(event.created_at) || Math.abs(event.created_at - now) > GRANT_SKEW_SEC) return no;
  if (event.content !== '' || !Array.isArray(event.tags) || event.tags.length !== 5) return no;
  const tag = (name) => {
    const all = event.tags.filter((t) => Array.isArray(t) && t[0] === name);
    return all.length === 1 && all[0].length === 2 && typeof all[0][1] === 'string' ? all[0][1] : null;
  };
  const project = tag('project');
  const id = tag('invite');
  const role = tag('role');
  const uses = Number(tag('uses'));
  const exp = Number(tag('expiration'));
  if (project !== slug || !INVITE_ID_RE.test(id || '') || !INVITE_ROLES.includes(role)) return no;
  if (!Number.isInteger(uses) || uses < 1 || uses > 11 || String(uses) !== tag('uses')) return no;
  const ttl = exp - now;
  if (!Number.isInteger(exp) || ttl < TTL_MIN_SEC - GRANT_SKEW_SEC || ttl > TTL_MAX_SEC + GRANT_SKEW_SEC) return no;
  let sigOk = false;
  try { sigOk = verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig }); } catch { sigOk = false; }
  if (!sigOk) return no;
  return { ok: true, id, grant_id: event.id, role, uses, ttl_sec: Math.min(TTL_MAX_SEC, Math.max(TTL_MIN_SEC, ttl)) };
}

export function createTeamInvites({ dir, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!dir) throw new Error('team-invites: dir required');
  const file = join(dir, 'invites.json');
  let tail = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      return { invites: raw?.invites && typeof raw.invites === 'object' ? raw.invites : {} };
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return { invites: {} };
      throw e;
    }
  }

  async function save(s) {
    const t = now();
    for (const [id, inv] of Object.entries(s.invites)) if (inv.expires_at <= t) delete s.invites[id];
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.invites.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await rename(tmp, file);
  }

  function serial(fn) {
    const run = tail.then(async () => {
      const s = await load();
      const out = await fn(s);
      if (out?.write !== false) await save(s);
      return out?.result;
    });
    tail = run.catch(() => {});
    return run;
  }

  const usable = (inv) => inv && !inv.revoked && inv.expires_at > now() && inv.uses_left > 0;

  /** Constant-time lookup: the same work for an unknown id as for a wrong secret. */
  function match(s, id, secret) {
    const okShape = INVITE_ID_RE.test(String(id || '')) && INVITE_SECRET_RE.test(String(secret || ''));
    const inv = okShape ? s.invites[id] : undefined;
    const want = inv ? Buffer.from(inv.secret_sha256, 'hex') : DUMMY_HASH;
    const got = sha256(okShape ? secret : '');
    const same = want.length === got.length && timingSafeEqual(want, got);
    return inv && same && usable(inv) ? inv : null;
  }

  const publicView = (inv) => ({
    id: inv.id, kind: inv.kind, auto: Boolean(inv.auto), pubkey: inv.pubkey ?? null, role: inv.role,
    created_at: inv.created_at, expires_at: inv.expires_at, uses_left: inv.uses_left,
    revoked: Boolean(inv.revoked), requests: inv.requests.map((r) => ({ pubkey: r.pubkey, at: r.at })),
  });

  /**
   * @param {{slug:string, kind:'open'|'named', pubkey?:string, role?:string, ttl_sec?:number, uses?:number,
   *   auto?:boolean, grant_id?:string, id?:string, grant?:object}} o  `grant` is the signed event (ADR 0011 proof)  `id` lets an auto link use the id its grant was signed for
   * @returns {Promise<{ok:true, id:string, secret:string, expires_at:number}|{ok:false, code:string}>}
   */
  function create(o) {
    const slug = String(o?.slug || '');
    const kind = o?.kind === 'named' ? 'named' : o?.kind === 'open' ? 'open' : null;
    const role = o?.role ?? 'contributor';
    const ttl = o?.ttl_sec ?? TTL_DEFAULT_SEC;
    const uses = kind === 'named' ? 1 : (o?.uses ?? 1);
    if (!SLUG_RE.test(slug) || !kind) return Promise.resolve({ ok: false, code: 'bad_request' });
    if (!INVITE_ROLES.includes(role)) return Promise.resolve({ ok: false, code: 'bad_role' });
    if (!Number.isInteger(ttl) || ttl < TTL_MIN_SEC || ttl > TTL_MAX_SEC) return Promise.resolve({ ok: false, code: 'bad_ttl' });
    if (!Number.isInteger(uses) || uses < 1 || uses > 11) return Promise.resolve({ ok: false, code: 'bad_uses' });
    if (kind === 'named' && !HEX64.test(String(o.pubkey || ''))) return Promise.resolve({ ok: false, code: 'bad_pubkey' });
    const auto = kind === 'open' && o?.auto === true;
    if (auto && (!HEX64.test(String(o.grant_id || '')) || !INVITE_ID_RE.test(String(o.id || '')))) {
      return Promise.resolve({ ok: false, code: 'bad_grant' });
    }
    return serial((s) => {
      const live = Object.values(s.invites).filter((i) => i.slug === slug && usable(i)).length;
      if (live >= MAX_LIVE_PER_PROJECT) return { write: false, result: { ok: false, code: 'too_many' } };
      // One grant, one link: a signed grant can never back a second link.
      if (auto && (s.invites[o.id] || Object.values(s.invites).some((i) => i.grant_id === o.grant_id))) {
        return { write: false, result: { ok: false, code: 'bad_grant' } };
      }
      let id = auto ? o.id : null;
      while (!id || s.invites[id]) id = randomBytes(12).toString('base64url');
      const secret = randomBytes(16).toString('base64url');
      const t = now();
      s.invites[id] = {
        id, slug, kind, role, pubkey: kind === 'named' ? o.pubkey : undefined,
        secret_sha256: sha256(secret).toString('hex'),
        created_at: t, expires_at: t + ttl, uses_left: uses, requests: [], revoked: false,
        ...(auto ? { auto: true, grant_id: o.grant_id, ...(o.grant?.id === o.grant_id ? { grant: o.grant } : {}) } : {}),
      };
      return { result: { ok: true, id, secret, expires_at: t + ttl } };
    });
  }

  /** Live and revoked-but-unexpired invites for one project (no hashes). */
  async function list(slug) {
    const s = await load();
    const t = now();
    return Object.values(s.invites)
      .filter((i) => i.slug === slug && i.expires_at > t && !i.revoked && i.uses_left > 0)
      .sort((a, b) => b.created_at - a.created_at)
      .map(publicView);
  }

  function revoke(slug, id) {
    return serial((s) => {
      const inv = s.invites[id];
      if (!inv || inv.slug !== slug) return { write: false, result: { ok: false, code: 'not_found' } };
      inv.revoked = true;
      inv.requests = [];
      return { result: { ok: true } };
    });
  }

  /** Peek without changing anything. @returns invite (internal) or null */
  async function find(id, secret) {
    return match(await load(), id, secret);
  }

  /** Spend a named invite (or an open one claimed by someone already on the roster). */
  function spend(id, secret) {
    return serial((s) => {
      const inv = match(s, id, secret);
      if (!inv) return { write: false, result: { ok: false } };
      if (inv.kind === 'named') inv.uses_left = 0;
      return { result: { ok: true } };
    });
  }

  /** Spend one use of a straight-in link (ADR 0010) after its person was admitted. */
  function useAuto(id, secret) {
    return serial((s) => {
      const inv = match(s, id, secret);
      if (!inv || inv.kind !== 'open' || !inv.auto) return { write: false, result: { ok: false } };
      inv.uses_left -= 1;
      return { result: { ok: true } };
    });
  }

  /** Record a join request on an open invite (idempotent per pubkey). */
  function request(id, secret, pubkey) {
    if (!HEX64.test(String(pubkey || ''))) return Promise.resolve({ ok: false });
    return serial((s) => {
      const inv = match(s, id, secret);
      if (!inv || inv.kind !== 'open' || inv.auto) return { write: false, result: { ok: false } };
      if (!inv.requests.some((r) => r.pubkey === pubkey)) {
        if (inv.requests.length >= MAX_REQUESTS_PER_INVITE) return { write: false, result: { ok: false } };
        inv.requests.push({ pubkey, at: now() });
      }
      return { result: { ok: true, slug: inv.slug, expires_at: inv.expires_at } };
    });
  }

  /** 'pending' while the request waits; 'gone' once declined, revoked or expired. */
  async function requestState(id, pubkey) {
    const s = await load();
    const inv = s.invites[id];
    if (!inv || inv.revoked || inv.expires_at <= now()) return { state: 'gone', slug: inv?.slug ?? null };
    return { state: inv.requests.some((r) => r.pubkey === pubkey) ? 'pending' : 'gone', slug: inv.slug };
  }

  /**
   * Owner decision on a request. Approve is called only after a roster that
   * lists the person is stored; it spends one use, and when none are left the
   * other waiting requests are dropped.
   */
  function decide(slug, id, pubkey, approve) {
    return serial((s) => {
      const inv = s.invites[id];
      if (!inv || inv.slug !== slug) return { write: false, result: { ok: false, code: 'not_found' } };
      const i = inv.requests.findIndex((r) => r.pubkey === pubkey);
      if (i < 0) return { write: false, result: { ok: false, code: 'no_request' } };
      inv.requests.splice(i, 1);
      if (approve) {
        inv.uses_left = Math.max(0, inv.uses_left - 1);
        if (inv.uses_left === 0) inv.requests = [];
      }
      return { result: { ok: true } };
    });
  }

  /** Waiting-request counts per project (for the Team view badge). */
  async function pendingCounts() {
    const s = await load();
    const out = {};
    for (const inv of Object.values(s.invites)) {
      if (!usable(inv) || inv.requests.length === 0) continue;
      out[inv.slug] = (out[inv.slug] || 0) + inv.requests.length;
    }
    return out;
  }

  return { create, list, revoke, find, spend, useAuto, request, requestState, decide, pendingCounts };
}
