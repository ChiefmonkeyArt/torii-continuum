/**
 * Continuum local store. Persists Nostr-shaped events to localStorage.
 * Exposes a tiny subscribable state layer used by the views.
 *
 * The store's public surface is intentionally small so that when we
 * flip to relays we only rewrite `load` / `save` — the callers never
 * see localStorage keys.
 */

import { KIND, makeEvent, newId, nowSec } from './schema.js';
import { seedProjects, seedSessions, seedMilestones, seedTodos, seedFiles, seedMarketTasks, seedRoutstr } from './seed.js';

const STORAGE_KEY = 'continuum.v1';

const listeners = new Set();
let state = null;

function emptyState() {
  return {
    projects: [],   // events kind 30078
    sessions: [],   // events kind 30079
    milestones: [], // events kind 30080
    todos: [],      // events kind 30081
    files: [],      // events kind 30082
    columns: [],    // events kind 30083 (board columns)
    cards: [],      // events kind 30084 (board cards)
    marketTasks: [],// events kind 30090
    routstr: null,  // event kind 30091
    members: [],    // events kind 30093 (operator roster; global, not per-project)
  };
}

function loadRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[continuum] persist failed', e);
  }
}

export function initStore() {
  const loaded = loadRaw();
  if (loaded && Array.isArray(loaded.projects) && loaded.projects.length > 0) {
    state = { ...emptyState(), ...loaded };
    // Guarantee shape after schema evolution. Older persisted state predates
    // the Kanban board (kinds 30083/30084); coerce the arrays so board reads
    // never touch `undefined`. Existing projects get their default columns
    // lazily on first board access (see ensureBoard) — no destructive rewrite.
    if (!Array.isArray(state.columns)) state.columns = [];
    if (!Array.isArray(state.cards)) state.cards = [];
    if (!Array.isArray(state.members)) state.members = [];
    if (!Array.isArray(state.marketTasks) || state.marketTasks.length === 0) {
      state.marketTasks = seedMarketTasks();
    }
    if (!state.routstr) state.routstr = seedRoutstr();
  } else {
    state = seedInitialState();
    persist();
  }
  return state;
}

