/** Project home page — milestones, todos, sessions, files. */
import { h, clear, timeAgo, formatBytes } from './util.js';
import { getProject, milestonesFor, todosFor, sessionsFor, filesFor, addTodo, toggleTodo, deleteProject } from '../data/store.js';
import { navigate } from '../router.js';
import { setChatContext } from '../chat.js';
import { renderSidebar } from '../shell.js';

export function renderProjectHome(mount, slug) {
  const p = getProject(slug);
  if (!p) {
    clear(mount);
    mount.appendChild(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '⛩' }),
      h('div', { text: 'No project with that slug.' }),
      h('button', { style: 'margin-top: 12px', onClick: () => navigate('/projects') }, ['Back to projects']),
    ]));
    return;
  }
  setChatContext({ label: p.content.name, where: 'project:' + slug });
  clear(mount);

  // Crumbs
  const crumbs = h('div', { class: 'crumbs' }, [
    h('a', { onClick: () => navigate('/projects') }, ['Projects']),
    h('span', { text: '›' }),
    h('span', { class: 'mono', text: slug }),
  ]);
  mount.appendChild(crumbs);
  mount.appendChild(renderProjectTabs(slug, 'overview'));

  // Header
  const ms = milestonesFor(slug);
  const done = ms.filter((m) => m.content.status === 'done').length;
  const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
  const todos = todosFor(slug);
  const openTodos = todos.filter((t) => !t.content.done).length;

  const sourceLink = p.content.sourceUrl
    ? h('a', { href: p.content.sourceUrl, target: '_blank', rel: 'noopener noreferrer', class: 'mono', text: p.content.sourceUrl })
    : h('span', { class: 'mono muted', text: 'local project' });

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: p.content.name }),
      h('div', { class: 'page-sub', text: p.content.description || '—' }),
      h('div', { class: 'page-sub', style: 'margin-top: 6px;' }, [
        h('span', { class: 'pill', text: p.content.source }),
        ' ',
        sourceLink,
      ]),
    ]),
    h('div', { class: 'page-actions' }, [
      h('button', { class: 'ghost', onClick: () => openInSource(p) }, ['Open source ↗']),
      p.content.slug === 'continuum' || p.content.slug === 'torii-quest'
        ? null
        : h('button', { class: 'ghost', onClick: () => confirmDelete(p) }, ['Delete']),
    ]),
  ]);
  mount.appendChild(header);

  // Overview strip
  const overview = h('div', { class: 'grid-3', style: 'margin-bottom: 20px;' }, [
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Progress' }),
        h('span', { class: 'value', text: `${pct}%` }),
      ]),
      h('div', { class: 'usage-bar', style: 'margin-top: 12px;' }, [h('i', { style: `width: ${pct}%` })]),
      h('div', { class: 'muted', style: 'margin-top: 8px; font-size: 12px;', text: `${done} / ${ms.length} milestones complete` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Open todos' }),
        h('span', { class: 'value', text: String(openTodos) }),
      ]),
      h('div', { class: 'muted', style: 'margin-top: 12px; font-size: 12px;', text: `${todos.length} total · updated ${timeAgo(p.created_at)}` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Sessions' }),
        h('span', { class: 'value', text: String(sessionsFor(slug).length) }),
      ]),
      h('div', { class: 'muted', style: 'margin-top: 12px; font-size: 12px;', text: 'Chat + build sessions logged for this project.' }),
    ]),
  ]);
  mount.appendChild(overview);

  // Two-column: milestones/sessions on the left, todos/files on the right
  const cols = h('div', { class: 'grid-2' }, [
    h('div', {}, [renderMilestones(slug), renderSessions(slug)]),
    h('div', {}, [renderTodos(slug), renderFiles(slug)]),
  ]);
  mount.appendChild(cols);
}

function renderMilestones(slug) {
  const ms = milestonesFor(slug);
  const list = h('div', { class: 'milestone-list' });
  for (const m of ms) {
    list.appendChild(h('div', { class: `milestone ${m.content.status}` }, [
      h('div', { class: 'num', text: 'M' + m.content.index }),
      h('div', { style: 'flex: 1; min-width: 0;' }, [
        h('div', { class: 'title', text: m.content.title }),
        m.content.note ? h('div', { class: 'meta', text: m.content.note }) : null,
      ]),
      h('span', { class: `pill ${statusToPill(m.content.status)}`, text: m.content.status }),
    ]));
  }
  if (ms.length === 0) list.appendChild(h('div', { class: 'muted', text: 'No milestones yet.' }));

  return h('div', { class: 'card', style: 'margin-bottom: 16px;' }, [
    h('h3', { text: 'Milestones' }),
    h('p', { class: 'muted', text: 'The ladder for this project. Nostr-addressable so any Continuum client can render the same view.' }),
    list,
  ]);
}

