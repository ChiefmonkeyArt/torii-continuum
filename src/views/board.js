/**
 * Kanban board view for a project. Columns (default Todo/Doing/Done, plus any
 * custom ones) hold cards. Cards can be created, edited, deleted, dragged
 * between/within columns, and — for keyboard and touch users who can't drag —
 * moved with explicit arrow controls. All state flows through the local store
 * (data/store.js), so it is per-project, persisted, and Nostr-shaped.
 *
 * Rendering goes exclusively through util.h() (textContent only) — no raw
 * HTML, so user-entered titles/descriptions can never inject markup.
 */
import { h, clear, openModal, timeAgo } from './util.js';
import {
  getProject,
  boardColumnsFor,
  cardsFor,
  todosFor,
  addColumn,
  renameColumn,
  moveColumn,
  deleteColumn,
  addCard,
  updateCard,
  deleteCard,
  moveCard,
  listMembers,
  BOARD_LIMITS,
} from '../data/store.js';
import { navigate } from '../router.js';
import { NavLink } from '../components/nav-link.js';
import { setChatContext, compose } from '../chat.js';
import { buildCardPrompt } from './card-prompt.js';
import { renderProjectTabs } from './projectHome.js';
import { timeAgo as _timeAgo } from './util.js';
import {
  isAgentConfigured,
  isLoggedIn,
  projectSources as fetchProjectSources,
  refreshProjectSources,
} from '../data/agent.js';

let mountEl = null;
let currentSlug = null;

function refresh() {
  if (mountEl && currentSlug) renderBoard(mountEl, currentSlug);
}

// ── Imported read-only sources (CONT-KANBAN-SYNC, v0.2.47-alpha) ────────────
//
// Records imported from the agent (local Markdown / public GitHub issues) are
// held ONLY in this ephemeral per-slug map. They are NEVER written to the local
// store, so they can never overwrite or mutate the operator's manual cards, and
// a refresh simply replaces this set (the server dedupes by fingerprint, so
// repeated refreshes never duplicate cards).
const importState = new Map(); // slug → { status, records, sources, syncedAt, reason, filters }

function agentAvailable() {
  try { return isAgentConfigured() && isLoggedIn(); } catch { return false; }
}

function importFor(slug) {
  let st = importState.get(slug);
  if (!st) {
    st = { status: 'idle', records: [], sources: [], syncedAt: null, reason: null, filters: { source: 'all', status: 'all' } };
    importState.set(slug, st);
  }
  return st;
}

// Kick a one-time snapshot load when the board mounts and the agent is usable.
function ensureImportsLoaded(slug) {
  const st = importFor(slug);
  if (!agentAvailable()) { st.status = 'unavailable'; return; }
  if (st.status !== 'idle') return;
  st.status = 'loading';
  fetchProjectSources(slug).then((r) => {
    applySnapshotResult(slug, r);
    refresh();
  });
}

function applySnapshotResult(slug, r) {
  const st = importFor(slug);
  if (!r || r.offline) { st.status = 'unavailable'; return; }
  if (!r.ok) { st.status = 'error'; st.reason = r.reason || 'request failed'; return; }
  const d = r.data || {};
  if (d.enabled === false) { st.status = 'disabled'; return; }
  st.sources = Array.isArray(d.configured) ? d.configured : [];
  const snap = d.snapshot;
  if (snap && Array.isArray(snap.records)) {
    st.records = snap.records;
    st.syncedAt = snap.syncedAt || null;
    st.status = 'ok';
  } else {
    st.records = [];
    st.syncedAt = null;
    st.status = 'never';
  }
}

