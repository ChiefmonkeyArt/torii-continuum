/**
 * Project roster editor (TEAMS-2a-2; people picker and Teams status from
 * docs/adr-teams-membership-signals.md).
 *
 * The owner finds people by profile name, NIP-05 or npub, picks roles, then
 * signs a kind-30098 roster in the browser (NIP-07 / NIP-46). The agent
 * verifies the signature, the owner and the created_at order, then stores it.
 * Rows always show avatar and display name, never a bare npub.
 *
 * Invite links (Teams repo ADR 0009, 0010). On screen the roster is called
 * "Members". Three ways in:
 *   personal link — "Add person" adds them, signs the list and copies a link
 *                   only they can use (one step, straight in);
 *   group link, "Ask me first" — whoever opens it waits for "Let in", which
 *                   adds them to the list, signs it and approves;
 *   group link, "Let them straight in" — the owner signs a grant once
 *                   (kind 27098) and each claim admits one person.
 * Waiting requests show at the top of the card.
 *
 * Every dependency is injectable (api, signer, projects, now) so the flow is
 * testable without a browser extension or a live agent.
 */
import { h, clear } from './util.js';
import { finalizeGrant } from '../lib/sign-roster.js';
import { rosterRows, MAX_HUMANS } from '../lib/roster.js';
import { parseNpub, toNpub } from '../lib/npub.js';
import { readSessionMarker } from '../auth.js';
import { signAndPutRoster } from '../lib/sign-roster.js';
import { loadProfiles, personEl, displayName, setPeopleApi } from '../lib/people.js';
import { renderPeoplePicker } from './people-picker.js';
import { ROSTER_CHANGED_EVENT, startTeamsFrame, dockTeamsFrame, teamsOrigin, chatPath, safeAppOrigin, navigateTeamsFrame } from '../lib/teams-frame.js';

const ROLE_OPTS = [
  ['maintainer', 'Maintainer — can merge'],
  ['contributor', 'Contributor — can propose'],
  ['viewer', 'Viewer — read and chat'],
  ['agent', 'Agent — acts for a person'],
];

export { ROSTER_CHANGED_EVENT };

/**
 * Teams status for one person, from the roster's `teams` signals.
 * @returns {{label:string, tone:string}|null}
 */
export function teamsStatus(teams, hex) {
  if (!teams) return null;
  if (teams.added?.includes(hex)) return { label: 'In the chat', tone: 'ok' };
  if (!teams.chat?.group_id) return { label: teams.ready?.includes(hex) ? 'Opened Teams' : 'Hasn\u2019t opened Teams yet', tone: '' };
  if (teams.ready?.includes(hex)) return { label: 'Opened Teams, being added', tone: 'warn' };
  return { label: 'Hasn\u2019t opened Teams yet', tone: '' };
}

/**
 * @param {object} deps
 * @param {{projectRoster:Function, putProjectRoster:Function, peopleSearch?:Function, teamProfiles?:Function, teamAvatarBlob?:Function,
 *   createInvite?:Function, listInvites?:Function, revokeInvite?:Function, decideInvite?:Function, pendingInvites?:Function}} deps.api
 * @param {() => Array<{content:{slug:string, name?:string}}>} deps.projects
 * @param {() => any} [deps.signer]   returns a NIP-07 object (window.nostr)
 * @param {() => number} [deps.now]   unix seconds
 * @param {() => string} [deps.ownerNpub] the signed-in owner (session marker)
 * @param {string} [deps.initialSlug]
 * @param {boolean} [deps.demo]
 * @param {() => void} [deps.onDemo]
 */
const peopleCount = (n) => (n === 1 ? '1 person' : `${n} people`);

