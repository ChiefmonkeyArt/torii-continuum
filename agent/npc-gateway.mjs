/**
 * NAP-BRIDGE-3 — nap-bridge gateway entrypoint (isolated from the Continuum agent).
 *
 * A standalone, long-running process that drives the hermes-npc greeter over
 * Nostr. It signs as the greeter with a LOCAL per-install ephemeral nsec — no
 * NIP-46 bunker, no nostrconnect:// approval, no client key. Every decrypt /
 * encrypt / sign is done in-process with the throwaway key from NPC_NSEC.
 *
 * Config comes from the environment (a 0600 EnvironmentFile, installed by
 * ops/install-nap-bridge.sh) so this process never opens the Continuum agent's
 * config.yaml and cannot read the owner's Routstr key / Cashu float / admin npub.
 *
 *   NPC_ENABLED=1                 (off by default)
 *   NPC_NSEC=<64-hex>            greeter nsec (minted at install; disposable)
 *   NPC_RELAYS="wss://a,wss://b"  relay URLs (DM delivery)
 *   NPC_ALLOWLIST="npub1…,hex…"   allowed sender npubs (fail-closed)
 *   NPC_PUBLIC=1                  admit EVERY authenticated sender (allowlist
 *                                 ignored; the per-sender rate limit becomes the
 *                                 only throttle). Off by default.
 *   NPC_OLLAMA_URL=http://127.0.0.1:11434/v1
 *   NPC_MODEL=llama3.2:1b
 *   NPC_SOUL_FILE=/home/hermes-npc/.hermes/profiles/npc/SOUL.md
 *   NPC_WORLD_FILE=/home/hermes-npc/.hermes/profiles/npc/WORLD.md       (optional; this world)
 *   NPC_LORE_FILE=/home/hermes-npc/.hermes/profiles/npc/TORII_LORE.md   (optional; shared metaverse)
 *   NPC_RATE_WINDOW_MS=60000      per-sender rate-limit window (ms)
 *   NPC_RATE_MAX_PER_WINDOW=6     max replies per sender per window
 *   NPC_NOTICE_AUTHOR=<hex>       (optional) operator npub whose kind-30078
 *                                 d="noticeboard" event is the world's read-only
 *                                 noticeboard. Unset => noticeboard disabled.
 *   NPC_NOTICE_TTL_MS=60000       noticeboard in-memory cache TTL (ms)
 */

import { readFile } from 'node:fs/promises';
import { SimplePool } from 'nostr-tools/pool';
import { createLocalSigner } from './core/npc-signer.mjs';
import {
  normalizeAllowlist,
  createNpcBridge,
  buildSystemPrompt,
  parseNoticeboard,
  formatNotices,
  createNoticeboardCache,
  NOTICEBOARD_KIND,
  NOTICEBOARD_D,
} from './core/npc-bridge.mjs';

function splitList(v) {
  if (!v) return [];
  return String(v).split(/[, ]+/).map((s) => s.trim()).filter(Boolean);
}

const log = {
  info: (m, d) => console.log(m, d ?? ''),
  warn: (m, d) => console.warn(m, d ?? ''),
  error: (m, d) => console.error(m, d ?? ''),
};

const enabled = process.env.NPC_ENABLED === '1' || process.env.NPC_ENABLED === 'true';
if (!enabled) {
  log.info('[npc-gateway] NPC_ENABLED is not set — exiting (no-op)');
  process.exit(0);
}

