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
import { listSessions, deleteSession, isAgentConfigured } from '../data/agent.js';
import { setChatContext } from '../chat.js';

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

  if (!isAgentConfigured()) {
    mount.appendChild(h('p', { class: 'muted', text: 'No agent is configured in this build, so there is no session history.' }));
    return;
  }

  const body = h('div', { class: 'session-admin' });
  mount.appendChild(body);
  void refresh(body);
}

async function refresh(body) {
  clear(body);
  body.appendChild(h('p', { class: 'muted', text: 'Loading sessions…' }));

  const r = await listSessions();
  if (!r.ok) {
    clear(body);
    body.appendChild(h('p', { class: 'muted', text: `Could not load sessions: ${r.reason || 'unknown error'}` }));
    return;
  }

  const sessions = (r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
  clear(body);

  if (sessions.length === 0) {
    body.appendChild(h('p', { class: 'muted', text: 'No sessions yet. Chat with Continuum on any project or page to create one.' }));
    return;
  }

  const list = h('ul', { class: 'session-list' });
  for (const s of sessions) {
    const label = sessionLabel(s.id);
    const meta = `updated ${timeAgo(s.updated_at || s.created_at)} · ${s.bytes || 0} B`;
    const del = h('button', {
      type: 'button',
      class: 'danger',
      text: 'Delete',
      'aria-label': `Delete session ${label}`,
      onclick: async () => {
        if (!window.confirm(`Delete "${label}"? This removes its messages for good.`)) return;
        const d = await deleteSession(s.id);
        if (!d.ok) {
          window.alert(`Could not delete: ${d.reason || 'unknown error'}`);
          return;
        }
        await refresh(body);
      },
    });
    const row = h('li', { class: 'session-row' }, [
      h('span', { class: 'session-name', text: label }),
      h('span', { class: 'session-meta muted', text: meta }),
      del,
    ]);
    list.appendChild(row);
  }
  body.appendChild(list);
}