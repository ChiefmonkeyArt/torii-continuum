/**
 * NAP-BRIDGE-1 — one-time NIP-46 setup helper.
 *
 * Generates the gateway's NIP-46 CLIENT keypair (NOT the greeter nsec) and the
 * `nostrconnect://` URI the operator approves ONCE in their bunker. The greeter
 * nsec never enters this process or any file on the VPS.
 *
 * Usage (run as the hermes-npc user, or from the installer):
 *   node scripts/npc-connect.mjs
 *
 * Env:
 *   NPC_RELAYS        comma-separated relay URLs (required)
 *   NPC_NAME          human label for the connection (default "Torii greeter")
 *   NPC_CLIENT_SECRET optional existing client secret (hex) to reuse
 *
 * Prints a single JSON object to stdout:
 *   { "client_secret": "<hex>", "client_pubkey": "<hex>",
 *     "connect_uri": "nostrconnect://…" }
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createNostrConnectURI } from 'nostr-tools/nip46';

const relays = String(process.env.NPC_RELAYS || '')
  .split(/[, ]+/)
  .map((s) => s.trim())
  .filter(Boolean);
if (relays.length === 0) {
  console.error('npc-connect: NPC_RELAYS is required.');
  process.exit(1);
}

// The perms the greeter needs: sign the kind-13 seal + NIP-44 encrypt/decrypt of
// gift-wrapped DMs + learn its own pubkey. No funds, no other kinds, no key
// export. (The outer kind-1059 wrap is signed by a local ephemeral key, not the
// bunker, so it needs no bunker perm.)
const perms = ['sign_event:13', 'nip44_encrypt', 'nip44_decrypt', 'get_public_key'];

let clientSecretHex;
const existing = process.env.NPC_CLIENT_SECRET || '';
if (/^[0-9a-f]{64}$/i.test(existing)) {
  clientSecretHex = existing.toLowerCase();
} else {
  clientSecretHex = Buffer.from(generateSecretKey()).toString('hex');
}

const clientPubkey = getPublicKey(Buffer.from(clientSecretHex, 'hex'));
const connectUri = createNostrConnectURI({
  clientPubkey,
  relays,
  secret: clientSecretHex,
  perms,
  name: process.env.NPC_NAME || 'Torii greeter',
});

process.stdout.write(
  JSON.stringify({ client_secret: clientSecretHex, client_pubkey: clientPubkey, connect_uri: connectUri }) + '\n',
);