function seedInitialState() {
  const s = emptyState();
  s.projects = seedProjects();
  s.sessions = seedSessions();
  s.milestones = seedMilestones();
  s.todos = seedTodos();
  s.files = seedFiles();
  s.marketTasks = seedMarketTasks();
  s.routstr = seedRoutstr();
  return s;
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

// --- Projects ---

export function listProjects() {
  return state.projects.slice().sort((a, b) => b.created_at - a.created_at);
}

export function getProject(slug) {
  return state.projects.find((p) => p.content.slug === slug) || null;
}

export function createProject({ name, description, source, sourceUrl, tags = [] }) {
  const slug = slugify(name);
  if (state.projects.some((p) => p.content.slug === slug)) {
    throw new Error(`A project with slug "${slug}" already exists.`);
  }
  const ev = makeEvent({
    kind: KIND.PROJECT,
    d: slug,
    content: {
      slug,
      name,
      description: description || '',
      source: source || 'local',      // 'github' | 'ngit' | 'local'
      sourceUrl: sourceUrl || null,
      status: 'active',
      createdAt: nowSec(),
      tagList: tags,
    },
    tags: [['t', 'continuum-project'], ...tags.map((t) => ['t', t])],
  });
  state.projects.push(ev);
  persist();
  notify();
  return ev;
}

export function deleteProject(slug) {
  const p = getProject(slug);
  if (!p) return;
  state.projects = state.projects.filter((x) => x !== p);
  // Cascade
  state.sessions = state.sessions.filter((s) => s.content.projectSlug !== slug);
  state.milestones = state.milestones.filter((m) => m.content.projectSlug !== slug);
  state.todos = state.todos.filter((t) => t.content.projectSlug !== slug);
  state.files = state.files.filter((f) => f.content.projectSlug !== slug);
  state.columns = state.columns.filter((c) => c.content.projectSlug !== slug);
  state.cards = state.cards.filter((c) => c.content.projectSlug !== slug);
  persist();
  notify();
}

// --- Sessions ---
export function sessionsFor(slug) {
  return state.sessions
    .filter((s) => s.content.projectSlug === slug)
    .sort((a, b) => b.content.startedAt - a.content.startedAt);
}

// --- Milestones ---
export function milestonesFor(slug) {
  return state.milestones
    .filter((m) => m.content.projectSlug === slug)
    .sort((a, b) => a.content.index - b.content.index);
}

// --- Todos ---
export function todosFor(slug) {
  return state.todos
    .filter((t) => t.content.projectSlug === slug)
    .sort((a, b) => a.content.order - b.content.order);
}

export function addTodo(slug, text) {
  const existing = todosFor(slug);
  const ev = makeEvent({
    kind: KIND.TODO,
    d: `${slug}:${newId('todo')}`,
    content: {
      projectSlug: slug,
      text,
      done: false,
      order: existing.length,
      createdAt: nowSec(),
    },
    tags: [['a', `${30078}:${slug}`], ['t', 'todo']],
  });
  state.todos.push(ev);
  persist();
  notify();
  return ev;
}

export function toggleTodo(ev) {
  ev.content.done = !ev.content.done;
  ev.created_at = nowSec();
  persist();
  notify();
}

// --- Files ---
export function filesFor(slug) {
  return state.files
    .filter((f) => f.content.projectSlug === slug)
    .sort((a, b) => a.content.path.localeCompare(b.content.path));
}

// --- Kanban board (columns 30083, cards 30084) ---

// Limits keep the persisted payload bounded (localStorage is finite and the
// whole state is JSON-serialised on every write) and defend the render path
// from pathological input. They are generous for real use but hard caps.
export const BOARD_LIMITS = Object.freeze({
  MAX_COLUMNS: 20,
  MAX_CARDS_PER_COLUMN: 200,
  COLUMN_NAME: 40,
  CARD_TITLE: 120,
  CARD_DESCRIPTION: 2000,
  CARD_ASSIGNEE: 80,
});

const DEFAULT_COLUMNS = ['Todo', 'Doing', 'Done'];

function cleanText(value, max) {
  // Collapse control chars (incl. newlines for single-line fields when max is
  // small) is left to callers; here we only trim and clamp length. Rendering
  // is always via textContent (see views/util.js h()), so this is about
  // payload size, not escaping.
  return String(value == null ? '' : value).trim().slice(0, max);
}

/**
 * Lazily materialise the three default columns (Todo, Doing, Done) for a
 * project the first time its board is touched. This is what makes migration
 * safe: existing projects (and freshly created ones) gain a board on demand
 * without a bulk rewrite of persisted state, and every project is guaranteed
 * the same starting columns. Isolated per project by `projectSlug`.
 */
export function ensureBoard(slug) {
  const has = state.columns.some((c) => c.content.projectSlug === slug);
  if (has) return;
  DEFAULT_COLUMNS.forEach((name, index) => {
    state.columns.push(makeColumnEvent(slug, name, index));
  });
  persist();
}

function makeColumnEvent(slug, name, order) {
  const id = newId('col');
  return makeEvent({
    kind: KIND.BOARD_COLUMN,
    d: `${slug}:col:${id}`,
    content: { projectSlug: slug, id, name, order, createdAt: nowSec() },
    tags: [['a', `${KIND.PROJECT}:${slug}`], ['t', 'continuum-board-column']],
  });
}

export function boardColumnsFor(slug) {
  ensureBoard(slug);
  return state.columns
    .filter((c) => c.content.projectSlug === slug)
    .sort((a, b) => a.content.order - b.content.order);
}

export function cardsFor(slug, columnId) {
  return state.cards
    .filter((c) => c.content.projectSlug === slug && c.content.columnId === columnId)
    .sort((a, b) => a.content.order - b.content.order);
}

function getColumn(slug, columnId) {
  return state.columns.find(
    (c) => c.content.projectSlug === slug && c.content.id === columnId,
  ) || null;
}

// Classify a column name into a status bucket. Inverse of board.js's
// columnForStatus() and shares its regex vocabulary so board placement and
// dashboard progress agree. Order matters: 'done' and 'doing' are checked
// before the broad todo/backlog patterns. Unmatched names fall through to
// 'todo' (the neutral default).
function bucketForColumnName(name) {
  const n = String(name || '');
  if (/done|complete|shipped/i.test(n)) return 'done';
  if (/doing|progress|active|wip|review/i.test(n)) return 'doing';
  if (/backlog|icebox|someday/i.test(n)) return 'backlog';
  if (/todo|to do|to-do|inbox/i.test(n)) return 'todo';
  return 'todo';
}

/**
 * Real kanban progress for a project's board. Pure data — no DOM. Counts cards
 * per column, folds each column into a status bucket, and derives a completion
 * percent as done/total. Safe for a project with no board or no cards (all
 * zeros, percent 0). This is the single source of truth behind the dashboard's
 * per-project progress.
 */
export function boardStatsFor(slug) {
  ensureBoard(slug);
  const stats = { total: 0, backlog: 0, todo: 0, doing: 0, done: 0, percent: 0 };
  for (const col of boardColumnsFor(slug)) {
    const bucket = bucketForColumnName(col.content.name);
    const count = cardsFor(slug, col.content.id).length;
    stats[bucket] += count;
    stats.total += count;
  }
  stats.percent = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  return stats;
}

// Rewrite the `order` field of a column's cards to a dense 0..n-1 sequence,
// preserving their current relative order. Keeps move/insert math simple and
// stops `order` values from drifting.
function reindexCards(slug, columnId) {
  cardsFor(slug, columnId).forEach((card, i) => { card.content.order = i; });
}

export function addColumn(slug, name) {
  ensureBoard(slug);
  const clean = cleanText(name, BOARD_LIMITS.COLUMN_NAME);
  if (!clean) throw new Error('Column needs a name.');
  const cols = boardColumnsFor(slug);
  if (cols.length >= BOARD_LIMITS.MAX_COLUMNS) {
    throw new Error(`A board can have at most ${BOARD_LIMITS.MAX_COLUMNS} columns.`);
  }
  const ev = makeColumnEvent(slug, clean, cols.length);
  state.columns.push(ev);
  persist();
  notify();
  return ev;
}

export function renameColumn(slug, columnId, name) {
  const col = getColumn(slug, columnId);
  if (!col) throw new Error('No such column.');
  const clean = cleanText(name, BOARD_LIMITS.COLUMN_NAME);
  if (!clean) throw new Error('Column needs a name.');
  col.content.name = clean;
  col.created_at = nowSec();
  persist();
  notify();
  return col;
}

export function reorderColumns(slug, orderedIds) {
  const cols = boardColumnsFor(slug);
  const known = new Set(cols.map((c) => c.content.id));
  // Only accept a permutation of the existing ids — ignore unknown/missing.
  const valid = orderedIds.filter((id) => known.has(id));
  if (valid.length !== cols.length) return; // refuse partial/foreign lists
  const rank = new Map(valid.map((id, i) => [id, i]));
  cols.forEach((c) => { c.content.order = rank.get(c.content.id); });
  persist();
  notify();
}

/**
 * Move a column one slot left/right. Convenience for the accessible
 * (keyboard/mobile) reorder controls, which can't drag.
 */
export function moveColumn(slug, columnId, direction) {
  const cols = boardColumnsFor(slug);
  const idx = cols.findIndex((c) => c.content.id === columnId);
  if (idx < 0) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= cols.length) return;
  const ids = cols.map((c) => c.content.id);
  [ids[idx], ids[target]] = [ids[target], ids[idx]];
  reorderColumns(slug, ids);
}

