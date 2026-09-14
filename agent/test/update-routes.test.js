/**
 * /api/version + /api/update route contract (VERSION-UPDATE-1).
 *
 * A22 follow-up: instead of copying the routes into a minimal inline app, this
 * drives the REAL `buildApp(cfg, deps)` registrations with in-memory
 * releaseChecker/updater doubles + a real `auth` injected through the deps
 * seam, then exercises via app.inject (no live socket, no network):
 *   • GET /api/version is PUBLIC and returns the non-secret summary
 *   • POST /api/update requires admin (401 without a token)
 *   • POST /api/update requires confirm:true (400)
 *   • admin can queue the vetted latest; unauthorized tag rejected (400)
 *   • concurrency: second queue → 409 pending
 *   • GET /api/update/status reflects the queued request
 *   • POST /api/update/cancel clears it
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';
import { createReleaseChecker } from '../core/release-check.mjs';
import { createUpdater } from '../core/updater.mjs';
import { buildApp } from '../index.mjs';

// Read the running version from the same source index.mjs boots from, so the
// authorizeUpdate('not_newer') gate is exercised against the REAL version.
const REAL_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

// A fictional server-vetted "latest" strictly newer than any 0.2.x running
// version, plus a distinct non-allowed tag against the same gate.
const LATEST = 'v9.0.0-alpha';
const BAD_TAG = 'v9.9.9-alpha';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

function releasesRes(tags) {
  const text = JSON.stringify(tags.map((t) => ({ tag_name: t, draft: false })));
  return { ok: true, status: 200, async text() { return text; }, body: null };
}

function cfg(adminNpub) {
  return {
    session_secret: 'b'.repeat(64),
    session_ttl_sec: 86400,
    session_max_lifetime_sec: 86400,
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

async function setupApp({ latest = LATEST } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'update-routes-'));
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const c = cfg(nip19.npubEncode(pk));
  const now = () => 1_700_000_000;

  const auth = createAuth(c, { now, log: silentLog() });
  const releaseChecker = createReleaseChecker({
    currentVersion: REAL_VERSION,
    fetchImpl: async () => releasesRes([latest, `v${REAL_VERSION}`]),
    now: () => Date.now(),
  });
  const updater = createUpdater({ requestPath: join(dir, 'update-request.json') });

  // A22: drive the REAL route registrations with the doubles injected.
  const { app } = await buildApp(c, { auth, releaseChecker, updater });

  // Prime the checker via the real route so latestKnown() is populated for the
  // /api/update authorize gate (same priming the copied test did inline).
  const prime = await app.inject({ method: 'GET', url: '/api/version' });
  assert.equal(prime.statusCode, 200);

  // Mint a real session token via the injected auth — requireAdmin verifies it.
  const { challenge } = auth.issueChallenge('203.0.113.7');
  const event = finalizeEvent(
    { kind: 22242, created_at: now(), tags: [['challenge', challenge]], content: challenge },
    sk,
  );
  const login = await auth.verifyChallenge(event, '203.0.113.7');
  assert.equal(login.ok, true);

  return { app, token: login.token, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

test('GET /api/version is public and returns the summary', async () => {
  const { app, cleanup } = await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.current, REAL_VERSION);
    assert.equal(body.latest, LATEST);
    assert.equal(body.update_available, true);
    assert.equal(body.channel, 'alpha');
  } finally {
    cleanup(); await app.close();
  }
});

test('POST /api/update requires admin token', async () => {
  const { app, cleanup } = await setupApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update',
      payload: { tag: LATEST, confirm: true },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    cleanup(); await app.close();
  }
});

test('POST /api/update requires confirm:true', async () => {
  const { app, token, cleanup } = await setupApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: LATEST },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'not_confirmed');
  } finally {
    cleanup(); await app.close();
  }
});

test('admin can queue the vetted latest; unauthorized tag rejected', async () => {
  const { app, token, cleanup } = await setupApp();
  try {
    const bad = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: BAD_TAG, confirm: true },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).code, 'not_allowed');

    const ok = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: LATEST, confirm: true },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).status, 'queued');
  } finally {
    cleanup(); await app.close();
  }
});

test('invalid tag rejected with 400 invalid_tag', async () => {
  const { app, token, cleanup } = await setupApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: 'garbage', confirm: true },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'invalid_tag');
  } finally {
    cleanup(); await app.close();
  }
});

test('concurrency: second queue returns 409 pending; status + cancel work', async () => {
  const { app, token, cleanup } = await setupApp();
  try {
    const first = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: LATEST, confirm: true },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST', url: '/api/update', headers: { authorization: `Bearer ${token}` },
      payload: { tag: LATEST, confirm: true },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(JSON.parse(second.body).code, 'pending');

    const status = await app.inject({
      method: 'GET', url: '/api/update/status', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(status.statusCode, 200);
    const sbody = JSON.parse(status.body);
    assert.equal(sbody.pending, true);
    assert.equal(sbody.tag, LATEST);
    assert.equal(sbody.current, REAL_VERSION);

    const cancel = await app.inject({
      method: 'POST', url: '/api/update/cancel', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(JSON.parse(cancel.body).cancelled, true);

    const after = await app.inject({
      method: 'GET', url: '/api/update/status', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(JSON.parse(after.body).pending, false);
  } finally {
    cleanup(); await app.close();
  }
});

test('GET /api/update/status requires admin', async () => {
  const { app, cleanup } = await setupApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    assert.equal(res.statusCode, 401);
  } finally {
    cleanup(); await app.close();
  }
});