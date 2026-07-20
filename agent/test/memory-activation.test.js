/**
 * MEMORY-ACTIVATION-1 — owner-signed action signature verification.
 *
 * verifyActionSignature() is the shared primitive behind consent-gated memory
 * activation: it reuses the login challenge pool (single-use + TTL → replay
 * protection) and full NIP-07 signature crypto, but binds the signature to an
 * already-authenticated owner and mints nothing. These pure unit tests use real
 * keys via nostr-tools so signature verification runs for real.
 *
 * Run: node --test   (from agent/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { createAuth } from '../core/auth.mjs';

const CHALLENGE_KIND = 22242;

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

function baseCfg(overrides = {}) {
  return {
    session_secret: 'a'.repeat(64),
    session_ttl_sec: 86400,
    rate_limit: { max_challenges: 1000 },
    admin_npub: '',
    admin_bootstrap: true,
    ...overrides,
  };
}

function signChallenge(sk, challenge) {
  return finalizeEvent(
    {
      kind: CHALLENGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['challenge', challenge]],
      content: challenge,
    },
    sk,
  );
}

test('verifyActionSignature: valid owner-signed challenge succeeds and is single-use', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(baseCfg(), { log: silentLog() });

  const { challenge } = auth.issueChallenge('203.0.113.5');
  const event = signChallenge(sk, challenge);

  const res = auth.verifyActionSignature(event, { expectPubkeyHex: pk, clientIp: '203.0.113.5' });
  assert.equal(res.ok, true, 'valid signature accepted');
  assert.equal(res.pubkey, pk, 'returns the signing pubkey');

  // Replay protection: the challenge is consumed on success.
  const replay = auth.verifyActionSignature(event, { expectPubkeyHex: pk, clientIp: '203.0.113.5' });
  assert.equal(replay.ok, false, 'consumed challenge cannot be replayed');
  assert.match(replay.reason, /unknown or expired/);
});

test('verifyActionSignature: owner binding — a different key is rejected', () => {
  const ownerSk = generateSecretKey();
  const ownerPk = getPublicKey(ownerSk);
  const otherSk = generateSecretKey();
  const auth = createAuth(baseCfg(), { log: silentLog() });

  const { challenge } = auth.issueChallenge('198.51.100.7');
  // Signed by someone OTHER than the session owner.
  const event = signChallenge(otherSk, challenge);

  const res = auth.verifyActionSignature(event, { expectPubkeyHex: ownerPk, clientIp: '198.51.100.7' });
  assert.equal(res.ok, false, 'foreign signature rejected');
  assert.match(res.reason, /not from the signed-in owner/);
});

test('verifyActionSignature: unknown/never-issued challenge is rejected', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(baseCfg(), { log: silentLog() });

  const event = signChallenge(sk, 'never-issued-challenge');
  const res = auth.verifyActionSignature(event, { expectPubkeyHex: pk });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown or expired/);
});

test('verifyActionSignature: wrong kind is rejected before crypto', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(baseCfg(), { log: silentLog() });

  const { challenge } = auth.issueChallenge('203.0.113.9');
  const event = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge]], content: challenge },
    sk,
  );
  const res = auth.verifyActionSignature(event, { expectPubkeyHex: pk });
  assert.equal(res.ok, false);
  assert.match(res.reason, /wrong kind/);
});

test('verifyActionSignature: requires a 64-hex owner binding', () => {
  const sk = generateSecretKey();
  const auth = createAuth(baseCfg(), { log: silentLog() });
  const { challenge } = auth.issueChallenge('203.0.113.10');
  const event = signChallenge(sk, challenge);

  const res = auth.verifyActionSignature(event, { expectPubkeyHex: 'short' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no owner binding/);
});

test('verifyActionSignature: tampered event body fails signature check', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(baseCfg(), { log: silentLog() });

  const { challenge } = auth.issueChallenge('203.0.113.11');
  const event = signChallenge(sk, challenge);
  // Tamper after signing: id no longer matches the mutated content.
  const tampered = { ...event, content: `${challenge}-tampered` };

  const res = auth.verifyActionSignature(tampered, { expectPubkeyHex: pk });
  assert.equal(res.ok, false);
  // Either content/tag mismatch or id mismatch — both are hard rejections.
  assert.ok(/mismatch|bad signature/.test(res.reason));
});

test('verifyActionSignature: does not mint a token or touch admin state', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const auth = createAuth(baseCfg(), { log: silentLog() });
  assert.equal(auth.isClaimed(), false, 'starts unclaimed');

  const { challenge } = auth.issueChallenge('203.0.113.12');
  const res = auth.verifyActionSignature(signChallenge(sk, challenge), { expectPubkeyHex: pk });

  assert.equal(res.ok, true);
  assert.equal(res.token, undefined, 'no session token minted');
  assert.equal(auth.isClaimed(), false, 'admin state untouched');
});
