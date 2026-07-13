/**
 * trustProxy is a loopback-only allow-list, not `true`.
 *
 * These tests pin the security property the nginx layer depends on:
 *   - A request whose socket peer is loopback (the local nginx hop) has its
 *     X-Forwarded-For honoured, so req.ip becomes the real client IP and the
 *     per-IP rate-limit buckets separate clients.
 *   - A request from a non-loopback peer (a direct off-box connection if the
 *     agent were ever exposed beyond 127.0.0.1) has its X-Forwarded-For
 *     IGNORED, so a forged header cannot spoof req.ip or collapse the buckets.
 *
 * We build a Fastify instance with the SAME trustProxy shape as index.mjs and
 * drive it with light-my-request (app.inject) so we can set the socket peer
 * (remoteAddress) and the forwarded header independently — no live socket.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// Mirror index.mjs: loopback-only trust list. Keep in sync with the Fastify
// constructor there — this is the exact property under test.
const TRUST_PROXY = ['127.0.0.1', '::1'];

function buildApp() {
  const app = Fastify({ trustProxy: TRUST_PROXY, logger: false });
  app.get('/whoami', async (req) => ({ ip: req.ip }));
  return app;
}

test('loopback peer: X-Forwarded-For is honoured → req.ip is the client', async () => {
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ip, '203.0.113.7', 'trusted loopback → forwarded client IP');
  } finally {
    await app.close();
  }
});

test('loopback peer, no XFF: req.ip falls back to the socket peer', async () => {
  const app = buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/whoami', remoteAddress: '127.0.0.1' });
    assert.equal(JSON.parse(res.body).ip, '127.0.0.1');
  } finally {
    await app.close();
  }
});

test('non-loopback peer: forged X-Forwarded-For is IGNORED → req.ip stays the socket peer', async () => {
  const app = buildApp();
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      remoteAddress: '198.51.100.9',
      headers: { 'x-forwarded-for': '127.0.0.1' }, // attacker tries to masquerade as loopback
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ip, '198.51.100.9', 'untrusted peer → XFF ignored, real socket IP kept');
  } finally {
    await app.close();
  }
});

test('two loopback-proxied clients get distinct req.ip → separate rate-limit buckets', async () => {
  // The rate limiter keys on req.ip. If XFF weren't honoured, both would key as
  // 127.0.0.1 and share a bucket. With the loopback trust list they differ.
  const app = buildApp();
  try {
    const a = await app.inject({
      method: 'GET', url: '/whoami', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const b = await app.inject({
      method: 'GET', url: '/whoami', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });
    assert.notEqual(JSON.parse(a.body).ip, JSON.parse(b.body).ip, 'distinct client IPs → distinct buckets');
  } finally {
    await app.close();
  }
});

test('two spoofing off-box clients cannot forge a shared victim bucket', async () => {
  // Without the loopback restriction, an off-box attacker could set XFF to any
  // value. Here their XFF is ignored, so each keeps its own socket IP and can
  // only ever exhaust its OWN bucket — never a chosen victim's.
  const app = buildApp();
  try {
    const a = await app.inject({
      method: 'GET', url: '/whoami', remoteAddress: '198.51.100.1',
      headers: { 'x-forwarded-for': '10.0.0.99' },
    });
    const b = await app.inject({
      method: 'GET', url: '/whoami', remoteAddress: '198.51.100.2',
      headers: { 'x-forwarded-for': '10.0.0.99' },
    });
    assert.equal(JSON.parse(a.body).ip, '198.51.100.1');
    assert.equal(JSON.parse(b.body).ip, '198.51.100.2');
  } finally {
    await app.close();
  }
});
