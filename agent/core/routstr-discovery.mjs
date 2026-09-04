/**
 * Routstr Core v0.1.0 provider discovery + model catalog.
 *
 * Providers announce themselves as Nostr kind 38421 events (RIP-02/RIP-03).
 * The base URL is carried in an "u" tag (tag[0] === "u"), the human name/about
 * in the event content ({name, about}), and the provider's npub is the signer
 * (event.pubkey). A provider may also advertise a Tor ".onion" URL; this agent
 * has no Tor proxy, so onion-only endpoints are skipped.
 *
 * Discovery is best-effort and layered — deterministic bootstrap endpoints
 * (config) always lead, then live Nostr announcements are merged in. A provider
 * is keyed by its normalised base URL so duplicate announcements collapse.
 *
 * Onboarding note: the agent targets Node >= 22.4.0 where `globalThis.WebSocket`
 * is available; `nostr-tools` SimplePool uses it. Unit tests inject a fake
 * `pool` and `fetchFn` so discovery is never exercised over a live network in
 * `node --test`.
 */

import { SimplePool } from 'nostr-tools/pool';

const KIND_PROVIDER_ANNOUNCEMENT = 38421;
const DEFAULT_RELAYS = [
  'wss://relay.routstr.com',
  'wss://nos.lol',
  'wss://relay.damus.io',
];
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8000;
const DEFAULT_CATALOG_TIMEOUT_MS = 12000;

/**
 * Normalise a provider base URL: trim whitespace/trailing slashes, prefix
 * `https://` when a scheme is missing (a bare host is a common announcement).
 * Returns null for anything that can't be normalised.
 */
export function normalizeBaseUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

/** Is this base URL an unreachable Tor onion address? (no proxy here) */
export function isOnionUrl(url) {
  return /\.onion(:\d+)?\/?$/i.test(url || '');
}

/** Extract the base URL from a kind-38421 event's "u" tag, if present. */
export function extractProviderUrl(event) {
  if (!event || !Array.isArray(event.tags)) return null;
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === 'u' && typeof tag[1] === 'string' && tag[1].trim()) {
      return normalizeBaseUrl(tag[1]);
    }
  }
  return null;
}

function safeName(event) {
  try {
    const n = JSON.parse(event?.content || '').name;
    if (typeof n === 'string' && n.trim()) return n.trim();
  } catch { /* non-JSON content — no name */ }
  return null;
}

/**
 * Discover providers = bootstrap endpoints (config) + live kind-38421
 * announcements, deduped by normalised base URL. Returns
 * `[{ baseUrl, name, npub }]`. Never throws — discovery degrades to the
 * bootstrap list (or an empty list) when the network is unavailable.
 *
 * @param {object} opts
 * @param {string[]} opts.bootstrapEndpoints  deterministic fallback base URLs
 * @param {string[]} [opts.relays]             relays to query (defaults supplied)
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.pool]               injectable nostr-tools SimplePool
 */
export async function discoverProviders({
  bootstrapEndpoints = [],
  relays = DEFAULT_RELAYS,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  pool = null,
} = {}) {
  const map = new Map();
  const add = (baseUrl, name, npub) => {
    const u = normalizeBaseUrl(baseUrl);
    if (!u || isOnionUrl(u)) return;
    if (!map.has(u)) {
      map.set(u, { baseUrl: u, name: name || u, npub: npub || null });
    } else if (name && !map.get(u).name) {
      map.get(u).name = name;
    }
  };

  for (const b of bootstrapEndpoints || []) add(b, null, null);

  const p = pool || new SimplePool();
  const rel = Array.isArray(relays) && relays.length ? relays : DEFAULT_RELAYS;
  try {
    const events = await queryKind38421(p, rel, timeoutMs);
    for (const ev of events) {
      const u = extractProviderUrl(ev);
      if (!u) continue;
      add(u, safeName(ev), ev.pubkey);
    }
  } catch {
    /* discovery best-effort — keep bootstrap list */
  } finally {
    if (!pool) { try { p.close(rel); } catch { /* ignore */ } }
  }

  return [...map.values()];
}

function queryKind38421(pool, relays, timeoutMs) {
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      pool.subscribeMany(relays, [{ kinds: [KIND_PROVIDER_ANNOUNCEMENT], limit: 200 }], {
        onevent: (ev) => { events.push(ev); },
        oneose: () => finish(),
        onclose: () => finish(),
      });
    } catch {
      finish();
    }
  });
}

/**
 * Pull each provider's model catalog from `GET {baseUrl}/v1/models`.
 * Returns `[{ baseUrl, name, npub, models: [{id, name, pricing_sats, max_cost_sats}] }]`
 * for every reachable provider; unreachable ones are skipped silently.
 * `models[i].pricing_sats` is the per-token cost in sats when the node exposes
 * `sats_pricing` (else null), and `max_cost_sats` is the ceiling for a request.
 */
export async function fetchProviderCatalog(providers, {
  timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
  fetchFn = fetch,
} = {}) {
  const out = [];
  await Promise.all((providers || []).map(async (p) => {
    if (!p?.baseUrl) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${p.baseUrl}/v1/models`, {
        signal: ac.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const j = await res.json();
      const models = Array.isArray(j?.data)
        ? j.data
            .filter((m) => typeof m?.id === 'string' && m.id)
            .map((m) => describeModel(m))
        : [];
      out.push({ baseUrl: p.baseUrl, name: p.name || p.baseUrl, npub: p.npub || null, models });
    } catch { /* provider unreachable — skip */ }
    finally { clearTimeout(timer); }
  }));
  return out;
}

/** Reduce a /v1/models entry to what the router needs (id, name, sats pricing). */
function describeModel(m) {
  const sp = m.sats_pricing;
  const pricingSats = (sp && typeof sp === 'object')
    ? {
        prompt: num(sp.prompt),
        completion: num(sp.completion),
        request: num(sp.request),
        max_cost: num(sp.max_cost),
      }
    : null;
  // Monotonic cheapness signal for provider failover ordering: the explicit
  // max_cost ceiling when the node exposes one, else per-token completion price
  // (the dominant cost driver), else null (sort last).
  const sortSats = pricingSats
    ? (pricingSats.max_cost > 0 ? pricingSats.max_cost : pricingSats.completion)
    : null;
  return {
    id: m.id,
    name: typeof m.name === 'string' && m.name ? m.name : m.id,
    pricing_sats: pricingSats,
    max_cost_sats: sortSats,
  };
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/**
 * Estimate the sats a request to `model` should over-allocate. When the provider
 * exposes per-token `sats_pricing` we compute prompt+completion+request plus a
 * safety margin (over-payment is returned as change in the X-Cashu header, but
 * UNDER-payment is a hard 402). Returns null when the model has no pricing, so
 * the caller can fall back to the configured `max_sats_per_request`.
 */
export function estimateSatsForModel(model, maxTokensOut, messages) {
  const satsCost = estimateTokenCost(model, maxTokensOut, messages);
  if (satsCost == null) return null;
  return Math.max(1, Math.ceil(satsCost * 1.2));
}

/** Raw (unmargined) sats cost, or null when the model advertises no pricing. */
function estimateTokenCost(model, maxTokensOut, messages) {
  const p = model?.pricing_sats;
  if (!p) return null;
  const promptTokens = estimatePromptTokens(messages);
  const completionTokens = typeof maxTokensOut === 'number' ? maxTokensOut : 2048;
  return p.request + promptTokens * p.prompt + completionTokens * p.completion;
}

/** Rough token count for a message list (~4 chars/token for English). */
function estimatePromptTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length;
  }
  return Math.max(16, Math.ceil(chars / 4));
}