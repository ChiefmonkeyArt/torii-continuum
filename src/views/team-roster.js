/**
 * Project roster editor (TEAMS-2a-2; people picker and Teams status from
 * docs/adr-teams-membership-signals.md).
 *
 * The owner finds people by profile name, NIP-05 or npub, picks roles, then
 * signs a kind-30098 roster in the browser (NIP-07 / NIP-46). The agent
 * verifies the signature, the owner and the created_at order, then stores it.
 * Rows always show avatar and display name, never a bare npub.
 *
 * Every dependency is injectable (api, signer, projects, now) so the flow is
 * testable without a browser extension or a live agent.
 */
import { h, clear } from './util.js';
import { rosterRows, MAX_HUMANS } from '../lib/roster.js';
import { parseNpub, toNpub } from '../lib/npub.js';
import { readSessionMarker } from '../auth.js';
import { signAndPutRoster } from '../lib/sign-roster.js';
import { loadProfiles, personEl, displayName, setPeopleApi } from '../lib/people.js';
import { renderPeoplePicker } from './people-picker.js';

const ROLE_OPTS = [
  ['maintainer', 'Maintainer — can merge'],
  ['contributor', 'Contributor — can propose'],
  ['viewer', 'Viewer — read and chat'],
  ['agent', 'Agent — acts for a person'],
];

