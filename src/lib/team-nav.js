/**
 * Small shared helpers for a project's team chat
 * (docs/adr-project-team-chat.md).
 *
 * - The Team page opens on one project when asked (TEAM_CHAT_PROJECT_KEY).
 * - A new project's group is the owner-only member list, signed once.
 */
import { signAndPutRoster } from './sign-roster.js';
import { ROSTER_CHANGED_EVENT } from './teams-frame.js';

export const TEAM_CHAT_PROJECT_KEY = 'continuum.teamChatProject';

/** Open the Team page (people and roles) on `slug`. */
export function openTeamFor(slug, navigate) {
  try { if (slug) sessionStorage.setItem(TEAM_CHAT_PROJECT_KEY, slug); } catch { /* storage off: opens on the first project */ }
  navigate('/team');
}

/** The slug the Team page should open on, once. */
export function takeTeamProject() {
  try {
    const v = sessionStorage.getItem(TEAM_CHAT_PROJECT_KEY);
    sessionStorage.removeItem(TEAM_CHAT_PROJECT_KEY);
    return v;
  } catch { return null; }
}

// Projects created in this page load whose group should start on its own
// when their Team tab first opens (§1). Memory only: a reload asks instead.
const fresh = new Set();
export function markNewProject(slug) { if (slug) fresh.add(slug); }
export function takeNewProject(slug) { return fresh.delete(slug); }

/**
 * Start a project's group: sign a member list holding just the owner (§1, §5).
 * The owner's running Teams frame then creates the encrypted chat.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function startProjectChat({ api, slug, signer, ownerHex, now = () => Math.floor(Date.now() / 1000), onStatus, win = typeof window !== 'undefined' ? window : null }) {
  const r = await signAndPutRoster({ api, signer, slug, rows: [], ownerHex, now, onStatus });
  if (r.ok) win?.dispatchEvent(new win.CustomEvent(ROSTER_CHANGED_EVENT, { detail: { slug } }));
  else if (r.reason === 'stale') return { ok: true }; // already has a member list
  return r;
}
