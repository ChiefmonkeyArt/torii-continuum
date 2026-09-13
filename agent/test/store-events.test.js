/**
 * OWNER-UI-3 — server-side event factory.
 *
 * These pin the agent-minted todo/milestone shape to the client's, so a record
 * the owner AI creates in chat is indistinguishable from one added by hand in
 * the UI (and survives a round-trip through the UI's schema-evolution guards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTodoEvent, makeMilestoneEvent, KIND, MILESTONE_STATUS } from '../lib/store-events.mjs';

test('makeTodoEvent matches the client addTodo shape (kind 30081)', () => {
  const ev = makeTodoEvent('torii-quest', 'wire the gateway', 3);
  assert.equal(ev.kind, KIND.TODO);
  assert.equal(ev.id, null);
  assert.equal(ev.pubkey, null);
  assert.equal(ev.sig, null);
  assert.ok(typeof ev.created_at === 'number');
  // d tag is the addressable key
  const d = ev.tags.find((t) => t[0] === 'd');
  assert.ok(d, 'must carry a d tag');
  assert.ok(d[1].startsWith('torii-quest:todo_'), 'd tag in <slug>:todo_… form');
  // addressable ref + type tag, exactly like the client
  assert.ok(ev.tags.some((t) => t[0] === 'a' && t[1] === '30078:torii-quest'));
  assert.ok(ev.tags.some((t) => t[0] === 't' && t[1] === 'todo'));
  assert.deepEqual(ev.content, {
    projectSlug: 'torii-quest',
    text: 'wire the gateway',
    done: false,
    order: 3,
    createdAt: ev.created_at,
  });
});

test('makeMilestoneEvent matches the milestone shape (kind 30080)', () => {
  const ev = makeMilestoneEvent('continuum', { title: 'Ship v1', status: 'active', note: 'notes', index: 4 });
  assert.equal(ev.kind, KIND.MILESTONE);
  const d = ev.tags.find((t) => t[0] === 'd');
  assert.equal(d[1], 'continuum:m4');
  assert.deepEqual(ev.content, {
    projectSlug: 'continuum',
    index: 4,
    title: 'Ship v1',
    status: 'active',
    note: 'notes',
  });
});

test('milestone status vocabulary is the three UI lanes', () => {
  assert.deepEqual(MILESTONE_STATUS, ['pending', 'active', 'done']);
});