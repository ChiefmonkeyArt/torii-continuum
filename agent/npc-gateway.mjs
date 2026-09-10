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
 *   NPC_OLLAMA_URL=http://127.0.0.1:11434/v1
 *   NPC_MODEL=llama3.2:1b
 *   NPC_SOUL_FILE=/home/hermes-npc/.hermes/profiles/npc/SOUL.md
 *   NPC_RATE_WINDOW_MS=60000      per-sender rate-limit window (ms)
 *   NPC_RATE_MAX_PER_WINDOW=6     max replies per sender per window
 */

import { readFile } from 'node:fs/promises';
import { SimplePool } from 'nostr-tools/pool';
import { createLocalSigner } from './core/npc-signer.mjs';
import { normalizeAllowlist, createNpcBridge } from './core/npc-bridge.mjs';

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
const ollamaUrl = (process.env.NPC_OLLAMA_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const model = process.env.NPC_MODEL || 'llama3.2:1b';
const soulFile = process.env.NPC_SOUL_FILE || '/home/hermes-npc/.hermes/profiles/npc/SOUL.md';

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
if (allowlist.size === 0) {
  log.error('[npc-gateway] NPC_ALLOWLIST normalises to zero senders — fail-closed. Refusing to start.');
  process.exit(1);
}

const soul = await readFile(soulFile, 'utf8').catch(() => {
  log.warn('[npc-gateway] SOUL file missing; the greeter will run without its persona. File:', soulFile);
  return '';
});

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
const bridge = createNpcBridge({
  cfg: { relayUrls: relays, allowlist, soul, model, rateLimit },
  greeterHex,
  log,
  pool,
  signer,
  chat,
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