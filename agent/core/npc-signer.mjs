/**
 * NAP-BRIDGE-3 — local greeter signer (signer custody = per-install ephemeral nsec).
 *
 * The greeter's nsec lives ON the VPS as a single 0600 file (minted by
 * ops/install-nap-bridge.sh at install). There is no NIP-46 bunker, no
 * nostrconnect:// approval, no client key. The gateway signs kind-13 seals and
 * NIP-44-encrypts/decrypts gift-wrapped DMs locally with that throwaway key.
 *
 * The nsec is deliberately disposable: it holds no funds, carries no
 * delegation, and is unlinkable to the operator's admin/owner npub. Worst case
 * on leak is impersonation-as-greeter (an attacker posts as the NPC), never
 * theft or owner-secret exposure. Rotation = delete the .env entry and
 * reinstall, or overwrite NPC_NSEC with a nsec the operator chose themselves.
 *
 * This module exports a signer matching the exact async contract the bridge
 * (core/npc-bridge.mjs) expects, so the signer is fully swappable in tests:
 *
 *   {
 *     getPublicKey()                         -> hex pubkey
 *     nip44Encrypt(peerHex, plaintext)       -> base64 ciphertext
 *     nip44Decrypt(peerHex, ciphertext)      -> plaintext
 *     signEvent(template)                    -> finalized (signed) event
 *   }
 */

import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44';

/**
 * Build a local signer from a 64-hex nsec.
 * @param {string} nsecHex 64-char lowercase/uppercase hex secret key
 * @returns {object} the signer contract above
 */
export function createLocalSigner(nsecHex) {
  if (!/^[0-9a-f]{64}$/i.test(nsecHex)) {
    throw new Error('npc-signer: NPC_NSEC must be 64-hex');
  }
  const sk = Buffer.from(nsecHex.toLowerCase(), 'hex');
  const pubkey = getPublicKey(sk);

  return {
    async getPublicKey() {
      return pubkey;
    },
    async nip44Encrypt(peerHex, plaintext) {
      const key = getConversationKey(sk, peerHex);
      return nip44Encrypt(plaintext, key);
    },
    async nip44Decrypt(peerHex, ciphertext) {
      const key = getConversationKey(sk, peerHex);
      return nip44Decrypt(ciphertext, key);
    },
    async signEvent(template) {
      return finalizeEvent(template, sk);
    },
  };
}