export function renderProjectRosters(deps) {
  const { api, projects } = deps;
  setPeopleApi(api);
  const getSigner = deps.signer || (() => (typeof window !== 'undefined' ? window.nostr : null));
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const ownerNpub = deps.ownerNpub || (() => readSessionMarker()?.npub || '');
  const knownOwnerHex = () => stored?.roster?.owner || (parseNpub(ownerNpub()).ok ? parseNpub(ownerNpub()).hex : null);

  const card = h('div', { class: 'card team-project-roster' });
  const list = (projects() || []).filter((p) => p?.content?.slug);
  if (list.length === 0) {
    card.appendChild(h('div', { class: 'muted', text: 'Create a project first, then add people to it here.' }));
    return card;
  }

  let slug = list.some((p) => p.content.slug === deps.initialSlug) ? deps.initialSlug : list[0].content.slug;
  let stored = null; // { roster, event, teams } from the agent
  let rows = [];
  let busy = false;
  let picking = false;
  let invites = [];
  let removed = new Set(); // hexes the owner removed since the last save
  let groupMode = 'ask'; // 'ask' | 'auto'
  let shown = null; // { url, expires_at, who } — the link is shown once, then only its expiry
  const canInvite = !deps.demo && typeof api.createInvite === 'function' && typeof api.listInvites === 'function';

  const select = h('select', { 'aria-label': 'Project' },
    list.map((p) => h('option', { value: p.content.slug, text: p.content.name || p.content.slug })));
  select.value = slug;
  const optionNames = new Map(list.map((p) => [p.content.slug, p.content.name || p.content.slug]));
  const body = h('div', { class: 'team-roster-body' });
  const waitingBox = h('div', { class: 'team-invite-waiting', style: 'max-width: 640px;' });
  const status = h('div', { class: 'muted team-roster-status', role: 'status', style: 'min-height: 18px; font-size: 12.5px; margin-top: 8px;' });
  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.style.color = tone === 'error' ? 'var(--accent-danger)' : '';
  };

  card.appendChild(h('div', { style: 'display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;' }, [
    h('strong', { text: 'Members' }),
    select,
  ]));
  card.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 10px; max-width: 640px;', text: `Up to ${MAX_HUMANS} people including you. Your Nostr signer signs every change; the list decides who can sign in, chat and use the project repository.` }));
  if (canInvite) card.appendChild(waitingBox);
  card.appendChild(body);
  card.appendChild(status);
  const invitesBox = h('div', { class: 'team-invites', style: 'margin-top: 14px; max-width: 640px;' });
  if (canInvite) card.appendChild(invitesBox);

  select.addEventListener('change', () => { slug = select.value; picking = false; shown = null; removed = new Set(); navigateTeamsFrame(slug); load(); });

  const hexOf = (npub) => (parseNpub(npub).ok ? parseNpub(npub).hex : null);

  async function load({ quiet = false } = {}) {
    if (!quiet) { setStatus('Loading…'); clear(body); }
    const r = await api.projectRoster(slug);
    if (!r.ok) {
      if (quiet) return;
      stored = null;
      rows = [];
      setStatus(r.offline ? 'The agent is offline.' : `Could not load the members: ${r.reason}`, 'error');
      return;
    }
    stored = r.data || null;
    if (!quiet) rows = rosterRows(stored?.roster || null);
    await loadProfiles(rows.map((x) => hexOf(x.npub)).filter(Boolean));
    if (!quiet) setStatus(stored?.roster ? `${peopleCount(stored.roster.members.length)} on this project.` : 'Only you so far. Add someone or share a group link.');
    draw();
    await loadInvites();
  }

  // ── invite links ──────────────────────────────────────────────────────
  async function loadInvites() {
    if (!canInvite) return;
    const forSlug = slug;
    const r = await api.listInvites(forSlug);
    if (forSlug !== slug) return;
    invites = r.ok && Array.isArray(r.data?.invites) ? r.data.invites : [];
    await loadProfiles(invites.flatMap((i) => i.requests.map((q) => q.pubkey)));
    drawInvites();
    updateBadges();
  }

  async function updateBadges() {
    if (typeof api.pendingInvites !== 'function') return;
    const r = await api.pendingInvites();
    const counts = r.ok ? r.data?.pending || {} : {};
    for (const o of select.options) {
      const n = Number(counts[o.value]) || 0;
      o.textContent = optionNames.get(o.value) + (n ? ` (${n} waiting)` : '');
    }
  }

  const expiry = (sec) => new Date(sec * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const inviteError = (r) => ({
    no_teams_app: 'Install Torii Teams on this node to use invite links.',
    full: `This project already has ${MAX_HUMANS} people.`,
    too_many: 'Too many live links. Stop some first.',
    not_on_roster: 'Save the member list first.',
    bad_grant: 'Your signer did not sign the link. Nothing was made.',
  }[r.data?.code || r.code] || r.reason || 'Could not make a link.');

  async function makeLink(body, who) {
    if (busy) return;
    busy = true;
    try {
      const r = await api.createInvite(slug, body);
      if (!r.ok) { setStatus(inviteError(r), 'error'); return; }
      shown = { url: r.data.url, expires_at: r.data.expires_at, who };
      let copied = false;
      try { await navigator.clipboard.writeText(r.data.url); copied = true; } catch { /* shown below to copy by hand */ }
      setStatus(copied ? `Link copied. Send it to ${who || 'your team'}.` : 'Copy the link below and send it.');
      await loadInvites();
    } finally { busy = false; }
  }

  function seatsLeft() {
    const humans = (stored?.roster?.members || []).filter((m) => m.role !== 'agent').length || 1;
    return Math.max(0, MAX_HUMANS - humans);
  }

  function drawInvites() {
    clear(waitingBox);
    const waiting = invites.flatMap((inv) => inv.requests.map((q) => ({ inv, pubkey: q.pubkey })));
    if (waiting.length) {
      waitingBox.appendChild(h('div', { style: 'font-size: 13px; font-weight: 600; margin-bottom: 4px;', text: `${waiting.length === 1 ? 'Someone wants' : `${waiting.length} people want`} to join` }));
    }
    for (const w of waiting) {
      waitingBox.appendChild(h('div', { class: 'team-invite-request', style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid hsl(var(--border));' }, [
        h('span', { style: 'flex: 2 1 240px; min-width: 0; display: flex;' }, [personEl(w.pubkey)]),
        h('button', { class: 'primary', onClick: () => letIn(w.inv, w.pubkey) }, ['Let in']),
        h('button', { class: 'ghost', onClick: () => decline(w.inv, w.pubkey) }, ['Decline']),
      ]));
    }

    clear(invitesBox);
    invitesBox.appendChild(h('strong', { text: 'Group link' }));
    invitesBox.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px; margin: 4px 0 8px;', text: 'One link for the whole group. For one person, use Add person above.' }));
    if (shown) {
      const field = h('input', { type: 'text', readonly: 'readonly', value: shown.url, 'aria-label': 'Invite link', style: 'width: 100%; font-family: var(--font-mono, monospace); font-size: 12px;' });
      field.addEventListener('focus', () => field.select());
      invitesBox.appendChild(h('div', { class: 'team-invite-shown', style: 'margin-bottom: 8px;' }, [
        field,
        h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 4px;', text: `${shown.who ? `For ${shown.who}. ` : ''}Works until ${expiry(shown.expires_at)}. Shown once.` }),
      ]));
    }
    for (const inv of invites.filter((i) => i.kind === 'open')) {
      const how = inv.auto ? 'straight in' : 'asks you first';
      invitesBox.appendChild(h('div', { class: 'team-invite-live muted', style: 'display: flex; gap: 8px; align-items: center; font-size: 12.5px; padding: 2px 0;' }, [
        h('span', { style: 'flex: 1 1 auto;', text: `Group link, ${how}, ${inv.uses_left === 1 ? 'one more person' : `${inv.uses_left} more people`}, until ${expiry(inv.expires_at)}` }),
        h('button', { class: 'ghost', onClick: () => stop(inv) }, ['Stop']),
      ]));
    }
    const mode = h('select', { 'aria-label': 'When someone opens the link' }, [
      h('option', { value: 'ask', text: 'Ask me first' }),
      h('option', { value: 'auto', text: 'Let them straight in' }),
    ]);
    mode.value = groupMode;
    const note = h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 4px;' });
    const fillNote = () => {
      note.textContent = groupMode === 'auto'
        ? 'Anyone holding the link joins, even if it is forwarded. You sign once now; stop it any time.'
        : 'People who open it wait here until you let them in.';
    };
    fillNote();
    mode.addEventListener('change', () => { groupMode = mode.value; fillNote(); });
    const seats = seatsLeft();
    invitesBox.appendChild(h('div', { style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px;' }, [
      h('label', { class: 'muted', style: 'font-size: 12.5px;', text: 'When someone opens it:' }),
      mode,
      h('button', { class: 'ghost', disabled: seats ? null : 'disabled', onClick: () => makeGroupLink() }, ['Copy group link']),
    ]));
    invitesBox.appendChild(note);
  }

  async function makeGroupLink() {
    const uses = seatsLeft();
    if (!uses) { setStatus(`This project already has ${MAX_HUMANS} people.`, 'error'); return; }
    if (groupMode !== 'auto') return makeLink({ kind: 'open', uses });
    if (busy) return;
    setStatus('Waiting for your signer…');
    const g = await finalizeGrant({ signer: getSigner(), slug, role: 'contributor', uses, ttlSec: 7 * 86400, now, ownerHex: knownOwnerHex() });
    if (!g.ok) { setStatus(g.reason, 'error'); return; }
    return makeLink({ kind: 'open', auto: true, grant: g.event });
  }

  async function stop(inv) {
    const r = await api.revokeInvite(slug, inv.id);
    setStatus(r.ok ? 'Link stopped.' : (r.reason || 'Could not stop the link.'), r.ok ? '' : 'error');
    await loadInvites();
  }

  async function decline(inv, pubkey) {
    const r = await api.decideInvite(slug, inv.id, pubkey, false);
    setStatus(r.ok ? 'Declined.' : (r.reason || 'Could not decline.'), r.ok ? '' : 'error');
    await loadInvites();
  }

  async function letIn(inv, pubkey) {
    if (busy) return;
    const listed = stored?.roster?.members?.some((m) => m.pubkey === pubkey);
    if (!listed) {
      if (!rows.some((x) => hexOf(x.npub) === pubkey)) rows.push({ npub: toNpub(pubkey), role: inv.role || 'contributor' });
      if (!(await save())) return;
    }
    const r = await api.decideInvite(slug, inv.id, pubkey, true);
    setStatus(r.ok ? `Let in. ${displayName(pubkey)} is added to the chat while your Continuum is open.` : (r.reason || 'Could not let them in.'), r.ok ? '' : 'error');
    await loadInvites();
  }

  function draw() {
    clear(body);
    rows.forEach((row, i) => body.appendChild(drawRow(row, i)));
    if (picking && !deps.demo && api.peopleSearch) {
      const picker = renderPeoplePicker({
        search: api.peopleSearch,
        exclude: () => new Set([knownOwnerHex(), ...rows.map((x) => hexOf(x.npub))].filter(Boolean)),
        onPick: async (hex) => {
          // One step (ADR 0010): add, sign the list, copy their personal link.
          rows.push({ npub: toNpub(hex), role: 'contributor' });
          removed.delete(hex);
          picking = false;
          draw();
          if (await save() && canInvite) await makeLink({ kind: 'named', pubkey: hex }, displayName(hex));
        },
      });
      body.appendChild(h('div', { style: 'margin-top: 8px; max-width: 560px;' }, [picker]));
      setTimeout(() => picker.focus(), 0);
    }
    body.appendChild(h('div', { style: 'display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;' }, [
      h('button', { class: 'ghost', onClick: () => { if (deps.demo) { deps.onDemo?.(); return; } picking = !picking; draw(); } }, [picking ? 'Close search' : 'Add person']),
      h('button', { class: 'ghost', title: 'Sign role changes and removals', onClick: save }, ['Save changes']),
    ]));
  }

  function drawRow(row, i) {
    const hex = hexOf(row.npub);
    const role = h('select', { 'aria-label': 'Role' }, ROLE_OPTS.map(([v, label]) => {
      const o = h('option', { value: v, text: label });
      if (v === row.role) o.selected = true;
      return o;
    }));
    const of = h('select', { 'aria-label': 'Acts for' });
    const fillOf = () => {
      clear(of);
      of.appendChild(h('option', { value: '', text: 'Acts for…' }));
      const oh = knownOwnerHex();
      if (oh) of.appendChild(h('option', { value: toNpub(oh), text: 'You (owner)' }));
      for (const r of rows) {
        const rh = hexOf(r.npub);
        if (r === row || r.role === 'agent' || !rh) continue;
        of.appendChild(h('option', { value: r.npub, text: displayName(rh) }));
      }
      of.value = row.of || '';
    };
    of.addEventListener('focus', fillOf);
    of.addEventListener('change', () => { row.of = of.value; });
    fillOf();
    if (row.of && of.value !== row.of) {
      const oh = hexOf(row.of);
      of.appendChild(h('option', { value: row.of, text: oh ? displayName(oh) : row.of }));
      of.value = row.of;
    }
    of.style.display = row.role === 'agent' ? '' : 'none';
    role.addEventListener('change', () => {
      row.role = role.value;
      if (row.role !== 'agent') delete row.of;
      of.style.display = row.role === 'agent' ? '' : 'none';
    });
    const st = hex && row.role !== 'agent' && stored?.roster?.members?.some((m) => m.pubkey === hex) ? teamsStatus(stored?.teams, hex) : null;
    const remove = h('button', { class: 'ghost', title: 'Remove from this project (then Save changes)', onClick: () => { rows.splice(i, 1); if (hex) removed.add(hex); draw(); setStatus('Removed. Save changes to sign it.'); } }, ['Remove']);
    const member = hex ? stored?.roster?.members?.find((m) => m.pubkey === hex) : null;
    const listed = hex && row.role !== 'agent' && Boolean(member);
    const named = canInvite && listed
      ? h('button', { class: 'ghost', title: 'A sign-in link only this person can use', onClick: () => makeLink({ kind: 'named', pubkey: hex }, displayName(hex)) }, ['Copy invite link'])
      : null;
    const viaLink = member?.via === 'invite' ? h('span', { class: 'pill', title: 'Joined with a group link; signed into the list at your next save', text: 'Joined by link' }) : null;
    return h('div', { class: 'team-roster-row', style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0;' }, [
      h('span', { style: 'flex: 2 1 240px; min-width: 0; display: flex;' }, [hex ? personEl(hex) : h('span', { class: 'muted', text: 'Unknown key' })]),
      st ? h('span', { class: `pill team-status ${st.tone}`, text: st.label }) : null,
      viaLink, role, of, named, remove,
    ]);
  }

  async function save() {
    if (deps.demo) { deps.onDemo?.(); return false; }
    if (busy) return false;
    busy = true;
    try {
      // Anyone a straight-in link admitted since this page loaded stays,
      // unless removed here (ADR 0010: the signed list absorbs them).
      const latest = await api.projectRoster(slug);
      let prevAt = stored?.roster?.created_at || 0;
      if (latest?.ok && latest.data?.roster) {
        prevAt = Math.max(prevAt, latest.data.roster.created_at || 0);
        for (const m of latest.data.roster.members) {
          if (m.via === 'invite' && !removed.has(m.pubkey) && !rows.some((x) => hexOf(x.npub) === m.pubkey)) rows.push({ npub: toNpub(m.pubkey), role: m.role });
        }
      }
      const r = await signAndPutRoster({
        api, signer: getSigner(), slug, rows, ownerHex: knownOwnerHex(),
        previousCreatedAt: prevAt, now, onStatus: setStatus,
      });
      if (!r.ok) {
        if (r.status === 409) {
          await load();
          setStatus('The member list changed elsewhere. Reloaded it; check and save again.', 'error');
          return false;
        }
        setStatus(r.reason, 'error');
        return false;
      }
      stored = { ...stored, roster: r.data.roster, event: r.event };
      rows = rosterRows(stored.roster);
      draw();
      removed = new Set();
      setStatus(`Saved. ${peopleCount(stored.roster.members.length)} on this project.`);
      // Tell an embedded Teams frame to refresh now rather than on its next poll.
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ROSTER_CHANGED_EVENT, { detail: { slug } }));
      load({ quiet: true });
      return true;
    } finally {
      busy = false;
    }
  }

  if (deps.demo) {
    stored = null;
    rows = [];
    draw();
    setStatus('Demo: sign in to manage real members.');
  } else {
    load();
    // Status pills follow the Teams signals without a page reload.
    const timer = setInterval(() => {
      if (!card.isConnected) { clearInterval(timer); return; }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!busy) load({ quiet: true });
    }, 60_000);
  }
  return card;
}

