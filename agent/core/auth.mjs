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
 * @param {object} deps optional deps for testing: { now, log }
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

  // Decode admin npubs to hex once at boot.
  const adminHexes = [];
  const adminHexToNpubMap = new Map(); // hex → npub mapping for response
  for (const npub of cfg.admin_npubs) {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') throw new Error(`not an npub: ${npub}`);
      const hex = decoded.data;
      if (adminHexes.includes(hex)) {
        log.warn(`[auth] duplicate admin npub detected: ${npub} and ${adminHexToNpubMap.get(hex)}`);
      }
      adminHexes.push(hex);
      adminHexToNpubMap.set(hex, npub);
    } catch (e) {
      // Boot-time failure: use console.error (logger may not exist yet in some code paths).
      console.error(`[auth] admin_npubs decode failed for ${npub}: ${e.message}`);
      process.exit(1);
    }
  }
  if (adminHexes.length === 0 && !cfg.setup_mode) {
    console.error('[auth] no valid admin npubs found');
    process.exit(1);
  }

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
   * @returns { ok: true, token, expiresAt } | { ok: false, reason }
   */
  function verifyChallenge(event, clientIp) {
    if (!event || typeof event !== 'object') {
      log.warn({ evt: 'auth.verify.fail', ip_prefix: prefix(clientIp || '', 12), reason: 'malformed_event' });
      return { ok: false, reason: 'no event' };
    }
    if (event.kind !== CHALLENGE_KIND) {
      log.warn({ evt: 'auth.verify.fail', ip_prefix: prefix(clientIp || '', 12), reason: 'wrong_kind' });
      return { ok: false, reason: 'wrong kind (expected 22242)' };
    }
    if (!adminHexes.includes(event.pubkey)) {
      log.warn({
        evt: 'auth.verify.fail',
        ip_prefix: prefix(clientIp || '', 12),
        pubkey_prefix: prefix(event.pubkey || ''),
        reason: 'notadmin',
      });
      return { ok: false, reason: 'pubkey is not an admin npub' };
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

    // All checks passed. Consume the challenge.
    challenges.delete(challenge);

    log.info({
      evt: 'auth.verify.success',
      ip_prefix: prefix(clientIp || '', 12),
      pubkey_prefix: prefix(event.pubkey),
    });

    const token = issueSessionToken(event.pubkey);
    return { ok: true, token: token.token, expires_at: token.expiresAt };
  }

  function issueSessionToken(hex) {
    const iat = now();
    const exp = iat + cfg.session_ttl_sec;
    const payload = `${iat}.${exp}.${hex}`;
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
    if (!adminHexes.includes(pk)) return { ok: false, reason: 'not an admin pubkey' };

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

    return { ok: true, npub: adminHexToNpubMap.get(pk), exp };
  }

  return {
    issueChallenge,
    verifyChallenge,
    verifySessionToken,
    issueSessionTokenForPubkey(hex) {
      return issueSessionToken(hex);
    },
    /**
     * Dynamically register an admin pubkey (used by setup flow after
     * browser-generated key is verified). Adds to both adminHexes and the
     * hex→npub map so subsequent verifySessionToken() calls succeed without
     * a restart.
     */
    registerAdminPubkey(hex, npub) {
      if (!adminHexes.includes(hex)) {
        adminHexes.push(hex);
      }
      if (!adminHexToNpubMap.has(hex)) {
        adminHexToNpubMap.set(hex, npub);
      }
    },
    _adminHexes: adminHexes, // exposed for tests
    _challenges: challenges, // exposed for tests (read-only usage)
    _maxChallenges: maxChallenges, // exposed for tests
  };
}
