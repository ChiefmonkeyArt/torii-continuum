/**
 * The account menu's identity and the "waiting to join" alert
 * (torii-teams ADR 0010).
 *
 * - Avatar and name: the signed-in owner's Nostr profile, read through the
 *   node (proxied avatar, as the member list does), instead of a letter C.
 * - Waiting: how many people asked to join through an "Ask me first" group
 *   link, across all projects. Checked every 60 s while the page is visible;
 *   the sidebar re-renders often, so the last count is kept here and painted
 *   into each fresh render.
 */
import { loadProfiles, avatarEl, displayName, profileOf, setPeopleApi } from './people.js';
import { parseNpub } from './npub.js';

const POLL_MS = 60_000;
let waiting = { total: 0, slug: null };
let timer = null;
let deps = null;
let painters = new Set();

/** Wire the agent calls once (shell start-up). */
export function initAccountChip(d) {
  deps = d;
  if (d.teamProfiles) setPeopleApi({ teamProfiles: d.teamProfiles, teamAvatarBlob: d.teamAvatarBlob });
}

function ownerHex() {
  const npub = deps?.ownerNpub?.() || '';
  const p = parseNpub(npub);
  return p.ok ? p.hex : null;
}

/** Fill the avatar and name slots of a freshly rendered account trigger. */
export function paintAccount(trigger) {
  if (!trigger) return;
  const hex = ownerHex();
  if (!hex) return;
  const fill = () => {
    if (!trigger.isConnected) return;
    const slot = trigger.querySelector('.profile-avatar');
    const name = trigger.querySelector('[data-account-name]');
    if (slot) {
      const a = avatarEl(hex, 36);
      a.classList.add('profile-avatar');
      slot.replaceWith(a);
    }
    if (name && profileOf(hex)) name.textContent = displayName(hex);
  };
  if (profileOf(hex)) { fill(); return; }
  loadProfiles([hex]).then(fill).catch(() => {});
}

/** Paint the waiting alert into `el` now and on every later count change. */
export function paintWaiting(el, { onOpen } = {}) {
  if (!el) return;
  const paint = () => {
    if (!el.isConnected) { painters.delete(paint); return; }
    const n = waiting.total;
    el.hidden = n === 0;
    el.textContent = n === 1 ? '1 person waiting to join' : `${n} people waiting to join`;
  };
  el.onclick = (e) => { e.preventDefault(); onOpen?.(waiting.slug); };
  painters.add(paint);
  paint();
}

/** One check now; returns the new total. */
export async function refreshWaiting() {
  if (!deps?.pendingInvites || !deps.isOwner?.()) return setWaiting({ total: 0, slug: null });
  try {
    const r = await deps.pendingInvites();
    const counts = r?.ok ? r.data?.pending || {} : {};
    let total = 0;
    let slug = null;
    for (const [s, c] of Object.entries(counts)) {
      const n = Number(c) || 0;
      if (n > 0 && !slug) slug = s;
      total += n;
    }
    return setWaiting({ total, slug });
  } catch { return waiting.total; }
}

function setWaiting(next) {
  const changed = next.total !== waiting.total || next.slug !== waiting.slug;
  waiting = next;
  if (changed) painters.forEach((p) => p());
  return waiting.total;
}

/** Start (or keep) the 60 s check; stop it with stopWaiting(). */
let onVisible = null;
let visDoc = null;

export function startWaiting(doc = document) {
  if (timer) return;
  refreshWaiting();
  timer = setInterval(() => {
    if (doc.visibilityState === 'hidden') return;
    refreshWaiting();
  }, POLL_MS);
  // Coming back to the tab checks at once instead of waiting up to 60 s.
  onVisible = () => { if (doc.visibilityState !== 'hidden') refreshWaiting(); };
  visDoc = doc;
  doc.addEventListener('visibilitychange', onVisible);
}

export function stopWaiting() {
  if (timer) clearInterval(timer);
  timer = null;
  if (visDoc && onVisible) visDoc.removeEventListener('visibilitychange', onVisible);
  onVisible = null;
  visDoc = null;
  setWaiting({ total: 0, slug: null });
}

/** Test hook. */
export function _resetAccountChip() { stopWaiting(); painters = new Set(); deps = null; }
