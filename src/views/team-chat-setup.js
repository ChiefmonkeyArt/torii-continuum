/**
 * New-project "Team chat" step (docs/adr-teams-membership-signals.md).
 *
 * Shown right after a project is created when Torii Teams is installed. The
 * owner may pick teammates (name, NIP-05 or npub search), then "Create chat"
 * signs the project's roster (just the owner when nobody is picked) and opens
 * the Team page on that project's chat, where the owner's Teams client
 * creates the group and adds teammates as they open Teams. "Skip for now"
 * changes nothing.
 */
import { h, clear, openModal } from './util.js';
import { toNpub, parseNpub } from '../lib/npub.js';
import { MAX_HUMANS } from '../lib/roster.js';
import { readSessionMarker } from '../auth.js';
import { signAndPutRoster } from '../lib/sign-roster.js';
import { personEl, setPeopleApi } from '../lib/people.js';
import { renderPeoplePicker } from './people-picker.js';

export const TEAM_CHAT_PROJECT_KEY = 'continuum.teamChatProject';

/**
 * @param {object} o
 * @param {{slug:string, name?:string}} o.project
 * @param {{putProjectRoster:Function, peopleSearch:Function, teamProfiles?:Function, teamAvatarBlob?:Function}} o.api
 * @param {(path:string) => void} o.navigate
 * @param {() => any} [o.signer]
 * @param {() => number} [o.now]
 * @param {() => string} [o.ownerNpub]
 */
export function openTeamChatSetup({ project, api, navigate, signer, now, ownerNpub }) {
  setPeopleApi(api);
  const getSigner = signer || (() => (typeof window !== 'undefined' ? window.nostr : null));
  const clock = now || (() => Math.floor(Date.now() / 1000));
  const owner = parseNpub((ownerNpub || (() => readSessionMarker()?.npub || ''))());
  const ownerHex = owner.ok ? owner.hex : null;
  const picked = []; // hex
  let busy = false;

  const list = h('div', { class: 'team-setup-picked', style: 'display:flex;flex-direction:column;gap:6px;margin:8px 0;' });
  const status = h('div', { class: 'muted', role: 'status', style: 'min-height:18px;font-size:12.5px;' });
  const setStatus = (t, err = false) => { status.textContent = t; status.style.color = err ? 'var(--accent-danger)' : ''; };

  function drawPicked() {
    clear(list);
    for (const hex of picked) {
      list.appendChild(h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;' }, [
        personEl(hex),
        h('button', { class: 'ghost', type: 'button', onClick: () => { picked.splice(picked.indexOf(hex), 1); drawPicked(); } }, ['Remove']),
      ]));
    }
  }

  const picker = renderPeoplePicker({
    search: api.peopleSearch,
    exclude: () => new Set([ownerHex, ...picked].filter(Boolean)),
    onPick: (hex) => {
      if (picked.length >= MAX_HUMANS - 1) { setStatus(`At most ${MAX_HUMANS} people including you.`, true); return; }
      picked.push(hex);
      drawPicked();
      setStatus('');
    },
  });

  async function create() {
    if (busy) return;
    busy = true;
    try {
      const r = await signAndPutRoster({
        api, signer: getSigner(), slug: project.slug, ownerHex, now: clock, onStatus: setStatus,
        rows: picked.map((hex) => ({ npub: toNpub(hex), role: 'contributor' })),
      });
      if (!r.ok) { setStatus(r.reason === 'stale' ? 'This project already has members. Manage them on the Team page.' : r.reason, true); return; }
      try { sessionStorage.setItem(TEAM_CHAT_PROJECT_KEY, project.slug); } catch { /* private mode: Team page opens on the first project */ }
      modal.close();
      navigate('/team');
    } finally { busy = false; }
  }

  const body = h('div', {}, [
    h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 10px;', text: 'Invite teammates now, or start the chat with just you. People can be added later on the Team page.' }),
    picker,
    list,
    status,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', type: 'button', onClick: () => modal.close() }, ['Skip for now']),
      h('button', { class: 'primary', type: 'button', onClick: create }, ['Create chat']),
    ]),
  ]);
  const modal = openModal({ title: `Team chat for ${project.name || project.slug}`, subtitle: 'Each project gets one private chat for its members.', body });
  setTimeout(() => picker.focus(), 0);
  return modal;
}
