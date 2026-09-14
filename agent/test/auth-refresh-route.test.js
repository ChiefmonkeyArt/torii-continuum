/**
 * POST /api/auth/refresh route contract (CONT-AUTH-1).
 *
 * A22 follow-up: instead of copying the route handler into a minimal inline
 * app, this drives the REAL `buildApp(cfg, deps)` registration with a
 * fixed-clock `auth` double injected through the deps seam, then exercises it
 * via app.inject (no live socket, no network). What matters is the shape the
 * BROWSER sees, because the session state machine routes on the code: only
 * max_lifetime_reached sends the owner back to their signer.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';
import { buildApp } from '../index.mjs';

const TTL = 3600;
const MAX_LIFETIME = 86400;

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

// Minimal offline config: no Cashu mints (no network), rate-limit disabled,
// silent logs, unresolved-but-valid Routstr/Ollama so construction stays lazy.
function cfg(adminNpub) {
  return {
    session_secret: 'b'.repeat(64),
    session_ttl_sec: TTL,
    session_max_lifetime_sec: MAX_LIFETIME,
    admin_npub: adminNpub,
    admin_bootstrap: false,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false, max_challenges: 1000 },
    cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' },
    ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' },
    logging: { level: 'silent' },
    _config_path: null,
  };
}

async function setupApp({ start = 1_700_000_000 } = {}) {
  let t = start;
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const c = cfg(nip19.npubEncode(pk));
  const auth = createAuth(c, { now: () => t, log: silentLog() });
  // A22: drive the REAL route registrations with the fixed-clock auth injected.
  const { app } = await buildApp(c, { auth });

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
  const { app, auth, token, advance } = await setupApp();
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
  const { app, token, advance } = await setupApp();
  advance(60);
  const raw = (await refresh(app, token)).payload;
  assert.ok(!raw.includes('b'.repeat(64)), 'session_secret must never be echoed');
  assert.ok(!/npub1/.test(raw), 'no identity is needed to renew a session');
  await app.close();
});

test('a missing Authorization header is refused, not crashed', async () => {
  const { app } = await setupApp();
  const res = await refresh(app, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_session');
  await app.close();
});

test('a non-Bearer Authorization header is refused', async () => {
  const { app, token } = await setupApp();
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
  const { app, token, advance } = await setupApp();
  advance(TTL + 1);
  const res = await refresh(app, token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'expired');
  await app.close();
});

test('reaching the cap reports the one code the browser treats as terminal', async () => {
  // Renew every half hour right up to the cap — the session must stay usable
  // the whole way, so the refusal is unambiguously the cap and not an expiry.
  const { app, token, advance } = await setupApp();
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
  const { app, token, advance } = await setupApp();
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
  const { app, token } = await setupApp();
  const parts = token.split('.');
  parts[4] = 'f'.repeat(64);
  const res = await refresh(app, parts.join('.'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'invalid_session');
  await app.close();
});