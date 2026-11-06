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
 *   here → frame  `torii:roster-changed` (member list saved) and
 *                 `torii:navigate` (show a project; path checked on both ends).
 */
import { h } from '../views/util.js';

export const ROSTER_CHANGED_EVENT = 'continuum:roster-changed';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HIDDEN = 'position:fixed;left:-12000px;top:0;width:960px;height:720px;visibility:hidden;pointer-events:none;border:0;';

let st = null; // { origin, pubkey, frame, loaded, docked, raf, offs[] }
let starting = null;
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
      src: `${origin}/chat?embed=1`,
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
      if (e.source !== frame.contentWindow || e.origin !== origin || busy) return;
      const ask = e.data;
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
    doc.body.appendChild(frame);
    st = s;
    return true;
  }).catch(() => false).finally(() => { starting = null; });
  return starting;
}

/** Remove the frame (sign-out). */
export function stopTeamsFrame() {
  declined = false;
  if (!st) return;
  undock();
  st.offs.forEach((off) => off());
  st.frame.remove();
  st = null;
}

/** Show a project (or the list) in the frame without reloading it. */
export function navigateTeamsFrame(slug) {
  if (!st) return;
  const path = chatPath(slug);
  if (!st.loaded) { st.frame.src = `${st.origin}${path}?embed=1`; return; }
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