/**
 * Team chat (ADR 0002/0010, Teams repo). The owner's one Teams frame
 * (lib/teams-frame.js, started at sign-in) is docked over this card's slot;
 * leaving the page hides it without stopping it, so newcomers are still
 * added to the chat. "Open in full window" is the fallback for signers that
 * do not inject into frames.
 * @param {{teamMe:Function, teamHandoff?:Function}} api
 * @returns {HTMLElement} a placeholder that fills in (or stays empty)
 */
export function renderTeamChatLink(api, { projectSlug = null } = {}) {
  const slot = h('div', { class: 'team-chat-link' });
  Promise.resolve(startTeamsFrame(api)).then((running) => {
    const url = teamsOrigin();
    if (!running || !url || !slot.isConnected) return;
    const path = chatPath(projectSlug);
    const dock = h('div', { class: 'team-chat-dock', style: 'height: max(480px, calc(100vh - 260px));' });
    slot.appendChild(h('div', { class: 'card', style: 'margin-bottom: 16px;' }, [
      h('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;' }, [
        h('strong', { text: 'Team chat' }),
        h('a', { class: 'team-chat-open', href: `${url}${path}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open in full window', style: 'font-size: 12.5px;' }),
      ]),
      dock,
    ]));
    dockTeamsFrame(dock, { projectSlug });
  }).catch(() => {});
  return slot;
}

export { safeAppOrigin };
