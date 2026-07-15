/**
 * Kanban board store tests — pure data layer, no DOM. localStorage is a tiny
 * in-memory stub (mirrors data/agent.test.js). Covers defaults, per-project
 * isolation, column ops, card ops, move primitives (the logic behind both
 * drag and the accessible keyboard/mobile controls), migration of legacy
 * persisted state, input validation, and dashboard/project regressions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

// store.js keeps module-level state, so re-import fresh per test with a clean
// localStorage. vitest resetModules gives each test its own module instance.
let store;
async function freshStore() {
  const stub = makeStorageStub();
  globalThis.localStorage = stub;
  vi.resetModules();
  store = await import('./store.js');
  store.initStore();
  return stub;
}

beforeEach(async () => {
  await freshStore();
});
afterEach(() => {
  delete globalThis.localStorage;
});

const SLUG = 'continuum'; // one of the seeded projects
const OTHER = 'torii-quest';

describe('defaults', () => {
  it('materialises Todo/Doing/Done for a project on first access', () => {
    const cols = store.boardColumnsFor(SLUG);
    expect(cols.map((c) => c.content.name)).toEqual(['Todo', 'Doing', 'Done']);
    expect(cols.map((c) => c.content.order)).toEqual([0, 1, 2]);
  });

  it('is idempotent — accessing twice does not duplicate columns', () => {
    store.boardColumnsFor(SLUG);
    const cols = store.boardColumnsFor(SLUG);
    expect(cols).toHaveLength(3);
  });

  it('starts every column empty', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    expect(store.cardsFor(SLUG, todo.content.id)).toEqual([]);
  });
});

describe('project isolation', () => {
  it('keeps columns and cards separate per project', () => {
    const [a] = store.boardColumnsFor(SLUG);
    const [b] = store.boardColumnsFor(OTHER);
    store.addCard(SLUG, a.content.id, { title: 'A-only' });
    expect(store.cardsFor(SLUG, a.content.id)).toHaveLength(1);
    expect(store.cardsFor(OTHER, b.content.id)).toHaveLength(0);
    // Column ids do not collide across projects.
    expect(a.content.id).not.toBe(b.content.id);
  });

  it('adding a column to one project does not affect another', () => {
    store.addColumn(SLUG, 'Review');
    expect(store.boardColumnsFor(SLUG)).toHaveLength(4);
    expect(store.boardColumnsFor(OTHER)).toHaveLength(3);
  });
});

describe('column operations', () => {
  it('adds, renames, and appends at the end', () => {
    const ev = store.addColumn(SLUG, 'Review');
    expect(ev.content.order).toBe(3);
    store.renameColumn(SLUG, ev.content.id, '  Code Review  ');
    expect(store.boardColumnsFor(SLUG)[3].content.name).toBe('Code Review');
  });

  it('reorders via explicit id permutation', () => {
    const cols = store.boardColumnsFor(SLUG);
    const ids = cols.map((c) => c.content.id);
    store.reorderColumns(SLUG, [ids[2], ids[0], ids[1]]);
    expect(store.boardColumnsFor(SLUG).map((c) => c.content.name))
      .toEqual(['Done', 'Todo', 'Doing']);
  });

  it('ignores a reorder list that is not a full permutation', () => {
    const ids = store.boardColumnsFor(SLUG).map((c) => c.content.id);
    store.reorderColumns(SLUG, [ids[0]]); // partial
    expect(store.boardColumnsFor(SLUG).map((c) => c.content.name))
      .toEqual(['Todo', 'Doing', 'Done']);
  });

  it('moves a column left/right (accessible control)', () => {
    const ids = store.boardColumnsFor(SLUG).map((c) => c.content.id);
    store.moveColumn(SLUG, ids[0], 'right');
    expect(store.boardColumnsFor(SLUG).map((c) => c.content.name))
      .toEqual(['Doing', 'Todo', 'Done']);
    store.moveColumn(SLUG, ids[0], 'left'); // Todo back to front
    expect(store.boardColumnsFor(SLUG).map((c) => c.content.name))
      .toEqual(['Todo', 'Doing', 'Done']);
  });

  it('clamps column moves at the edges (no throw, no-op)', () => {
    const ids = store.boardColumnsFor(SLUG).map((c) => c.content.id);
    store.moveColumn(SLUG, ids[0], 'left'); // already first
    expect(store.boardColumnsFor(SLUG)[0].content.name).toBe('Todo');
  });

  it('deletes an empty column and closes the order gap', () => {
    const doing = store.boardColumnsFor(SLUG)[1];
    store.deleteColumn(SLUG, doing.content.id);
    const cols = store.boardColumnsFor(SLUG);
    expect(cols.map((c) => c.content.name)).toEqual(['Todo', 'Done']);
    expect(cols.map((c) => c.content.order)).toEqual([0, 1]);
  });

  it('refuses to delete the final column', () => {
    const cols = store.boardColumnsFor(SLUG);
    store.deleteColumn(SLUG, cols[2].content.id);
    store.deleteColumn(SLUG, cols[1].content.id);
    expect(() => store.deleteColumn(SLUG, cols[0].content.id)).toThrow(/at least one/i);
  });
});

describe('safe column deletion (never lose cards)', () => {
  it('blocks deleting a column that still holds cards without a destination', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    store.addCard(SLUG, todo.content.id, { title: 'keep me' });
    expect(() => store.deleteColumn(SLUG, todo.content.id)).toThrow(/move/i);
    // Card survives the failed delete.
    expect(store.cardsFor(SLUG, todo.content.id)).toHaveLength(1);
  });

  it('relocates cards to the destination column, then deletes', () => {
    const cols = store.boardColumnsFor(SLUG);
    const [todo, doing] = cols;
    store.addCard(SLUG, todo.content.id, { title: 'one' });
    store.addCard(SLUG, todo.content.id, { title: 'two' });
    store.addCard(SLUG, doing.content.id, { title: 'existing' });
    store.deleteColumn(SLUG, todo.content.id, doing.content.id);
    const moved = store.cardsFor(SLUG, doing.content.id);
    expect(moved.map((c) => c.content.title)).toEqual(['existing', 'one', 'two']);
    expect(moved.map((c) => c.content.order)).toEqual([0, 1, 2]);
    expect(store.boardColumnsFor(SLUG).map((c) => c.content.name)).toEqual(['Doing', 'Done']);
  });

  it('rejects a bogus destination column', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    store.addCard(SLUG, todo.content.id, { title: 'x' });
    expect(() => store.deleteColumn(SLUG, todo.content.id, 'no-such-col')).toThrow(/valid destination/i);
  });
});

describe('card operations', () => {
  it('creates a card with optional assignee and due date', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const card = store.addCard(SLUG, todo.content.id, {
      title: 'Wire NIP-07', description: 'signer flow', assignee: 'chief', dueDate: '2026-08-01',
    });
    expect(card.content.title).toBe('Wire NIP-07');
    expect(card.content.assignee).toBe('chief');
    expect(card.content.dueDate).toBe('2026-08-01');
    expect(card.content.order).toBe(0);
  });

  it('edits fields in place and bumps updatedAt', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const card = store.addCard(SLUG, todo.content.id, { title: 'draft' });
    const before = card.content.updatedAt;
    store.updateCard(SLUG, card.content.id, { title: 'final', description: 'done' });
    const again = store.cardsFor(SLUG, todo.content.id)[0];
    expect(again.content.title).toBe('final');
    expect(again.content.description).toBe('done');
    expect(again.content.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('deletes a card and reindexes the column densely', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const a = store.addCard(SLUG, todo.content.id, { title: 'a' });
    store.addCard(SLUG, todo.content.id, { title: 'b' });
    store.addCard(SLUG, todo.content.id, { title: 'c' });
    store.deleteCard(SLUG, a.content.id);
    const rest = store.cardsFor(SLUG, todo.content.id);
    expect(rest.map((c) => c.content.title)).toEqual(['b', 'c']);
    expect(rest.map((c) => c.content.order)).toEqual([0, 1]);
  });
});

describe('moveCard (drag + accessible controls share this primitive)', () => {
  it('reorders within a column', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const a = store.addCard(SLUG, todo.content.id, { title: 'a' });
    store.addCard(SLUG, todo.content.id, { title: 'b' });
    store.addCard(SLUG, todo.content.id, { title: 'c' });
    store.moveCard(SLUG, a.content.id, todo.content.id, 2); // a -> end
    expect(store.cardsFor(SLUG, todo.content.id).map((c) => c.content.title))
      .toEqual(['b', 'c', 'a']);
  });

  it('moves across columns at a chosen index', () => {
    const cols = store.boardColumnsFor(SLUG);
    const [todo, doing] = cols;
    const a = store.addCard(SLUG, todo.content.id, { title: 'a' });
    store.addCard(SLUG, doing.content.id, { title: 'x' });
    store.addCard(SLUG, doing.content.id, { title: 'y' });
    store.moveCard(SLUG, a.content.id, doing.content.id, 1); // between x and y
    expect(store.cardsFor(SLUG, todo.content.id)).toHaveLength(0);
    expect(store.cardsFor(SLUG, doing.content.id).map((c) => c.content.title))
      .toEqual(['x', 'a', 'y']);
  });

  it('clamps an out-of-range target index to the end', () => {
    const cols = store.boardColumnsFor(SLUG);
    const [todo, doing] = cols;
    const a = store.addCard(SLUG, todo.content.id, { title: 'a' });
    store.addCard(SLUG, doing.content.id, { title: 'x' });
    store.moveCard(SLUG, a.content.id, doing.content.id, 999);
    expect(store.cardsFor(SLUG, doing.content.id).map((c) => c.content.title))
      .toEqual(['x', 'a']);
  });

  it('keeps both source and destination orders dense after a cross move', () => {
    const cols = store.boardColumnsFor(SLUG);
    const [todo, doing] = cols;
    const a = store.addCard(SLUG, todo.content.id, { title: 'a' });
    store.addCard(SLUG, todo.content.id, { title: 'b' });
    store.moveCard(SLUG, a.content.id, doing.content.id, 0);
    expect(store.cardsFor(SLUG, todo.content.id).map((c) => c.content.order)).toEqual([0]);
    expect(store.cardsFor(SLUG, doing.content.id).map((c) => c.content.order)).toEqual([0]);
  });
});

describe('input validation & payload bounds', () => {
  it('rejects an empty/whitespace card title', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    expect(() => store.addCard(SLUG, todo.content.id, { title: '   ' })).toThrow(/title/i);
  });

  it('rejects an empty column name on add and rename', () => {
    expect(() => store.addColumn(SLUG, '   ')).toThrow(/name/i);
    const [todo] = store.boardColumnsFor(SLUG);
    expect(() => store.renameColumn(SLUG, todo.content.id, '')).toThrow(/name/i);
  });

  it('clamps over-long text to the configured limits', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const long = 'x'.repeat(5000);
    const card = store.addCard(SLUG, todo.content.id, { title: long, description: long, assignee: long });
    expect(card.content.title).toHaveLength(store.BOARD_LIMITS.CARD_TITLE);
    expect(card.content.description).toHaveLength(store.BOARD_LIMITS.CARD_DESCRIPTION);
    expect(card.content.assignee).toHaveLength(store.BOARD_LIMITS.CARD_ASSIGNEE);
  });

  it('drops a malformed due date rather than storing it', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    const card = store.addCard(SLUG, todo.content.id, { title: 't', dueDate: 'not-a-date' });
    expect(card.content.dueDate).toBeNull();
  });

  it('caps columns per board', () => {
    for (let i = store.boardColumnsFor(SLUG).length; i < store.BOARD_LIMITS.MAX_COLUMNS; i++) {
      store.addColumn(SLUG, `col-${i}`);
    }
    expect(() => store.addColumn(SLUG, 'overflow')).toThrow(/at most/i);
  });

  it('caps cards per column', () => {
    const [todo] = store.boardColumnsFor(SLUG);
    for (let i = 0; i < store.BOARD_LIMITS.MAX_CARDS_PER_COLUMN; i++) {
      store.addCard(SLUG, todo.content.id, { title: `c${i}` });
    }
    expect(() => store.addCard(SLUG, todo.content.id, { title: 'overflow' })).toThrow(/at most/i);
  });
});

describe('persistence & migration', () => {
  it('persists board state across a reload (new store instance, same storage)', async () => {
    const stub = globalThis.localStorage;
    const [todo] = store.boardColumnsFor(SLUG);
    store.addCard(SLUG, todo.content.id, { title: 'survive reload' });

    vi.resetModules();
    const store2 = await import('./store.js');
    store2.initStore();
    const cols = store2.boardColumnsFor(SLUG);
    const cards = store2.cardsFor(SLUG, cols[0].content.id);
    expect(cards.map((c) => c.content.title)).toContain('survive reload');
    expect(stub).toBe(globalThis.localStorage); // same backing store
  });

  it('migrates legacy state with no columns/cards keys without data loss', async () => {
    // Simulate a persisted blob from before the board existed.
    const legacy = {
      projects: [{
        id: null, pubkey: null, created_at: 1000, kind: 30078, sig: null,
        tags: [['d', 'legacy']],
        content: { slug: 'legacy', name: 'Legacy', description: '', source: 'local', status: 'active', createdAt: 1000, tagList: [] },
      }],
      sessions: [], milestones: [], todos: [], files: [],
    };
    const stub = makeStorageStub();
    stub.setItem('continuum.v1', JSON.stringify(legacy));
    globalThis.localStorage = stub;
    vi.resetModules();
    const store2 = await import('./store.js');
    store2.initStore();
    // Legacy project still there; board lazily created on access.
    expect(store2.getProject('legacy')).not.toBeNull();
    const cols = store2.boardColumnsFor('legacy');
    expect(cols.map((c) => c.content.name)).toEqual(['Todo', 'Doing', 'Done']);
  });
});

describe('regressions — existing project surface still works', () => {
  it('deleteProject cascades board columns and cards', () => {
    const created = store.createProject({ name: 'Temp Board Proj' });
    const slug = created.content.slug;
    const [c0] = store.boardColumnsFor(slug);
    store.addCard(slug, c0.content.id, { title: 'temp' });
    store.deleteProject(slug);
    expect(store.getProject(slug)).toBeNull();
    // No orphaned board events remain for that slug.
    const state = store.getState();
    expect(state.columns.some((c) => c.content.projectSlug === slug)).toBe(false);
    expect(state.cards.some((c) => c.content.projectSlug === slug)).toBe(false);
  });

  it('leaves todos/milestones/sessions untouched by board ops', () => {
    const beforeTodos = store.todosFor(SLUG).length;
    const [todo] = store.boardColumnsFor(SLUG);
    store.addCard(SLUG, todo.content.id, { title: 'unrelated' });
    expect(store.todosFor(SLUG).length).toBe(beforeTodos);
    expect(store.milestonesFor(SLUG).length).toBeGreaterThan(0);
  });
});
