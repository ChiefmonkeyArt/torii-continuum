/**
 * Fastify v5 + plugin-stack contract (AGENT-SEC dependency remediation).
 *
 * The v0.2.27-alpha security bump moved fastify 4 → 5, @fastify/cors 9 → 11,
 * and @fastify/rate-limit 9 → 11 to clear the fast-uri / fastify advisories.
 * These tests pin the exact plugin API surface index.mjs relies on so a future
 * bump can't silently regress it, using light-my-request (no live socket):
 *
 *   - CORS preflight is answered and echoes the configured origin.
 *   - The rate limiter registered with { global: false } only bounds routes
 *     that opt in via config.rateLimit, and returns the structured 429 body +
 *     Retry-After that index.mjs builds.
 *   - errorResponseBuilder still receives a numeric context.ttl (index.mjs
 *     derives retry_after_sec from it).
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

const ORIGIN = 'http://localhost:5173';

async function buildApp() {
  const app = Fastify({ trustProxy: ['127.0.0.1', '::1'], logger: false });
  await app.register(cors, {
    origin: [ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(rateLimit, { global: false, keyGenerator: (req) => req.ip });

  let sawNumericTtl = false;
  const limited = {
    rateLimit: {
      max: 2,
      timeWindow: '1 minute',
      errorResponseBuilder: (req, ctx) => {
        sawNumericTtl = typeof ctx.ttl === 'number';
        return {
          statusCode: 429,
          error: 'Too Many Requests',
          ok: false,
          reason: 'rate_limited',
          retry_after_sec: Math.ceil((ctx.ttl || 60000) / 1000),
        };
      },
    },
  };

  app.post('/limited', { config: limited }, async () => ({ ok: true }));
  app.post('/open', async () => ({ ok: true }));
  await app.ready();
  return { app, ttlSeen: () => sawNumericTtl };
}

test('CORS preflight is answered and echoes the configured origin', async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/limited',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  } finally {
    await app.close();
  }
});

test('rate limiter trips at N+1 with structured 429 body + Retry-After', async () => {
  const { app, ttlSeen } = await buildApp();
  try {
    const inject = () =>
      app.inject({ method: 'POST', url: '/limited', payload: {}, remoteAddress: '203.0.113.5' });
    assert.equal((await inject()).statusCode, 200);
    assert.equal((await inject()).statusCode, 200);
    const tripped = await inject();
    assert.equal(tripped.statusCode, 429);
    assert.ok(tripped.headers['retry-after'], 'Retry-After header present');
    const body = JSON.parse(tripped.body);
    assert.equal(body.reason, 'rate_limited');
    assert.equal(typeof body.retry_after_sec, 'number');
    assert.ok(ttlSeen(), 'errorResponseBuilder received a numeric context.ttl');
  } finally {
    await app.close();
  }
});

test('bodyless POST contract: empty body + application/json is a 400, no content-type is a 200', async () => {
  // Pins the Fastify v5 behaviour that the onboarding client's postJson must
  // respect. /api/auth/challenge takes no request body. If a caller sends an
  // empty body WITH `Content-Type: application/json`, Fastify's JSON parser
  // rejects it as FST_ERR_CTP_EMPTY_JSON_BODY (HTTP 400) before the handler
  // runs — this is what surfaced to the operator as "agent challenge failed
  // (400)". The same call with NO content-type reaches the handler and 200s.
  const app = Fastify({ logger: false });
  app.post('/api/auth/challenge', async () => ({ challenge: 'x'.repeat(48), expires_in: 300, kind: 22242 }));
  await app.ready();
  try {
    const withJsonCt = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(withJsonCt.statusCode, 400);
    assert.equal(JSON.parse(withJsonCt.body).code, 'FST_ERR_CTP_EMPTY_JSON_BODY');

    const bodyless = await app.inject({ method: 'POST', url: '/api/auth/challenge' });
    assert.equal(bodyless.statusCode, 200);
    assert.equal(JSON.parse(bodyless.body).kind, 22242);
  } finally {
    await app.close();
  }
});

test('global:false leaves un-opted routes unbounded past the v11 default max (1000)', async () => {
  // @fastify/rate-limit v11 defaults to max:1000 per window for routes that opt
  // in without their own max. With global:false and no route-level config, /open
  // must have NO limiter at all — so exceeding 1000 requests in one window still
  // 200s. Fewer than 1001 requests could not distinguish "no limiter" from an
  // "accidental default limiter", so we cross the 1000 boundary explicitly.
  const { app } = await buildApp();
  try {
    let last = 0;
    for (let i = 0; i < 1001; i++) {
      const res = await app.inject({ method: 'POST', url: '/open', payload: {}, remoteAddress: '203.0.113.6' });
      last = res.statusCode;
      if (res.statusCode !== 200) {
        assert.fail(`unconfigured route was limited at request ${i + 1} (status ${res.statusCode}) — global:false leaked a default limiter`);
      }
    }
    assert.equal(last, 200, 'the 1001st request past the v11 default cap still succeeds');
  } finally {
    await app.close();
  }
});
