/**
 * First-touch admin bootstrap + configured-admin behaviour (SUITE-VPS-READY-2).
 *
 * These are pure unit tests: createAuth() takes an injected persistAdmin so no
 * filesystem is touched. Valid NIP-07 challenge events are produced with real
 * keys via nostr-tools, so signature verification runs for real.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
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

// Build a valid, signed kind-22242 challenge event for the given challenge.
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

// A persistAdmin spy that records calls and (optionally) throws.
function persister({ throwErr = false } = {}) {
  const calls = [];
  const fn = async (npub) => {
    calls.push(npub);
    if (throwErr) throw new Error('disk full');
  };
  fn.calls = calls;
  return fn;
}

test('first-touch: first verified caller claims admin', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const persist = persister();
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  assert.equal(auth.isClaimed(), false, 'starts unclaimed');

  const { challenge } = auth.issueChallenge('203.0.113.5');
  const res = await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.5');

  assert.equal(res.ok, true, 'claim succeeds');
  assert.ok(res.token, 'token issued');
  assert.equal(auth.isClaimed(), true, 'now claimed');
  assert.equal(persist.calls.length, 1, 'persisted exactly once');
  assert.equal(persist.calls[0], nip19.npubEncode(pk), 'persisted canonical npub of caller');
  assert.equal(auth.adminNpub(), nip19.npubEncode(pk), 'live admin npub matches');
});

test('restart: persisted admin is honoured as configured admin', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const npub = nip19.npubEncode(pk);
  const persist = persister();
  // Simulate a reboot: config.yaml now carries the claimed npub.
  const auth = createAuth(baseCfg({ admin_npub: npub, admin_bootstrap: false }), {
    log: silentLog(),
    persistAdmin: persist,
  });

  assert.equal(auth.isClaimed(), true, 'boots already claimed');

  const { challenge } = auth.issueChallenge('203.0.113.6');
  const res = await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.6');

  assert.equal(res.ok, true, 'configured admin logs in');
  assert.equal(persist.calls.length, 0, 'no re-persist on a configured admin');
});

test('second, different caller is rejected after claim', async () => {
  const sk1 = generateSecretKey();
  const sk2 = generateSecretKey();
  const persist = persister();
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  const c1 = auth.issueChallenge('203.0.113.7').challenge;
  const r1 = await auth.verifyChallenge(signChallenge(sk1, c1), '203.0.113.7');
  assert.equal(r1.ok, true, 'first claims');

  const c2 = auth.issueChallenge('203.0.113.8').challenge;
  const r2 = await auth.verifyChallenge(signChallenge(sk2, c2), '203.0.113.8');
  assert.equal(r2.ok, false, 'different caller rejected');
  assert.equal(persist.calls.length, 1, 'still only one claim persisted');
});

test('configured admin: matching caller ok, other rejected, never persists', async () => {
  const adminSk = generateSecretKey();
  const adminNpub = nip19.npubEncode(getPublicKey(adminSk));
  const strangerSk = generateSecretKey();
  const persist = persister();
  const auth = createAuth(baseCfg({ admin_npub: adminNpub, admin_bootstrap: false }), {
    log: silentLog(),
    persistAdmin: persist,
  });

  const cOk = auth.issueChallenge('203.0.113.9').challenge;
  assert.equal((await auth.verifyChallenge(signChallenge(adminSk, cOk), '203.0.113.9')).ok, true);

  const cBad = auth.issueChallenge('203.0.113.10').challenge;
  const bad = await auth.verifyChallenge(signChallenge(strangerSk, cBad), '203.0.113.10');
  assert.equal(bad.ok, false, 'stranger rejected');

  assert.equal(persist.calls.length, 0, 'configured admin never triggers a claim');
});

test('bad signature does not claim in bootstrap mode', async () => {
  const sk = generateSecretKey();
  const persist = persister();
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  const { challenge } = auth.issueChallenge('203.0.113.11');
  // Build the event by hand (no finalizeEvent) so nostr-tools does NOT cache a
  // "verified" flag on it — the id is correct but the signature is bogus, so
  // real verifyEvent() must reject it.
  const ev = {
    pubkey: getPublicKey(sk),
    kind: CHALLENGE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge]],
    content: challenge,
  };
  ev.id = getEventHash(ev);
  ev.sig = '0'.repeat(128);

  const res = await auth.verifyChallenge(ev, '203.0.113.11');
  assert.equal(res.ok, false, 'bad signature rejected');
  assert.equal(auth.isClaimed(), false, 'still unclaimed');
  assert.equal(persist.calls.length, 0, 'no persistence attempted');
});

test('malformed event (wrong kind) does not claim', async () => {
  const sk = generateSecretKey();
  const persist = persister();
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  const { challenge } = auth.issueChallenge('203.0.113.12');
  const ev = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge]], content: challenge },
    sk,
  );
  const res = await auth.verifyChallenge(ev, '203.0.113.12');
  assert.equal(res.ok, false);
  assert.equal(auth.isClaimed(), false);
  assert.equal(persist.calls.length, 0);
});

test('concurrent first-touch: exactly one claim wins', async () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const persist = persister();
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  const cA = auth.issueChallenge('203.0.113.13').challenge;
  const cB = auth.issueChallenge('203.0.113.14').challenge;

  const [rA, rB] = await Promise.all([
    auth.verifyChallenge(signChallenge(skA, cA), '203.0.113.13'),
    auth.verifyChallenge(signChallenge(skB, cB), '203.0.113.14'),
  ]);

  const wins = [rA.ok, rB.ok].filter(Boolean).length;
  assert.equal(wins, 1, 'exactly one concurrent claim succeeds');
  assert.equal(persist.calls.length, 1, 'persisted exactly once — no overwrite');
  assert.equal(auth.isClaimed(), true);
  // The persisted npub must be the winner's.
  const winnerSk = rA.ok ? skA : skB;
  assert.equal(persist.calls[0], nip19.npubEncode(getPublicKey(winnerSk)));
});

test('persistence failure fails closed (no claim, no token)', async () => {
  const sk = generateSecretKey();
  const persist = persister({ throwErr: true });
  const auth = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist });

  const { challenge } = auth.issueChallenge('203.0.113.15');
  const res = await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.15');

  assert.equal(res.ok, false, 'claim rejected when persistence throws');
  assert.equal(auth.isClaimed(), false, 'box stays unclaimed');
  assert.ok(!res.token, 'no session token issued');

  // A subsequent attempt (persistence now recovers) can still claim — the box
  // remained safely claimable.
  const persist2 = persister();
  const auth2 = createAuth(baseCfg(), { log: silentLog(), persistAdmin: persist2 });
  const c2 = auth2.issueChallenge('203.0.113.16').challenge;
  const ok = await auth2.verifyChallenge(signChallenge(sk, c2), '203.0.113.16');
  assert.equal(ok.ok, true, 'retry after recovery succeeds');
});

test('no persister configured: bootstrap claim fails closed', async () => {
  const sk = generateSecretKey();
  const auth = createAuth(baseCfg(), { log: silentLog() }); // no persistAdmin
  const { challenge } = auth.issueChallenge('203.0.113.17');
  const res = await auth.verifyChallenge(signChallenge(sk, challenge), '203.0.113.17');
  assert.equal(res.ok, false, 'cannot claim without a persister');
  assert.equal(auth.isClaimed(), false);
});