/**
 * Delete a column without ever losing cards. If the column holds cards the
 * caller MUST pass `moveToColumnId` (an existing sibling) so they are relocated
 * first; otherwise we throw and the UI blocks the delete. Also refuses to
 * remove the final column so a board is never left with nowhere to put cards.
 */
export function deleteColumn(slug, columnId, moveToColumnId = null) {
  const col = getColumn(slug, columnId);
  if (!col) throw new Error('No such column.');
  const cols = boardColumnsFor(slug);
  if (cols.length <= 1) throw new Error('A board needs at least one column.');
  const cards = cardsFor(slug, columnId);
  if (cards.length > 0) {
    if (!moveToColumnId || moveToColumnId === columnId) {
      throw new Error('Move this column\'s cards before deleting it.');
    }
    const dest = getColumn(slug, moveToColumnId);
    if (!dest) throw new Error('Choose a valid destination column.');
    let base = cardsFor(slug, moveToColumnId).length;
    for (const card of cards) {
      card.content.columnId = moveToColumnId;
      card.content.order = base++;
      card.created_at = nowSec();
    }
  }
  state.columns = state.columns.filter((c) => c !== col);
  // Close the order gap left by the removed column.
  boardColumnsFor(slug).forEach((c, i) => { c.content.order = i; });
  persist();
  notify();
}

