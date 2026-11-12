/**
 * One Torii Teams frame per Continuum page load (torii-teams ADR 0010).
 *
 * The owner's own Teams client is what adds newcomers to a project's
 * encrypted chat, so it must keep running while Continuum is open, not only
 * on the Team page. The frame is created once, after sign-in, for the owner
 * of a node with Teams installed. On the Team page it is docked over the chat
 * slot (fixed position, tracked each animation frame, clipped to the main
 * pane); everywhere else it stays hidden, inert and running.
 *
 * Messages, exact origins both ways:
 *   frame → here  `torii:session-request` (ADR 0008): answered with a scoped
 *                 owner team token for the same pubkey.
 *   frame → here  `torii:roster-synced` (ADR 0015): after a roster-changed
 *                 pass, `{slug, left, error}`; counts only, no keys.
 *   frame → here  `torii:members` (torii-teams ADR 0021 §4): `{slug, joined,
 *                 waiting}` for the strip; counts only, no keys.
 *   here → frame  `torii:roster-changed` (member list saved) and
 *                 `torii:navigate` (show a project; path checked on both ends).
 *   here → frame  `torii:theme {mode}` when light/dark changes, and
 *                 `torii:open-computers` (ADR 0021 §2, §3). The frame address
 *                 also carries `&mode=` so its first paint matches.
 */
import { h } from '../views/util.js';

export const ROSTER_CHANGED_EVENT = 'continuum:roster-changed';
/** torii-teams ADR 0021 §4: fired on `window` with `{slug, joined, waiting}`. */
export const TEAM_MEMBERS_EVENT = 'continuum:team-members';
const members = new Map(); // slug -> {joined, waiting}, from the frame
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HIDDEN = 'position:fixed;left:-12000px;top:0;width:960px;height:720px;visibility:hidden;pointer-events:none;border:0;';

let st = null; // { origin, pubkey, frame, loaded, docked, raf, offs[] }
let starting = null;
const waits = new Map(); // slug -> Set of resolvers for torii:roster-synced (ADR 0015)
export const SYNC_WAIT_MS = 20 * 1000;
let declined = false; // teamMe said no Teams / not owner: do not ask again until sign-out

export function safeAppOrigin(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return (u.protocol === 'https:' || loopback) && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

/** `/chat` or `/chat/p/<slug>`; anything else falls back to `/chat`. */
export function chatPath(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) ? `/chat/p/${slug}` : '/chat';
}

export function teamsOrigin() { return st?.origin ?? null; }

/** Continuum's light or dark (shell.js sets `data-theme`; dark is the default). */
export function themeMode(doc = document) {
  return doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** The frame address: always `embed=1`, plus the mode for a matching first paint. */
export function frameSrc(origin, path, mode) {
  return `${origin}${path}?embed=1&mode=${mode === 'light' ? 'light' : 'dark'}`;
}

/** Last counts the frame reported for `slug`, or null. */
export function teamMembers(slug) { return members.get(slug) ?? null; }

/**
 * Start the frame once (idempotent). Resolves true when a frame is running.
 * @param {{teamMe:Function, teamHandoff:Function}} api
 */
export function startTeamsFrame(api, { doc = document, win = window } = {}) {
  if (st) return Promise.resolve(true);
  if (declined) return Promise.resolve(false);
  if (starting) return starting;
  starting = Promise.resolve(api.teamMe()).then((r) => {
    const origin = r?.ok && r.data?.owner ? safeAppOrigin(r.data?.teams_app_url) : null;
    if (st) return true;
    if (!origin) { declined = Boolean(r?.ok); return false; }
    const frame = h('iframe', {
      class: 'team-chat-frame',
      src: frameSrc(origin, '/chat', themeMode(doc)),
      title: 'Team chat',
      allow: 'clipboard-write',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
      referrerpolicy: 'no-referrer',
      tabindex: '-1',
      'aria-hidden': 'true',
      style: HIDDEN,
    });
    frame.inert = true;
    const s = { origin, pubkey: r.data.pubkey, frame, loaded: false, docked: null, raf: 0, offs: [], win };
    frame.addEventListener('load', () => { s.loaded = true; });
    let busy = false;
    const onAsk = async (e) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      const ask = e.data;
      if (ask?.type === 'torii:roster-synced') return settle(ask);
      if (ask?.type === 'torii:members') return noteMembers(ask, win);
      if (busy) return;
      if (!ask || ask.type !== 'torii:session-request' || ask.pubkey !== s.pubkey) return;
      busy = true;
      try {
        const got = await api.teamHandoff();
        const d = got?.ok ? got.data : null;
        if (d && d.pubkey === ask.pubkey && typeof d.token === 'string') {
          frame.contentWindow?.postMessage({ type: 'torii:session', token: d.token, expires_at: d.expires_at, pubkey: d.pubkey }, origin);
        }
      } catch { /* the frame falls back to its own sign-in */ } finally { busy = false; }
    };
    const onRoster = (e) => frame.contentWindow?.postMessage({ type: 'torii:roster-changed', slug: e.detail?.slug ?? null }, origin);
    win.addEventListener('message', onAsk);
    win.addEventListener(ROSTER_CHANGED_EVENT, onRoster);
    s.offs.push(() => win.removeEventListener('message', onAsk), () => win.removeEventListener(ROSTER_CHANGED_EVENT, onRoster));
    // ADR 0021 §2: follow the theme toggle without reloading the frame.
    const Obs = win.MutationObserver || globalThis.MutationObserver;
    if (Obs) {
      let mode = themeMode(doc);
      const obs = new Obs(() => {
        const next = themeMode(doc);
        if (next === mode) return;
        mode = next;
        frame.contentWindow?.postMessage({ type: 'torii:theme', mode }, origin);
      });
      obs.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      s.offs.push(() => obs.disconnect());
    }
    doc.body.appendChild(frame);
    st = s;
    return true;
  }).catch(() => false).finally(() => { starting = null; });
  return starting;
}

