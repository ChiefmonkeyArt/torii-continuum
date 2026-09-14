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
import { isIP } from 'node:net';

const KIND_PROVIDER_ANNOUNCEMENT = 38421;
const DEFAULT_RELAYS = [
  'wss://relay.routstr.com',
  'wss://nos.lol',
  'wss://relay.damus.io',
];
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8000;
const DEFAULT_CATALOG_TIMEOUT_MS = 12000;

// A19: bounded discovery fan-out. Discovery is best-effort and untrusted, so the
// number of accepted providers, models per provider, and the catalog body size are
// all hard-capped — a flood of announcements cannot blow up memory or wallet risk.
const MAX_PROVIDERS = 50;
const MAX_MODELS_PER_PROVIDER = 200;
const MAX_CATALOG_BODY_BYTES = 1_048_576; // 1 MiB of /v1/models JSON
const CATALOG_CONCURRENCY = 8;

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

/**
 * A19: reject IPv4 literals in private/loopback/link-local/reserved/multicast/
 * broadcast ranges. A discovered announcement is UNTRUSTED, so a literal IP that
 * resolves to a local/private network must never become a fetch or payment target.
 */
function isUnsafeIPv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;                    // 0/8, 10/8, 127/8
  if (a === 100 && b >= 64 && b <= 127) return true;                     // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;                               // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;                      // 172.16/12
  if (a === 192 && b === 168) return true;                               // 192.168/16
  if (a === 192 && (b === 0 || b === 2 || b === 88 || b === 99)) return true; // 192.0/24, 192.0.2/24, 192.88.99/24, 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;      // 198.18/15, 198.51.100/24
  if (a === 203 && b === 0 && o[2] === 113) return true;                 // 203.0.113/24
  if (a >= 224) return true;                                             // 224/4 multicast + 240/4 reserved
  return false;
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 (`::ffff:a.b.c.d`). Node's
 * URL normalises the dotted quad to hex (e.g. `::ffff:7f00:1`), so parse the low
 * 32 bits back into an IPv4 dotted quad for `isUnsafeIPv4`.
 */
function mappedIPv4Octets(ip) {
  const i = ip.indexOf('::ffff:');
  if (i < 0) return null;
  const tail = ip.slice(i + '::ffff:'.length); // e.g. '7f00:1' or '127.0.0.1'
  if (tail.includes('.')) return tail;          // dotted quad (un-normalised input)
  const groups = tail.split(':').filter(Boolean);
  if (!groups.length) return null;
  // The low 32 bits may be written as one 32-bit group or the last two 16-bit
  // groups. Reconstruct the 32-bit value either way.
  let v;
  if (groups.length === 1) v = parseInt(groups[0], 16) >>> 0;
  else {
    const g = groups.slice(-2);
    if (g.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
    v = ((parseInt(g[0], 16) << 16) | parseInt(g[1], 16)) >>> 0;
  }
  return [
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ].join('.');
}

/**
 * A19: reject IPv6 literals in loopback/unspecified/ULA/link-local/multicast/
 * IPv4-mapped ranges. Recurse into an IPv4-mapped tail so a smuggled
 * `::ffff:127.0.0.1` cannot slip through.
 */
function isUnsafeIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;     // fc00::/7 ULA
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true;                                // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4.
  const v4 = mappedIPv4Octets(lower);
  if (v4 && isIP(v4) === 4) return isUnsafeIPv4(v4);
  return false;
}

/**
 * A19: is a hostname a loopback/link-local/private name that an untrusted
 * announcement must not reach? Covers literal IPs (IPv4+IPv6), `localhost`/
 * `*.localhost`, `.local` (mDNS), `.internal`, and `home.arpa`. DNS is NOT
 * resolved here — that would itself be a side-effecting act; we judge only the
 * literal string, which means a public DNS name that happens to resolve to a
 * private address is an operator-network-policy concern, not silently reachable
 * through a bare IP.
 */
function isUnsafeHostname(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return true;
  const ipv = isIP(h);
  if (ipv === 4) return isUnsafeIPv4(h);
  if (ipv === 6) return isUnsafeIPv6(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  if (h === 'home.arpa' || h.endsWith('.home.arpa')) return true;
  return false;
}

/**
 * A19: validate an UNTRUSTED remote base URL (a discovered Nostr announcement).
 * Returns null unless the URL is https, carries no embedded credentials, and its
 * host is not a loopback/private/link-local address. Operator-configured
 * bootstrap endpoints are exempt — a self-hosted http/private provider is a
 * deliberate operator opt-in, not an announcement-trust decision.
 * @param {string} url
 * @returns {string|null} the safe, normalised base URL or null when unsafe
 */
export function safeRemoteBaseUrl(url) {
  const base = normalizeBaseUrl(url);
  if (!base) return null;
  let u;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (isUnsafeHostname(u.hostname)) return null;
  return base;
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
  const add = (baseUrl, name, npub, { remote = false } = {}) => {
    // Bootstrap endpoints are operator-approved configuration (exempt from the
    // remote SSRF guard); RELAY-announced URLs go through the strict remote check
    // so an untrusted event cannot steer fetches/payment into a private network.
    const u = remote ? safeRemoteBaseUrl(baseUrl) : normalizeBaseUrl(baseUrl);
    if (!u || isOnionUrl(u)) return;
    if (map.size >= MAX_PROVIDERS && !map.has(u)) return; // A19: hard provider cap
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
      if (map.size >= MAX_PROVIDERS) break; // stop once the cap is reached
      const u = extractProviderUrl(ev);
      if (!u) continue;
      add(u, safeName(ev), ev.pubkey, { remote: true });
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
      // nostr-tools SimplePool.subscribeMany takes a BARE filter object as arg 2
      // (not an array of filters) — passing `[{...}]` sends a malformed wire REQ
      // that every relay rejects. See npc-bridge.mjs's documented contract.
      pool.subscribeMany(relays, { kinds: [KIND_PROVIDER_ANNOUNCEMENT], limit: 200 }, {
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
  concurrency = CATALOG_CONCURRENCY,
} = {}) {
  const out = [];
  const list = (providers || []).slice(0, MAX_PROVIDERS);

  async function one(p) {
    if (!p?.baseUrl) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // A19: redirect:'error' — a 30x from the catalog endpoint cannot bounce the
      // fetch (and later payment) to an attacker/private origin.
      const res = await fetchFn(`${p.baseUrl}/v1/models`, {
        signal: ac.signal,
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      if (!res.ok) return;
      // A19: bound the body — read as text and cap bytes before parsing, so a
      // hostile provider cannot stream an unbounded /v1/models response.
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_CATALOG_BODY_BYTES) return;
      let j;
      try { j = JSON.parse(text); } catch { return; }
      const models = Array.isArray(j?.data)
        ? j.data
            .slice(0, MAX_MODELS_PER_PROVIDER)
            .filter((m) => typeof m?.id === 'string' && m.id)
            .map((m) => describeModel(m))
        : [];
      out.push({ baseUrl: p.baseUrl, name: p.name || p.baseUrl, npub: p.npub || null, models });
    } catch { /* provider unreachable — skip */ }
    finally { clearTimeout(timer); }
  }

  // A19: bounded concurrency — a fan-out over hundreds of providers must not
  // open hundreds of sockets at once. Process the list in windows.
  for (let i = 0; i < list.length; i += concurrency) {
    await Promise.all(list.slice(i, i + concurrency).map(one));
  }
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