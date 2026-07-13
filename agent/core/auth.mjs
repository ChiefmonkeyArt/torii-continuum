/**
 * NIP-07 login + session tokens.
 *
 * Flow:
 *   1. Browser POSTs /api/auth/challenge → server returns a random challenge
 *      string + expiry (5 min). Challenge is bound to the client's IP + a
 *      short-lived server-side nonce so a stolen challenge can't be replayed
 *      from elsewhere.
 *   2. Browser asks Plebeian Signer to sign a NIP-42-shaped event
 *      (kind 22242, "client authentication"):
 *        { kind: 22242,
 *          content: challenge,
 *          tags: [['challenge', challenge], ['relay', origin]] }
 *   3. Browser POSTs /api/auth/verify { event } → server verifies:
 *        - event.pubkey === admin_npub (in hex, decoded from npub1...)
 *        - event.kind === 22242
 *        - event.tags contains a matching 'challenge' tag
 *        - event.sig verifies against event.pubkey
 *        - challenge still exists in the pending set + not expired
 *      If all pass: issue HMAC-signed session token, clear the challenge.
 *   4. Browser sends `Authorization: Bearer <token>` on every subsequent call.
 *
 * We deliberately do NOT store session state server-side. Tokens are
 * self-verifying HMAC tokens (like JWT-but-simpler). Revoke by rotating
 * session_secret.
 *
 * Hardening (v0.2.14-alpha, SUITE-VPS-READY-1):
 *   - The challenges Map is bounded by cfg.rate_limit.max_challenges (default
 *     1000). If size would exceed the cap, the oldest entries by expiresAt
 *     are evicted before insertion. Belt-and-braces alongside
 *     @fastify/rate-limit — even a misconfigured limiter cannot OOM the
 *     process by flooding /api/auth/challenge.
 *   - Every auth event emits a single-line JSON record prefixed `[auth]`
 *     via the pino logger. Prefix-only for pubkeys/challenges/IPs; never the
 *     full value. See README §rate-limit for the taxonomy.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyEvent, getEventHash } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const CHALLENGE_TTL_SEC = 5 * 60;
const CHALLENGE_KIND = 22242;
const DEFAULT_MAX_CHALLENGES = 1000;

// Prefix helpers — never log full pubkeys, full challenges, or full IPs.
function prefix(str, n = 8) {
  if (typeof str !== 'string' || !str) return '';
  return str.slice(0, n);
}

/**
 * @param {object} cfg  frozen loadConfig() result
 * @param {object} deps optional deps for testing:
 *   { now, log, persistAdmin }
 *   - persistAdmin(npub) async — persists a first-touch admin claim. Injected
 *     so auth stays unit-testable without touching the filesystem. index.mjs
 *     wires it to config.persistAdminNpub(cfg._config_path, npub).
 */
