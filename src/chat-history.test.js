import { test, expect } from 'vitest';
import { buildHistory, MAX_HISTORY_ITEMS, MAX_HISTORY_CHARS, MAX_HISTORY_ITEM_CHARS } from './chat-history.js';

const u = text => ({ who: 'user', text });
const ai = (text, ok = true) => ({ who: 'ai', text, ...(ok ? { ok: true } : {}) });

test('only owner messages followed by a real answer are sent, oldest first', () => {
  const msgs = [ai('What would you like to work on?', false), u('fruits?'), ai('apple, pear'),
    u('more'), ai('The model provider timed out.', false), u('again'), ai('plum')];
  expect(buildHistory(msgs)).toEqual([
    { role: 'user', text: 'fruits?' }, { role: 'assistant', text: 'apple, pear' },
    { role: 'user', text: 'again' }, { role: 'assistant', text: 'plum' },
  ]);
});

test('messages saved before the ok mark are left out', () => {
  expect(buildHistory([u('old'), { who: 'ai', text: 'old answer' }])).toEqual([]);
  expect(buildHistory(undefined)).toEqual([]);
});

test('the local-model note is not part of the answer; attachment names stay', () => {
  const h = buildHistory([u('What is in these?\nAttached: shot.jpg'), ai('A cat.\n\n_(answered by the local llama model — routstr was unavailable)_')]);
  expect(h[0].text).toContain('Attached: shot.jpg');
  expect(h[1].text).toBe('A cat.');
});

test('newest whole pairs within the count and size limits', () => {
  const many = [];
  for (let i = 0; i < 15; i++) many.push(u(`q${i}`), ai(`a${i}`));
  const h = buildHistory(many);
  expect(h.length).toBe(MAX_HISTORY_ITEMS);
  expect(h[0].text).toBe('q5');
  expect(h.at(-1).text).toBe('a14');

  const big = 'x'.repeat(MAX_HISTORY_ITEM_CHARS + 100);
  const long = [];
  for (let i = 0; i < 4; i++) long.push(u(`q${i}${big}`), ai(`a${i}${big}`));
  const l = buildHistory(long);
  expect(l.every(m => m.text.length <= MAX_HISTORY_ITEM_CHARS)).toBe(true);
  expect(l.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
  expect(l[0].role).toBe('user');
  expect(l.at(-1).text.startsWith('a3')).toBe(true);
});
