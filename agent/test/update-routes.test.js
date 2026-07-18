/**
 * /api/version + /api/update route contract (VERSION-UPDATE-1).
 *
 * Builds a minimal inline Fastify app that wires the SAME modules index.mjs
 * uses (createReleaseChecker + createUpdater) behind the SAME auth shape
 * (Bearer preHandler), then exercises via app.inject (no live socket, no net):
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
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReleaseChecker } from '../core/release-check.mjs';
import { createUpdater } from '../core/updater.mjs';

const VERSION = '0.2.69-alpha';
const GOOD_TOKEN = 'valid-session';

function releasesRes(tags) {
  const text = JSON.stringify(tags.map((t) => ({ tag_name: t, draft: false })));
  return { ok: true, status: 200, async text() { return text; }, body: null };
}

async function buildApp({ latest = 'v0.2.70-alpha' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'update-routes-'));
  const app = Fastify({ logger: false });

  const releaseChecker = createReleaseChecker({
    currentVersion: VERSION,
    fetchImpl: async () => releasesRes([latest, VERSION].map((v) => (v.startsWith('v') ? v : 'v' + v))),
    now: () => Date.now(),
  });
  const updater = createUpdater({ requestPath: join(dir, 'update-request.json') });

  async function requireAdmin(req, reply) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== GOOD_TOKEN) return reply.code(401).send({ error: 'unauthorized' });
    req.session = { npub: 'npub1admin' };
  }

  app.get('/api/version', async () => releaseChecker.get());

  app.post('/api/update', { preHandler: requireAdmin }, async (req, reply) => {
    const tag = typeof req.body?.tag === 'string' ? req.body.tag.trim() : '';
    if (req.body?.confirm !== true) {
      return reply.code(400).send({ ok: false, code: 'not_confirmed', reason: 'confirm:true required' });
    }
    const result = await updater.request({
      tag,
      currentVersion: VERSION,
      latestKnown: releaseChecker.latestKnown(),
      requestedBy: req.session?.npub || null,
    });
    if (!result.ok) {
      const status = result.code === 'pending' ? 409 : 400;
      return reply.code(status).send(result);
    }
    return result;
  });

  app.get('/api/update/status', { preHandler: requireAdmin }, async () => {
    const s = await updater.status();
    return { ok: true, ...s, current: VERSION, latest: releaseChecker.latestKnown() };
  });

  app.post('/api/update/cancel', { preHandler: requireAdmin }, async () => updater.cancel());

  await app.ready();
  // Prime the checker so latestKnown() is populated for authz.
  await app.inject({ method: 'GET', url: '/api/version' });
  return { app, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

const auth = { authorization: `Bearer ${GOOD_TOKEN}` };

test('GET /api/version is public and returns the summary', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.current, VERSION);
    assert.equal(body.latest, 'v0.2.70-alpha');
    assert.equal(body.update_available, true);
    assert.equal(body.channel, 'alpha');
  } finally {
    cleanup(); await app.close();
  }
});

test('POST /api/update requires admin token', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update',
      payload: { tag: 'v0.2.70-alpha', confirm: true },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    cleanup(); await app.close();
  }
});

test('POST /api/update requires confirm:true', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'v0.2.70-alpha' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'not_confirmed');
  } finally {
    cleanup(); await app.close();
  }
});

test('admin can queue the vetted latest; unauthorized tag rejected', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const bad = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'v9.9.9-alpha', confirm: true },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).code, 'not_allowed');

    const ok = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'v0.2.70-alpha', confirm: true },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).status, 'queued');
  } finally {
    cleanup(); await app.close();
  }
});

test('invalid tag rejected with 400 invalid_tag', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'garbage', confirm: true },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'invalid_tag');
  } finally {
    cleanup(); await app.close();
  }
});

test('concurrency: second queue returns 409 pending; status + cancel work', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const first = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'v0.2.70-alpha', confirm: true },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST', url: '/api/update', headers: auth,
      payload: { tag: 'v0.2.70-alpha', confirm: true },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(JSON.parse(second.body).code, 'pending');

    const status = await app.inject({ method: 'GET', url: '/api/update/status', headers: auth });
    assert.equal(status.statusCode, 200);
    const sbody = JSON.parse(status.body);
    assert.equal(sbody.pending, true);
    assert.equal(sbody.tag, 'v0.2.70-alpha');
    assert.equal(sbody.current, VERSION);

    const cancel = await app.inject({ method: 'POST', url: '/api/update/cancel', headers: auth });
    assert.equal(cancel.statusCode, 200);
    assert.equal(JSON.parse(cancel.body).cancelled, true);

    const after = await app.inject({ method: 'GET', url: '/api/update/status', headers: auth });
    assert.equal(JSON.parse(after.body).pending, false);
  } finally {
    cleanup(); await app.close();
  }
});

test('GET /api/update/status requires admin', async () => {
  const { app, cleanup } = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    assert.equal(res.statusCode, 401);
  } finally {
    cleanup(); await app.close();
  }
});