function applyRefreshResult(slug, r) {
  const st = importFor(slug);
  if (!r || r.offline) { st.status = 'unavailable'; return; }
  if (!r.ok && !r.data) { st.status = 'error'; st.reason = r.reason || 'refresh failed'; return; }
  const d = r.data || {};
  if (d.enabled === false) { st.status = 'disabled'; return; }
  st.records = Array.isArray(d.records) ? d.records : [];
  st.sources = Array.isArray(d.sources) ? d.sources : st.sources;
  st.syncedAt = d.syncedAt || st.syncedAt;
  if (d.stale) { st.status = 'stale'; st.reason = 'live refresh failed — showing last good snapshot'; }
  else if (d.partial) { st.status = 'partial'; st.reason = 'some sources failed'; }
  else if (d.ok) { st.status = 'ok'; st.reason = null; }
  else { st.status = 'error'; st.reason = 'refresh failed'; }
}

function doRefresh(slug) {
  const st = importFor(slug);
  if (st.status === 'loading') return;
  st.status = 'loading';
  refresh();
  refreshProjectSources(slug).then((r) => {
    applyRefreshResult(slug, r);
    refresh();
  });
}

export function renderBoard(mount, slug) {
  mountEl = mount;
  currentSlug = slug;

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

  setChatContext({ label: `${p.content.name} · Board`, where: 'project-board:' + slug });
  ensureImportsLoaded(slug);
  clear(mount);

  mount.appendChild(h('div', { class: 'crumbs' }, [
    NavLink({ href: '#/projects', children: ['Projects'] }),
    h('span', { text: '›' }),
    NavLink({ href: `#/projects/${slug}`, children: [h('span', { class: 'mono', text: slug })] }),
    h('span', { text: '›' }),
    h('span', { text: 'Board' }),
  ]));
  mount.appendChild(renderProjectTabs(slug, 'board'));

  const columns = boardColumnsFor(slug);
  // Count native store cards, the read-only imported cards, AND the read-only
  // project-todo cards currently shown so the header total matches what is on
  // the board. Excluding these made a board with only todos/imports read
  // "0 cards" even though the project had open work.
  const totalCards = columns.reduce(
    (n, c) => n
      + cardsFor(slug, c.content.id).length
      + importedCardsFor(slug, c.content.id, columns).length
      + todoCardsFor(slug, c.content.id, columns).length,
    0,
  );

  mount.appendChild(h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Board' }),
      h('div', { class: 'page-sub', text: `${columns.length} columns · ${totalCards} cards · drag or use the arrow controls to move work along.` }),
    ]),
    h('div', { class: 'page-actions' }, [
      h('button', { class: 'primary', onClick: () => openColumnEditor(slug) }, ['+ Add column']),
    ]),
  ]));

  const syncBar = renderSyncBar(slug);
  if (syncBar) mount.appendChild(syncBar);

  const scroller = h('div', { class: 'board-scroller' });
  columns.forEach((col, i) => scroller.appendChild(renderColumn(slug, col, columns, i)));
  mount.appendChild(scroller);
}

// ── Imported records: read-only sync/filter bar + card rendering ────────────

// Which local column an imported record lands in, matched by conventional name
// then falling back to position. Never mutates columns — this is display-only.
function columnForStatus(status, columns) {
  const byName = (re) => columns.find((c) => re.test(c.content.name || ''));
  if (status === 'done') {
    return byName(/done|complete|shipped/i) || columns[columns.length - 1] || null;
  }
  if (status === 'doing') {
    return byName(/doing|progress|active|wip|review/i) || columns[Math.min(1, columns.length - 1)] || null;
  }
  if (status === 'backlog') {
    return byName(/backlog|icebox|someday/i) || byName(/todo|to do|to-do|inbox/i) || columns[0] || null;
  }
  // todo (default)
  return byName(/todo|to do|to-do|inbox|backlog/i) || columns[0] || null;
}

// Pure: imported records that land in `colId` after applying the source + status
// filters. Exported (and free of the module-level importState) so the
// distribution + counting contract is unit-tested without a DOM.
export function filterImportedForColumn(records, colId, columns, filters = {}) {
  const srcFilter = filters.source || 'all';
  const statusFilter = filters.status || 'all';
  return (Array.isArray(records) ? records : []).filter((rec) => {
    if (srcFilter !== 'all' && sourceKey(rec) !== srcFilter) return false;
    if (statusFilter !== 'all' && rec.status !== statusFilter) return false;
    const target = columnForStatus(rec.status, columns);
    return target && target.content.id === colId;
  });
}

