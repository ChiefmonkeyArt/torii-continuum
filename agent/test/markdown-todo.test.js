/**
 * markdown-todo.mjs — pure parser: status mapping, priority lifting, inline
 * flattening, and the DoS-resistant bounds (maxLines / maxTasks / title clamp).
 *
 * No I/O, no network. Fixtures use generic placeholder task text only.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTodos, MD_LIMITS } from '../lib/markdown-todo.mjs';

test('empty / non-string input yields no tasks', () => {
  assert.deepEqual(parseMarkdownTodos('').tasks, []);
  assert.deepEqual(parseMarkdownTodos(null).tasks, []);
  assert.deepEqual(parseMarkdownTodos(undefined).tasks, []);
});

test('checkbox markers map to lanes', () => {
  const md = [
    '- [ ] open one',
    '- [x] done one',
    '- [X] done two',
    '- [-] wip dash',
    '- [/] wip slash',
    '- [~] wip tilde',
    '- [>] wip gt',
  ].join('\n');
  const { tasks } = parseMarkdownTodos(md);
  assert.deepEqual(tasks.map((t) => t.status), ['todo', 'done', 'done', 'doing', 'doing', 'doing', 'doing']);
});

test('plain bullets import ONLY under a status-mapped heading', () => {
  const md = [
    '## Random prose',
    '- not a task, just prose',
    '## Doing',
    '- actively working',
    '## Notes',
    '- ignored again',
  ].join('\n');
  const { tasks } = parseMarkdownTodos(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'actively working');
  assert.equal(tasks[0].status, 'doing');
  assert.equal(tasks[0].section, 'Doing');
});

test('heading status vocabulary maps to lanes', () => {
  for (const [heading, lane] of [
    ['Backlog', 'backlog'], ['Icebox', 'backlog'],
    ['To do', 'todo'], ['Planned', 'todo'],
    ['In progress', 'doing'], ['WIP', 'doing'],
    ['Done', 'done'], ['Completed', 'done'],
  ]) {
    const { tasks } = parseMarkdownTodos(`## ${heading}\n- item`);
    assert.equal(tasks.length, 1, `${heading} should map a plain bullet`);
    assert.equal(tasks[0].status, lane, `${heading} → ${lane}`);
  }
});

test('checkbox marker wins over enclosing heading', () => {
  const md = '## Done\n- [ ] still open even under Done';
  const { tasks } = parseMarkdownTodos(md);
  assert.equal(tasks[0].status, 'todo');
});

test('priority tokens are lifted and stripped from the title', () => {
  const cases = [
    ['- [ ] ship it (P0)', 'high', 'ship it'],
    ['- [ ] ship it (P1)', 'high', 'ship it'],
    ['- [ ] ship it (P2)', 'med', 'ship it'],
    ['- [ ] ship it (P3)', 'low', 'ship it'],
    ['- [ ] tidy up #p3', 'low', 'tidy up'],
  ];
  for (const [line, pri, title] of cases) {
    const { tasks } = parseMarkdownTodos(line);
    assert.equal(tasks[0].priority, pri, line);
    assert.equal(tasks[0].title, title, line);
  }
});

test('inline markdown emphasis and links are flattened to text', () => {
  const md = '- [ ] see [the docs](https://example.com/x) and **bold** `code`';
  const { tasks } = parseMarkdownTodos(md);
  assert.equal(tasks[0].title, 'see the docs and bold code');
});

test('maxTasks bound truncates and never over-allocates', () => {
  const md = Array.from({ length: 50 }, (_, i) => `- [ ] task ${i}`).join('\n');
  const { tasks, truncated } = parseMarkdownTodos(md, { maxTasks: 10 });
  assert.equal(tasks.length, 10);
  assert.equal(truncated, true);
});

test('maxLines bound stops scanning and flags truncated', () => {
  const md = Array.from({ length: 20 }, () => 'filler').join('\n') + '\n- [ ] deep task';
  const { tasks, truncated } = parseMarkdownTodos(md, { maxLines: 5 });
  assert.equal(truncated, true);
  assert.equal(tasks.length, 0);
});

test('title is clamped to titleMax', () => {
  const long = 'x'.repeat(1000);
  const { tasks } = parseMarkdownTodos(`- [ ] ${long}`, { titleMax: 50 });
  assert.equal(tasks[0].title.length, 50);
});

test('pathological single long line is skipped, not parsed', () => {
  const { tasks } = parseMarkdownTodos('- [ ] ' + 'a'.repeat(20000));
  assert.equal(tasks.length, 0);
});

test('MD_LIMITS is frozen with the documented defaults', () => {
  assert.equal(Object.isFrozen(MD_LIMITS), true);
  assert.equal(MD_LIMITS.maxTasks, 500);
});
