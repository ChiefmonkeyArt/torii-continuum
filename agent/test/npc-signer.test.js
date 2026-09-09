/**
 * NAP-BRIDGE-3 — local greeter signer tests.
 *
 * Proves the LocalSigner satisfies the exact async contract the bridge expects:
 * NIP-44 encrypt/decrypt round-trips with a real peer, getPublicKey returns the
 * greeter hex, and signEvent produces an event that verifyEvent accepts. No
 * bunker, no network.
 *
 * Run:  node --test test/npc-signer.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44';
import { createLocalSigner } from '../core/npc-signer.mjs';

test('rejects a non-hex nsec', () => {
  assert.throws(() => createLocalSigner('zzzz'), /64-hex/);
  assert.throws(() => createLocalSigner('abcd'), /64-hex/);
});

test('getPublicKey returns the 64-hex greeter pubkey', async () => {
  const sk = generateSecretKey();
  const hex = Buffer.from(sk).toString('hex');
  const signer = createLocalSigner(hex);
  assert.equal(await signer.getPublicKey(), getPublicKey(sk));
});

test('nip44Encrypt/nip44Decrypt round-trips with a real peer', async () => {
  const sk = generateSecretKey();
  const signer = createLocalSigner(Buffer.from(sk).toString('hex'));
  const peerSk = generateSecretKey();
  const peerHex = getPublicKey(peerSk);

  const plaintext = 'hello greeter';
  const cipher = await signer.nip44Encrypt(peerHex, plaintext);
  assert.notEqual(cipher, plaintext);
  const back = await signer.nip44Decrypt(peerHex, cipher);
  assert.equal(back, plaintext);
});

test('round-trip matches nostr-tools own NIP-44 primitives', async () => {
  const nsec = Buffer.from(generateSecretKey()).toString('hex');
  const signer = createLocalSigner(nsec);
  const peerSk = generateSecretKey();
  const peerHex = getPublicKey(peerSk);

  // Decrypt something the peer encrypted to us, to prove interop (not just
  // self-consistency).
  const key = getConversationKey(peerSk, await signer.getPublicKey());
  const cipher = nip44Encrypt('interop check', key);
  assert.equal(await signer.nip44Decrypt(peerHex, cipher), 'interop check');
});

test('signEvent finalizes an event that verifyEvent accepts', async () => {
  const sk = generateSecretKey();
  const signer = createLocalSigner(Buffer.from(sk).toString('hex'));
  const tpl = { kind: 13, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' };
  const signed = await signer.signEvent(tpl);
  assert.equal(signed.pubkey, getPublicKey(sk));
  assert.equal(verifyEvent(signed), true);
});