function statusToPill(status) {
  if (status === 'done') return 'ok';
  if (status === 'active') return 'hot';
  if (status === 'blocked') return 'danger';
  return '';
}

function renderSessions(slug) {
  const sessions = sessionsFor(slug);
  const list = h('div', { class: 'session-list' });
  for (const s of sessions) {
    list.appendChild(h('div', { class: 'session' }, [
      h('div', { class: 'title', text: s.content.title }),
      h('div', { class: 'meta', text: `${Math.round(s.content.durationSec / 3600)}h · ${timeAgo(s.content.startedAt)}` }),
    ]));
  }
  if (sessions.length === 0) list.appendChild(h('div', { class: 'muted', text: 'No sessions logged yet.' }));

  return h('div', { class: 'card' }, [
    h('h3', { text: 'Sessions' }),
    h('p', { class: 'muted', text: 'Working sessions on this project — chat + builds — with the AI or with yourself.' }),
    list,
  ]);
}

function renderTodos(slug) {
  const todos = todosFor(slug);
  const list = h('div', { class: 'todo-list' });
  for (const t of todos) {
    const row = h('div', { class: `todo ${t.content.done ? 'done' : ''}` }, [
      h('input', {
        type: 'checkbox',
        checked: t.content.done ? 'checked' : false,
        onChange: () => { toggleTodo(t); renderTodos.refresh?.(slug); },
      }),
      h('div', { class: 'text', text: t.content.text }),
    ]);
    list.appendChild(row);
  }

  const addInput = h('input', {
    type: 'text',
    class: 'add-input',
    placeholder: '+ add a todo…',
    onKeydown: (e) => {
      if (e.key === 'Enter') {
        const v = addInput.value.trim();
        if (!v) return;
        addTodo(slug, v);
        addInput.value = '';
        renderTodos.refresh?.(slug);
      }
    },
  });
  list.appendChild(h('div', { class: 'todo' }, [
    h('span', { style: 'width:15px; text-align:center; color: var(--muted); font-size:13px;', text: '+' }),
    addInput,
  ]));

  const card = h('div', { class: 'card', style: 'margin-bottom: 16px;' }, [
    h('h3', { text: 'Todo list' }),
    h('p', { class: 'muted', text: 'Every todo is a signed, addressable nostr event — portable across clients.' }),
    list,
  ]);
  return card;
}

function renderFiles(slug) {
  const files = filesFor(slug);
  const list = h('div', { class: 'file-list' });
  for (const f of files) {
    list.appendChild(h('div', { class: 'file' }, [
      h('span', { class: 'kind', text: f.content.kind }),
      h('span', { class: 'mono', text: f.content.path }),
      h('span', { class: 'size', text: formatBytes(f.content.size) }),
    ]));
  }
  if (files.length === 0) list.appendChild(h('div', { class: 'muted', text: 'No files tracked yet.' }));
  return h('div', { class: 'card' }, [
    h('h3', { text: 'Files created' }),
    h('p', { class: 'muted', text: 'Files produced or referenced during sessions for this project.' }),
    list,
  ]);
}

// Re-render the projectHome content when todos change (simple full re-render)
renderTodos.refresh = function refresh(slug) {
  const mount = document.getElementById('main-content');
  renderProjectHome(mount, slug);
};

/**
 * The per-project view switcher (Overview · Board). Shared by projectHome and
 * the Kanban board so the multi-view navigation is identical on both. Rendered
 * as real links/buttons with aria-current for the active tab.
 */
export function renderProjectTabs(slug, active) {
  const tab = (id, label, path) => {
    const el = h('div', {
      class: `view-tab ${active === id ? 'active' : ''}`,
      role: 'tab',
      tabindex: 0,
      'aria-selected': active === id ? 'true' : 'false',
    }, [label]);
    el.addEventListener('click', () => navigate(path));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
    return el;
  };
  return h('div', { class: 'view-tabs', role: 'tablist', 'aria-label': 'Project views' }, [
    tab('overview', 'Overview', `/projects/${slug}`),
    tab('board', 'Board', `/projects/${slug}/board`),
  ]);
}

function openInSource(p) {
  if (p.content.sourceUrl) {
    window.open(p.content.sourceUrl, '_blank', 'noopener,noreferrer');
  }
}

function confirmDelete(p) {
  if (window.confirm(`Delete "${p.content.name}"? This removes local milestones, todos, sessions, and files for this project.`)) {
    deleteProject(p.content.slug);
    renderSidebar();
    navigate('/projects');
  }
}
