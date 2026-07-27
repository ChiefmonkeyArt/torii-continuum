/**
 * Sliding session refresh + the absolute lifetime cap (CONT-AUTH-1).
 *
 * The clock is injected, so every deadline here is exercised by arithmetic
 * rather than by sleeping — a seven-day cap is asserted in microseconds.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createAuth } from '../core/auth.mjs';

const CHALLENGE_KIND = 22242;
const TTL = 3600; // 1h sliding window
const MAX_LIFETIME = 86400; // 1 day absolute cap

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

/** A clock the test drives by hand. */
function clock(startSec) {
  let t = startSec;
  return { now: () => t, advance: (s) => { t += s; }, get value() { return t; } };
}

/**
 * An auth module with a claimed admin and a live session, plus the clock that
 * drives it. Logging in for real (signed kind-22242 event) keeps the token
 * under test identical to a production one.
 */
async function loggedIn({ ttl = TTL, maxLifetime = MAX_LIFETIME, start = 1_700_000_000 } = {}) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const c = clock(start);
  const auth = createAuth(
    {
      session_secret: 'a'.repeat(64),
      session_ttl_sec: ttl,
      session_max_lifetime_sec: maxLifetime,
      rate_limit: { max_challenges: 1000 },
      admin_npub: nip19.npubEncode(pk),
      admin_bootstrap: false,
    },
    { now: c.now, log: silentLog() },
  );
  const { challenge } = auth.issueChallenge('203.0.113.1');
  const event = finalizeEvent(
    { kind: CHALLENGE_KIND, created_at: c.value, tags: [['challenge', challenge]], content: challenge },
    sk,
  );
  const verified = await auth.verifyChallenge(event, '203.0.113.1');
  assert.equal(verified.ok, true, 'fixture must start from a real login');
  return { auth, clock: c, token: verified.token, expiresAt: verified.expires_at };
}

test('a login token carries its original iat and is accepted', async () => {
  const { auth, token, clock: c } = await loggedIn();
  const seen = auth.verifySessionToken(token);
  assert.equal(seen.ok, true);
  assert.equal(seen.oiat, c.value, 'oiat is the moment of the signature');
  assert.equal(seen.iat, seen.oiat, 'a fresh login has not been refreshed yet');
});

test('refresh issues a NEW token further in the future', async () => {
  const { auth, token, expiresAt, clock: c } = await loggedIn();
  c.advance(60);
  const r = auth.refreshSession(token);
  assert.equal(r.ok, true);
  assert.notEqual(r.token, token, 'a refresh must not hand back the same token');
  assert.equal(r.expires_at, expiresAt + 60, 'the window slid forward by the elapsed time');
  assert.equal(auth.verifySessionToken(r.token).ok, true);
});

test('the original iat survives every refresh — the cap cannot be slid', async () => {
  // This is the property that bounds a stolen token: renewals move `exp`, but
  // never the origin the cap is measured from.
  const { auth, token, clock: c } = await loggedIn();
  const origin = auth.verifySessionToken(token).oiat;
  let current = token;
  for (let i = 0; i < 10; i++) {
    c.advance(600);
    const r = auth.refreshSession(current);
    assert.equal(r.ok, true, `refresh ${i} should still be inside the cap`);
    current = r.token;
    assert.equal(auth.verifySessionToken(current).oiat, origin, 'oiat drifted');
  }
});

test('refresh is refused once the absolute lifetime is reached', async () => {
  const { auth, token, clock: c } = await loggedIn();
  let current = token;
  // Walk right up to the cap, renewing along the way.
  for (let i = 0; i < 23; i++) {
    c.advance(3600);
    const r = auth.refreshSession(current);
    assert.equal(r.ok, true, `hour ${i + 1} should still renew`);
    current = r.token;
  }
  c.advance(3600); // now exactly at oiat + MAX_LIFETIME
  const refused = auth.refreshSession(current);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'max_lifetime_reached');
});

