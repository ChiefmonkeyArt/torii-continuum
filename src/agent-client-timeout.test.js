/**
 * Agent client — bounded fetch (v0.2.91-alpha, CONT-TIMEOUT-1).
 *
 * The browser fetch had NO deadline. When the agent stalled behind a slow model
 * provider the operator watched a spinner until nginx severed the socket at
 * 120s — and the SPA had no way to tell "slow" from "gone". Every request now
 * carries an AbortController deadline, and a chat turn gets a longer one that
 * sits between the agent's own turn budget and nginx's read timeout:
 *
 *   agent budget 100s  <  CHAT_CLIENT_TIMEOUT_MS 115s  <=  nginx 120s
 *
 * fetch is stubbed — no network. Source-structure assertions follow the repo's
 * jsdom-free convention (tests run in the node environment; there is no window).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chat, CHAT_CLIENT_TIMEOUT_MS } from './data/agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(join(here, 'data/agent.js'), 'utf8');

/** The agent client reads its base URL off window at call time. */
function withAgentUrl(url, fn) {
  const had = 'window' in globalThis;
  const prev = globalThis.window;
  globalThis.window = { __CONTINUUM_AGENT_URL__: url };
  try { return fn(); } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
}

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
  vi.useRealTimers();
});

describe('the deadline chain', () => {
  it('places the client deadline above the agent budget and below nginx', () => {
    // agent/lib/timeout-budget.mjs DEFAULT_TOTAL_BUDGET_MS
    const AGENT_BUDGET_MS = 100000;
    // ops/nginx/torii-api.conf proxy_read_timeout
    const NGINX_READ_TIMEOUT_MS = 120000;
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeGreaterThan(AGENT_BUDGET_MS);
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(NGINX_READ_TIMEOUT_MS);
  });
});

describe('chat() bounds its request', () => {
  it('passes an AbortSignal to fetch', async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      seen.push(opts);
      return { ok: true, status: 200, json: async () => ({ reply: 'hi' }) };
    });
    await withAgentUrl('https://agent.example', async () => {
      const r = await chat({ message: 'gm', context: {} });
      expect(r.ok).toBe(true);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeTruthy();
    expect(seen[0].signal.aborted).toBe(false);
  });

  it('reports client_timeout — not "offline" — when the deadline fires', async () => {
    // A stalled agent is reachable but slow. Calling that "offline" would send
    // the operator chasing a network fault that isn't there.
    globalThis.fetch = vi.fn((url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    vi.useFakeTimers();
    const pending = withAgentUrl('https://agent.example', () => chat({ message: 'gm', context: {} }));
    await vi.advanceTimersByTimeAsync(CHAT_CLIENT_TIMEOUT_MS + 1);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('client_timeout');
    expect(r.timeout).toBe(true);
    expect(r.offline).toBeUndefined();
    expect(r.reason).toMatch(/timed out after 115s/);
  });

  it('still classifies a genuine connection failure as offline', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const r = await withAgentUrl('https://agent.example', () => chat({ message: 'gm', context: {} }));
    expect(r.ok).toBe(false);
    expect(r.offline).toBe(true);
    expect(r.code).toBeUndefined();
  });

  it('does not fire the deadline for a request that completes in time', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ reply: 'quick' }) }));
    const r = await withAgentUrl('https://agent.example', () => chat({ message: 'gm', context: {} }));
    expect(r.ok).toBe(true);
    expect(r.data.reply).toBe('quick');
  });

  it('aborts a response whose BODY never arrives, not just a hung connection', async () => {
    // A proxy can send headers and then stall. Clearing the timer before the
    // body read would leave that case unbounded.
    globalThis.fetch = vi.fn(async (url, opts) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }));
    vi.useFakeTimers();
    const pending = withAgentUrl('https://agent.example', () => chat({ message: 'gm', context: {} }));
    await vi.advanceTimersByTimeAsync(CHAT_CLIENT_TIMEOUT_MS + 1);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('client_timeout');
  });

  it('returns offline without touching fetch when no agent is configured', async () => {
    globalThis.fetch = vi.fn();
    const r = await chat({ message: 'gm', context: {} });
    expect(r.offline).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('source structure', () => {
  it('every request goes through the bounded req() helper', () => {
    expect(agentSrc).toMatch(/const ctl = typeof AbortController === 'function' \? new AbortController\(\) : null;/);
    expect(agentSrc).toMatch(/signal: ctl \? ctl\.signal : undefined,/);
  });

  it('chat() opts into the longer chat deadline explicitly', () => {
    expect(agentSrc).toMatch(/timeoutMs: CHAT_CLIENT_TIMEOUT_MS/);
  });

  it('documents the ordering against nginx so the constant is not tuned blindly', () => {
    expect(agentSrc).toMatch(/proxy_read_timeout/);
  });
});