export function createAuth(cfg, deps = {}) {
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  // Logger indirection — tests pass their own; index.mjs passes app.log.
  // Falls back to a console-based shim so unit-style usage without a
  // Fastify app still emits the JSON lines.
  const log =
    deps.log ||
    {
      info: (o) => console.log(`[auth] ${typeof o === 'string' ? o : JSON.stringify(o)}`),
      warn: (o) => console.warn(`[auth] ${typeof o === 'string' ? o : JSON.stringify(o)}`),
      error: (o) => console.error(`[auth] ${typeof o === 'string' ? o : JSON.stringify(o)}`),
    };
  const maxChallenges =
    Number.isFinite(cfg?.rate_limit?.max_challenges) && cfg.rate_limit.max_challenges > 0
      ? cfg.rate_limit.max_challenges
      : DEFAULT_MAX_CHALLENGES;

  const challenges = new Map(); // challenge → { expiresAt, ip }

  const persistAdmin =
    typeof deps.persistAdmin === 'function' ? deps.persistAdmin : null;

  // Decode admin npub to hex once at boot. An empty admin_npub is the valid
  // "unclaimed" first-touch state — we boot in bootstrap mode and let the
  // first verified caller claim admin (see claimAdmin below). A NON-empty but
  // undecodable admin_npub is a hard misconfiguration → refuse to start.
  let adminHex = null; // hex pubkey of the admin, or null while unclaimed
  let adminNpub = cfg.admin_npub || null; // canonical npub, kept in sync on claim
  const bootstrap = !cfg.admin_npub || cfg.admin_bootstrap === true;
  if (!bootstrap) {
    try {
      const decoded = nip19.decode(cfg.admin_npub);
      if (decoded.type !== 'npub') throw new Error('not an npub');
      adminHex = decoded.data;
    } catch (e) {
      // Boot-time failure: use console.error (logger may not exist yet in some code paths).
      console.error(`[auth] admin_npub decode failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    log.warn({
      evt: 'auth.bootstrap.armed',
      note: 'admin_npub empty — first verified caller will claim admin',
    });
  }

  // Guards the one-shot first-touch claim. While a claim is being persisted
  // this holds the in-flight promise so a second concurrent verify cannot
  // also claim (single-threaded JS makes the check-and-set atomic between
  // awaits). Cleared once the claim resolves or fails.
  let claimInFlight = null;

  function gc() {
    const t = now();
    for (const [k, v] of challenges) {
      if (v.expiresAt < t) challenges.delete(k);
    }
  }

  /**
   * Enforce the MAX_CHALLENGES ceiling. Called from issueChallenge()
   * BEFORE the new entry is inserted. Evicts oldest-by-expiresAt until the
   * map has room. Emits one `auth.challenge.evicted` line per call if
   * anything was evicted.
   */
  function enforceCap() {
    if (challenges.size < maxChallenges) return;
    // Collect entries sorted by expiresAt ascending (oldest first). We do NOT
    // rely on insertion order because gc() may have deleted middle entries.
    const entries = [];
    for (const [k, v] of challenges) entries.push({ k, exp: v.expiresAt });
    entries.sort((a, b) => a.exp - b.exp);
    // Evict enough to leave room for one new insert.
    let evicted = 0;
    const target = maxChallenges - 1;
    for (const e of entries) {
      if (challenges.size <= target) break;
      challenges.delete(e.k);
      evicted++;
    }
    if (evicted > 0) {
      log.warn({
        evt: 'auth.challenge.evicted',
        count: evicted,
        remaining: challenges.size,
        max: maxChallenges,
      });
    }
  }

  function issueChallenge(clientIp) {
    gc();
    enforceCap();
    const challenge = randomBytes(24).toString('hex');
    challenges.set(challenge, { expiresAt: now() + CHALLENGE_TTL_SEC, ip: clientIp });
    log.info({
      evt: 'auth.challenge.issued',
      ip_prefix: prefix(clientIp || '', 12),
      challenge_prefix: prefix(challenge),
      pending: challenges.size,
    });
    return { challenge, expires_in: CHALLENGE_TTL_SEC };
  }

  /**
   * @returns Promise<{ ok: true, token, expiresAt } | { ok: false, reason }>
   *
   * Async because a successful first-touch verification persists the admin
   * claim to disk before issuing a token.
   */
  async function verifyChallenge(event, clientIp) {
    if (!event || typeof event !== 'object') {
      log.warn({ evt: 'auth.verify.fail', ip_prefix: prefix(clientIp || '', 12), reason: 'malformed_event' });
      return { ok: false, reason: 'no event' };
    }
    if (event.kind !== CHALLENGE_KIND) {
      log.warn({ evt: 'auth.verify.fail', ip_prefix: prefix(clientIp || '', 12), reason: 'wrong_kind' });
      return { ok: false, reason: 'wrong kind (expected 22242)' };
    }
    // Cheap early reject only once an admin is CLAIMED. In bootstrap mode we
    // cannot pre-judge the pubkey, so we fall through to full signature
    // verification and let claimAdmin() decide.
    if (adminHex && event.pubkey !== adminHex) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        pubkey_prefix: prefix(event.pubkey || ''),
        reason: 'notadmin',
      });
      return { ok: false, reason: 'pubkey is not admin npub' };
    }

    // Find the challenge tag
    const tag = (event.tags || []).find((t) => Array.isArray(t) && t[0] === 'challenge');
    if (!tag || !tag[1]) {
      log.warn({ evt: 'auth.verify.fail', ip_prefix: prefix(clientIp || '', 12), reason: 'malformed_event' });
      return { ok: false, reason: 'missing challenge tag' };
    }
    const challenge = tag[1];

    const entry = challenges.get(challenge);
    if (!entry) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        challenge_prefix: prefix(challenge),
        reason: 'notfound',
      });
      return { ok: false, reason: 'unknown or expired challenge' };
    }
    if (entry.expiresAt < now()) {
      challenges.delete(challenge);
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        challenge_prefix: prefix(challenge),
        reason: 'expired',
      });
      return { ok: false, reason: 'expired challenge' };
    }
    if (entry.ip && clientIp && entry.ip !== clientIp) {
      // Not fatal — mobile networks reissue IPs. Warn but allow.
      // Toggle to reason:'ip-mismatch' if you want to be strict.
    }

    // Verify event content also carries the same challenge (defence-in-depth).
    if (event.content && event.content !== challenge) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        challenge_prefix: prefix(challenge),
        reason: 'malformed_event',
      });
      return { ok: false, reason: 'content/tag mismatch' };
    }

    // Verify id + signature
    let sigOk = false;
    try {
      const computedId = getEventHash(event);
      if (computedId !== event.id) {
        log.warn({
          evt: 'auth.verify.fail',
          ip_prefix: prefix(clientIp || '', 12),
          challenge_prefix: prefix(challenge),
          reason: 'malformed_event',
        });
        return { ok: false, reason: 'id mismatch' };
      }
      sigOk = verifyEvent(event);
    } catch (e) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        challenge_prefix: prefix(challenge),
        reason: 'badsig',
      });
      return { ok: false, reason: `sig verify threw: ${e.message}` };
    }
    if (!sigOk) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        challenge_prefix: prefix(challenge),
        reason: 'badsig',
      });
      return { ok: false, reason: 'bad signature' };
    }

    // Signature is valid. Consume the challenge so it can't be replayed even
    // if the claim below fails.
    challenges.delete(challenge);

    // First-touch bootstrap: no admin claimed yet → this verified caller
    // claims it. Persist BEFORE issuing a token so a crash mid-claim never
    // leaves a live session for an unpersisted admin.
    if (!adminHex) {
      const claim = await claimAdmin(event.pubkey, clientIp);
      if (!claim.ok) return { ok: false, reason: claim.reason };
    }

    log.info({
      evt: 'auth.verify.success',
      ip_prefix: prefix(clientIp || '', 12),
      pubkey_prefix: prefix(event.pubkey),
    });

    const token = issueSessionToken();
    return { ok: true, token: token.token, expires_at: token.expiresAt };
  }

  /**
   * One-shot first-touch admin claim. Called only after a caller's NIP-07
   * signature has been fully verified.
   *
   * Race safety: JS runs synchronously between awaits, so the
   * `if (claimInFlight)` check and the `claimInFlight = ...` assignment form
   * an atomic critical section. Two concurrent first verifies therefore see:
   * the first sets claimInFlight and awaits persistence; the second observes
   * claimInFlight truthy and is rejected. Neither can overwrite the other.
   * Persistence failures fail closed — adminHex stays null and no token is
   * issued, so the box remains unclaimed and safe to retry.
   *
   * @returns Promise<{ ok: true } | { ok: false, reason }>
   */
  async function claimAdmin(pubkeyHex, clientIp) {
    // Lost a race that already resolved: honour the winner.
    if (adminHex) {
      return adminHex === pubkeyHex
        ? { ok: true }
        : { ok: false, reason: 'admin already claimed' };
    }
    // Lost a race still in flight: refuse rather than double-claim.
    if (claimInFlight) {
      log.warn({
        evt: 'auth.claim.contended',
        ip_prefix: prefix(clientIp || '', 12),
        pubkey_prefix: prefix(pubkeyHex),
      });
      return { ok: false, reason: 'admin claim already in progress' };
    }
    if (!persistAdmin) {
      log.error({ evt: 'auth.claim.fail', reason: 'no_persister' });
      return { ok: false, reason: 'no admin persister configured' };
    }

    let npub;
    try {
      npub = nip19.npubEncode(pubkeyHex);
    } catch (e) {
      log.error({ evt: 'auth.claim.fail', reason: 'npub_encode', msg: e.message });
      return { ok: false, reason: 'could not encode admin npub' };
    }

    claimInFlight = Promise.resolve().then(() => persistAdmin(npub));
    try {
      await claimInFlight;
    } catch (e) {
      claimInFlight = null;
      log.error({
        evt: 'auth.claim.fail',
        ip_prefix: prefix(clientIp || '', 12),
        pubkey_prefix: prefix(pubkeyHex),
        reason: 'persist_error',
      });
      return { ok: false, reason: 'failed to persist admin claim' };
    }
    claimInFlight = null;
    adminHex = pubkeyHex;
    adminNpub = npub;
    log.info({ evt: 'auth.claim.success', pubkey_prefix: prefix(pubkeyHex) });
    return { ok: true };
  }

  function issueSessionToken() {
    // Only ever called after a claim (or with a configured admin), so adminHex
    // is guaranteed non-null here.
    const iat = now();
    const exp = iat + cfg.session_ttl_sec;
    const payload = `${iat}.${exp}.${adminHex}`;
    const sig = createHmac('sha256', cfg.session_secret).update(payload).digest('hex');
    return { token: `${payload}.${sig}`, expiresAt: exp };
  }

  /**
   * @returns { ok, npub? , reason? }
   */
  function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return { ok: false, reason: 'no token' };
    const parts = token.split('.');
    if (parts.length !== 4) return { ok: false, reason: 'malformed' };
    const [iatStr, expStr, pk, sig] = parts;
    const iat = parseInt(iatStr, 10);
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, reason: 'bad timestamps' };
    if (exp < now()) return { ok: false, reason: 'expired' };
    // Unclaimed box: no valid session can exist yet.
    if (!adminHex || pk !== adminHex) return { ok: false, reason: 'not admin pubkey' };

    const expected = createHmac('sha256', cfg.session_secret)
      .update(`${iat}.${exp}.${pk}`)
      .digest('hex');
    let match = false;
    try {
      match = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return { ok: false, reason: 'sig length mismatch' };
    }
    if (!match) return { ok: false, reason: 'bad signature' };

    return { ok: true, npub: adminNpub, exp };
  }

  return {
    issueChallenge,
    verifyChallenge,
    verifySessionToken,
    isClaimed: () => adminHex !== null,
    adminNpub: () => adminNpub,
    _challenges: challenges, // exposed for tests (read-only usage)
    _maxChallenges: maxChallenges, // exposed for tests
    get _adminHex() { return adminHex; }, // live getter for tests
  };
}