export function addCard(slug, columnId, { title, description = '', assignee = '', dueDate = null } = {}) {
  const col = getColumn(slug, columnId);
  if (!col) throw new Error('No such column.');
  const cleanTitle = cleanText(title, BOARD_LIMITS.CARD_TITLE);
  if (!cleanTitle) throw new Error('A card needs a title.');
  const existing = cardsFor(slug, columnId);
  if (existing.length >= BOARD_LIMITS.MAX_CARDS_PER_COLUMN) {
    throw new Error(`A column can hold at most ${BOARD_LIMITS.MAX_CARDS_PER_COLUMN} cards.`);
  }
  const id = newId('card');
  const ev = makeEvent({
    kind: KIND.BOARD_CARD,
    d: `${slug}:card:${id}`,
    content: {
      projectSlug: slug,
      columnId,
      id,
      title: cleanTitle,
      description: cleanText(description, BOARD_LIMITS.CARD_DESCRIPTION),
      assignee: cleanText(assignee, BOARD_LIMITS.CARD_ASSIGNEE),
      dueDate: normalizeDueDate(dueDate),
      order: existing.length,
      createdAt: nowSec(),
      updatedAt: nowSec(),
    },
    tags: [['a', `${KIND.PROJECT}:${slug}`], ['t', 'continuum-board-card']],
  });
  state.cards.push(ev);
  persist();
  notify();
  return ev;
}

function getCard(slug, cardId) {
  return state.cards.find(
    (c) => c.content.projectSlug === slug && c.content.id === cardId,
  ) || null;
}

// Accept only YYYY-MM-DD (the <input type="date"> value) or null. Anything
// else is dropped rather than stored, so a card's dueDate is always safe to
// render and compare.
function normalizeDueDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function updateCard(slug, cardId, patch = {}) {
  const card = getCard(slug, cardId);
  if (!card) throw new Error('No such card.');
  const c = card.content;
  if ('title' in patch) {
    const t = cleanText(patch.title, BOARD_LIMITS.CARD_TITLE);
    if (!t) throw new Error('A card needs a title.');
    c.title = t;
  }
  if ('description' in patch) c.description = cleanText(patch.description, BOARD_LIMITS.CARD_DESCRIPTION);
  if ('assignee' in patch) c.assignee = cleanText(patch.assignee, BOARD_LIMITS.CARD_ASSIGNEE);
  if ('dueDate' in patch) c.dueDate = normalizeDueDate(patch.dueDate);
  c.updatedAt = nowSec();
  card.created_at = nowSec();
  persist();
  notify();
  return card;
}

