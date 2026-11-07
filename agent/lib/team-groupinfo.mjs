/**
 * team-groupinfo.mjs: each project chat's join card (torii-teams ADR 0011).
 *
 * Members' Teams clients upload the chat's MLS GroupInfo after every epoch
 * change, so someone let in can add themselves while the owner is away. A
 * GroupInfo holds no secret: it lets its holder ask to join, never read. The
 * node keeps the highest epoch it was given, plus each epoch's confirmed
 * transcript hash (first one wins), so a newcomer can tell whether its own
 * join landed.
 *
 * Storage: memory/teams/groupinfo/<slug>.json, 0600, atomic temp+rename, one
 * writer at a time.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_GROUP_INFO_B64 = Math.ceil((64 * 1024 * 4) / 3) + 4; // 64 KB of bytes
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const GROUP_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const EPOCH_RE = /^(0|[1-9][0-9]{0,18})$/;
const HASH_RE = /^[0-9a-f]{32,128}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_HISTORY = 32;

export function createTeamGroupInfo({ dir, now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!dir) throw new Error('team-groupinfo: dir required');
  let tail = Promise.resolve();
  const file = (slug) => join(dir, `${slug}.json`);

  async function read(slug) {
    try {
      const raw = JSON.parse(await readFile(file(slug), 'utf8'));
      return raw && typeof raw === 'object' && typeof raw.group_id === 'string' ? raw : null;
    } catch (e) {
      if (e.code === 'ENOENT' || e instanceof SyntaxError) return null;
      throw e;
    }
  }

  async function write(slug, value) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${slug}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file(slug));
  }

  /**
   * @param {string} slug
   * @param {{group_id:string, epoch:string, group_info:string, transcript_hash:string}} o
   * @returns {Promise<{ok:true, stored:boolean}|{ok:false, code:string}>}
   */
  function put(slug, o) {
    if (!SLUG_RE.test(String(slug || ''))) return Promise.resolve({ ok: false, code: 'bad_request' });
    const groupId = String(o?.group_id || '');
    const epoch = String(o?.epoch ?? '');
    const info = String(o?.group_info || '');
    const hash = String(o?.transcript_hash || '').toLowerCase();
    if (!GROUP_ID_RE.test(groupId)) return Promise.resolve({ ok: false, code: 'bad_group_id' });
    if (!EPOCH_RE.test(epoch)) return Promise.resolve({ ok: false, code: 'bad_epoch' });
    // Epoch 0 has no confirmed transcript yet (an empty hash); nothing to record.
    if (!(HASH_RE.test(hash) || (hash === '' && epoch === '0'))) {
      return Promise.resolve({ ok: false, code: 'bad_hash' });
    }
    if (!info || info.length > MAX_GROUP_INFO_B64 || !B64_RE.test(info)) {
      return Promise.resolve({ ok: false, code: 'bad_group_info' });
    }
    const run = tail.then(async () => {
      let cur = await read(slug);
      // A new chat for the project replaces the old one's card.
      if (cur && cur.group_id !== groupId) cur = null;
      const history = { ...(cur?.history ?? {}) };
      if (history[epoch] && history[epoch] !== hash) return { ok: true, stored: false };
      if (hash) history[epoch] = hash;
      const keep = Object.keys(history).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, MAX_HISTORY);
      const next = {
        group_id: groupId,
        history: Object.fromEntries(keep.map((e) => [e, history[e]])),
        epoch: cur?.epoch ?? epoch,
        group_info: cur?.group_info ?? info,
        at: cur?.at ?? now(),
      };
      const newer = !cur || BigInt(epoch) > BigInt(cur.epoch);
      if (newer) Object.assign(next, { epoch, group_info: info, at: now() });
      await write(slug, next);
      return { ok: true, stored: newer };
    });
    tail = run.catch(() => {});
    return run;
  }

  async function get(slug) {
    if (!SLUG_RE.test(String(slug || ''))) return null;
    return read(slug);
  }

  return { put, get };
}
