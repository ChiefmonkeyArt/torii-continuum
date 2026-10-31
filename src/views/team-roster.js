/**
 * Project roster editor (TEAMS-2a-2).
 *
 * The owner edits who is on a project and in what role, then signs a
 * kind-30098 roster in the browser (NIP-07 / NIP-46). The agent verifies the
 * signature, the owner and the created_at order, then stores it. No key ever
 * leaves the signer; this view only builds the unsigned event.
 *
 * Every dependency is injectable (api, signer, projects, now) so the flow is
 * testable without a browser extension or a live agent.
 */
import { h, clear } from './util.js';
import { buildRosterEvent, rosterRows, MAX_HUMANS } from '../lib/roster.js';
import { parseNpub, shortNpub, toNpub } from '../lib/npub.js';
import { readSessionMarker } from '../auth.js';
import { reconcileSignedEvent } from '../signer-compat.js';

const ROLE_OPTS = [
  ['maintainer', 'Maintainer — can merge'],
  ['contributor', 'Contributor — can propose'],
  ['viewer', 'Viewer — read and chat'],
  ['agent', 'Agent — acts for a person'],
];

/**
 * @param {object} deps
 * @param {{projectRoster:Function, putProjectRoster:Function}} deps.api
 * @param {() => Array<{content:{slug:string, name?:string}}>} deps.projects
 * @param {() => any} [deps.signer]   returns a NIP-07 object (window.nostr)
 * @param {() => number} [deps.now]   unix seconds
 * @param {() => string} [deps.ownerNpub] the signed-in owner (session marker)
 * @param {boolean} [deps.demo]
 * @param {() => void} [deps.onDemo]
 */
export function renderProjectRosters(deps) {
  const { api, projects } = deps;
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

  let slug = list[0].content.slug;
  let stored = null; // { roster, event } from the agent
  let rows = [];
  let busy = false;

  const select = h('select', { 'aria-label': 'Project' },
    list.map((p) => h('option', { value: p.content.slug, text: p.content.name || p.content.slug })));
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

  select.addEventListener('change', () => { slug = select.value; load(); });

  async function load() {
    setStatus('Loading…');
    clear(body);
    const r = await api.projectRoster(slug);
    if (!r.ok) {
      stored = null;
      rows = [];
      setStatus(r.offline ? 'The agent is offline.' : `Could not load the roster: ${r.reason}`, 'error');
      return;
    }
    stored = r.data || null;
    rows = rosterRows(stored?.roster || null);
    setStatus(stored?.roster ? `Signed roster, ${stored.roster.members.length} on the team.` : 'No roster yet. Only you have access.');
    draw();
  }

  function draw() {
    clear(body);
    rows.forEach((row, i) => body.appendChild(drawRow(row, i)));
    body.appendChild(h('div', { style: 'display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;' }, [
      h('button', { class: 'ghost', onClick: () => { rows.push({ npub: '', role: 'contributor' }); draw(); } }, ['Add person']),
      h('button', { class: 'primary', onClick: save }, ['Sign and save']),
    ]));
  }

  function drawRow(row, i) {
    const npub = h('input', { type: 'text', value: row.npub, placeholder: 'npub1… or 64-hex', maxlength: '70', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Member npub', style: 'flex: 2 1 280px; font-family: var(--font-mono, monospace);' });
    npub.addEventListener('input', () => { row.npub = npub.value.trim(); });
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
        if (r === row || r.role === 'agent' || !parseNpub(r.npub).ok) continue;
        of.appendChild(h('option', { value: r.npub, text: shortNpub(r.npub) }));
      }
      of.value = row.of || '';
    };
    of.addEventListener('focus', fillOf);
    of.addEventListener('change', () => { row.of = of.value; });
    fillOf();
    if (row.of && of.value !== row.of) {
      of.appendChild(h('option', { value: row.of, text: shortNpub(row.of) }));
      of.value = row.of;
    }
    of.style.display = row.role === 'agent' ? '' : 'none';
    role.addEventListener('change', () => {
      row.role = role.value;
      if (row.role !== 'agent') delete row.of;
      of.style.display = row.role === 'agent' ? '' : 'none';
    });
    const remove = h('button', { class: 'ghost', title: 'Remove from roster', onClick: () => { rows.splice(i, 1); draw(); } }, ['Remove']);
    return h('div', { class: 'team-roster-row', style: 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0;' }, [npub, role, of, remove]);
  }

  async function save() {
    if (deps.demo) { deps.onDemo?.(); return; }
    if (busy) return;
    const signer = getSigner();
    if (!signer || typeof signer.signEvent !== 'function') {
      setStatus('No Nostr signer found. Connect your signer to sign the roster.', 'error');
      return;
    }
    busy = true;
    try {
      let ownerHex = knownOwnerHex();
      if (!ownerHex) {
        const pk = await signer.getPublicKey?.();
        const p = parseNpub(pk || '');
        if (!p.ok) { setStatus('Your signer did not share its public key.', 'error'); return; }
        ownerHex = p.hex;
      }
      const clean = rows.filter((r) => r.npub).map((r) => ({ ...r }));
      let built;
      try {
        // The agent refuses a roster that is not newer than the stored one.
        const createdAt = Math.max(now(), (stored?.roster?.created_at || 0) + 1);
        built = buildRosterEvent(slug, clean, { ownerHex, createdAt });
      } catch (e) {
        setStatus(e.message, 'error');
        return;
      }
      setStatus('Waiting for your signer…');
      let returned;
      try {
        returned = await signer.signEvent(built);
      } catch (e) {
        setStatus(`Signing cancelled or failed: ${e?.message || e}`, 'error');
        return;
      }
      const rec = reconcileSignedEvent(built, returned);
      if (!rec.ok) { setStatus('The signer returned no signature. Nothing was saved.', 'error'); return; }
      const event = rec.event;
      if (!event.pubkey) event.pubkey = ownerHex;
      setStatus('Saving…');
      const r = await api.putProjectRoster(slug, event);
      if (!r.ok) {
        if (r.status === 409) {
          await load();
          setStatus('A newer roster was saved elsewhere. Reloaded it; check and sign again.', 'error');
          return;
        }
        setStatus(`The agent refused the roster: ${r.reason}`, 'error');
        return;
      }
      stored = { roster: r.data.roster, event };
      rows = rosterRows(stored.roster);
      draw();
      setStatus(`Saved. ${stored.roster.members.length} on the team.`);
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
  }
  return card;
}
