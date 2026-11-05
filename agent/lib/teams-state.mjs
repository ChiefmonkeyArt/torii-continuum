/**
 * teams-state.mjs: Teams membership signals (docs/adr-teams-membership-signals.md).
 *
 * Three facts reported by Torii Teams clients, so they can poll Continuum
 * (no signer) instead of the chat coordinator (a signer prompt per call):
 *   ready[pubkey]        = unix s   their key packages are on the node coordinator
 *   chats[slug]          = { claimed_at } then { group_id, at }  the project's chat
 *   added[slug][pubkey]  = unix s   the owner's client added them to the chat
 * Signals never grant access: the roster stays the authority.
 *
 * Storage: memory/teams/teams-state.json, 0600, atomic temp+rename, one writer
 * at a time. Public keys, a group id and timestamps only.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CLAIM_TTL_SEC = 600;
export const GROUP_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_READY = 2000;
const MAX_LIST = 64;

const empty = () => ({ ready: {}, chats: {}, added: {} });

export function createTeamsState({ dir, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!dir) throw new Error('teams-state: dir required');
  const file = join(dir, 'teams-state.json');
  let tail = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      return {
        ready: raw?.ready && typeof raw.ready === 'object' ? raw.ready : {},
        chats: raw?.chats && typeof raw.chats === 'object' ? raw.chats : {},
        added: raw?.added && typeof raw.added === 'object' ? raw.added : {},
      };
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return empty();
      throw e;
    }
  }

  async function save(s) {
    // Bound the ready map: keep the newest entries.
    const ready = Object.entries(s.ready);
    if (ready.length > MAX_READY) {
      s.ready = Object.fromEntries(ready.sort((a, b) => b[1] - a[1]).slice(0, MAX_READY));
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.teams-state.${randomBytes(6).toString('hex')}.tmp`);
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

  /** Mark one pubkey ready (idempotent; refreshes the timestamp). */
  function setReady(pubkey) {
    if (!HEX64.test(String(pubkey || ''))) return Promise.resolve({ ok: false, code: 'bad_pubkey' });
    return serial((s) => {
      s.ready[pubkey] = now();
      return { result: { ok: true } };
    });
  }

  /**
   * Chat record ops (owner only; enforced by the route).
   * claim → 409-style { ok:false, code:'exists'|'claimed', chat } when taken.
   */
  function chatOp(slug, op, groupId) {
    if (!SLUG_RE.test(String(slug || ''))) return Promise.resolve({ ok: false, code: 'bad_slug' });
    return serial((s) => {
      const cur = s.chats[slug] || null;
      const t = now();
      if (op === 'claim') {
        if (cur?.group_id) return { write: false, result: { ok: false, code: 'exists', chat: cur } };
        if (cur?.claimed_at && t - cur.claimed_at < CLAIM_TTL_SEC) {
          return { write: false, result: { ok: false, code: 'claimed', chat: cur } };
        }
        s.chats[slug] = { claimed_at: t };
        return { result: { ok: true, chat: s.chats[slug] } };
      }
      if (op === 'set') {
        if (!GROUP_ID_RE.test(String(groupId || ''))) return { write: false, result: { ok: false, code: 'bad_group_id' } };
        if (cur?.group_id && cur.group_id !== groupId) {
          return { write: false, result: { ok: false, code: 'exists', chat: cur } };
        }
        s.chats[slug] = { group_id: groupId, at: t };
        return { result: { ok: true, chat: s.chats[slug] } };
      }
      if (op === 'release') {
        if (cur && !cur.group_id) delete s.chats[slug];
        else return { write: false, result: { ok: true, chat: cur } };
        return { result: { ok: true, chat: null } };
      }
      return { write: false, result: { ok: false, code: 'bad_op' } };
    });
  }

  /** Record adds/removals; `onRoster(pk)` filters adds to current roster members. */
  function markMembers(slug, { added = [], removed = [] } = {}, onRoster = () => true) {
    if (!SLUG_RE.test(String(slug || ''))) return Promise.resolve({ ok: false, code: 'bad_slug' });
    const okList = (l) => Array.isArray(l) && l.length <= MAX_LIST && l.every((p) => HEX64.test(String(p)));
    if (!okList(added) || !okList(removed)) return Promise.resolve({ ok: false, code: 'bad_members' });
    return serial((s) => {
      const m = { ...(s.added[slug] || {}) };
      const t = now();
      for (const p of added) if (onRoster(p)) m[p] = t;
      for (const p of removed) delete m[p];
      s.added[slug] = m;
      return { result: { ok: true } };
    });
  }

  /** Signals for one roster's members only (no cross-project oracle). */
  async function forRoster(slug, memberPubkeys) {
    const s = await load();
    const members = new Set(memberPubkeys);
    const chat = s.chats[slug] || null;
    const added = Object.keys(s.added[slug] || {}).filter((p) => members.has(p)).sort();
    const ready = [...members].filter((p) => s.ready[p]).sort();
    return { chat: chat ? { group_id: chat.group_id || null, claimed: !chat.group_id } : null, ready, added };
  }

  /** For /api/team/me: caller's ready flag and per-project chat/added. */
  async function forCaller(pubkey, slugs) {
    const s = await load();
    const projects = {};
    for (const slug of slugs) {
      projects[slug] = { chat: Boolean(s.chats[slug]?.group_id), added: Boolean(s.added[slug]?.[pubkey]) };
    }
    return { ready: Boolean(s.ready[pubkey]), projects };
  }

  return { setReady, chatOp, markMembers, forRoster, forCaller, file };
}
