/**
 * Routstr Core v0.1.0 provider discovery + routing (RIP-02/RIP-03).
 *
 * Covers the pure discovery helpers (URL normalisation, kind-38421 "u" tag
 * extraction, onion filtering), sats estimation from sats_pricing, catalog
 * fetching, and — through createRoutstr's injected `deps` — the runtime routing:
 * cheapest-provider-first failover and cost-degrade when the configured model
 * is not served by any reachable provider.
 *
 * All network seams are injected (a fake Nostr pool, a fake catalog fetcher,
 * a stub globalThis.fetch) so no real relay, provider, or mint is touched.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeBaseUrl,
  extractProviderUrl,
  isOnionUrl,
  estimateSatsForModel,
  fetchProviderCatalog,
  discoverProviders,
} from '../core/routstr-discovery.mjs';
import { createRoutstr } from '../core/routstr.mjs';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

// ── pure helpers ──

test('normalizeBaseUrl prefixes https and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('api.example.com'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeBaseUrl('http://x.onion/'), 'http://x.onion');
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl(null), null);
});

test('extractProviderUrl reads the "u" tag only', () => {
  assert.equal(extractProviderUrl({ tags: [['u', 'https://p.example']] }), 'https://p.example');
  assert.equal(extractProviderUrl({ tags: [['d', 'https://no'], ['u', 'https://yes/']] }), 'https://yes');
  assert.equal(extractProviderUrl({ tags: [['u', '']] }), null);
  assert.equal(extractProviderUrl({ tags: [] }), null);
  assert.equal(extractProviderUrl(null), null);
});

test('isOnionUrl flags Tor-only addresses the agent cannot reach', () => {
  assert.equal(isOnionUrl('http://xyz.onion'), true);
  assert.equal(isOnionUrl('https://xyz.onion:8000/'), true);
  assert.equal(isOnionUrl('https://cleartext.example'), false);
});

test('estimateSatsForModel prices from sats_pricing with a safety margin', () => {
  const model = { pricing_sats: { prompt: 1, completion: 2, request: 5, max_cost: 0 } };
  const msgs = [{ role: 'user', content: 'hello' }, { role: 'user', content: 'hi there' }]; // 13 chars
  const promptTokens = Math.max(16, Math.ceil(13 / 4)); // 16
  const raw = 5 + promptTokens * 1 + 100 * 2; // 5 + 16 + 200 = 221
  assert.equal(estimateSatsForModel(model, 100, msgs), Math.max(1, Math.ceil(raw * 1.2))); // 266
});

test('estimateSatsForModel returns null when a model has no pricing', () => {
  assert.equal(estimateSatsForModel({}, 100, []), null);
  assert.equal(estimateSatsForModel(null, 100, []), null);
});

// ── catalog + discovery ──

test('fetchProviderCatalog parses models, filters empty ids, skips unreachable', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('good.example')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-x', name: 'GPT X', sats_pricing: { prompt: 0.01, completion: 0.02, request: 0.001 } },
            { id: '', name: 'empty id' },                 // filtered
            { id: 'no-price', name: 'No price' },          // no sats_pricing
          ],
        }),
      };
    }
    return { ok: false, status: 500 };
  };
  const catalog = await fetchProviderCatalog(
    [
      { baseUrl: 'https://good.example', name: 'g', npub: null },
      { baseUrl: 'https://bad.example', name: 'b', npub: null },
    ],
    { fetchFn },
  );
  assert.equal(catalog.length, 1, 'unreachable provider skipped');
  assert.equal(catalog[0].baseUrl, 'https://good.example');
  assert.equal(catalog[0].models.length, 2, 'empty id filtered out');
  assert.equal(catalog[0].models[0].id, 'gpt-x');
  assert.equal(catalog[0].models[0].pricing_sats.completion, 0.02);
  // No explicit max_cost → the cheapness signal falls back to completion price.
  assert.equal(catalog[0].models[0].max_cost_sats, 0.02);
  assert.equal(catalog[0].models[1].pricing_sats, null);
  assert.equal(catalog[0].models[1].max_cost_sats, null);
});

test('discoverProviders merges bootstrap + kind-38421 announcements, dedupes, skips onion', async () => {
  const fakePool = {
    subscribeMany(_relays, _filters, handlers) {
      handlers.onevent({ pubkey: 'npubAAA', content: JSON.stringify({ name: 'Node A' }), tags: [['u', 'https://a.example']] });
      handlers.onevent({ pubkey: 'npubBBB', content: JSON.stringify({ name: 'Onion' }), tags: [['u', 'http://xyz.onion']] });
      handlers.onevent({ pubkey: 'npubCCC', content: 'not json', tags: [['u', 'https://c.example/']] });
      handlers.onevent({ pubkey: 'npubDDD', content: '{}', tags: [['d', 'https://noturl.example']] }); // no "u" tag
      handlers.oneose();
      return {};
    },
    close() {},
  };
  const providers = await discoverProviders({
    bootstrapEndpoints: ['https://bootstrap.example', 'https://a.example'], // a.example also announced → dedupe
    relays: ['wss://relay.test'],
    pool: fakePool,
  });
  const urls = providers.map((p) => p.baseUrl);
  assert.ok(urls.includes('https://bootstrap.example'));
  assert.ok(urls.includes('https://a.example'));
  assert.ok(urls.includes('https://c.example'), 'trailing slash stripped');
  assert.ok(!urls.some((u) => u.includes('.onion')), 'onion-only announcement skipped');
  assert.ok(!urls.includes('https://noturl.example'), 'no u-tag → not a provider');
  assert.equal(new Set(urls).size, urls.length, 'duplicates collapsed by normalised URL');
});

// ── runtime routing via createRoutstr ──

async function baseCfg(model) {
  const dir = await mkdtemp(join(tmpdir(), 'routstr-discovery-'));
  return {
    routstr: {
      providers: [],
      discovery: { enabled: false },
      models: { chat: model },
      limits: { max_sats_per_request: 50, max_tokens_out: 2048 },
    },
    logging: { cost_log: join(dir, 'costs.jsonl') },
  };
}

function okWallet() {
  return {
    async send() { return { ok: true, token: 'cashuTOK', mint: 'm', sats: 50, rollback: async () => {} }; },
    async receive() { return { ok: true, added_sats: 0 }; },
  };
}

function completion(content) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  return { ok: true, status: 200, headers: new Map(), async text() { return body; } };
}

function errorResponse(status, body) {
  return { ok: false, status, headers: new Map(), async text() { return body; } };
}

function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  return (async () => {
    try { return await fn(); } finally { globalThis.fetch = orig; }
  })();
}

test('routes to the cheapest provider for a model and fails over on failure', async () => {
  const cfg = await baseCfg('m');
  const deps = {
    fetchCatalog: async () => [
      {
        baseUrl: 'https://pricey.example', name: 'pricey', npub: null,
        models: [{ id: 'm', name: 'm', pricing_sats: { prompt: 2, completion: 2, request: 0, max_cost: 0 }, max_cost_sats: 2 }],
      },
      {
        baseUrl: 'https://cheap.example', name: 'cheap', npub: null,
        models: [{ id: 'm', name: 'm', pricing_sats: { prompt: 1, completion: 1, request: 0, max_cost: 0 }, max_cost_sats: 1 }],
      },
    ],
  };
  const chatCalls = [];
  await withFetch(async (url, opts) => {
    if (String(url).endsWith('/v1/balance/refund')) return errorResponse(404, 'no');
    chatCalls.push(String(url));
    if (String(url).includes('cheap.example')) return errorResponse(503, 'down');
    return completion('served-by-pricey');
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog(), deps);
    const r = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'served-by-pricey');
  });
  assert.deepEqual(chatCalls, [
    'https://cheap.example/v1/chat/completions',
    'https://pricey.example/v1/chat/completions',
  ], 'cheapest provider first, then fail over');
});

test('degrades to the cheapest available model when the configured model is absent', async () => {
  const cfg = await baseCfg('missing-model');
  const deps = {
    fetchCatalog: async () => [
      {
        baseUrl: 'https://p.example', name: 'p', npub: null,
        models: [{ id: 'fallback-model', name: 'fallback', pricing_sats: null, max_cost_sats: null }],
      },
    ],
  };
  let usedModel = null;
  await withFetch(async (url, opts) => {
    if (String(url).endsWith('/v1/balance/refund')) return errorResponse(404, 'no');
    usedModel = JSON.parse(opts.body).model;
    return completion('ok');
  }, async () => {
    const routstr = createRoutstr(cfg, okWallet(), silentLog(), deps);
    const r = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
    assert.equal(r.ok, true);
  });
  assert.equal(usedModel, 'fallback-model', 'must degrade to an available model, not 404');
});

test('returns provider_disabled when no provider is reachable and no legacy endpoint', async () => {
  const cfg = await baseCfg('auto');
  const deps = { fetchCatalog: async () => [] };
  const routstr = createRoutstr(cfg, okWallet(), silentLog(), deps);
  const r = await routstr.chat({ messages: [{ role: 'user', content: 'yo' }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'provider_disabled');
});