import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../index.mjs';
import { createAuth } from '../core/auth.mjs';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const silent = { info() {}, warn() {}, error() {} };
async function fixture(handle) {
  const sk = generateSecretKey();
  const config = {
    session_secret: 'b'.repeat(64), session_ttl_sec: 86400, session_max_lifetime_sec: 86400,
    admin_npub: nip19.npubEncode(getPublicKey(sk)), admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost'] },
    rate_limit: { enabled: false }, cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' }, ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' }, logging: { level: 'silent' },
  };
  const now = () => 1700000000;
  const auth = createAuth(config, { now, log: silent });
  const writes = [];
  const { app } = await buildApp(config, {
    auth, chatSkill: { handle },
    projectStore: { async load() {}, async applyAction(action) { writes.push(action); return { ok: true }; } },
  });
  const { challenge } = auth.issueChallenge('127.0.0.1');
  const event = finalizeEvent({ kind: 22242, created_at: now(), tags: [['challenge', challenge]], content: challenge }, sk);
  const session = await auth.verifyChallenge(event, '127.0.0.1');
  assert.equal(session.ok, true);
  return { app, writes, headers: { authorization: `Bearer ${session.token}` } };
}

test('real chat route validates auth and input BEFORE starting SSE', async () => {
  let called = 0;
  const { app, headers } = await fixture(async () => { called++; return { ok: true, reply: 'hi' }; });
  try {
    for (const [payload, auth, status] of [
      [{ message: 'gm', stream: true }, {}, 401],
      [{ message: '', stream: true }, headers, 400],
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/chat', payload, headers: auth });
      assert.equal(res.statusCode, status);
      assert.match(res.headers['content-type'], /json/);
    }
    assert.equal(called, 0);
  } finally { await app.close(); }
});

test('real HTTP stream arrives before completion; fenced actions only apply at done', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const action = '```store\n{"action":"add_todo","project":"test","text":"Task"}\n```';
  const { app, headers, writes } = await fixture(async ({ onDelta, telemetry }) => {
    telemetry.attempt('routstr');
    onDelta('Hello '); onDelta('``'); onDelta('`store\n'); onDelta('PRIVATE ACTION JSON');
    await gate;
    return { ok: true, reply: 'Hello ' + action, model: 'test', provider: 'routstr' };
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/api/chat`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'gm', stream: true }) });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const reader = res.body.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('"delta"')) text += decoder.decode((await reader.read()).value);
    assert.match(text, /Hello /);
    assert.ok(!text.includes('PRIVATE'));
    assert.ok(!text.includes('```'));
    assert.equal(writes.length, 0);
    release();
    while (true) { const r = await reader.read(); if (r.done) break; text += decoder.decode(r.value); }
    assert.equal(writes.length, 1);
    const done = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(e => e.type === 'done');
    assert.equal(done.reply, 'Hello');
    assert.equal(done.timings.attempts, 1);
    assert.ok(done.timings.first_text_ms >= 0);
    assert.equal(done.store_writes.length, 1);
  } finally { release(); await app.close(); }
});

test('route reports error after partial output and never applies partial actions', async () => {
  const { app, headers, writes } = await fixture(async ({ onDelta }) => {
    onDelta('Incomplete preview');
    return { ok: false, code: 'upstream_empty', reason: 'Interrupted' };
  });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'gm', stream: true } });
    assert.match(res.body, /"type":"error"/);
    assert.ok(!res.body.includes('"type":"done"'));
    assert.equal(writes.length, 0);
  } finally { await app.close(); }
});

test('fallback resets provisional text and thrown errors are sanitized', async () => {
  const { app, headers } = await fixture(async ({ onDelta, telemetry }) => {
    telemetry.attempt('routstr'); onDelta('first');
    telemetry.attempt('ollama'); onDelta('second');
    throw new Error('secret-key-not-for-client');
  });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'gm', stream: true } });
    assert.equal((res.body.match(/"type":"reset"/g) || []).length, 2);
    assert.match(res.body, /"type":"error"/);
    assert.ok(!res.body.includes('secret-key'));
  } finally { await app.close(); }
});

test('legacy JSON clients still receive the original reply plus timings', async () => {
  const { app, headers } = await fixture(async ({ onDelta }) => {
    assert.equal(onDelta, undefined);
    return { ok: true, reply: 'Legacy reply', model: 'test' };
  });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { message: 'gm' } });
    assert.equal(res.json().reply, 'Legacy reply');
    assert.ok(res.json().timings.total_ms >= 0);
  } finally { await app.close(); }
});

test('client disconnect skips late project writes without replaying the turn', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { app, headers, writes } = await fixture(async ({ onDelta }) => {
    calls++;
    onDelta('Preview');
    await gate;
    return { ok: true, reply: 'Done\n```store\n{"action":"add_todo","project":"test","text":"Late"}\n```' };
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const ctl = new AbortController();
    const res = await fetch(`${address}/api/chat`, { method: 'POST', signal: ctl.signal,
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'gm', stream: true }) });
    await res.body.getReader().read();
    ctl.abort();
    await new Promise(r => setTimeout(r, 30));
    release();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls, 1);
    assert.equal(writes.length, 0);
  } finally { release(); await app.close(); }
});
