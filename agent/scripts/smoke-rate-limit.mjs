/**
 * Local smoke for v0.2.14-alpha rate-limit slice.
 *
 * Boots a Fastify instance with a minimal in-memory config, hammers
 * /api/auth/challenge and /api/auth/verify to prove:
 *   1. Default limits enforce (429 on the 11th /challenge, 21st /verify)
 *   2. Retry-After header present on 429
 *   3. auth.challenge.issued / auth.verify.fail / auth.ratelimited log lines
 *   4. MAX_CHALLENGES cap actually evicts oldest entries under overshoot
 *   5. Disabling via cfg.rate_limit.enabled=false lets 15/15 through
 *
 * Run: node agent/scripts/smoke-rate-limit.mjs
 */

import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createAuth } from '../core/auth.mjs';

function makeCfg(overrides = {}) {
  return {
    admin_npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
    session_secret: 'a'.repeat(64),
    session_ttl_sec: 86400,
    rate_limit: {
      enabled: true,
      auth_challenge_per_min: 10,
      auth_verify_per_min: 20,
      max_challenges: 5, // low for fast eviction check
      ...(overrides.rate_limit || {}),
    },
    ...overrides,
  };
}

async function makeApp(cfg) {
  const captured = [];
  const stubLog = {
    info: (o) => captured.push({ level: 'info', ...(typeof o === 'string' ? { msg: o } : o) }),
    warn: (o) => captured.push({ level: 'warn', ...(typeof o === 'string' ? { msg: o } : o) }),
    error: (o) => captured.push({ level: 'error', ...(typeof o === 'string' ? { msg: o } : o) }),
    child: () => stubLog,
    fatal: () => {},
    trace: () => {},
    debug: () => {},
  };

  const app = Fastify({ logger: false });
  // Attach our capturing log for the routes/auth to use.
  app.log = stubLog;

  if (cfg.rate_limit?.enabled !== false) {
    await app.register(rateLimit, { global: false, keyGenerator: (req) => req.ip });
  }

  const auth = createAuth(cfg, { log: stubLog });

  function rateLimitConfig(max, route) {
    if (cfg.rate_limit?.enabled === false) return undefined;
    return {
      rateLimit: {
        max,
        timeWindow: '1 minute',
        errorResponseBuilder: (req, ctx) => {
          stubLog.warn({ evt: 'auth.ratelimited', route, ip_prefix: (req.ip || '').slice(0, 12), max, remaining_ms: ctx.ttl });
          return { statusCode: 429, error: 'Too Many Requests', ok: false, reason: 'rate_limited', retry_after_sec: Math.ceil((ctx.ttl || 60000) / 1000) };
        },
      },
    };
  }

  app.post('/api/auth/challenge', { config: rateLimitConfig(cfg.rate_limit?.auth_challenge_per_min, '/api/auth/challenge') }, async (req) => {
    return auth.issueChallenge(req.ip);
  });

  app.post('/api/auth/verify', { config: rateLimitConfig(cfg.rate_limit?.auth_verify_per_min, '/api/auth/verify') }, async (req, reply) => {
    const event = req.body?.event;
    if (!event) return reply.code(400).send({ error: 'body.event required' });
    const result = auth.verifyChallenge(event, req.ip);
    if (!result.ok) return reply.code(401).send({ error: result.reason });
    return { token: result.token, expires_at: result.expires_at };
  });

  await app.ready();
  return { app, auth, log: captured };
}

async function hammer(app, path, n) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: 'POST', url: path, payload: {}, remoteAddress: '203.0.113.42' });
    results.push({ i: i + 1, status: res.statusCode, retryAfter: res.headers['retry-after'] || null });
  }
  return results;
}