// Imported records for a column, after applying the source + status filters.
function importedCardsFor(slug, colId, columns) {
  const st = importFor(slug);
  if (st.status === 'unavailable' || st.status === 'disabled') return [];
  return filterImportedForColumn(st.records, colId, columns, st.filters);
}

// ── Project todos as read-only board cards (KANBAN-TODO-OVERLAY, v0.2.63) ────
//
// A project's todos (kind 30081, edited on the Overview tab) are distinct
// entities from board cards (kind 30084). Before this overlay, a brand-new or
// migrated board showed "0 cards" even though the project had todos, because
// the board only read cardsFor() (empty until someone adds a card) plus the
// agent import set (empty when logged out). We surface each todo as a
// read-only card so the board reflects the project's real work without a
// destructive store rewrite. These cards are NEVER written to the store and
// carry no move/edit controls — editing happens on the Overview tab.
//
// Pure and exported so the todo→column distribution + counting contract is
// unit-tested without a DOM. A done todo lands in the Done-conventional column;
// an open todo lands in the Todo-conventional column (via columnForStatus,
// shared with the imported overlay so placement stays consistent).
export function filterTodosForColumn(todos, colId, columns) {
  return (Array.isArray(todos) ? todos : []).filter((t) => {
    const status = t.content && t.content.done ? 'done' : 'todo';
    const target = columnForStatus(status, columns);
    return target && target.content.id === colId;
  });
}

function todoCardsFor(slug, colId, columns) {
  return filterTodosForColumn(todosFor(slug), colId, columns);
}

function renderTodoCard(slug, todo) {
  const c = todo.content;
  const meta = [
    h('span', { class: 'imported-badge', text: 'Project todo · read-only' }),
    h('a', {
      class: 'imported-link',
      href: `#/projects/${slug}`,
      'aria-label': `Edit on the Overview tab: ${c.text}`,
    }, ['edit on Overview ↗']),
  ];
  return h('div', {
    class: 'board-card imported todo-card',
    dataset: { todoId: c.id || '' },
    'aria-label': `Read-only project todo card: ${c.text} (${c.done ? 'done' : 'open'})`,
  }, [
    h('div', { class: 'card-src muted', text: c.done ? 'Todo · done' : 'Todo · open' }),
    h('div', { class: 'card-title', text: c.text }),
    h('div', { class: 'card-meta muted' }, meta),
  ]);
}

function sourceKey(rec) {
  const s = rec.source || {};
  return `${s.type || 'unknown'}:${s.ref || ''}`;
}