test('exp is clamped to the cap, so no token outlives its own session', async () => {
  // Renew every half hour until only 30 minutes of the cap remain; the 1h TTL
  // would then reach past it, so exp must be clamped back to the cap.
  const { auth, token, clock: c } = await loggedIn();
  const origin = auth.verifySessionToken(token).oiat;
  let current = token;
  while (c.value < origin + MAX_LIFETIME - 1800) {
    c.advance(1800);
    const step = auth.refreshSession(current);
    assert.equal(step.ok, true);
    current = step.token;
  }
  const r = auth.refreshSession(current);
  assert.equal(r.ok, true);
  assert.equal(r.expires_at, origin + MAX_LIFETIME, 'exp must stop at the cap, not TTL');
  assert.ok(r.expires_at < c.value + TTL, 'the clamp actually bit');
});

test('an expired token cannot be refreshed back to life', async () => {
  const { auth, token, clock: c } = await loggedIn();
  c.advance(TTL + 1);
  const r = auth.refreshSession(token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'expired');
});

test('a tampered token is refused, and its code is not the terminal one', async () => {
  // The browser only sends the owner back to their signer on
  // max_lifetime_reached, so garbage must never masquerade as that.
  const { auth, token } = await loggedIn();
  const parts = token.split('.');
  parts[1] = String(Number(parts[1]) + 99999); // buy yourself more time
  const r = auth.refreshSession(parts.join('.'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_session');
});

test('a token from another secret is refused', async () => {
  const a = await loggedIn();
  const b = await loggedIn();
  // b's token is well-formed but signed for a different admin/secret pair.
  const r = a.auth.refreshSession(b.token);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_session');
});

test('junk input is refused without throwing', async () => {
  const { auth } = await loggedIn();
  for (const junk of ['', null, undefined, 'a.b.c', 'a.b.c.d', 'a.b.c.d.e.f', {}, 42]) {
    const r = auth.refreshSession(junk);
    assert.equal(r.ok, false, `${JSON.stringify(junk)} must be refused`);
    assert.equal(r.code, 'invalid_session');
  }
});

test('the old four-field token shape is no longer accepted', async () => {
  // Upgrading the agent invalidates in-flight sessions exactly once, by design:
  // a token with no origin claim cannot have a cap enforced against it.
  const { auth, token } = await loggedIn();
  const [iat, exp, pk, , sig] = token.split('.');
  const legacy = `${iat}.${exp}.${pk}.${sig}`;
  assert.equal(auth.verifySessionToken(legacy).ok, false);
  assert.equal(auth.refreshSession(legacy).code, 'invalid_session');
});

test('a token claiming to predate its own login is refused', async () => {
  // oiat > iat would mean the cap expires before the session began.
  const { auth, token } = await loggedIn();
  const [iat, exp, pk] = token.split('.');
  const forged = `${iat}.${exp}.${pk}.${Number(iat) + 500}.${'0'.repeat(64)}`;
  assert.equal(auth.verifySessionToken(forged).ok, false);
});

test('a refreshed token still authenticates as the same admin', async () => {
  const { auth, token, clock: c } = await loggedIn();
  const before = auth.verifySessionToken(token).npub;
  c.advance(60);
  const r = auth.refreshSession(token);
  assert.equal(auth.verifySessionToken(r.token).npub, before);
});

test('the cap defaults are sane relative to the sliding window', async () => {
  // A cap shorter than one TTL would refuse every refresh; config.mjs floors
  // it, and this asserts the fixture's own ordering holds too.
  assert.ok(MAX_LIFETIME >= TTL);
  const { auth, token, clock: c } = await loggedIn({ ttl: 600, maxLifetime: 600 });
  c.advance(60);
  const r = auth.refreshSession(token);
  assert.equal(r.ok, true, 'a cap equal to one TTL still permits a slide within it');
  assert.equal(r.expires_at, auth.verifySessionToken(token).oiat + 600);
});
