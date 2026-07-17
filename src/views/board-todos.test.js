/**
 * Board todo overlay — project todos surface as read-only cards
 * (KANBAN-TODO-OVERLAY, v0.2.63-alpha).
 *
 * Regression guard for the live v0.2.62 acceptance defect: both board routes
 * rendered Todo/Doing/Done with "0 cards" even though the project had nonzero
 * open todos, because the board read only native store cards (empty until a
 * card is manually added) plus the agent import set (empty when logged out).
 * A project's todos (kind 30081) are now mirrored onto the board as read-only
 * cards, never written to the store, so the board reflects real work.
 *
 * filterTodosForColumn is the pure distribution primitive both the counts and
 * the rendered todo cards flow through — tested here without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { filterTodosForColumn } from './board.js';

const here = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(here, 'board.js'), 'utf8');

const columns = [
  { content: { id: 'c-todo', name: 'Todo' } },
  { content: { id: 'c-doing', name: 'Doing' } },
  { content: { id: 'c-done', name: 'Done' } },
];

const todos = [
  { content: { text: 'open 1', done: false } },
  { content: { text: 'open 2', done: false } },
  { content: { text: 'shipped', done: true } },
];

describe('filterTodosForColumn — distribution by done-state → column', () => {
  it('routes open todos to the Todo column and done todos to the Done column', () => {
    expect(filterTodosForColumn(todos, 'c-todo', columns).map((t) => t.content.text))
      .toEqual(['open 1', 'open 2']);
    expect(filterTodosForColumn(todos, 'c-done', columns).map((t) => t.content.text))
      .toEqual(['shipped']);
    // Doing has no todos — todos only ever bucket to todo/done.
    expect(filterTodosForColumn(todos, 'c-doing', columns)).toEqual([]);
  });

  it('the per-column sum equals the whole todo set (nothing lost or double-counted)', () => {
    const total = columns.reduce(
      (n, c) => n + filterTodosForColumn(todos, c.content.id, columns).length,
      0,
    );
    expect(total).toBe(todos.length);
  });

  it('falls back to the first column when no Todo-named column exists', () => {
    const custom = [
      { content: { id: 'x', name: 'Inbox' } },
      { content: { id: 'y', name: 'Doing' } },
    ];
    // "Inbox" matches the todo vocabulary, so open todos land there.
    expect(filterTodosForColumn([{ content: { text: 'o', done: false } }], 'x', custom))
      .toHaveLength(1);
  });

  it('is defensive against non-array / malformed input', () => {
    expect(filterTodosForColumn(null, 'c-todo', columns)).toEqual([]);
    expect(filterTodosForColumn(undefined, 'c-todo', columns)).toEqual([]);
    expect(filterTodosForColumn([{}], 'c-todo', columns)).toHaveLength(1); // missing content.done → open
  });
});

describe('board.js — counts and empty-check include todo cards', () => {
  it('header total adds todo cards per column', () => {
    expect(boardSrc).toMatch(/todoCardsFor\(slug, c\.content\.id, columns\)\.length/);
  });

  it('per-column count adds todoCards.length alongside native + imported', () => {
    expect(boardSrc).toMatch(/cards\.length \+ imported\.length \+ todoCards\.length/);
  });

  it('empty-column check accounts for todo cards', () => {
    expect(boardSrc).toMatch(/cards\.length === 0 && imported\.length === 0 && todoCards\.length === 0/);
  });
});

describe('board.js — todo cards are read-only and never mutate the store', () => {
  it('renders todo cards read-only: not draggable, no move/edit controls', () => {
    const fn = boardSrc.slice(
      boardSrc.indexOf('function renderTodoCard'),
      boardSrc.indexOf('function renderSyncBar'),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain("draggable: 'true'");
    expect(fn).not.toContain('card-moves');
    expect(fn).toContain("class: 'board-card imported todo-card'");
  });

  it('todo cards announce their read-only state to assistive tech', () => {
    expect(boardSrc).toContain('Read-only project todo card:');
  });

  it('the todo overlay is display-only — never writes todos to the board store', () => {
    expect(boardSrc).not.toMatch(/addCard\([^)]*todo/);
    expect(boardSrc).not.toMatch(/updateCard\([^)]*todo/);
  });

  it('links each todo card back to the Overview tab for editing', () => {
    expect(boardSrc).toMatch(/href:\s*`#\/projects\/\$\{slug\}`/);
  });
});
