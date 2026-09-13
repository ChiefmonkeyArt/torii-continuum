/**
 * OWNER-UI-3 — store-action parser.
 *
 * The chat model appends a fenced JSON block when the operator asks for a
 * milestone/todo change. `extractStoreActions` must recover ONLY well-formed,
 * allowlisted actions, strip the block from the visible reply, and never treat
 * arbitrary prose (or a `json` fence that isn't ours) as a write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStoreActions, normalizeAction, ACTION_LIMITS } from '../lib/store-actions.mjs';

test('extracts a single add_todo from a ```store fence and strips it', () => {
  const reply = 'Done.\n```store\n{"action":"add_todo","project":"continuum","text":"wire tests"}\n```';
  const r = extractStoreActions(reply);
  assert.equal(r.actions.length, 1);
  assert.deepEqual(r.actions[0], { action: 'add_todo', project: 'continuum', text: 'wire tests' });
  assert.ok(!r.reply.includes('```'), 'the fence must be stripped');
  assert.ok(r.reply.includes('Done.'), 'the prose must survive');
});

test('extracts a list of actions and strips them all', () => {
  const reply = 'Sure.\n```json\n[\n {"action":"add_todo","project":"continuum","text":"a"},\n {"action":"add_todo","project":"continuum","text":"b"}\n]\n```';
  const r = extractStoreActions(reply);
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].text, 'a');
  assert.equal(r.actions[1].text, 'b');
  assert.ok(!r.reply.includes('```'));
});

test('a non-action json fence is left alone', () => {
  const reply = 'Here is config:\n```json\n{"foo": 1}\n```';
  const r = extractStoreActions(reply);
  assert.equal(r.actions.length, 0);
  assert.ok(r.reply.includes('```json'), 'an unrelated fence must not be stripped');
});

test('no fence means no actions and the reply is untouched', () => {
  const reply = 'Just chit-chat, no writes.';
  const r = extractStoreActions(reply);
  assert.deepEqual(r.actions, []);
  assert.equal(r.reply, 'Just chit-chat, no writes.');
});

test('an unknown/unsafe action is ignored', () => {
  const reply = '```store\n[{"action":"add_todo","project":"continuum","text":"ok"},{"action":"drop_table","project":"x"}]\n```';
  const r = extractStoreActions(reply);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].action, 'add_todo');
});

test('unknown status defaults add_milestone to pending; invalid set_milestone_status rejected', () => {
  assert.equal(normalizeAction({ action: 'add_milestone', project: 'p', title: 't', status: 'bogus' }).status, 'pending');
  assert.equal(normalizeAction({ action: 'set_milestone_status', project: 'p', title: 't', status: 'bogus' }), null);
  assert.equal(normalizeAction({ action: 'add_todo', project: 'p' }), null, 'missing text rejected');
  assert.equal(normalizeAction({ action: 'add_todo', project: 'P!!', text: 'x' }), null, 'non-kebab slug rejected');
});

test('text and project are clamped to bounds', () => {
  const long = 'x'.repeat(ACTION_LIMITS.textMax + 100);
  const a = normalizeAction({ action: 'add_todo', project: 'p', text: long });
  assert.equal(a.text.length, ACTION_LIMITS.textMax);
});