function settle(d) {
  if (typeof d.slug !== 'string' || !SLUG_RE.test(d.slug)) return;
  if (!Number.isInteger(d.left) || d.left < 0 || typeof d.error !== 'boolean') return;
  const set = waits.get(d.slug);
  if (!set) return;
  waits.delete(d.slug);
  for (const done of [...set]) done({ left: d.left, error: d.error });
}

function noteMembers(d, win) {
  if (typeof d.slug !== 'string' || !SLUG_RE.test(d.slug)) return;
  if (![d.joined, d.waiting].every((n) => Number.isInteger(n) && n >= 0 && n < 10000)) return;
  const v = { joined: d.joined, waiting: d.waiting };
  members.set(d.slug, v);
  win.dispatchEvent(new win.CustomEvent(TEAM_MEMBERS_EVENT, { detail: { slug: d.slug, ...v } }));
}

/** Open Your computers in the frame (torii-teams ADR 0021 §3). */
export function openTeamsComputers() {
  if (!st?.loaded) return false;
  st.frame.contentWindow?.postMessage({ type: 'torii:open-computers' }, st.origin);
  return true;
}

/** True while a Teams frame is running on this page. */
export function teamsFrameRunning() { return Boolean(st); }

/**
 * Wait for the frame's answer to the next roster-changed for `slug`
 * (ADR 0015). Resolves `{left, error}`, or null without a frame or after
 * `timeoutMs`. Call before dispatching ROSTER_CHANGED_EVENT.
 */
export function waitForRosterSynced(slug, { timeoutMs = SYNC_WAIT_MS } = {}) {
  if (!st || typeof slug !== 'string' || !SLUG_RE.test(slug)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let set = waits.get(slug);
    if (!set) waits.set(slug, (set = new Set()));
    const done = (v) => { clearTimeout(timer); set.delete(done); if (!set.size && waits.get(slug) === set) waits.delete(slug); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    set.add(done);
  });
}

/** Remove the frame (sign-out). */
export function stopTeamsFrame() {
  declined = false;
  if (!st) return;
  undock();
  st.offs.forEach((off) => off());
  st.frame.remove();
  st = null;
  members.clear();
  for (const set of waits.values()) for (const done of [...set]) done(null);
  waits.clear();
}

/** Show a project (or the list) in the frame without reloading it. */
export function navigateTeamsFrame(slug) {
  if (!st) return;
  const path = chatPath(slug);
  if (!st.loaded) { st.frame.src = frameSrc(st.origin, path, themeMode(st.frame.ownerDocument)); return; }
  st.frame.contentWindow?.postMessage({ type: 'torii:navigate', path }, st.origin);
}

/**
 * Dock the running frame over `slot` until the slot leaves the page.
 * @returns {boolean} false when no frame is running
 */
export function dockTeamsFrame(slot, { projectSlug = null } = {}) {
  if (!st) return false;
  undock();
  st.docked = slot;
  st.frame.inert = false;
  st.frame.removeAttribute('aria-hidden');
  st.frame.removeAttribute('tabindex');
  if (projectSlug) navigateTeamsFrame(projectSlug);
  const raf = st.win.requestAnimationFrame?.bind(st.win) || ((fn) => setTimeout(fn, 16));
  let last = '';
  const place = () => {
    if (!st || st.docked !== slot) return;
    if (!slot.isConnected) { undock(); return; }
    const r = slot.getBoundingClientRect();
    const pane = slot.closest('main')?.getBoundingClientRect() || { top: 0, left: 0, right: st.win.innerWidth, bottom: st.win.innerHeight };
    const clip = [Math.max(0, pane.top - r.top), Math.max(0, r.right - pane.right), Math.max(0, r.bottom - pane.bottom), Math.max(0, pane.left - r.left)];
    const css = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:transparent;z-index:5;clip-path:inset(${clip.map((n) => `${n}px`).join(' ')});`;
    if (css !== last) { st.frame.style.cssText = css; last = css; }
    st.raf = raf(place);
  };
  place();
  return true;
}

function undock() {
  if (!st || !st.docked) return;
  st.docked = null;
  st.win.cancelAnimationFrame?.(st.raf);
  st.frame.style.cssText = HIDDEN;
  st.frame.inert = true;
  st.frame.setAttribute('aria-hidden', 'true');
  st.frame.setAttribute('tabindex', '-1');
}

/** Test hook. */
export function _resetTeamsFrame() { stopTeamsFrame(); starting = null; }
