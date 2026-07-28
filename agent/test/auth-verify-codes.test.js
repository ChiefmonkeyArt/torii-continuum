/**
 * /api/auth/verify refusals carry a stable code (CONT-SIGNER-1).
 *
 * `reason` is prose written for an operator reading a log. The browser has to
 * make a different decision for refusals whose remedies are opposites — a
 * `not_owner` refusal cannot be fixed by pressing Try again with the same key,
 * while `challenge_expired` is fixed by exactly that — and it cannot make that
 * decision by matching on English sentences. Refresh has returned a code since
 * CONT-AUTH-1 for precisely this reason; verify was the one that did not.
 *
 * These tests pin the code, not the prose, so the wording stays free to change.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';

const CHALLENGE_KIND = 22242;
const silentLog = () => ({ info() {}, warn() {}, error() {} });

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

const signChallenge = (sk, challenge, extra = {}) => finalizeEvent(
  {
    kind: CHALLENGE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge]],
    content: challenge,
    ...extra,
  },
  sk,
);

const mkAuth = (cfg = {}) => createAuth(baseCfg(cfg), {
  log: silentLog(),
  persistAdmin: async () => {},
});

test('a missing or non-object event is malformed_event', async () => {
  const auth = mkAuth();
  for (const bad of [null, undefined, 'nope', 42]) {
    const r = await auth.verifyChallenge(bad, '203.0.113.1');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'malformed_event', `for ${JSON.stringify(bad)}`);
  }
});

test('the wrong event kind is wrong_kind, not a generic refusal', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.2');
  const ev = signChallenge(sk, challenge, { kind: 1 });

  const r = await auth.verifyChallenge(ev, '203.0.113.2');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong_kind');
});

test('a key that is not the owner is not_owner — the one refusal a retry cannot fix', async () => {
  const adminSk = generateSecretKey();
  const strangerSk = generateSecretKey();
  const auth = mkAuth({
    admin_npub: nip19.npubEncode(getPublicKey(adminSk)),
    admin_bootstrap: false,
  });

  const { challenge } = auth.issueChallenge('203.0.113.3');
  const r = await auth.verifyChallenge(signChallenge(strangerSk, challenge), '203.0.113.3');

  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_owner');
  // And the owner still gets in, so the code is not simply always set.
  const { challenge: ok } = auth.issueChallenge('203.0.113.3');
  const good = await auth.verifyChallenge(signChallenge(adminSk, ok), '203.0.113.3');
  assert.equal(good.ok, true);
  assert.equal(good.code, undefined);
});

test('a challenge the agent never issued is challenge_expired, which IS worth retrying', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();

  const r = await auth.verifyChallenge(signChallenge(sk, 'f'.repeat(64)), '203.0.113.4');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'challenge_expired');
});

test('a dropped challenge tag is malformed_event', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.5');
  const ev = signChallenge(sk, challenge, { tags: [] });

  const r = await auth.verifyChallenge(ev, '203.0.113.5');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed_event');
});

test('content that disagrees with the challenge tag is malformed_event', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.6');
  const ev = signChallenge(sk, challenge, { content: 'something else' });

  const r = await auth.verifyChallenge(ev, '203.0.113.6');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed_event');
});

test('an id that does not hash over the event is malformed_event', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.7');
  const ev = { ...signChallenge(sk, challenge), id: 'd'.repeat(64) };

  const r = await auth.verifyChallenge(ev, '203.0.113.7');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed_event');
});

test('a signature that does not verify is bad_signature', async () => {
  const auth = mkAuth();
  const sk = generateSecretKey();
  const other = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.8');
  // Keep the event (and therefore its id) intact, swap only the signature so it
  // is the signature check — not the id check — that refuses. Round-tripped
  // through JSON because finalizeEvent stamps nostr-tools' "already verified"
  // symbol onto the object and a spread would carry it across, short-circuiting
  // the very check under test.
  const ev = JSON.parse(JSON.stringify(signChallenge(sk, challenge)));
  ev.sig = signChallenge(other, challenge).sig;

  const r = await auth.verifyChallenge(ev, '203.0.113.8');

  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_signature');
});

test('every refusal names a code — a new one cannot ship without an answer', async () => {
  // The property that matters: not which codes exist, but that no path returns
  // ok:false with nothing for the browser to route on.
  const KNOWN = new Set([
    'malformed_event', 'wrong_kind', 'not_owner',
    'challenge_expired', 'bad_signature', 'claim_failed',
  ]);
  const auth = mkAuth({
    admin_npub: nip19.npubEncode(getPublicKey(generateSecretKey())),
    admin_bootstrap: false,
  });
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.9');

  const refusals = [
    await auth.verifyChallenge(null, '203.0.113.9'),
    await auth.verifyChallenge(signChallenge(sk, challenge, { kind: 1 }), '203.0.113.9'),
    await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.9'),
    await auth.verifyChallenge(signChallenge(sk, 'f'.repeat(64)), '203.0.113.9'),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.ok(KNOWN.has(r.code), `unroutable refusal: ${JSON.stringify(r)}`);
    assert.ok(r.reason, 'prose is still there for the log');
  }
});

test('a persistence failure during first-touch claim is claim_failed', async () => {
  const auth = createAuth(baseCfg(), {
    log: silentLog(),
    persistAdmin: async () => { throw new Error('disk full'); },
  });
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.10');

  const r = await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.10');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'claim_failed');
  assert.equal(auth.isClaimed(), false, 'fails closed — the box stays unclaimed');
});

test('the sensitive-action verifier is left alone', async () => {
  // verifyActionSignature repeats verifyChallenge's reason strings word for word
  // and is a different contract with a different caller. Codes were added to the
  // login path only; this pins that boundary so a future sweep does not blur it.
  const auth = mkAuth();
  const sk = generateSecretKey();
  const { challenge } = auth.issueChallenge('203.0.113.11');
  const r = auth.verifyActionSignature(signChallenge(sk, challenge, { kind: 1 }), {
    clientIp: '203.0.113.11',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, undefined);
  assert.ok(r.reason);
});