async function main() {
  const failures = [];

  // --- Test 1: /api/auth/challenge trips at N+1 ---
  {
    const cfg = makeCfg();
    const { app, log } = await makeApp(cfg);
    const r = await hammer(app, '/api/auth/challenge', 12);
    const ok10 = r.slice(0, 10).every((x) => x.status === 200);
    const trip11 = r[10].status === 429 && r[10].retryAfter !== null;
    const trip12 = r[11].status === 429;
    console.log(`[T1] challenge x10 all 200: ${ok10 ? 'PASS' : 'FAIL'}`);
    console.log(`[T1] challenge #11 = 429 + Retry-After: ${trip11 ? 'PASS' : 'FAIL'} (status=${r[10].status}, retry-after=${r[10].retryAfter})`);
    console.log(`[T1] challenge #12 = 429: ${trip12 ? 'PASS' : 'FAIL'}`);
    const rl = log.filter((l) => l.evt === 'auth.ratelimited');
    console.log(`[T1] auth.ratelimited log lines: ${rl.length >= 2 ? 'PASS' : 'FAIL'} (got ${rl.length})`);
    if (!ok10 || !trip11 || !trip12 || rl.length < 2) failures.push('T1');
    await app.close();
  }

  // --- Test 2: /api/auth/verify trips at 21st ---
  {
    const cfg = makeCfg({ rate_limit: { enabled: true, auth_challenge_per_min: 999, auth_verify_per_min: 20, max_challenges: 5 } });
    const { app } = await makeApp(cfg);
    const r = await hammer(app, '/api/auth/verify', 22);
    const first20 = r.slice(0, 20).every((x) => x.status !== 429); // 400 or 401 acceptable
    const trip21 = r[20].status === 429;
    console.log(`[T2] verify x20 no 429s: ${first20 ? 'PASS' : 'FAIL'}`);
    console.log(`[T2] verify #21 = 429: ${trip21 ? 'PASS' : 'FAIL'} (status=${r[20].status})`);
    if (!first20 || !trip21) failures.push('T2');
    await app.close();
  }

  // --- Test 3: challenges Map cap enforced ---
  {
    const cfg = makeCfg({ rate_limit: { enabled: true, auth_challenge_per_min: 999, auth_verify_per_min: 999, max_challenges: 5 } });
    const { app, auth, log } = await makeApp(cfg);
    await hammer(app, '/api/auth/challenge', 10);
    const size = auth._challenges.size;
    const capOk = size <= 5;
    console.log(`[T3] challenges Map size after 10 issues (cap=5): ${capOk ? 'PASS' : 'FAIL'} (size=${size})`);
    const evicted = log.filter((l) => l.evt === 'auth.challenge.evicted');
    console.log(`[T3] auth.challenge.evicted logs emitted: ${evicted.length > 0 ? 'PASS' : 'FAIL'} (count=${evicted.length})`);
    if (!capOk || evicted.length === 0) failures.push('T3');
    await app.close();
  }

  // --- Test 4: disable path lets everything through ---
  {
    const cfg = makeCfg({ rate_limit: { enabled: false } });
    const { app } = await makeApp(cfg);
    const r = await hammer(app, '/api/auth/challenge', 15);
    const allOk = r.every((x) => x.status === 200);
    console.log(`[T4] rate_limit.enabled=false → 15/15 accepted: ${allOk ? 'PASS' : 'FAIL'}`);
    if (!allOk) failures.push('T4');
    await app.close();
  }

  // --- Test 5: log line taxonomy present ---
  {
    const cfg = makeCfg({ rate_limit: { enabled: true, auth_challenge_per_min: 999, auth_verify_per_min: 999, max_challenges: 1000 } });
    const { app, log } = await makeApp(cfg);
    await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: {}, remoteAddress: '203.0.113.42' });
    await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { event: { kind: 99 } }, remoteAddress: '203.0.113.42' });
    const issued = log.filter((l) => l.evt === 'auth.challenge.issued');
    const fail = log.filter((l) => l.evt === 'auth.verify.fail');
    console.log(`[T5] auth.challenge.issued: ${issued.length > 0 ? 'PASS' : 'FAIL'} (${issued.length})`);
    console.log(`[T5] auth.verify.fail: ${fail.length > 0 ? 'PASS' : 'FAIL'} (${fail.length})`);
    console.log(`[T5] no full pubkey/challenge in issued log: ${issued.every((l) => !l.challenge && !l.pubkey) ? 'PASS' : 'FAIL'}`);
    if (issued.length === 0 || fail.length === 0) failures.push('T5');
    await app.close();
  }

  console.log('');
  if (failures.length === 0) {
    console.log('ALL SMOKE TESTS PASS');
    process.exit(0);
  } else {
    console.error(`FAILURES: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('SMOKE THREW:', e);
  process.exit(2);
});
