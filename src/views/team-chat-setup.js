/**
 * New-project "Team chat" step (docs/adr-teams-membership-signals.md).
 *
 * Shown right after a project is created when Torii Teams is installed. The
 * owner may pick teammates (name, NIP-05 or npub search), then "Create chat"
 * signs the project's roster (just the owner when nobody is picked). Then,
 * when invite links are available (torii-teams ADR 0012 §1), a second step
 * makes each picked person's own link (Copy, or a QR to scan) and offers an
 * ask-first group link, before "Open chat" goes to the Team page. Without
 * invite links it opens the Team page straight away. "Skip for now" changes
 * nothing.
 */
import { h, clear, openModal } from './util.js';
import { toNpub, parseNpub } from '../lib/npub.js';
import { MAX_HUMANS } from '../lib/roster.js';
import { readSessionMarker } from '../auth.js';
import { signAndPutRoster } from '../lib/sign-roster.js';
import { personEl, setPeopleApi } from '../lib/people.js';
import { renderPeoplePicker } from './people-picker.js';
import { inviteShare } from './invite-share.js';

export const TEAM_CHAT_PROJECT_KEY = 'continuum.teamChatProject';

/**
 * @param {object} o
 * @param {{slug:string, name?:string}} o.project
 * @param {{putProjectRoster:Function, peopleSearch:Function, createInvite?:Function, teamProfiles?:Function, teamAvatarBlob?:Function}} o.api
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
      if (typeof api.createInvite === 'function') { await sendStep(); return; }
      openChat();
    } finally { busy = false; }
  }

  function openChat() {
    modal.close();
    navigate('/team');
  }

  const linkError = (r) => ({
    no_teams_app: 'Install Torii Teams on this node to use invite links.',
    full: `This project already has ${MAX_HUMANS} people.`,
    too_many: 'Too many live links. Stop some on the Team page.',
  }[r?.data?.code || r?.code] || r?.reason || 'Could not make a link.');

  /** Step 2: a link for each picked person, and an optional group link. */
  async function sendStep() {
    clear(body);
    setStatus('');
    const rows = h('div', { style: 'display:flex;flex-direction:column;gap:12px;margin:8px 0;' });
    const groupBox = h('div', { style: 'margin-top:6px;' });
    const done = h('button', { class: 'primary', type: 'button', onClick: openChat }, ['Open chat']);
    body.append(
      h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 10px;', text: picked.length
        ? 'Send each person their own link. Only they can use it, any time, even while you are away. Each link is shown once.'
        : 'Share a group link now, or add people later on the Team page.' }),
      rows, groupBox, status,
      h('div', { class: 'form-actions' }, [done]),
    );
    const copied = (ok) => setStatus(ok ? 'Link copied.' : 'Copy the link by hand.', !ok);
    for (const hex of picked) {
      const slot = h('div', { class: 'muted', style: 'font-size:12.5px;', text: 'Making a link…' });
      rows.appendChild(h('div', { class: 'team-setup-link' }, [personEl(hex), slot]));
      const r = await api.createInvite(project.slug, { kind: 'named', pubkey: hex });
      slot.replaceWith(r?.ok && r.data?.url
        ? inviteShare({ url: r.data.url, label: 'Personal invite link', onCopied: copied })
        : h('div', { style: 'font-size:12.5px;color:var(--accent-danger);', text: linkError(r) }));
    }
    const seats = MAX_HUMANS - 1 - picked.length;
    if (seats > 0) {
      const make = h('button', { class: 'ghost', type: 'button' }, ['Make a group link']);
      make.addEventListener('click', async () => {
        make.disabled = true;
        const r = await api.createInvite(project.slug, { kind: 'open', uses: seats });
        if (!r?.ok || !r.data?.url) { setStatus(linkError(r), true); make.disabled = false; return; }
        groupBox.replaceChildren(
          h('div', { style: 'font-size:13px;font-weight:600;margin-bottom:4px;', text: 'Group link' }),
          inviteShare({ url: r.data.url, label: 'Group invite link', onCopied: copied }),
          h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px;', text: 'Anyone who opens it waits on the Team page until you let them in.' }),
        );
      });
      groupBox.appendChild(make);
    }
    done.focus?.();
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
