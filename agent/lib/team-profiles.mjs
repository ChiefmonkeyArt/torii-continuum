/**
 * team-profiles.mjs: server-side Nostr profiles, people search and avatar
 * proxy for Continuum and Torii Teams (docs/adr-teams-membership-signals.md).
 *
 * Browsers never contact profile relays or avatar hosts: this module does,
 * with bounded memory caches. Avatar URLs come only from kind-0 events read
 * here (a client cannot name a URL), and are fetched through safe-fetch.
 */
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { safeGet, sniffImage } from './safe-fetch.mjs';

export const DEFAULT_PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol'];
export const DEFAULT_SEARCH_RELAYS = ['wss://relay.ditto.pub', 'wss://nostr.wine', 'wss://search.nos.today'];
const HEX64 = /^[0-9a-f]{64}$/;
const PROFILE_TTL = 60 * 60 * 1000;
const FOLLOWS_TTL = 30 * 60 * 1000;
const AVATAR_TTL = 6 * 60 * 60 * 1000;
const MAX_PROFILES = 500;
const MAX_AVATARS = 200;
const MAX_AVATAR_BYTES_TOTAL = 25 * 1024 * 1024;
const MAX_FOLLOWS = 2000;
const QUERY_WAIT_MS = 4000;

/** Small LRU keyed map with per-entry expiry. */
function lru(max) {
  const m = new Map();
  return {
    get(k, now) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp <= now) { m.delete(k); return undefined; }
      m.delete(k); m.set(k, e);
      return e.v;
    },
    set(k, v, exp) {
      m.delete(k); m.set(k, { v, exp });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    delete(k) { m.delete(k); },
    entries: () => m.entries(),
    get size() { return m.size; },
  };
}

const clean = (s, max = 64) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').trim().slice(0, max) : '');

/** Parse a kind-0 event into display fields (exported for tests). */
export function parseProfile(ev) {
  let c = {};
  try { c = JSON.parse(ev?.content || '{}') || {}; } catch { c = {}; }
  const picture = typeof c.picture === 'string' && /^https:\/\//i.test(c.picture) ? c.picture.slice(0, 2048) : '';
  return {
    name: clean(c.name),
    display_name: clean(c.display_name || c.displayName),
    nip05: clean(c.nip05, 128),
    picture,
  };
}

/** Resolve npub / nprofile / 64-hex to hex, else null. */
export function parseKey(q) {
  const s = String(q || '').trim().replace(/^nostr:/i, '');
  if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
  try {
    const d = nip19.decode(s);
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  } catch { /* not bech32 */ }
  return null;
}

const NIP05_RE = /^([a-z0-9._-]{1,64})@([a-z0-9.-]{1,253}\.[a-z]{2,63})$/i;

