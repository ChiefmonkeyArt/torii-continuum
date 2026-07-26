/**
 * Providers honour the turn budget (v0.2.91-alpha, CONT-TIMEOUT-1).
 *
 * The router hands each provider a `budget_ms`. Two properties matter:
 *
 *   1. The AbortController deadline is min(configured timeout, remaining budget)
 *      — this is what stops a 180s `ollama.timeout_ms` from outliving nginx.
 *   2. Routstr must report `budget_exhausted` BEFORE calling wallet.send when
 *      the slice is too thin. Paying for a completion that is guaranteed to
 *      abort spends real sats for nothing.
 *
 * fetch is stubbed and the wallet is a double — no network, no mint, no sats.
 *
 * Run: node --test   (from agent/)
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createRoutstr } from '../core/routstr.mjs';
import { createOllama } from '../core/ollama.mjs';
import { ERROR_CODES } from '../lib/provider-errors.mjs';
import { MIN_PROVIDER_SLICE_MS } from '../lib/timeout-budget.mjs';

const log = { info() {}, warn() {}, error() {} };
const MESSAGES = [{ role: 'user', content: 'gm' }];

let realFetch;
/** Absolute cost-log path in a temp dir, so no test writes agent/memory/. */
let costLog;

beforeEach(async () => {
  realFetch = globalThis.fetch;
  costLog = join(await mkdtemp(join(tmpdir(), 'torii-budget-')), 'costs.jsonl');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records the AbortSignal it was given, then resolves with a canned reply. */
function recordingFetch(reply) {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), signal: opts.signal });
    return reply();
  };
  return seen;
}

function sseOk(content = 'hello') {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n`;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    text: async () => body,
  };
}

function jsonOk(content = 'hello') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ choices: [{ message: { content } }], usage: {} }),
    text: async () => '',
  };
}

function walletDouble() {
  const sends = [];
  return {
    sends,
    async send(sats) {
      sends.push(sats);
      return { ok: true, token: 'cashuAtesttoken', markSpent: async () => {} };
    },
    async receive() { return { ok: true, added_sats: 0 }; },
  };
}

function routstrCfg(routstrExtra = {}) {
  return {
    routstr: {
      endpoint: 'https://routstr.test',
      models: { chat: 'test-model' },
      limits: { max_sats_per_request: 10, timeout_ms: 45000 },
      ...routstrExtra,
    },
    logging: { cost_log: costLog },
  };
}

test('routstr refuses a too-thin budget WITHOUT spending sats', async () => {
  const seen = recordingFetch(() => sseOk());
  const wallet = walletDouble();
  const routstr = createRoutstr(routstrCfg(), wallet, log);

  const r = await routstr.chat({ skill: 'chat', messages: MESSAGES, budget_ms: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.BUDGET_EXHAUSTED);
  assert.equal(wallet.sends.length, 0, 'no Cashu token may be minted for a doomed call');
  assert.equal(seen.length, 0, 'and no request may be dispatched');
  assert.equal(r.retryable, false);
});

test('routstr proceeds when the budget is at the minimum slice', async () => {
  recordingFetch(() => sseOk('paid answer'));
  const wallet = walletDouble();
  const routstr = createRoutstr(routstrCfg(), wallet, log);

  const r = await routstr.chat({ skill: 'chat', messages: MESSAGES, budget_ms: MIN_PROVIDER_SLICE_MS });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'paid answer');
  assert.equal(wallet.sends.length, 1);
});

test('routstr still works with no budget at all (called directly)', async () => {
  recordingFetch(() => sseOk('paid answer'));
  const wallet = walletDouble();
  const routstr = createRoutstr(routstrCfg(), wallet, log);

  const r = await routstr.chat({ skill: 'chat', messages: MESSAGES });
  assert.equal(r.ok, true, 'omitting budget_ms must not break standalone use');
});

test('routstr arms an AbortSignal on every dispatched request', async () => {
  const seen = recordingFetch(() => sseOk());
  const routstr = createRoutstr(routstrCfg(), walletDouble(), log);
  await routstr.chat({ skill: 'chat', messages: MESSAGES, budget_ms: 60000 });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal, 'no signal means no deadline');
  assert.equal(seen[0].signal.aborted, false);
});

test('routstr stops walking its model ladder once the budget is gone', async () => {
  // Every attempt fails with a retryable 503, and each burns 40s of a 100s turn,
  // so at most two rungs can run — not all four.
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    clockOffset += 40000;
    return { ok: false, status: 503, headers: new Headers(), text: async () => 'upstream busy' };
  };
  let clockOffset = 0;
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + clockOffset;
  try {
    const cfg = routstrCfg({ fallback: { enabled: true, chat: ['m1', 'm2', 'm3', 'm4'] } });
    const routstr = createRoutstr(cfg, walletDouble(), log);
    const r = await routstr.chat({ skill: 'chat', messages: MESSAGES, budget_ms: 100000 });
    assert.equal(r.ok, false);
    assert.ok(calls < 5, `ladder must stop early, got ${calls} attempts`);
    assert.ok(calls >= 2, 'but it should have tried more than just the primary');
  } finally {
    Date.now = realNow;
  }
});

/** 180000ms mirrors config.example.yaml — longer than nginx's 120s read timeout. */
function ollamaCfg(ollamaExtra = {}) {
  return {
    ollama: {
      enabled: true,
      endpoint: 'http://127.0.0.1:11434',
      model: 'llama3.2:3b',
      timeout_ms: 180000,
      ...ollamaExtra,
    },
    logging: { cost_log: costLog },
  };
}

test('ollama refuses a too-thin budget', async () => {
  const seen = recordingFetch(() => jsonOk());
  const ollama = createOllama(ollamaCfg(), log);
  const r = await ollama.chat({ skill: 'chat', messages: MESSAGES, budget_ms: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.BUDGET_EXHAUSTED);
  assert.equal(seen.length, 0, 'a local model that cannot load in time is not worth starting');
});

test('ollama arms a deadline derived from the budget, not its 180s config', async () => {
  // A 180s configured timeout is longer than nginx's 120s read timeout, so the
  // clamp is the whole point. We assert the signal aborts within the budget by
  // handing over a budget short enough to fire quickly.
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(opts.signal);
    // Never resolve until aborted — proves the deadline, not the server, ends it.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const ollama = createOllama(ollamaCfg({ timeout_ms: 180000 }), log);
  const r = await ollama.chat({ skill: 'chat', messages: MESSAGES, budget_ms: MIN_PROVIDER_SLICE_MS });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.UPSTREAM_TIMEOUT);
  assert.match(r.reason, new RegExp(`timed out after ${MIN_PROVIDER_SLICE_MS}ms`),
    'the deadline came from the budget, not from ollama.timeout_ms');
  assert.equal(seen.length, 1);
});

test('ollama keeps its configured timeout when no budget is supplied', async () => {
  globalThis.fetch = async (url, opts = {}) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const ollama = createOllama(ollamaCfg({ timeout_ms: 20 }), log);
  const r = await ollama.chat({ skill: 'chat', messages: MESSAGES });
  assert.equal(r.code, ERROR_CODES.UPSTREAM_TIMEOUT);
  assert.match(r.reason, /timed out after 20ms/);
});
