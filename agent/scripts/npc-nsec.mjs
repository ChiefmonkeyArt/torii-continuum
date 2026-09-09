/**
 * NAP-BRIDGE-3 — per-install greeter nsec mint helper.
 *
 * Mints a fresh throwaway greeter nsec (unless NPC_NSEC is already set to a
 * valid 64-hex / nsec1 value, in which case it reuses it so reinstalls stay on
 * the same identity). There is no NIP-46 bunker, no nostrconnect:// URI, no
 * approval step — the operator need never touch this.
 *
 * Usage (run from the agent dir, or by ops/install-nap-bridge.sh):
 *   node scripts/npc-nsec.mjs            # mint fresh, print JSON to stdout
 *   NPC_NSEC=nsec1… node scripts/npc-nsec.mjs   # reuse an existing nsec
 *
 * Prints a single JSON object to stdout:
 *   { "nsec_hex": "<64-hex>", "npub": "npub1…", "nsec_bech32": "nsec1…" }
 *
 * The 64-hex value is what the gateway reads from NPC_NSEC / the .env.
 * nsec_bech32 is for the operator to export/back up if they choose to keep the
 * identity; npub is the greeter's public address players DM.
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const HEX_RE = /^[0-9a-f]{64}$/i;

function toHex(v) {
  if (HEX_RE.test(v)) return v.toLowerCase();
  if (v.startsWith('nsec1')) {
    try {
      // nsec decode returns the secret key as a Uint8Array.
      return Buffer.from(nip19.decode(v).data).toString('hex');
    } catch {
      /* fall through to error */
    }
  }
  return null;
}

let nsecHex;
const existing = String(process.env.NPC_NSEC || '').trim();
if (existing) {
  nsecHex = toHex(existing);
  if (!nsecHex) {
    console.error('npc-nsec: NPC_NSEC is set but not 64-hex or nsec1. Refusing to mint over it.');
    process.exit(1);
  }
} else {
  nsecHex = Buffer.from(generateSecretKey()).toString('hex');
}

const pubkey = getPublicKey(Buffer.from(nsecHex, 'hex'));

process.stdout.write(
  JSON.stringify({
    nsec_hex: nsecHex,
    npub: nip19.npubEncode(pubkey),
    // nsecEncode takes bytes (unlike npubEncode, which takes hex).
    nsec_bech32: nip19.nsecEncode(Buffer.from(nsecHex, 'hex')),
  }) + '\n',
);