function renderImportedCard(slug, rec) {
  const footer = [];
  if (rec.priority) footer.push(h('span', { class: `pill card-priority pri-${rec.priority}`, text: rec.priority }));
  if (Array.isArray(rec.labels)) {
    rec.labels.slice(0, 3).forEach((l) => footer.push(h('span', { class: 'pill card-label', text: l })));
  }

  const srcType = rec.source?.type === 'github_issues' ? 'GitHub' : 'Markdown';
  const srcLabel = `${srcType} · ${rec.source?.label || rec.source?.ref || ''}${rec.source?.id ? ' ' + rec.source.id : ''}`;

  const meta = [h('span', { class: 'imported-badge', text: 'Imported · read-only' })];
  if (rec.url) {
    meta.push(h('a', {
      class: 'imported-link',
      href: rec.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Open source for: ${rec.title}`,
    }, ['↗ source']));
  }

  const el = h('div', {
    class: 'board-card imported',
    dataset: { fingerprint: rec.fingerprint },
    'aria-label': `Read-only imported card: ${rec.title} (${srcLabel})`,
  }, [
    h('div', { class: 'card-src muted', text: srcLabel }),
    h('div', { class: 'card-title', text: rec.title }),
    rec.description ? h('div', { class: 'card-desc', text: rec.description }) : null,
    footer.length ? h('div', { class: 'card-footer' }, footer) : null,
    h('div', { class: 'card-meta muted' }, meta),
  ]);
  return el;
}

function renderSyncBar(slug) {
  const st = importFor(slug);
  if (st.status === 'unavailable' || st.status === 'disabled') return null;
  // Nothing to sync for a project with no configured sources — don't render an
  // empty "No snapshot yet" bar on every such board. During the initial load we
  // don't yet know the source list, so keep showing the bar until it resolves.
  if (st.status !== 'loading' && (!st.sources || st.sources.length === 0)) return null;

  const loading = st.status === 'loading';

  // Distinct sources present across the current record set (plus configured).
  const seen = new Map();
  st.records.forEach((r) => {
    const key = sourceKey(r);
    if (!seen.has(key)) {
      const type = r.source?.type === 'github_issues' ? 'GitHub' : 'Markdown';
      seen.set(key, `${type}: ${r.source?.label || r.source?.ref || key}`);
    }
  });
  const sourceOptions = [h('option', { value: 'all', text: 'All sources' })];
  for (const [value, text] of seen) {
    sourceOptions.push(h('option', { value, text, selected: st.filters.source === value ? 'selected' : false }));
  }

  const sourceSel = h('select', { 'aria-label': 'Filter by source' }, sourceOptions);
  sourceSel.value = st.filters.source;
  sourceSel.addEventListener('change', () => { st.filters.source = sourceSel.value; refresh(); });

  const statusSel = h('select', { 'aria-label': 'Filter by status' }, [
    ['all', 'All statuses'], ['backlog', 'Backlog'], ['todo', 'Todo'], ['doing', 'Doing'], ['done', 'Done'],
  ].map(([v, t]) => h('option', { value: v, text: t, selected: st.filters.status === v ? 'selected' : false })));
  statusSel.value = st.filters.status;
  statusSel.addEventListener('change', () => { st.filters.status = statusSel.value; refresh(); });

  const refreshBtn = h('button', {
    class: 'ghost',
    disabled: loading ? 'disabled' : false,
    onClick: () => doRefresh(slug),
  }, [loading ? 'Refreshing…' : '↻ Refresh sources']);

  const count = st.records.length;
  const syncText = loading
    ? 'Syncing imported sources…'
    : st.syncedAt
      ? `${count} imported · last synced ${_timeAgo(Math.floor(st.syncedAt / 1000))}`
      : st.status === 'never'
        ? 'No snapshot yet — refresh to import'
        : `${count} imported`;

  const rows = [
    h('div', { class: 'sync-row' }, [
      h('span', { class: 'sync-title', text: 'Imported sources' }),
      h('span', { class: 'sync-status muted', text: syncText }),
      h('div', { class: 'sync-controls' }, [sourceSel, statusSel, refreshBtn]),
    ]),
  ];

  if ((st.status === 'stale' || st.status === 'partial' || st.status === 'error') && st.reason) {
    rows.push(h('div', { class: `sync-banner ${st.status}`, text: st.reason }));
  }

  return h('div', { class: 'sync-bar', role: 'region', 'aria-label': 'Imported sources' }, rows);
}

function renderColumn(slug, col, columns, index) {
  const colId = col.content.id;
  const cards = cardsFor(slug, colId);
  const imported = importedCardsFor(slug, colId, columns);
  const todoCards = todoCardsFor(slug, colId, columns);

  const controls = h('div', { class: 'col-controls' }, [
    iconBtn('‹', 'Move column left', () => { moveColumn(slug, colId, 'left'); refresh(); }, index === 0),
    iconBtn('›', 'Move column right', () => { moveColumn(slug, colId, 'right'); refresh(); }, index === columns.length - 1),
    iconBtn('✎', 'Rename column', () => openColumnEditor(slug, col)),
    iconBtn('✕', 'Delete column', () => openDeleteColumn(slug, col, columns)),
  ]);

  // Column count includes imported read-only cards so it matches the cards
  // actually listed below (native + imported), consistent with the header total.
  const header = h('div', { class: 'col-header' }, [
    h('div', { class: 'col-title' }, [
      h('span', { class: 'col-name', text: col.content.name }),
      h('span', { class: 'col-count', text: String(cards.length + imported.length + todoCards.length) }),
    ]),
    controls,
  ]);

  const list = h('div', { class: 'card-list', dataset: { columnId: colId } });
  if (cards.length === 0 && imported.length === 0 && todoCards.length === 0) {
    list.appendChild(h('div', { class: 'card-empty muted', text: 'No cards yet.' }));
  } else {
    cards.forEach((card, ci) => list.appendChild(renderCard(slug, card, columns, index, ci, cards.length)));
    todoCards.forEach((todo) => list.appendChild(renderTodoCard(slug, todo)));
    imported.forEach((rec) => list.appendChild(renderImportedCard(slug, rec)));
  }

  // Drag targeting: allow dropping onto the list; compute an insertion index
  // from the pointer position so drops land where the user aims.
  list.addEventListener('dragover', (e) => {
    if (!dragState.cardId) return;
    e.preventDefault();
    list.classList.add('drag-over');
  });
  list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
  list.addEventListener('drop', (e) => {
    if (!dragState.cardId) return;
    e.preventDefault();
    list.classList.remove('drag-over');
    const toIndex = insertionIndex(list, e.clientY);
    try {
      moveCard(slug, dragState.cardId, colId, toIndex);
    } catch (err) {
      window.alert(err.message);
    }
    dragState.cardId = null;
    refresh();
  });

  const addBtn = h('button', { class: 'ghost col-add', onClick: () => openCardEditor(slug, colId) }, ['+ Add card']);

  return h('div', { class: 'board-column' }, [header, list, addBtn]);
}

function renderCard(slug, card, columns, colIndex, cardIndex, cardCount) {
  const c = card.content;
  const colId = c.columnId;

  const footer = [];
  if (c.assignee) footer.push(h('span', { class: 'pill card-assignee', text: c.assignee }));
  if (c.dueDate) footer.push(h('span', { class: `pill card-due ${isOverdue(c.dueDate) ? 'danger' : ''}`, text: c.dueDate }));

  // Card actions: an explicit Edit button (keyboard + screen-reader reachable)
  // plus accessible move controls that shift between columns and reorder within
  // a column without dragging. These are real <button>s and, because the card
  // container is a plain non-interactive <div>, they are not nested under any
  // role="button" — so each is an independent, correctly-labelled control.
  const moves = h('div', { class: 'card-moves' }, [
    iconBtn('✎', `Edit card: ${c.title}`, () => openCardEditor(slug, colId, card)),
    iconBtn('‹', 'Move to previous column', () => {
      const prev = columns[colIndex - 1];
      if (prev) { safeMove(slug, c.id, prev.content.id); }
    }, colIndex === 0),
    iconBtn('↑', 'Move up', () => moveCardBy(slug, c.id, colId, cardIndex, -1), cardIndex === 0),
    iconBtn('↓', 'Move down', () => moveCardBy(slug, c.id, colId, cardIndex, 1), cardIndex === cardCount - 1),
    iconBtn('›', 'Move to next column', () => {
      const next = columns[colIndex + 1];
      if (next) { safeMove(slug, c.id, next.content.id); }
    }, colIndex === columns.length - 1),
    iconBtn('✦', 'Ask Continuum to work on this task', () => askContinuum(slug, card, columns)),
  ]);

  const el = h('div', {
    class: 'board-card',
    draggable: 'true',
    dataset: { cardId: c.id },
  }, [
    h('div', { class: 'card-title', text: c.title }),
    c.description ? h('div', { class: 'card-desc', text: c.description }) : null,
    footer.length ? h('div', { class: 'card-footer' }, footer) : null,
    h('div', { class: 'card-meta muted', text: `updated ${timeAgo(c.updatedAt || c.createdAt)}` }),
    moves,
  ]);

  // Mouse convenience only: clicking the card body (not a control) opens the
  // editor. Keyboard/AT users reach the same action via the Edit button above,
  // so the container itself carries no interactive role.
  el.addEventListener('click', (e) => {
    if (e.target.closest('.card-moves')) return;
    openCardEditor(slug, colId, card);
  });
  el.addEventListener('dragstart', (e) => {
    dragState.cardId = c.id;
    el.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragState.cardId = null; });

  return el;
}

const dragState = { cardId: null };

// Insertion index for a drop at pointer-Y: first card whose vertical midpoint
// is below the pointer wins; otherwise append. Scoped to draggable manual cards
// (which carry data-card-id) so read-only imported cards — appended after the
// manual ones — never inflate the index into the manual-card array.
function insertionIndex(list, clientY) {
  const cards = [...list.querySelectorAll('.board-card[data-card-id]:not(.dragging)')];
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return i;
  }
  return cards.length;
}

function safeMove(slug, cardId, toColumnId) {
  try {
    moveCard(slug, cardId, toColumnId);
  } catch (err) {
    window.alert(err.message);
  }
  refresh();
}

function moveCardBy(slug, cardId, colId, cardIndex, delta) {
  moveCard(slug, cardId, colId, cardIndex + delta);
  refresh();
}

// Prefill (never auto-send) a task prompt into the chat dock so an operator can
// "vibe code" a response with the Continuum agent. The consent boundary is
// preserved: compose() only fills + expands + focuses the input; the operator
// reviews the drafted turn and hits Send, because every agent turn spends sats.
function askContinuum(slug, card, columns) {
  const p = getProject(slug);
  const projectName = p ? `${p.content.name} (${slug})` : slug;
  const col = columns.find((c) => c.content.id === card.content.columnId);
  const columnName = col ? col.content.name : '';
  const prompt = buildCardPrompt(card, projectName, columnName);
  setChatContext({ label: `${p ? p.content.name : slug} · Board`, where: 'project-board:' + slug });
  compose(prompt);
}

function isOverdue(dueDate) {
  const today = new Date().toISOString().slice(0, 10);
  return dueDate < today;
}

function iconBtn(glyph, label, onClick, disabled = false) {
  return h('button', {
    class: 'icon-btn',
    'aria-label': label,
    title: label,
    disabled: disabled ? 'disabled' : false,
    onClick: (e) => { e.stopPropagation(); if (!disabled) onClick(); },
  }, [glyph]);
}

// --- Modals ---

// Assignee is picked from the operator roster (Team view). We store the
// human-readable display string (label, else a short npub) in the existing
// free-text `assignee` field so renderCard's pill stays readable and the card
// data shape is unchanged. An empty roster degrades to just "Unassigned"; a
// card whose current assignee predates the roster keeps its value as a
// selectable option so editing never silently drops it.
function assigneeDisplay(member) {
  const c = member.content;
  return c.label || (c.npub.length > 16 ? `${c.npub.slice(0, 8)}…${c.npub.slice(-6)}` : c.npub);
}

function buildAssigneeSelect(current) {
  const select = h('select', {});
  select.appendChild(h('option', { value: '', text: 'Unassigned' }));
  const options = new Set();
  for (const m of listMembers()) {
    const label = assigneeDisplay(m);
    if (options.has(label)) continue;
    options.add(label);
    select.appendChild(h('option', { value: label, text: label }));
  }
  if (current && !options.has(current)) {
    select.appendChild(h('option', { value: current, text: `${current} (not on roster)` }));
  }
  select.value = current || '';
  return select;
}

function openCardEditor(slug, columnId, card = null) {
  const editing = !!card;
  const c = card ? card.content : {};

  const titleInput = h('input', { type: 'text', maxlength: String(BOARD_LIMITS.CARD_TITLE), placeholder: 'Card title', value: c.title || '' });
  const descInput = h('textarea', { rows: 4, maxlength: String(BOARD_LIMITS.CARD_DESCRIPTION), placeholder: 'Description (optional)' });
  descInput.value = c.description || '';
  const assigneeInput = buildAssigneeSelect(c.assignee || '');
  const dueInput = h('input', { type: 'date', value: c.dueDate || '' });
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const actions = [
    h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
    h('button', { class: 'primary', onClick: () => submit() }, [editing ? 'Save' : 'Add card']),
  ];
  if (editing) {
    actions.unshift(h('button', {
      class: 'ghost',
      style: 'margin-right: auto; color: hsl(var(--destructive));',
      onClick: () => { deleteCard(slug, c.id); modal.close(); refresh(); },
    }, ['Delete']));
  }

  const body = h('div', {}, [
    formRow('Title', titleInput),
    formRow('Description', descInput),
    formRow('Assignee', assigneeInput),
    formRow('Due date', dueInput),
    errorEl,
    h('div', { class: 'form-actions' }, actions),
  ]);

  const modal = openModal({
    title: editing ? 'Edit card' : 'New card',
    subtitle: editing ? 'Update this card. Changes persist to your local, signable store.' : 'Cards are Nostr-shaped events, addressable and portable.',
    body,
  });
  titleInput.focus();

  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  function submit() {
    errorEl.textContent = '';
    const patch = {
      title: titleInput.value,
      description: descInput.value,
      assignee: assigneeInput.value,
      dueDate: dueInput.value || null,
    };
    try {
      if (editing) updateCard(slug, c.id, patch);
      else addCard(slug, columnId, patch);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function openColumnEditor(slug, col = null) {
  const editing = !!col;
  const nameInput = h('input', { type: 'text', maxlength: String(BOARD_LIMITS.COLUMN_NAME), placeholder: 'Column name', value: editing ? col.content.name : '' });
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const body = h('div', {}, [
    formRow('Name', nameInput),
    errorEl,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
      h('button', { class: 'primary', onClick: () => submit() }, [editing ? 'Rename' : 'Add column']),
    ]),
  ]);

  const modal = openModal({
    title: editing ? 'Rename column' : 'New column',
    subtitle: editing ? null : `Up to ${BOARD_LIMITS.MAX_COLUMNS} columns per board.`,
    body,
  });
  nameInput.focus();
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  function submit() {
    errorEl.textContent = '';
    try {
      if (editing) renameColumn(slug, col.content.id, nameInput.value);
      else addColumn(slug, nameInput.value);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function openDeleteColumn(slug, col, columns) {
  const colId = col.content.id;
  const cards = cardsFor(slug, colId);
  const others = columns.filter((c) => c.content.id !== colId);

  if (columns.length <= 1) {
    window.alert('A board needs at least one column.');
    return;
  }

  // Empty column → simple confirm, no card handling needed.
  if (cards.length === 0) {
    if (window.confirm(`Delete column "${col.content.name}"?`)) {
      try { deleteColumn(slug, colId); } catch (err) { window.alert(err.message); }
      refresh();
    }
    return;
  }

  // Non-empty → force a destination so no card is lost.
  const select = h('select', {},
    others.map((c) => h('option', { value: c.content.id, text: c.content.name })));
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const body = h('div', {}, [
    h('p', { class: 'muted', text: `"${col.content.name}" holds ${cards.length} card${cards.length === 1 ? '' : 's'}. Move them to another column, then delete.` }),
    formRow('Move cards to', select),
    errorEl,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
      h('button', { class: 'primary', onClick: () => submit() }, ['Move & delete']),
    ]),
  ]);

  const modal = openModal({ title: 'Delete column', subtitle: 'Cards are never lost — they are relocated first.', body });

  function submit() {
    errorEl.textContent = '';
    try {
      deleteColumn(slug, colId, select.value);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function formRow(label, control) {
  return h('div', { class: 'form-row' }, [h('label', { text: label }), control]);
}
