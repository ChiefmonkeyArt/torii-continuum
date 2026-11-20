/**
 * A22 — buildApp(deps) test seam + production CORS/DELETE regression.
 *
 * The audit found the production CORS `methods` list omitted DELETE (and PUT),
 * so a cross-origin `DELETE /api/pending/:file` preflight was answered without a
 * DELETE allow and the browser refused the real request. It also noted no test
 * drove the REAL route registrations (they copied inline routes).
 *
 * These tests import the extracted `buildApp(cfg)` and drive the genuine Fastify
 * app via app.inject(), so they verify the production wiring — not a copy.
 *
 * Run: node --test test/buildapp-cors.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../index.mjs';

// Minimal offline config: no Cashu mints (no network), rate-limit disabled,
// silent logs, unresolved-but-valid Routstr/Ollama so construction stays lazy.
function silentCfg() {
  return {
    session_secret: 'a'.repeat(64),
    session_ttl_sec: 86400,
    admin_npub: '',
    admin_bootstrap: true,
    server: { host: '127.0.0.1', port: 0, cors_origins: ['http://localhost:5173'] },
    rate_limit: { enabled: false },
    cashu: { mints: [] },
    routstr: { endpoint: 'https://example.invalid' },
    ollama: { enabled: false },
    model_router: { strategy: 'routstr_first' },
    logging: { level: 'silent' },
    _config_path: null,
  };
}

test('local route authenticates before inference and sends only bounded text to QVAC', async () => {
  const seen = [];
  const { app } = await buildApp(silentCfg(), {
    auth: { verifySessionToken: () => ({ ok: true, npub: 'fixture' }) },
    askQvac: async (q, opts) => { seen.push(q); opts.onDelta('hello'); return 'hello'; },
  });
  try {
    const request = { method: 'POST', url: '/api/local-chat', payload: { question: 'gm' } };
    assert.equal((await app.inject(request)).statusCode, 401);
    request.headers = { authorization: 'Bearer fixture' };
    assert.equal((await app.inject({ ...request, payload: { question: ' ' } })).statusCode, 400);
    assert.deepEqual(seen, []);
    const result = (await app.inject(request)).json();
    assert.equal(result.reply, 'hello'); assert.equal(result.sats_spent, 0);
    const stream = await app.inject({ ...request, payload: { question: 'gm', stream: true } });
    assert.match(stream.body, /"type":"delta"/); assert.match(stream.body, /"type":"done"/);
    assert.deepEqual(seen, ['gm','gm']);
  } finally { await app.close(); }
});

test('A22: importing buildApp does NOT listen or bind a port', async () => {
  const ctx = await buildApp(silentCfg());
  try {
    // The core of the extraction: a built app is not a listening server until
    // .listen() is called by the entrypoint guard.
    assert.equal(ctx.app.server.address(), null);
  } finally {
    await ctx.app.close();
  }
});

test('A22: production CORS preflight allows DELETE and PUT', async () => {
  const ctx = await buildApp(silentCfg());
  try {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/pending/some.draft.json',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'DELETE',
      },
    });
    assert.equal(res.statusCode, 204);
    const allow = (res.headers['access-control-allow-methods'] || '').split(/,\s*/);
    assert.ok(
      allow.includes('DELETE'),
      `allow-methods ${res.headers['access-control-allow-methods']} must include DELETE`,
    );
    assert.ok(allow.includes('PUT'), 'allow-methods must include PUT too');
  } finally {
    await ctx.app.close();
  }
});

test('A22: DELETE /api/pending/:file is registered on the real app', async () => {
  const ctx = await buildApp(silentCfg());
  try {
    // Unauthenticated → requireAdmin 401. A 404 here would mean the route was
    // never wired into the production app.
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/pending/foo.draft.json' });
    assert.equal(res.statusCode, 401);
  } finally {
    await ctx.app.close();
  }
});
