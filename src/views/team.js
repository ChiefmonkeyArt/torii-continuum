/**
 * Team view — the operator roster.
 *
 * LOCAL-FIRST FOUNDATION (TEAMS-1). The admin can add npubs as "operators"
 * and label them; the roster lives in the local store (kind 30093) and feeds
 * the Kanban card assignee picker. It carries NO authorization weight yet — the
 * agent's requireAdmin is unchanged. Real multi-user auth (agent-side operator
 * allow-list, relay sync, NIP-17 invite/accept) is deferred to TEAMS-2.
 */
import { h, clear, timeAgo } from './util.js';
import * as store from '../data/store.js';
import { shortNpub } from '../lib/npub.js';
import { setChatContext } from '../chat.js';
import { isDemo, demoSource, demoBanner, goToLogin } from '../demo/demo-mode.js';

let storeUnsub = null;

export function renderTeam(mount, opts = {}) {
  const demo = isDemo(opts);
  const S = demoSource(opts, store);
  setChatContext({ label: 'Team', where: 'team' });
  clear(mount);

  // Re-render on store changes so add/remove reflect immediately, and tear the
  // subscription down when the view is replaced (matches dashboard.js pattern).
  if (storeUnsub) { storeUnsub(); storeUnsub = null; }

  if (demo) mount.appendChild(demoBanner());

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('p', { class: 'eyebrow', text: 'Workspace' }),
      h('h1', { class: 'page-title', text: 'Team' }),
      h('div', { class: 'page-sub', text: 'Operators you’ve added to this Continuum.' }),
    ]),
  ]);
  mount.appendChild(header);

  const note = h('div', { class: 'muted', style: 'font-size: 12.5px; margin: -4px 0 16px; max-width: 640px;', text: 'Operators can be assigned to Kanban cards. This roster is local for now — shared multi-user editing and agent-side authorization arrive in a later slice.' });
  mount.appendChild(note);

  mount.appendChild(renderAddForm(demo));

  const listWrap = h('div', { class: 'card', style: 'margin-top: 16px; padding: 0;' });
  renderRoster(listWrap, S, demo);
  mount.appendChild(listWrap);

  // demoStore.subscribe() is a no-op returning an unsubscribe, so this is inert
  // in demo mode (fixtures never change) yet keeps the real store live-updating.
  storeUnsub = S.subscribe(() => {
    renderRoster(listWrap, S, demo);
  });
  window.addEventListener('hashchange', () => {
    if (storeUnsub) { storeUnsub(); storeUnsub = null; }
  }, { once: true });
}

function renderAddForm(demo) {
  const npubInput = h('input', { type: 'text', placeholder: 'Operator npub (npub1… or 64-hex)', maxlength: '70', spellcheck: 'false', autocapitalize: 'off', style: 'flex: 2 1 320px; font-family: var(--font-mono, monospace);' });
  const labelInput = h('input', { type: 'text', placeholder: 'Label (optional)', maxlength: '40', style: 'flex: 1 1 160px;' });
  const errorEl = h('div', { class: 'muted', style: 'color: var(--accent-danger); min-height: 18px; font-size: 12.5px; margin-top: 6px;' });

  function submit() {
    if (demo) { goToLogin(); return; }
    errorEl.textContent = '';
    try {
      store.addMember({ npub: npubInput.value, label: labelInput.value });
      npubInput.value = '';
      labelInput.value = '';
      npubInput.focus();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  const row = h('div', { style: 'display: flex; gap: 10px; flex-wrap: wrap; align-items: center;' }, [
    npubInput,
    labelInput,
    h('button', { class: 'primary', onClick: submit }, ['Add operator npub']),
  ]);

  [npubInput, labelInput].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  });

  return h('div', { class: 'card' }, [row, errorEl]);
}

function renderRoster(wrap, S, demo) {
  clear(wrap);
  const members = S.listMembers();

  if (members.length === 0) {
    wrap.appendChild(h('div', { class: 'muted', style: 'padding: 28px 20px; text-align: center; font-size: 13px;', text: 'No operators yet. Add an npub above to build your roster.' }));
    return;
  }

  const list = h('div', { class: 'team-roster' });
  for (const m of members) {
    list.appendChild(renderMemberRow(m, demo));
  }
  wrap.appendChild(list);
}

function renderMemberRow(m, demo) {
  const c = m.content;
  const removeBtn = h('button', { class: 'ghost', title: 'Remove from roster', onClick: () => (demo ? goToLogin() : store.removeMember(c.npub)) }, ['Remove']);

  const meta = h('div', { style: 'display: flex; flex-direction: column; gap: 3px; min-width: 0;' }, [
    h('span', { class: 'mono', style: 'font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', title: c.npub, text: shortNpub(c.npub) }),
    c.label
      ? h('span', { style: 'font-size: 13px;', text: c.label })
      : h('span', { class: 'muted', style: 'font-size: 12px; font-style: italic;', text: 'no label' }),
  ]);

  const right = h('div', { style: 'display: flex; align-items: center; gap: 12px; flex-shrink: 0;' }, [
    h('span', { class: 'pill', text: c.role }),
    h('span', { class: 'muted', style: 'font-size: 11.5px;', text: `added ${timeAgo(c.addedAt)}` }),
    removeBtn,
  ]);

  return h('div', {
    class: 'team-row',
    style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid hsl(var(--border));',
  }, [meta, right]);
}
