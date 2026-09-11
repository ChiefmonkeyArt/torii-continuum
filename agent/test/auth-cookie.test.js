/**
 * HERMES-DASHBOARD-1 — session-cookie mirror + read-only /api/auth/session.
 *
 * The Continuum agent is Bearer-only auth; to gate a separate same-origin SPA
 * (the Hermes dashboard) behind nginx `auth_request`, the agent must also mint
 * an HttpOnly `__Host-torii_session` cookie mirroring the bearer, clear it on
 * logout, and expose a read-only check that accepts cookie OR bearer.
 *
 * Builds a minimal inline Fastify app wiring the SAME createAuth + SAME handler
 * bodies index.mjs uses, then exercises them via app.inject (no live socket).
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';

const TTL = 3600;
const MAX_LIFETIME = 86400;
const COOKIE = '__Host-torii_session';
const IP = '203.0.113.7';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

// Build a minimal app mirroring index.mjs's HERMES-DASHBOARD-1 handlers, and
// burn a real login so tests can reuse a valid token + signed event.
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
  await app.register(cookie);

  app.post('/api/auth/verify', async (req, reply) => {
    const event = req.body?.event;
    if (!event) return reply.code(400).send({ ok: false, error: 'body.event required' });
    const result = await auth.verifyChallenge(event, IP);
    if (!result.ok) return reply.code(401).send({ ok: false, code: result.code || null, error: result.reason });
    reply.setCookie(COOKIE, result.token, {
      path: '/', httpOnly: true, secure: true, sameSite: 'lax',
      expires: new Date(result.expires_at * 1000),
    });
    return { token: result.token, expires_at: result.expires_at };
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const header = req.headers?.authorization || '';
    const tok = header.startsWith('Bearer ') ? header.slice(7) : '';
    const result = auth.refreshSession(tok);
    if (!result.ok) return reply.code(401).send({ ok: false, code: result.code, reason: result.reason });
    reply.setCookie(COOKIE, result.token, {
      path: '/', httpOnly: true, secure: true, sameSite: 'lax',
      expires: new Date(result.expires_at * 1000),
    });
    return { ok: true, token: result.token, expires_at: result.expires_at };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/session', async (req, reply) => {
    const header = req.headers?.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      const c = req.cookies?.[COOKIE];
      if (typeof c === 'string' && c.length) token = c;
    }
    if (!token) return reply.code(401).send({ error: 'no session' });
    const check = auth.verifySessionToken(token);
    if (!check.ok) return reply.code(401).send({ error: `session invalid: ${check.reason}` });
    return reply.send({ ok: true, npub: check.npub });
  });

  // A PENDING challenge + signed event for the verify POST test (NOT consumed).
  const { challenge } = auth.issueChallenge(IP);
  const event = finalizeEvent(
    { kind: 22242, created_at: t, tags: [['challenge', challenge]], content: challenge },
    sk,
  );

  // A SEPARATE, already-consumed login so refresh/session tests hold a real
  // valid token without burning the pending challenge above.
  const { challenge: c2 } = auth.issueChallenge(IP);
  const event2 = finalizeEvent(
    { kind: 22242, created_at: t, tags: [['challenge', c2]], content: c2 },
    sk,
  );
  const login = await auth.verifyChallenge(event2, IP);

  return { app, auth, login, event };
}

function setCookieHeader(res) {
  const sc = res.headers['set-cookie'];
  return Array.isArray(sc) ? sc.join('; ') : (sc || '');
}

test('verify mints an HttpOnly Secure SameSite=Lax __Host cookie beside the token', async () => {
  const { app, event } = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { event } });
  assert.equal(res.statusCode, 200);
  const sc = setCookieHeader(res);
  assert.match(sc, /__Host-torii_session=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\//);
  assert.match(sc, /Expires=/);
});

test('refresh re-issues the mirror cookie', async () => {
  const { app, login } = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/refresh',
    headers: { authorization: `Bearer ${login.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.match(setCookieHeader(res), /__Host-torii_session=/);
});

test('logout clears the cookie', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(res.statusCode, 200);
  const sc = setCookieHeader(res);
  assert.match(sc, /__Host-torii_session=/);
  assert.match(sc, /Max-Age=0|1970/);
});

test('/api/auth/session accepts a valid cookie', async () => {
  const { app, login } = await buildApp();
  const res = await app.inject({
    method: 'GET', url: '/api/auth/session',
    headers: { cookie: `__Host-torii_session=${login.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('/api/auth/session is 401 with no cookie', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(res.statusCode, 401);
});

test('/api/auth/session is 401 with a forged cookie', async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: 'GET', url: '/api/auth/session',
    headers: { cookie: '__Host-torii_session=forged.token.here' },
  });
  assert.equal(res.statusCode, 401);
});

test('/api/auth/session accepts the Authorization bearer', async () => {
  const { app, login } = await buildApp();
  const res = await app.inject({
    method: 'GET', url: '/api/auth/session',
    headers: { authorization: `Bearer ${login.token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('/api/auth/session is 401 with an invalid bearer', async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: 'GET', url: '/api/auth/session',
    headers: { authorization: 'Bearer not.a.real.token' },
  });
  assert.equal(res.statusCode, 401);
});