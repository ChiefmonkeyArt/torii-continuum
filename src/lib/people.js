/**
 * People display (docs/adr-teams-membership-signals.md). Profiles and avatars
 * come from the agent (it reads relays and avatar hosts; the browser never
 * does). Avatars arrive as bearer-authenticated Blobs shown via blob: URLs;
 * a failed or missing avatar falls back to initials.
 *
 * Caches are per page load and bounded; blob URLs are revoked on eviction.
 */
import { h } from '../views/util.js';
import { shortNpub, toNpub } from './npub.js';

const MAX = 200;
const profiles = new Map(); // hex → profile | null
const avatars = new Map(); // hex → Promise<string|null> (blob URL)
let api = null;

/** Inject the agent client (tests pass fakes). */
export function setPeopleApi(next) {
  api = next;
}

function bound(map, onDrop) {
  while (map.size > MAX) {
    const k = map.keys().next().value;
    onDrop?.(map.get(k));
    map.delete(k);
  }
}

/** Seed profiles we already have (e.g. from search results). */
export function rememberProfiles(list) {
  for (const p of list || []) {
    if (p?.pubkey) profiles.set(p.pubkey, { name: p.name || '', display_name: p.display_name || '', nip05: p.nip05 || '', avatar: Boolean(p.avatar) });
  }
  bound(profiles);
}

/** Load any missing profiles in one batch (≤ 50 per request). */
export async function loadProfiles(hexes) {
  const want = [...new Set(hexes)].filter((x) => /^[0-9a-f]{64}$/.test(x) && !profiles.has(x));
  for (let i = 0; i < want.length && api?.teamProfiles; i += 50) {
    const r = await api.teamProfiles(want.slice(i, i + 50));
    if (!r?.ok) return;
    for (const [hex, p] of Object.entries(r.data?.profiles || {})) rememberProfiles([{ ...p, pubkey: hex }]);
  }
}

export function profileOf(hex) {
  return profiles.get(hex) || null;
}

/** Best display name: display_name, then name, then short npub. */
export function displayName(hex) {
  const p = profiles.get(hex);
  return p?.display_name || p?.name || shortNpub(toNpub(hex));
}

/**
 * torii-teams ADR 0023 §2: the same face as Teams before a picture loads,
 * the key's first six hex digits as a colour (Teams `pubkeyToHexColor`).
 */
export function faceColour(hex) {
  return typeof hex === 'string' && /^[0-9a-f]{6}/i.test(hex) ? `#${hex.slice(0, 6).toLowerCase()}` : 'hsl(var(--muted))';
}

function avatarUrl(hex) {
  if (!api?.teamAvatarBlob || !profiles.get(hex)?.avatar) return Promise.resolve(null);
  if (!avatars.has(hex)) {
    avatars.set(hex, Promise.resolve(api.teamAvatarBlob(hex))
      .then((b) => (b && typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(b) : null))
      .catch(() => null));
    bound(avatars, (p) => p.then((u) => u && URL.revokeObjectURL?.(u)));
  }
  return avatars.get(hex);
}

/** Round avatar: Teams' colour immediately, the image once it loads. */
export function avatarEl(hex, size = 32) {
  const el = h('span', {
    class: 'person-avatar',
    'aria-hidden': 'true',
    style: `width:${size}px;height:${size}px;border-radius:50%;flex:0 0 ${size}px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;background:${faceColour(hex)};`,
  });
  avatarUrl(hex).then((url) => {
    if (!url) return;
    const img = h('img', { src: url, alt: '', width: String(size), height: String(size), style: 'width:100%;height:100%;object-fit:cover;' });
    img.addEventListener('error', () => img.remove());
    el.textContent = '';
    el.appendChild(img);
  });
  return el;
}

/** Avatar + name + secondary line (NIP-05 or short npub). */
export function personEl(hex, { size = 32, extra = null } = {}) {
  const p = profiles.get(hex);
  const npub = toNpub(hex);
  const sub = [p?.nip05, shortNpub(npub)].filter(Boolean).join(' · ');
  return h('span', { class: 'person', title: npub, style: 'display:inline-flex;align-items:center;gap:10px;min-width:0;' }, [
    avatarEl(hex, size),
    h('span', { style: 'display:flex;flex-direction:column;min-width:0;' }, [
      h('span', { class: 'person-name', style: 'font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', text: displayName(hex) }),
      h('span', { class: 'muted mono', style: 'font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', text: sub }),
    ]),
    extra,
  ]);
}

/** Test hook. */
export function _resetPeople() {
  profiles.clear();
  avatars.clear();
  api = null;
}