export function deleteCard(slug, cardId) {
  const card = getCard(slug, cardId);
  if (!card) return;
  const { columnId } = card.content;
  state.cards = state.cards.filter((c) => c !== card);
  reindexCards(slug, columnId);
  persist();
  notify();
}

/**
 * Move a card to `toColumnId` at position `toIndex` (clamped). Works for both
 * intra-column reordering and cross-column moves, and is the single primitive
 * behind drag-drop AND the accessible arrow-button controls. Reindexes both
 * the source and destination columns so `order` stays dense.
 */
export function moveCard(slug, cardId, toColumnId, toIndex = Number.MAX_SAFE_INTEGER) {
  const card = getCard(slug, cardId);
  if (!card) throw new Error('No such card.');
  const dest = getColumn(slug, toColumnId);
  if (!dest) throw new Error('No such destination column.');
  const fromColumnId = card.content.columnId;

  if (fromColumnId !== toColumnId
      && cardsFor(slug, toColumnId).length >= BOARD_LIMITS.MAX_CARDS_PER_COLUMN) {
    throw new Error(`A column can hold at most ${BOARD_LIMITS.MAX_CARDS_PER_COLUMN} cards.`);
  }

  // Pull the card out of its current column ordering.
  card.content.columnId = toColumnId;
  card.content.order = -1; // temporary: sorts first within destination
  reindexCards(slug, fromColumnId);

  // Reinsert at the requested slot within the destination column.
  const destCards = cardsFor(slug, toColumnId).filter((c) => c !== card);
  const clamped = Math.max(0, Math.min(toIndex, destCards.length));
  destCards.splice(clamped, 0, card);
  destCards.forEach((c, i) => { c.content.order = i; });
  card.created_at = nowSec();
  card.content.updatedAt = nowSec();

  persist();
  notify();
  return card;
}

// --- Marketplace ---
export function listMarketTasks() {
  return state.marketTasks.slice();
}

// --- Routstr ---
export function getRoutstr() { return state.routstr; }
export function updateRoutstr(patch) {
  state.routstr.content = { ...state.routstr.content, ...patch };
  state.routstr.created_at = nowSec();
  persist();
  notify();
}

// --- Team / operator roster (kind 30093) ---
//
// LOCAL-FIRST FOUNDATION. The roster is a local list of npubs the admin has
// designated as operators. It carries NO authorization weight yet — the agent's
// requireAdmin is unchanged. Real multi-user auth (agent-side operator
// allow-list, relay sync, NIP-17 invite/accept) is deferred to TEAMS-2.
//
// Members are GLOBAL (workspace-wide), not per-project, so deleteProject does
// not cascade to them.

const MEMBER_LABEL_MAX = 40;
const NPUB_HEX_RE = /^[0-9a-f]{64}$/;

export function listMembers() {
  return state.members
    .slice()
    .sort((a, b) => a.content.addedAt - b.content.addedAt);
}

export function addMember({ npub, label } = {}) {
  const hex = String(npub == null ? '' : npub).trim().toLowerCase();
  if (!NPUB_HEX_RE.test(hex)) {
    throw new Error('Enter a valid npub (64 hex characters).');
  }
  if (state.members.some((m) => m.content.npub === hex)) {
    throw new Error('That operator is already on the roster.');
  }
  const ev = makeEvent({
    kind: KIND.TEAM_MEMBER,
    d: `member:${hex}`,
    content: {
      npub: hex,
      label: cleanText(label, MEMBER_LABEL_MAX),
      role: 'operator',
      addedAt: nowSec(),
      addedBy: 'admin',
    },
    tags: [['t', 'continuum-team-member']],
  });
  state.members.push(ev);
  persist();
  notify();
  return ev;
}

export function removeMember(npub) {
  const hex = String(npub == null ? '' : npub).trim().toLowerCase();
  const before = state.members.length;
  state.members = state.members.filter((m) => m.content.npub !== hex);
  if (state.members.length === before) return;
  persist();
  notify();
}

// --- helpers ---
function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || `project-${Date.now().toString(36)}`;
}
