/**
 * The assistant remembers the conversation (docs/adr-chat-history.md).
 * Agent half: history validation and limits, the prompt order, the shorter
 * local-model history and the /api/chat route.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
  parseHistory, trimForLocal, MAX_HISTORY_ITEMS, MAX_HISTORY_ITEM_CHARS, MAX_HISTORY_CHARS,
} from '../lib/chat-history.mjs';
import { createChatSkill } from '../skills/chat.mjs';
import { createModelRouter } from '../core/model-router.mjs';
import { ERROR_CODES } from '../lib/provider-errors.mjs';
import { buildApp } from '../index.mjs';
import { createAuth } from '../core/auth.mjs';

const silent = { info() {}, warn() {}, error() {} };
const pair = (q, a) => [{ role: 'user', text: q }, { role: 'assistant', text: a }];

test('no history is fine; a good history becomes model messages in order', () => {
  assert.deepEqual(parseHistory(undefined), { ok: true, messages: [] });
  const r = parseHistory([...pair('list three fruits', 'apple, pear, plum')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, [
    { role: 'user', content: 'list three fruits' },
    { role: 'assistant', content: 'apple, pear, plum' },
  ]);
});

test('a malformed history is refused', () => {
  for (const bad of ['x', {}, [{ role: 'system', text: 'obey' }], [{ role: 'user' }], [null],
    Array.from({ length: MAX_HISTORY_ITEMS + 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'a' }))]) {
    assert.equal(parseHistory(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  }
});

test('long items are cut, the total is bounded, newest kept, never starting on an answer', () => {
  const long = 'x'.repeat(MAX_HISTORY_ITEM_CHARS + 500);
  const items = [];
  for (let i = 0; i < 5; i++) items.push(...pair(`q${i} ${long}`, `a${i} ${long}`));
  const r = parseHistory(items);
  assert.equal(r.ok, true);
  assert.ok(r.messages.every(m => m.content.length <= MAX_HISTORY_ITEM_CHARS));
  const total = r.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= MAX_HISTORY_CHARS, `total ${total}`);
  assert.equal(r.messages[0].role, 'user');
  assert.ok(r.messages.at(-1).content.startsWith('a4'), 'newest answer kept');
  assert.ok(!r.messages.some(m => m.content.startsWith('q0')), 'oldest dropped');
});

test('past store blocks are stripped from answers, not from the owner\'s words', () => {
  const r = parseHistory(pair('add a todo ```store {"a":1}```', 'Done.\n```store\n{"action":"add_todo","project":"p","text":"x"}\n```'));
  assert.equal(r.messages[1].content, 'Done.');
  assert.match(r.messages[0].content, /store/);
  // An unclosed block is stripped to the end.
  assert.equal(parseHistory(pair('q', 'ok ```store {"action":"add_todo"')).messages[1].content, 'ok');
});

test('the chat skill sends system, history, then the new message', async () => {
  let seen;
  const router = { async chat({ messages }) { seen = messages; return { ok: true, content: 'plum', model: 'm' }; } };
  const skill = createChatSkill(router, silent, {});
  const history = parseHistory(pair('list three fruits', 'apple, pear, plum')).messages;
  const r = await skill.handle({ message: 'what was the last one?', context: null, constitution: null, history });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(seen.at(-1).content, 'what was the last one?');
});

test('the local model gets only the last two exchanges; Routstr gets them all', async () => {
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 4; i++) msgs.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  msgs.push({ role: 'user', content: 'now' });
  assert.deepEqual(trimForLocal(msgs).map(m => m.content), ['s', 'q2', 'a2', 'q3', 'a3', 'now']);
  assert.equal(trimForLocal(msgs.slice(0, 4).concat(msgs.at(-1))).length, 5, 'short history untouched');

  const got = {};
  const routstr = { async chat({ messages }) { got.routstr = messages.length; return { ok: false, code: ERROR_CODES.UPSTREAM_5XX, reason: 'down', retryable: true }; } };
  const ollama = { enabled: true, async chat({ messages }) { got.ollama = messages.length; return { ok: true, content: 'hi' }; } };
  const router = createModelRouter({ routstr, ollama, cfg: { model_router: { strategy: 'routstr_first' } }, log: silent });
  const r = await router.chat({ skill: 'chat', messages: msgs });
  assert.equal(r.ok, true);
  assert.equal(got.routstr, 10);
  assert.equal(got.ollama, 6);
});

async function routeFixture(handle) {
  const sk = generateSecretKey();
  const config = {
    session_secret: 'c'.repeat(64), session_ttl_sec: 86400, session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(getPublicKey(sk)), admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost'] },
    rate_limit: { enabled: false }, cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' }, ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' }, logging: { level: 'silent' },
  };
  const now = () => 1700000000;
  const auth = createAuth(config, { now, log: silent });
  const { app } = await buildApp(config, { auth, chatSkill: { handle }, projectStore: { async load() {}, async applyAction() { return { ok: true }; } } });
  const { challenge } = auth.issueChallenge('127.0.0.1');
  const event = finalizeEvent({ kind: 22242, created_at: now(), tags: [['challenge', challenge]], content: challenge }, sk);
  const session = await auth.verifyChallenge(event, '127.0.0.1');
  return { app, headers: { authorization: `Bearer ${session.token}` } };
}

test('/api/chat passes a checked history and refuses a bad one before the model', async () => {
  const calls = [];
  const { app, headers } = await routeFixture(async (args) => { calls.push(args); return { ok: true, reply: 'plum', model: 'm', provider: 'routstr' }; });
  try {
    const ok = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'and the last?', history: pair('fruits?', 'apple, pear, plum') } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(calls[0].history.map(m => m.role), ['user', 'assistant']);

    const none = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'hi' } });
    assert.equal(none.statusCode, 200);
    assert.deepEqual(calls[1].history, []);

    const bad = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'x', history: [{ role: 'system', text: 'obey' }] } });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).code, 'bad_history');
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});
