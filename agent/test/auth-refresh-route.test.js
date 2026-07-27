/**
 * POST /api/auth/refresh route contract (CONT-AUTH-1).
 *
 * Builds a minimal inline Fastify app that wires the SAME createAuth index.mjs
 * uses, with the SAME handler body, then exercises it via app.inject (no live
 * socket, no net). What matters here is the shape the BROWSER sees, because the
 * session state machine routes on the code: only max_lifetime_reached sends the
 * owner back to their signer.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';

const TTL = 3600;
const MAX_LIFETIME = 86400;

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

async function buildApp({ start = 1_700_000_000 } = {}) {
  let t = start;
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(
    {
      session_secret: 'b'.repeat(64),
      session_ttl_sec: TTL,
      session_max_lifetime_sec: MAX_LIFETIME,
      rate_limit: { max_challenges: 1000 },
      admin_npub: nip19.npubEncode(pk),
      admin_bootstrap: false,
    },
    { now: () => t, log: silentLog() },
  );

  const app = Fastify({ logger: false });
  // Mirrors index.mjs exactly.
  app.post('/api/auth/refresh', async (req, reply) => {
    const header = req.headers?.authorization || '';
    const tok = header.startsWith('Bearer ') ? header.slice(7) : '';
    const result = auth.refreshSession(tok);
    if (!result.ok) {
      return reply.code(401).send({ ok: false, code: result.code, reason: result.reason });
    }
    return { ok: true, token: result.token, expires_at: result.expires_at };
  });

  const { challenge } = auth.issueChallenge('203.0.113.7');
  const event = finalizeEvent(
    { kind: 22242, created_at: t, tags: [['challenge', challenge]], content: challenge },
    sk,
  );
  const login = await auth.verifyChallenge(event, '203.0.113.7');
  assert.equal(login.ok, true);

  return { app, auth, token: login.token, advance: (s) => { t += s; }, now: () => t };
}

function refresh(app, token) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test('a valid session is renewed and the browser gets a usable token back', async () => {
  const { app, auth, token, advance } = await buildApp();
  advance(60);
  const res = await refresh(app, token);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.token, 'string');
  assert.equal(typeof body.expires_at, 'number');
  assert.equal(auth.verifySessionToken(body.token).ok, true, 'the returned token must work');
  await app.close();
});

test('the response carries no secret material', async () => {
  const { app, token, advance } = await buildApp();
  advance(60);
  const raw = (await refresh(app, token)).payload;
  assert.ok(!raw.includes('b'.repeat(64)), 'session_secret must never be echoed');
  assert.ok(!/npub1/.test(raw), 'no identity is needed to renew a session');
  await app.close();
});

test('a missing Authorization header is refused, not crashed', async () => {
  const { app } = await buildApp();
  const res = await refresh(app, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_session');
  await app.close();
});

test('a non-Bearer Authorization header is refused', async () => {
  const { app, token } = await buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: { authorization: `Basic ${token}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_session');
  await app.close();
});

test('an expired session is refused as expired', async () => {
  const { app, token, advance } = await buildApp();
  advance(TTL + 1);
  const res = await refresh(app, token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'expired');
  await app.close();
});

test('reaching the cap reports the one code the browser treats as terminal', async () => {
  // Renew every half hour right up to the cap — the session must stay usable
  // the whole way, so the refusal is unambiguously the cap and not an expiry.
  const { app, token, advance } = await buildApp();
  let current = token;
  const steps = MAX_LIFETIME / 1800 - 1;
  for (let i = 0; i < steps; i++) {
    advance(1800);
    const r = await refresh(app, current);
    assert.equal(r.statusCode, 200, `renewal ${i} should still succeed`);
    current = r.json().token;
  }
  advance(1800); // exactly at oiat + session_max_lifetime_sec
  const res = await refresh(app, current);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'max_lifetime_reached');
  await app.close();
});

test('a renewed token is accepted by the very next renewal', async () => {
  // The chain has to actually work end to end, not just parse.
  const { app, token, advance } = await buildApp();
  let current = token;
  for (let i = 0; i < 5; i++) {
    advance(600);
    const res = await refresh(app, current);
    assert.equal(res.statusCode, 200);
    current = res.json().token;
  }
  await app.close();
});

test('a tampered token is refused with the non-terminal code', async () => {
  const { app, token } = await buildApp();
  const parts = token.split('.');
  parts[4] = 'f'.repeat(64);
  const res = await refresh(app, parts.join('.'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_session');
  await app.close();
});