export function createTeamProfiles({
  profileRelays = DEFAULT_PROFILE_RELAYS,
  searchRelays = DEFAULT_SEARCH_RELAYS,
  query = null,
  fetcher = safeGet,
  now = () => Date.now(),
  log = null,
} = {}) {
  let pool = null;
  const q = query || ((relays, filter) => {
    pool ??= new SimplePool();
    return pool.querySync(relays, filter, { maxWait: QUERY_WAIT_MS }).catch(() => []);
  });
  const profiles = lru(MAX_PROFILES); // hex → { event, fields } | null (none found)
  const follows = lru(8); // owner hex → [hex]
  const avatars = lru(MAX_AVATARS); // hex → { url, body, type } | null
  const inflight = new Map();

  /** Keep the newest kind-0 per author. */
  function remember(events) {
    const newest = new Map();
    for (const ev of events || []) {
      if (ev?.kind !== 0 || !HEX64.test(String(ev.pubkey))) continue;
      const cur = newest.get(ev.pubkey);
      if (!cur || ev.created_at > cur.created_at) newest.set(ev.pubkey, ev);
    }
    const t = now();
    for (const [pk, ev] of newest) {
      const prev = profiles.get(pk, t);
      if (prev?.event && prev.event.created_at >= ev.created_at) continue;
      profiles.set(pk, { event: ev, fields: parseProfile(ev) }, t + PROFILE_TTL);
    }
    return newest;
  }

  async function load(pubkeys) {
    const t = now();
    const want = [...new Set(pubkeys)].filter((p) => HEX64.test(p) && profiles.get(p, t) === undefined);
    for (let i = 0; i < want.length; i += 300) {
      const chunk = want.slice(i, i + 300);
      const got = remember(await q(profileRelays, { kinds: [0], authors: chunk }));
      // Negative-cache misses briefly (10 min) so a missing profile is not re-asked every call.
      for (const p of chunk) if (!got.has(p) && profiles.get(p, now()) === undefined) profiles.set(p, null, now() + 10 * 60 * 1000);
    }
  }

  const view = (pk) => {
    const e = profiles.get(pk, now());
    if (!e) return { pubkey: pk, name: '', display_name: '', nip05: '', avatar: false, event: null };
    const { name, display_name, nip05, picture } = e.fields;
    return { pubkey: pk, name, display_name, nip05, avatar: Boolean(picture), event: e.event };
  };

  /** Profiles for up to 50 pubkeys. */
  async function getProfiles(pubkeys) {
    const list = [...new Set((pubkeys || []).filter((p) => HEX64.test(String(p))))].slice(0, 50);
    await load(list);
    return Object.fromEntries(list.map((p) => [p, view(p)]));
  }

  /** Avatar bytes for one pubkey, or null. */
  async function avatar(pk) {
    if (!HEX64.test(String(pk))) return null;
    await load([pk]);
    const e = profiles.get(pk, now());
    const url = e?.fields?.picture;
    if (!url) return null;
    const cached = avatars.get(pk, now());
    if (cached !== undefined && cached?.url === url) return cached;
    if (cached === null) return null;
    if (inflight.has(pk)) return inflight.get(pk);
    const p = (async () => {
      const r = await fetcher(url, { maxBytes: 512 * 1024, accept: 'image/*' });
      const type = r.ok ? sniffImage(r.body) : null;
      const out = type ? { url, body: r.body, type } : null;
      avatars.set(pk, out, now() + (out ? AVATAR_TTL : 30 * 60 * 1000));
      // Total-bytes bound: drop oldest until under the cap.
      let total = 0;
      for (const [, v] of avatars.entries()) total += v.v?.body?.length || 0;
      for (const [k, v] of avatars.entries()) {
        if (total <= MAX_AVATAR_BYTES_TOTAL) break;
        total -= v.v?.body?.length || 0;
        avatars.delete(k);
      }
      return out;
    })().finally(() => inflight.delete(pk));
    inflight.set(pk, p);
    return p;
  }

  async function nip05(qs) {
    const m = NIP05_RE.exec(qs);
    if (!m) return null;
    const [, name, domain] = m;
    const r = await fetcher(`https://${domain.toLowerCase()}/.well-known/nostr.json?name=${encodeURIComponent(name.toLowerCase())}`, { maxBytes: 64 * 1024, accept: 'application/json' });
    if (!r.ok) return null;
    try {
      const hex = JSON.parse(r.body.toString('utf8'))?.names?.[name.toLowerCase()];
      return HEX64.test(String(hex)) ? hex : null;
    } catch { return null; }
  }

  async function followList(ownerHex) {
    if (!HEX64.test(String(ownerHex))) return [];
    const t = now();
    const hit = follows.get(ownerHex, t);
    if (hit) return hit;
    const evs = await q(profileRelays, { kinds: [3], authors: [ownerHex] });
    const ev = (evs || []).filter((e) => e?.kind === 3).sort((a, b) => b.created_at - a.created_at)[0];
    const list = ev ? [...new Set(ev.tags.filter((x) => x[0] === 'p' && HEX64.test(String(x[1]))).map((x) => x[1]))].slice(0, MAX_FOLLOWS) : [];
    follows.set(ownerHex, list, t + FOLLOWS_TTL);
    return list;
  }

  const matches = (v, needle) => [v.name, v.display_name, v.nip05].some((s) => s && s.toLowerCase().includes(needle));
  const strip = ({ event, ...rest }) => rest;

  /**
   * People search for the owner. Exact keys and NIP-05 first, then the owner's
   * follows, then NIP-50 search relays. ≤ 20 results; nameless hits only for
   * exact matches.
   */
  async function search(raw, ownerHex) {
    const qs = String(raw || '').trim();
    if (qs.length < 2 || qs.length > 128) return [];
    const out = new Map();
    const exact = parseKey(qs) || (qs.includes('@') ? await nip05(qs).catch(() => null) : null);
    if (exact) {
      await load([exact]);
      out.set(exact, { ...strip(view(exact)), follows: false, exact: true });
      return [...out.values()];
    }
    const needle = qs.toLowerCase().slice(0, 64);
    // Follows and NIP-50 run in parallel; follows still rank first.
    const searched = searchRelays.length ? q(searchRelays, { kinds: [0], search: needle, limit: 20 }).catch(() => []) : Promise.resolve([]);
    const fl = await followList(ownerHex).catch(() => []);
    const followSet = new Set(fl);
    await load(fl);
    for (const pk of fl) {
      const v = view(pk);
      if (matches(v, needle)) out.set(pk, { ...strip(v), follows: true, exact: false });
      if (out.size >= 20) break;
    }
    const evs = await searched;
    if (out.size < 20) {
      remember(evs);
      for (const ev of evs || []) {
        if (out.size >= 20) break;
        const v = view(ev.pubkey);
        if (out.has(ev.pubkey) || !(v.name || v.display_name)) continue;
        out.set(ev.pubkey, { ...strip(v), follows: followSet.has(ev.pubkey), exact: false });
      }
    }
    return [...out.values()];
  }

  function close() {
    try { pool?.destroy?.(); } catch (e) { log?.warn?.({ evt: 'team.profiles.close', err: String(e) }); }
  }

  return { getProfiles, avatar, search, close };
}
