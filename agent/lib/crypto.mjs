/**
 * NIP-44 v2 sealed-at-rest — signer round-trip model.
 *
 * Design invariant: the agent has NO nsec. All NIP-44 encrypt/decrypt happens
 * in the operator's browser via Plebeian Signer (or any NIP-07-compatible
 * signer that exposes `window.nostr.nip44.encrypt / decrypt`).
 *
 * Wire model:
 *
 *   Write:   browser → nip44.encrypt(admin_pubkey, plaintext) → POST ciphertext →
 *            agent writes `<eventid>.enc` to disk. Plaintext never leaves browser
 *            in that direction.
 *
 *   Read:    browser reads all `.enc` files from agent (raw ciphertext) → decrypts
 *            each via nip44.decrypt(admin_pubkey, ciphertext) → POSTs plaintext
 *            bundle back to agent via /api/memory/unlock. Agent holds plaintext
 *            in this module's RAM cache, keyed by session token. On session
 *            lease expiry / SIGINT / panic, the cache reference is dropped
 *            (best-effort; immutable JS strings are not cryptographically zeroized).
 *
 * The agent NEVER sees a raw private key, and NEVER derives one. All NIP-44
 * work happens on the operator's device. This module is the RAM-only cache +
 * a tiny convenience layer for the write direction (which is a passthrough).
 *
 * Why this shape:
 *   - Preserves the CONT-AGENT-1 hard rule: no key material on the box.
 *   - Character + semantic + procedural are useless without operator consent
 *     to unlock (their browser).
 *   - If VPS is seized cold, disk shows only ciphertext keyed to a pubkey
 *     that isn't stored anywhere on the box.
 *   - Panic key (kind:30097) can be published from a cold device to collapse
 *     the wipe cooldown → operator flips a physical toggle, everything
 *     unwrapped in RAM is dropped and disk is `unlink()`'d.
 *
 * This module does not import nostr-tools' nip44 impl on purpose: the agent
 * must never be a decrypt oracle. If future refactors add browser-signed
 * NIP-46 remote decrypt, that goes through core/routstr.mjs, not here.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * Shape of an entry in the RAM cache.
 * @typedef {object} MemoryEntry
 * @property {string} eventId     - hex id of the underlying 30092/30094/30095 event
 * @property {number} kind        - 30092 | 30094 | 30095 | 30096 | 30097
 * @property {string} dTag        - the parameterized-replaceable d-tag
 * @property {object} content     - decrypted JSON payload (see events.mjs for shapes)
 * @property {number} createdAt   - unix seconds
 * @property {string} scope       - project slug (scoped store) or null (flat identity/intents/panic)
 * @property {string} source      - 'unlock' | 'draft' — where the entry originated
 */

/**
 * Create the sealed-at-rest RAM cache.
 *
 * MEMORY-AUTHORITY-1 (audit A17): the verified admin session (Nostr-signer login)
 * is the SINGLE authority for the plaintext RAM cache. Both /api/memory/unlock and
 * the hardened /api/memory/activate write this same cache; activation is the
 * first-run, owner-signed consent ceremony, not a separate memory protocol. The
 * plaintext here is leased for a deliberate duration (opts.ttlSec) and dropped
 * when the lease lapses or the operator revokes (lock/panic/shutdown) — it is not
 * retained indefinitely after the originating session ends.
 *
 * @param {object} log  fastify logger
 * @param {{ttlSec?:number, now?:()=>number}} [opts] lease duration + injectable clock
 * @returns {object}    { unlock, get, list, clear, snapshot, isUnlocked, unlockedForNpub }
 */