export const ROSTER_CHANGED_EVENT = 'continuum:roster-changed';

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
 * @param {{projectRoster:Function, putProjectRoster:Function, peopleSearch?:Function, teamProfiles?:Function, teamAvatarBlob?:Function}} deps.api
 * @param {() => Array<{content:{slug:string, name?:string}}>} deps.projects
 * @param {() => any} [deps.signer]   returns a NIP-07 object (window.nostr)
 * @param {() => number} [deps.now]   unix seconds
 * @param {() => string} [deps.ownerNpub] the signed-in owner (session marker)
 * @param {string} [deps.initialSlug]
 * @param {boolean} [deps.demo]
 * @param {() => void} [deps.onDemo]
 */
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

  const select = h('select', { 'aria-label': 'Project' },
    list.map((p) => h('option', { value: p.content.slug, text: p.content.name || p.content.slug })));
  select.value = slug;
  const body = h('div', { class: 'team-roster-body' });
  const status = h('div', { class: 'muted team-roster-status', role: 'status', style: 'min-height: 18px; font-size: 12.5px; margin-top: 8px;' });
  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.style.color = tone === 'error' ? 'var(--accent-danger)' : '';
  };

  card.appendChild(h('div', { style: 'display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;' }, [
    h('strong', { text: 'Project roster' }),
    select,
  ]));
  card.appendChild(h('div', { class: 'muted', style: 'font-size: 12.5px; margin-bottom: 10px; max-width: 640px;', text: `Up to ${MAX_HUMANS} people including you. You sign the roster with your Nostr signer; it decides who can sign in, chat and use the project repository.` }));
  card.appendChild(body);
  card.appendChild(status);

  select.addEventListener('change', () => { slug = select.value; picking = false; load(); });

  const hexOf = (npub) => (parseNpub(npub).ok ? parseNpub(npub).hex : null);

  async function load({ quiet = false } = {}) {
    if (!quiet) { setStatus('Loading…'); clear(body); }
    const r = await api.projectRoster(slug);
    if (!r.ok) {
      if (quiet) return;
      stored = null;
      rows = [];
      setStatus(r.offline ? 'The agent is offline.' : `Could not load the roster: ${r.reason}`, 'error');
      return;
    }
    stored = r.data || null;
    if (!quiet) rows = rosterRows(stored?.roster || null);
    await loadProfiles(rows.map((x) => hexOf(x.npub)).filter(Boolean));
    if (!quiet) setStatus(stored?.roster ? `Signed roster, ${stored.roster.members.length} on the team.` : 'No roster yet. Only you have access.');
    draw();
  }

  function draw() {
    clear(body);
    rows.forEach((row, i) => body.appendChild(drawRow(row, i)));
    if (picking && !deps.demo && api.peopleSearch) {
      const picker = renderPeoplePicker({
        search: api.peopleSearch,
        exclude: () => new Set([knownOwnerHex(), ...rows.map((x) => hexOf(x.npub))].filter(Boolean)),
        onPick: async (hex) => {
          rows.push({ npub: toNpub(hex), role: 'contributor' });
          picking = false;
          draw();
          setStatus('Added. Sign and save to give them access.');
        },
      });
      body.appendChild(h('div', { style: 'margin-top: 8px; max-width: 560px;' }, [picker]));
      setTimeout(() => picker.focus(), 0);
    }
    body.appendChild(h('div', { style: 'display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;' }, [
      h('button', { class: 'ghost', onClick: () => { if (deps.demo) { deps.onDemo?.(); return; } picking = !picking; draw(); } }, [picking ? 'Close search' : 'Add person']),
      h('button', { class: 'primary', onClick: save }, ['Sign and save']),
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
    const remove = h('button', { class: 'ghost', title: 'Remove from roster', onClick: () => { rows.splice(i, 1); draw(); } }, ['Remove']);
    return h('div', { class: 'team-roster-row', style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0;' }, [
      h('span', { style: 'flex: 2 1 240px; min-width: 0; display: flex;' }, [hex ? personEl(hex) : h('span', { class: 'muted', text: 'Unknown key' })]),
      st ? h('span', { class: `pill team-status ${st.tone}`, text: st.label }) : null,
      role, of, remove,
    ]);
  }

  async function save() {
    if (deps.demo) { deps.onDemo?.(); return; }
    if (busy) return;
    busy = true;
    try {
      const r = await signAndPutRoster({
        api, signer: getSigner(), slug, rows, ownerHex: knownOwnerHex(),
        previousCreatedAt: stored?.roster?.created_at || 0, now, onStatus: setStatus,
      });
      if (!r.ok) {
        if (r.status === 409) {
          await load();
          setStatus('A newer roster was saved elsewhere. Reloaded it; check and sign again.', 'error');
          return;
        }
        setStatus(r.reason, 'error');
        return;
      }
      stored = { ...stored, roster: r.data.roster, event: r.event };
      rows = rosterRows(stored.roster);
      draw();
      setStatus(`Saved. ${stored.roster.members.length} on the team.`);
      // Tell an embedded Teams frame to refresh now rather than on its next poll.
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ROSTER_CHANGED_EVENT, { detail: { slug } }));
      load({ quiet: true });
    } finally {
      busy = false;
    }
  }

  if (deps.demo) {
    stored = null;
    rows = [];
    draw();
    setStatus('Demo: sign in to manage a real roster.');
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
 * Team chat (TEAMS-2a Team view link → embed, v0.2.194). Shown only when the
 * agent reports a Torii Teams app origin (config teams.app_url, written by
 * Suite's install-teams-app.sh). The app is framed at <origin>/chat?embed=1:
 * it stays on its OWN origin, so its chat keys never share storage with
 * Continuum. "Open in full window" is the fallback for signers that do not
 * inject into frames. The agent only returns a bare https origin; it is
 * re-checked here so a bad value can never become a javascript: link or src.
 * @param {{teamMe:Function, teamHandoff?:Function}} api
 * @returns {HTMLElement} a placeholder that fills in (or stays empty)
 */
export function renderTeamChatLink(api, { projectSlug = null } = {}) {
  const slot = h('div', { class: 'team-chat-link' });
  Promise.resolve(api.teamMe()).then((r) => {
    const url = r?.ok ? safeAppOrigin(r.data?.teams_app_url) : null;
    if (!url) return;
    // A just-created project opens straight on its chat (new-project flow).
    const path = projectSlug && /^[a-z0-9][a-z0-9-]{0,47}$/.test(projectSlug) ? `/chat/p/${projectSlug}` : '/chat';
    const frame = h('iframe', {
      class: 'team-chat-frame',
      src: `${url}${path}?embed=1`,
      title: 'Team chat',
      allow: 'clipboard-write',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
      referrerpolicy: 'no-referrer',
      loading: 'lazy',
      style: 'display: block; width: 100%; height: max(480px, calc(100vh - 260px)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); background: transparent;',
    });
    slot.appendChild(h('div', { class: 'card', style: 'margin-bottom: 16px;' }, [
      h('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;' }, [
        h('strong', { text: 'Team chat' }),
        h('a', { class: 'team-chat-open', href: `${url}${path}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open in full window', style: 'font-size: 12.5px;' }),
      ]),
      frame,
    ]));
    // Roster saved here → tell the frame (exact Teams origin) to refresh now.
    const onChange = (e) => {
      if (!slot.isConnected) { window.removeEventListener(ROSTER_CHANGED_EVENT, onChange); return; }
      frame.contentWindow?.postMessage({ type: 'torii:roster-changed', slug: e.detail?.slug ?? null }, url);
    };
    window.addEventListener(ROSTER_CHANGED_EVENT, onChange);
    // One sign-in (ADR 0008, Teams repo): the owner is already signed in here,
    // so a session request from THIS frame (exact source and origin, same
    // pubkey) is answered with a scoped owner team token. Members never get
    // one: the agent's handoff route is admin-only and teamMe says owner.
    let busy = false;
    const onAsk = async (e) => {
      if (!slot.isConnected) { window.removeEventListener('message', onAsk); return; }
      if (e.source !== frame.contentWindow || e.origin !== url || busy) return;
      const ask = e.data;
      if (!ask || ask.type !== 'torii:session-request' || ask.pubkey !== r.data?.pubkey || !r.data?.owner) return;
      if (typeof api.teamHandoff !== 'function') return;
      busy = true;
      try {
        const got = await api.teamHandoff();
        const d = got?.ok ? got.data : null;
        if (d && d.pubkey === ask.pubkey && typeof d.token === 'string') {
          frame.contentWindow?.postMessage({ type: 'torii:session', token: d.token, expires_at: d.expires_at, pubkey: d.pubkey }, url);
        }
      } catch { /* the frame falls back to its own sign-in */ } finally { busy = false; }
    };
    window.addEventListener('message', onAsk);
  }).catch(() => {});
  return slot;
}

export function safeAppOrigin(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}
