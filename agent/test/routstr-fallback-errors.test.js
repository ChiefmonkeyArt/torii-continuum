/**
 * Routstr client — structured sanitised failures + the chat deadline
 * (v0.2.90-alpha, CONT-FALLBACK-1).
 *
 * Three failure modes previously produced either a dead turn or a leaky reason:
 *
 *   1. 5xx  — reason spliced 200 chars of the raw body into a client string.
 *   2. HTML — a Cloudflare-style error page, sometimes under a 200 status, was
 *             reported only as the opaque "no content in stream".
 *   3. hang — the completion fetch had NO timeout at all, so a stalled edge held
 *             the chat request open indefinitely instead of yielding to Ollama.
 *
 * Each now returns { ok:false, code, reason, retryable } with the upstream body
 * classified, never forwarded. HTTP is faked by stubbing globalThis.fetch.
 * No real proofs, secrets, or tokens.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutstr } from '../core/routstr.mjs';
import { ERROR_CODES } from '../lib/provider-errors.mjs';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

async function baseCfg(extraLimits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-fb-'));
  return {
    routstr: {
      endpoint: 'https://api.routstr.com',
      models: { chat: 'deepseek-chat' },
      limits: { max_sats_per_request: 50, ...extraLimits },
    },
    logging: { cost_log: join(dir, 'costs.jsonl') },
  };
}

/** Wallet double: always funds, and tolerates the refund-reclaim attempt. */
function okWallet() {
  return {
    async send() {
      return { ok: true, token: 'cashuATESTTOKEN', mint: 'm', sats: 50, rollback: async () => {} };
    },
    async receive() { return { ok: false, reason: 'nothing to claim' }; },
  };
}

function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  return (async () => {
    try { return await fn(); } finally { globalThis.fetch = orig; }
  })();
}

/** A non-OK response double. */
function errorResponse(status, body) {
  return {
    ok: false,
    status,
    headers: new Map(),
    async text() { return body; },
  };
}

const MSGS = [{ role: 'user', content: 'yo' }];

test('a 5xx yields a retryable upstream_5xx and never echoes the raw body', async () => {
  const cfg = await baseCfg();
  const leaky = 'internal-host.example exploded: stacktrace at /srv/secret/path.py:42';
  await withFetch(async (url) => {
    // The refund-reclaim probe also hits fetch; answer it harmlessly.
    if (url.endsWith('/v1/wallet/refund')) return errorResponse(404, 'no');
    return errorResponse(503, leaky);
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERROR_CODES.UPSTREAM_5XX);
    assert.equal(r.retryable, true);
    assert.ok(!r.reason.includes('/srv/secret/path.py'), 'must not leak upstream body');
    assert.ok(!r.reason.includes('internal-host.example'), 'must not leak upstream body');
  });
});

test('an HTML error page under a 5xx is classified as upstream_html', async () => {
  const cfg = await baseCfg();
  const html = '<!doctype html><html><head><title>520 Origin Error</title></head><body>cf</body></html>';
  await withFetch(async (url) => {
    if (url.endsWith('/v1/wallet/refund')) return errorResponse(404, 'no');
    return errorResponse(520, html);
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.code, ERROR_CODES.UPSTREAM_HTML);
    assert.equal(r.retryable, true);
    assert.ok(!r.reason.includes('<'), 'no markup in the reason');
  });
});

test('an HTML error page served under a 200 is upstream_html, not an empty stream', async () => {
  // The nastiest real case: status says 200, body is an edge error page. The old
  // code reported the opaque "no content in stream" for this.
  const cfg = await baseCfg();
  const html = '<html><body>Bad gateway</body></html>';
  await withFetch(async (url) => {
    if (url.endsWith('/v1/wallet/refund')) return errorResponse(404, 'no');
    return { ok: true, status: 200, headers: new Map(), async text() { return html; } };
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.code, ERROR_CODES.UPSTREAM_HTML);
    assert.equal(r.retryable, true);
  });
});

test('a genuinely empty 200 stream is upstream_empty (distinct from HTML)', async () => {
  const cfg = await baseCfg();
  await withFetch(async (url) => {
    if (url.endsWith('/v1/wallet/refund')) return errorResponse(404, 'no');
    return { ok: true, status: 200, headers: new Map(), async text() { return 'data: [DONE]\n\n'; } };
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.code, ERROR_CODES.UPSTREAM_EMPTY);
    assert.equal(r.retryable, true);
  });
});

test('the completion fetch is given an AbortSignal deadline', async () => {
  const cfg = await baseCfg({ timeout_ms: 1234 });
  let sawSignal = false;
  await withFetch(async (url, opts) => {
    if (url.endsWith('/v1/chat/completions')) sawSignal = !!opts?.signal;
    return errorResponse(500, 'boom');
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    await routstr.chat({ messages: MSGS });
  });
  assert.equal(sawSignal, true, 'a hung upstream must be abortable');
});

test('an aborted completion yields a retryable upstream_timeout', async () => {
  const cfg = await baseCfg({ timeout_ms: 25 });
  await withFetch(async (url, opts) => {
    if (url.endsWith('/v1/wallet/refund')) return errorResponse(404, 'no');
    // Never settle on its own — only the client's deadline ends this.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    });
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERROR_CODES.UPSTREAM_TIMEOUT);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /timed out after 25ms/);
  });
});

test('a dry wallet is a retryable insufficient_funds without dispatching a request', async () => {
  const cfg = await baseCfg();
  const dryWallet = {
    async send() { return { ok: false, reason: 'insufficient balance across all mints for 50 sats' }; },
    async receive() { throw new Error('unreachable'); },
  };
  let dispatched = false;
  await withFetch(async () => { dispatched = true; return errorResponse(500, 'x'); }, async () => {
    const routstr = createRoutstr(cfg, dryWallet, silentLog());
    const r = await routstr.chat({ messages: MSGS });
    assert.equal(r.ok, false);
    assert.equal(r.code, ERROR_CODES.INSUFFICIENT_FUNDS);
    assert.equal(r.retryable, true);
  });
  assert.equal(dispatched, false, 'must not call the model without payment');
});

test('an empty messages array is a non-retryable bad_request', async () => {
  const cfg = await baseCfg();
  const routstr = createRoutstr(cfg, okWallet(), silentLog());
  const r = await routstr.chat({ messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.BAD_REQUEST);
  assert.equal(r.retryable, false);
});
