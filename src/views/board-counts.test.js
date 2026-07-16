/**
 * Board card counts — imported read-only cards must be counted (v0.2.49-alpha).
 *
 * Regression guard for the v0.2.48 live Kanban UX defect: the board header
 * total and per-column counts summed only native store cards, so a column (or a
 * whole board) showing imported read-only cards read "0" even with cards on
 * screen. filterImportedForColumn is the pure distribution primitive both the
 * counts and the rendered cards flow through.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { filterImportedForColumn } from './board.js';

const here = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(here, 'board.js'), 'utf8');

const columns = [
  { content: { id: 'c-todo', name: 'Todo' } },
  { content: { id: 'c-doing', name: 'Doing' } },
  { content: { id: 'c-done', name: 'Done' } },
];

const records = [
  { title: 'a', status: 'todo', source: { type: 'markdown', ref: 'TODO.md' } },
  { title: 'b', status: 'doing', source: { type: 'markdown', ref: 'TODO.md' } },
  { title: 'c', status: 'done', source: { type: 'github_issues', ref: 'owner/repo' } },
  { title: 'd', status: 'todo', source: { type: 'github_issues', ref: 'owner/repo' } },
];

describe('filterImportedForColumn — distribution by status → column', () => {
  it('routes records to conventional columns by status', () => {
    expect(filterImportedForColumn(records, 'c-todo', columns).map((r) => r.title)).toEqual(['a', 'd']);
    expect(filterImportedForColumn(records, 'c-doing', columns).map((r) => r.title)).toEqual(['b']);
    expect(filterImportedForColumn(records, 'c-done', columns).map((r) => r.title)).toEqual(['c']);
  });

  it('applies the source filter', () => {
    const f = { source: 'github_issues:owner/repo', status: 'all' };
    expect(filterImportedForColumn(records, 'c-todo', columns, f).map((r) => r.title)).toEqual(['d']);
    expect(filterImportedForColumn(records, 'c-doing', columns, f)).toEqual([]);
  });

  it('applies the status filter', () => {
    const f = { source: 'all', status: 'done' };
    expect(filterImportedForColumn(records, 'c-done', columns, f).map((r) => r.title)).toEqual(['c']);
    expect(filterImportedForColumn(records, 'c-todo', columns, f)).toEqual([]);
  });

  it('the per-column sum equals the total imported set (no card lost or double-counted)', () => {
    const total = columns.reduce((n, c) => n + filterImportedForColumn(records, c.content.id, columns).length, 0);
    expect(total).toBe(records.length);
  });

  it('is defensive against non-array records', () => {
    expect(filterImportedForColumn(null, 'c-todo', columns)).toEqual([]);
    expect(filterImportedForColumn(undefined, 'c-todo', columns)).toEqual([]);
  });
});

describe('board.js — counts include imported cards', () => {
  it('per-column count adds imported.length to native cards', () => {
    expect(boardSrc).toMatch(/cards\.length \+ imported\.length/);
  });

  it('header total adds imported cards per column', () => {
    expect(boardSrc).toMatch(/importedCardsFor\(slug, c\.content\.id, columns\)\.length/);
  });
});
