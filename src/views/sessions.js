/**
 * Sessions — the owner's chat-session history (OWNER-UI-1).
 *
 * Lists the sealed sessions the agent stores (GET /api/sessions) and lets the
 * owner delete any of them (DELETE /api/sessions/:id). The list shows only the
 * non-secret metadata the serve owns (id + timestamps + size); message content
 * lives inside the browser-sealed blob and is never read here, so this view
 * works without a NIP-44 signer.
 */
import { h, clear, timeAgo } from './util.js';
import { isAgentConfigured } from '../data/agent.js';
import { setChatContext } from '../chat.js';
import { sessionLibrary, historyTitle, forgetConversation } from '../chat.js';

/** Human-readable label for a raw session id (slug). Pure + exported for tests. */
export function sessionLabel(id) {
  const s = String(id || '');
  if (s === 'general') return 'General chat';
  if (s.startsWith('project-')) return 'Project · ' + s.slice('project-'.length);
  if (s.startsWith('page-')) return 'Page · ' + s.slice('page-'.length);
  return s || 'Untitled session';
}

export function renderSessions(mount) {
  setChatContext({ label: 'Sessions', where: 'sessions' });
  clear(mount);
  mount.appendChild(h('h2', { text: 'Sessions' }));
  mount.appendChild(h('p', { class: 'muted', text: 'Your chat history, stored on this server and encrypted at rest. Delete any session you no longer want.' }));
  const search = h('input', { type: 'search', placeholder: 'Search conversation titles…', 'aria-label': 'Search conversations', class: 'history-search' });
  mount.append(search);

  if (!isAgentConfigured()) {
    mount.appendChild(h('p', { class: 'muted', text: 'No agent is configured in this build, so there is no session history.' }));
    return;
  }

  const body = h('div', { class: 'session-admin' });
  mount.appendChild(body);
  let query = '';
  const update = () => {
    if (!body.isConnected) { document.removeEventListener('continuum:history-changed', update); return; }
    renderRows(body, query);
  };
  search.addEventListener('input', () => { query = search.value; update(); });
  document.addEventListener('continuum:history-changed', update);
  void refresh(body).then(update);
}

async function refresh(body) {
  clear(body);
  body.appendChild(h('p', { class: 'muted', text: 'Loading sessions…' }));

  // The shared private-history cache avoids duplicate metadata requests.
  await sessionLibrary.load();
  renderRows(body);
}

function renderRows(body, query = '') {
  const state = sessionLibrary.status();
  const r = { ok: !state.error, reason: state.error };
  if (!r.ok) {
    clear(body);
    body.appendChild(h('p', { class: 'muted', text: `Could not load sessions: ${r.reason || 'unknown error'}` }));
    body.appendChild(h('button', { text: 'Retry', onclick: () => void sessionLibrary.retry() }));
    return;
  }

  const sessions = sessionLibrary.rows().filter(s => historyTitle(s).toLowerCase().includes(query.trim().toLowerCase()));
  clear(body);

  if (sessions.length === 0) {
    body.appendChild(h('p', { class: 'muted', text: state.loading ? 'Loading your private conversations…' : query ? 'No matching conversations.' : 'No sessions yet. Start a new chat to create one.' }));
    body.appendChild(h('a', { href: '#/chat', class: 'workspace-session-link', text: 'Start a new chat' }));
    return;
  }

  const list = h('ul', { class: 'session-list' });
  if (sessions.some(s => s.locked)) body.appendChild(h('button', { text: 'Unlock history with signer', onclick: () => void sessionLibrary.retry() }));
  for (const s of sessions) {
    const label = s.locked ? sessionLabel(s.id) : historyTitle(s);
    const meta = `updated ${timeAgo(s.updated_at || s.created_at)} · ${s.bytes || 0} B`;
    const del = h('button', {
      type: 'button',
      class: 'danger',
      text: 'Delete',
      'aria-label': `Delete session ${label}`,
      onclick: async () => {
        if (!window.confirm(`Delete "${label}"? This removes its messages for good.`)) return;
        // Serialize with pending saves so a late write cannot resurrect a deletion.
        try { await sessionLibrary.remove(s.id); forgetConversation(s); }
        catch (e) { window.alert(e.message); }
      },
    });
    const row = h('li', { class: 'session-row' }, [
      h('a', { class: 'session-name', href: '#/sessions/' + s.id, text: label }),
      h('span', { class: 'session-meta muted', text: meta }),
      h('button', { type: 'button', text: s.metadata?.pinned ? 'Unpin' : 'Pin', disabled: s.locked,
        'aria-label': `${s.metadata?.pinned ? 'Unpin' : 'Pin'} ${label}`,
        onclick: async () => {
          try { await sessionLibrary.patch(s.id, { pinned: !s.metadata?.pinned }); }
          catch (e) { window.alert(e.message); }
        } }),
      del,
    ]);
    list.appendChild(row);
  }
  body.appendChild(list);
}