export function createMemoryCache(log, { ttlSec = 86400, now = () => Math.floor(Date.now() / 1000) } = {}) {
  /** @type {Map<string, MemoryEntry>} */
  let cache = new Map(); // key = `${kind}:${scope}:${dTag}` scoped / `${kind}:${dTag}` flat (latest replaces older)
  let unlockedAt = null;
  let unlockedFor = null; // npub the cache is unlocked for

  // Drop the lease when it lapses, so plaintext cannot outlive the session window.
  // Best-effort: replacing the Map releases references to the (immutable) JS
  // strings, but does NOT guarantee cryptographic zeroization of those strings.
  function ensureFresh() {
    if (unlockedAt == null) return;
    if (now() - unlockedAt >= ttlSec) clear('session-lease-expired');
  }

  /**
   * Called by /api/memory/unlock after the browser has decrypted every .enc
   * file. Replaces the entire cache in one shot.
   *
   * @param {string} npub                admin npub the cache is now unlocked for
   * @param {MemoryEntry[]} entries      decrypted entries
   */
  function unlock(npub, entries) {
    if (!npub || typeof npub !== 'string') throw new Error('unlock: missing npub');
    if (!Array.isArray(entries)) throw new Error('unlock: entries must be array');

    // Fresh Map — never merge across unlocks.
    const next = new Map();
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      if (!e.kind || !e.dTag) continue;
      // A09 follow-up (scope-aware): a scoped-store entry keys on its project
      // slug, so the same kind+d-tag under two projects no longer shadows each
      // other in the flat prompt cache. Flat identity/intents/panic (no scope)
      // keep the legacy flat key.
      const scope = (typeof e.scope === 'string' && e.scope.length > 0) ? e.scope : null;
      const key = scope ? `${e.kind}:${scope}:${e.dTag}` : `${e.kind}:${e.dTag}`;
      // If we've seen this key already in this batch, keep the newer createdAt.
      const prev = next.get(key);
      if (prev && prev.createdAt > (e.createdAt || 0)) continue;
      next.set(key, {
        eventId: e.eventId || null,
        kind: e.kind,
        dTag: e.dTag,
        scope,
        content: e.content,
        createdAt: e.createdAt || Math.floor(Date.now() / 1000),
        source: e.source || 'unlock',
      });
    }
    cache = next;
    unlockedAt = now();
    unlockedFor = npub;
    log.info(`[crypto] memory cache unlocked: ${cache.size} entries for ${npub.slice(0, 12)}...`);
    return { count: cache.size, unlockedAt };
  }

  /**
   * Get one entry by kind + d-tag.
   */
  function get(kind, dTag, scope = null) {
    ensureFresh();
    return cache.get(scope ? `${kind}:${scope}:${dTag}` : `${kind}:${dTag}`) || null;
  }

  /**
   * List all entries of a kind. Optional filter on d-tag prefix.
   */
  function list(kind, dTagPrefix = null) {
    ensureFresh();
    const out = [];
    for (const [key, entry] of cache) {
      if (!key.startsWith(`${kind}:`)) continue;
      if (dTagPrefix && !entry.dTag.startsWith(dTagPrefix)) continue;
      out.push(entry);
    }
    // Deterministic ordering — d-tag alphabetical.
    out.sort((a, b) => a.dTag.localeCompare(b.dTag));
    return out;
  }

  /**
   * Drop the RAM cache (best-effort). Called on:
   *   - session lease expiry (plaintext is leased, not retained forever)
   *   - SIGINT / SIGTERM
   *   - operator-triggered panic (via /api/memory/panic)
   *
   * NOTE: replacing the Map releases references to the cached strings; it does
   * NOT guarantee cryptographic zeroization. Immutable JS strings are not
   * overwritable in place, and the heap may retain copies until GC.
   */
  function clear(reason = 'unspecified') {
    const n = cache.size;
    cache = new Map();
    unlockedAt = null;
    unlockedFor = null;
    log.warn(`[crypto] memory cache cleared: ${n} entries dropped (reason: ${reason})`);
  }

  /**
   * Non-sensitive status snapshot for /api/memory (never returns plaintext).
   */
  function snapshot() {
    ensureFresh();
    const byKind = {};
    for (const entry of cache.values()) {
      byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    }
    return {
      unlocked: cache.size > 0,
      unlocked_at: unlockedAt,
      total_entries: cache.size,
      by_kind: byKind,
    };
  }

  function isUnlocked() {
    ensureFresh();
    return cache.size > 0;
  }

  function unlockedForNpub() {
    ensureFresh();
    return unlockedFor;
  }

  return { unlock, get, list, clear, snapshot, isUnlocked, unlockedForNpub };
}

// ─────────────────────────────────────────────────────────────
// Write-direction helpers (passthrough — agent never touches plaintext)
// ─────────────────────────────────────────────────────────────

/**
 * Validate that a ciphertext blob looks like NIP-44 v2 output before we
 * touch disk. We can't decrypt (no key), but we can bounce obvious garbage.
 *
 * NIP-44 v2 payloads:
 *   - are base64url or standard base64 strings
 *   - decode to at least 99 bytes (1 version + 32 nonce + 2 length + 32 padded plaintext + 32 hmac)
 *   - the first decoded byte is 0x02 (version)
 *
 * @param {string} ciphertext
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateCiphertext(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return { ok: false, reason: 'not a string' };
  }
  if (ciphertext.length < 132) {
    // 99 bytes → 132 base64 chars minimum
    return { ok: false, reason: 'too short to be NIP-44 v2' };
  }
  if (ciphertext.length > 65535) {
    return { ok: false, reason: 'too large (max 65535)' };
  }
  let raw;
  try {
    raw = Buffer.from(ciphertext, 'base64');
  } catch {
    return { ok: false, reason: 'invalid base64' };
  }
  if (raw.length < 99) return { ok: false, reason: 'decoded < 99 bytes' };
  if (raw[0] !== 0x02) return { ok: false, reason: `unknown version byte 0x${raw[0].toString(16)}` };
  return { ok: true };
}

/**
 * Compute the filename an encrypted file should have. NIP-01 event id
 * format = 32-byte hex (64 chars).
 *
 * For draft (unsigned) files, we haven't got an event id yet — use a
 * random 16-byte tag so drafts don't collide.
 *
 * @param {string | null} eventId  32-byte hex, or null for drafts
 * @returns {string}
 */
export function ciphertextFilename(eventId = null) {
  if (eventId) {
    if (!/^[0-9a-f]{64}$/i.test(eventId)) {
      throw new Error(`ciphertextFilename: bad event id: ${eventId}`);
    }
    return `${eventId.toLowerCase()}.enc`;
  }
  return `draft-${randomBytes(16).toString('hex')}.enc`;
}

/**
 * Hash an arbitrary blob for logging without leaking content.
 * Used to correlate "wrote file X" with "unlocked entry X" without ever
 * printing the plaintext.
 */
export function fingerprintCiphertext(ciphertext) {
  return createHash('sha256').update(ciphertext, 'utf8').digest('hex').slice(0, 12);
}
