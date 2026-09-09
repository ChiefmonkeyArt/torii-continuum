/**
 * NAP-BRIDGE-1 — nap-bridge gateway entrypoint (isolated from the Continuum agent).
 *
 * A standalone, long-running process that drives the hermes-npc greeter over
 * Nostr. It is a NIP-46 *client*: it holds NO nsec. The greeter nsec lives in a
 * bunker; every decrypt / encrypt / sign is a bunker RPC.
 *
 * Config comes from the environment (a 0600 EnvironmentFile, installed by
 * ops/install-nap-bridge.sh) so this process never opens the Continuum agent's
 * config.yaml and cannot read the owner's Routstr key / Cashu float / admin npub.
 *
 *   NPC_ENABLED=1                 (off by default)
 *   NPC_CLIENT_SECRET=<hex>       NIP-46 client secret key (NOT the greeter nsec)
 *   NPC_BUNKER_PUBKEY=<hex>       the bunker's pubkey
 *   NPC_RELAYS="wss://a,wss://b"  relay URLs (DM + NIP-46 channel)
 *   NPC_ALLOWLIST="npub1…,hex…"   allowed sender npubs (fail-closed)
 *   NPC_OLLAMA_URL=http://127.0.0.1:11434/v1
 *   NPC_MODEL=qwen3:4b
 *   NPC_SOUL_FILE=/home/hermes-npc/.hermes/profiles/npc/SOUL.md
 */

import { readFile } from 'node:fs/promises';
import { SimplePool } from 'nostr-tools/pool';
import { BunkerSigner } from 'nostr-tools/nip46';
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

const clientSecret = process.env.NPC_CLIENT_SECRET || '';
const bunkerPubkey = (process.env.NPC_BUNKER_PUBKEY || '').toLowerCase();
const relays = splitList(process.env.NPC_RELAYS);
const allowlist = normalizeAllowlist(splitList(process.env.NPC_ALLOWLIST));
const ollamaUrl = (process.env.NPC_OLLAMA_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const model = process.env.NPC_MODEL || 'qwen3:4b';
const soulFile = process.env.NPC_SOUL_FILE || '/home/hermes-npc/.hermes/profiles/npc/SOUL.md';

if (!/^[0-9a-f]{64}$/i.test(clientSecret)) {
  log.error('[npc-gateway] NPC_CLIENT_SECRET missing or not 64-hex. Refusing to start.');
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(bunkerPubkey)) {
  log.error('[npc-gateway] NPC_BUNKER_PUBKEY missing or not 64-hex. Refusing to start.');
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

// NIP-46 client — connects to the bunker; greeter nsec never leaves it.
// nostr-tools' BunkerSigner expects the client secret as bytes internally, so
// we decode the 64-hex env value before handing it over.
const signer = BunkerSigner.fromBunker(Buffer.from(clientSecret, 'hex'), { pubkey: bunkerPubkey, relays });
await signer.connect();
const greeterHex = (await signer.getPublicKey()).toLowerCase();
log.info(`[npc-gateway] greeter pubkey ${greeterHex.slice(0, 8)}… (via NIP-46 bunker)`);

const pool = new SimplePool();
const bridge = createNpcBridge({
  cfg: { relayUrls: relays, allowlist, soul, model },
  greeterHex,
  log,
  pool,
  signer,
  chat,
});

await bridge.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`[npc-gateway] ${sig} — shutting down`);
    bridge.stop();
    pool.close(relays);
    process.exit(0);
  });
}