const nsecHex = (process.env.NPC_NSEC || '').trim().toLowerCase();
const relays = splitList(process.env.NPC_RELAYS);
const allowlist = normalizeAllowlist(splitList(process.env.NPC_ALLOWLIST));
const isPublic = process.env.NPC_PUBLIC === '1' || process.env.NPC_PUBLIC === 'true';
const ollamaUrl = (process.env.NPC_OLLAMA_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const model = process.env.NPC_MODEL || 'llama3.2:1b';
const soulFile = process.env.NPC_SOUL_FILE || '/home/hermes-npc/.hermes/profiles/npc/SOUL.md';
const worldFile = process.env.NPC_WORLD_FILE || '/home/hermes-npc/.hermes/profiles/npc/WORLD.md';
const loreFile = process.env.NPC_LORE_FILE || '/home/hermes-npc/.hermes/profiles/npc/TORII_LORE.md';
const noticeAuthor = (process.env.NPC_NOTICE_AUTHOR || '').trim().toLowerCase();
const noticeTtlMs = Number(process.env.NPC_NOTICE_TTL_MS ?? '60000');

// Per-sender rate limit (NAP-BRIDGE-5). The greeter's inference is FREE but
// still costs CPU, so a spammer must not be able to peg the host by flooding
// DMs. Invalid/absent values fall back to the defaults inside createRateLimiter.
const rateLimit = {
  windowMs: Number(process.env.NPC_RATE_WINDOW_MS ?? '60000'),
  maxPerWindow: Number(process.env.NPC_RATE_MAX_PER_WINDOW ?? '6'),
};

if (!/^[0-9a-f]{64}$/i.test(nsecHex)) {
  log.error('[npc-gateway] NPC_NSEC missing or not 64-hex. Refusing to start.');
  process.exit(1);
}
if (relays.length === 0) {
  log.error('[npc-gateway] NPC_RELAYS is empty. Refusing to start.');
  process.exit(1);
}
if (allowlist.size === 0 && !isPublic) {
  log.error('[npc-gateway] NPC_ALLOWLIST normalises to zero senders and NPC_PUBLIC is off — fail-closed. Refusing to start.');
  process.exit(1);
}

const soul = await readFile(soulFile, 'utf8').catch(() => {
  log.warn('[npc-gateway] SOUL file missing; the greeter will run without its persona. File:', soulFile);
  return '';
});
// World + metaverse lore are optional layers (NAP-BRIDGE-7); missing ones are
// simply absent, so a minimal install still works on SOUL alone.
const world = await readFile(worldFile, 'utf8').catch(() => '');
const lore = await readFile(loreFile, 'utf8').catch(() => '');
const systemContext = buildSystemPrompt({ soul, world, lore });

// Short timeout so a hung relay query can never stall a player's reply.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Read-only world noticeboard (NAP-BRIDGE-8). The operator signs ONE replaceable
// kind-30078 d="noticeboard" event; Nakama reads it (cached) and never publishes
// it. Disabled unless NPC_NOTICE_AUTHOR is set. A fetch failure returns '' so the
// greeter still answers (just without the current notices).
function fetchNotices(authorHex) {
  const filter = {
    kinds: [NOTICEBOARD_KIND],
    authors: [authorHex],
    '#d': [NOTICEBOARD_D],
    limit: 5,
  };
  return withTimeout(pool.querySync(relays, filter), 5_000)
    .then((events) => {
      if (!Array.isArray(events) || events.length === 0) return '';
      events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      return formatNotices(parseNoticeboard((events[0] && events[0].content) || ''));
    })
    .catch((err) => {
      log.warn('[npc-gateway] noticeboard query failed', err?.message || err);
      return '';
    });
}

const noticeCache = createNoticeboardCache({ ttlMs: Number.isFinite(noticeTtlMs) ? noticeTtlMs : 60_000 });
async function getNoticeboard() {
  if (!noticeAuthor) return '';
  return noticeCache.get(() => fetchNotices(noticeAuthor));
}

// Local Ollama — this process's one and only inference surface (no router).
async function chat({ messages }) {
  try {
    const res = await fetch(`${ollamaUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, code: `http_${res.status}`, reason: `ollama ${res.status}` };
    const body = await res.json().catch(() => null);
    const content = body?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, code: 'empty', reason: 'empty completion' };
    return { ok: true, content };
  } catch (e) {
    return { ok: false, code: 'unreachable', reason: e?.message || e };
  }
}

// Local signer — the greeter nsec signs/encrypts/decrypts entirely in-process.
const signer = createLocalSigner(nsecHex);
const greeterHex = (await signer.getPublicKey()).toLowerCase();
log.info(`[npc-gateway] greeter pubkey ${greeterHex.slice(0, 8)}… (local ephemeral nsec)`);

const pool = new SimplePool();
log.info(`[npc-gateway] noticeboard ${noticeAuthor ? `enabled (author ${noticeAuthor.slice(0, 8)}…)` : 'disabled (no NPC_NOTICE_AUTHOR)'}`);
const bridge = createNpcBridge({
  cfg: { relayUrls: relays, allowlist, soul: systemContext, model, public: isPublic, rateLimit },
  greeterHex,
  log,
  pool,
  signer,
  chat,
  getNoticeboard,
});

await bridge.start();

// Node's event loop needs at least one active handle to stay alive between
// gift-wrap events. The WebSocket connections opened by nostr-tools SimplePool
// are not sufficient on their own — a socket-only process can exit as soon as
// bridge.start() resolves, before any DM is received. A recurring no-op timer
// is the cheapest active handle and does not conflict with a subsequent
// clearInterval on shutdown.
//
// (Do NOT use `await new Promise(() => {})` — Node 22 rejects an unsettled
// top-level await with exit code 13.)
const keepAlive = setInterval(() => {}, 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`[npc-gateway] ${sig} — shutting down`);
    clearInterval(keepAlive);
    bridge.stop();
    pool.close(relays);
    process.exit(0);
  });
}