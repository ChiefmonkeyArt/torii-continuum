/**
 * secretstore.mjs — the smallest secure encrypted-at-rest store for
 * operator secrets the agent legitimately needs to hold plaintext for
 * (an NWC connection URI, a Routstr sk-... key).
 *
 * WHY THIS EXISTS (and why it is NOT the NIP-44 ciphertext path in
 * lib/crypto.mjs): the character/semantic/skill stack is sealed to the
 * operator's OWN npub and decrypted only in the browser — the agent never
 * holds a key and never sees plaintext. That model is perfect for data the
 * agent only ever *relays*. But an NWC URI and a Routstr key are different:
 * the agent must USE them on the operator's behalf (pay an invoice through
 * NWC, authenticate to Routstr) with no browser in the loop, so it must be
 * able to recover the plaintext itself at rest. NIP-44-to-self cannot do
 * that. This module is the "smallest secure encrypted-at-rest mechanism
 * consistent with the repo's existing session_secret and filesystem
 * permissions" the slice calls for.
 *
 * Construction:
 *   key    = HKDF-SHA256(ikm = session_secret bytes, salt = "", info =
 *            "torii-continuum/secretstore/v1/" + name)  → 32 bytes
 *   cipher = AES-256-GCM, random 12-byte IV, 16-byte auth tag
 *   file   = memory/secrets/<name>.enc, mode 0600, JSON envelope:
 *            { v:1, alg:"A256GCM", iv, tag, ct, updated_at }  (all base64 but
 *            updated_at)
 *
 * Domain separation: the info string binds every ciphertext to BOTH the
 * store version and the secret name, so a blob encrypted for "nwc" can never
 * be decrypted (or silently swapped in) as "routstr_key" even though both
 * derive from the same session_secret. Rotating session_secret makes every
 * stored secret undecryptable (fail closed) — the same revocation story the
 * session tokens already have.
 *
 * The plaintext is returned ONLY to same-process callers (the NWC / Routstr
 * clients). It is never logged, never returned over the API, and never
 * written anywhere but the GCM ciphertext on disk.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ENVELOPE_VERSION = 1;
const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const INFO_PREFIX = 'torii-continuum/secretstore/v1/';

// A secret name maps 1:1 to a file. Keep names to a short, filesystem-safe
// vocabulary so nothing can traverse out of the secrets dir.
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`secretstore: bad secret name (want ${NAME_RE})`);
  }
}

/**
 * A25: resolve the AT-REST master key, decoupled from session signing.
 *
 * `session_secret` signs/verifies session tokens (core/auth.mjs). The encrypted
 * store is deliberately keyed by a SEPARATE secret so rotating `session_secret`
 * (the login/session secret) does NOT destroy the NWC/Routstr credentials the
 * agent legitimately holds at rest. When no dedicated key is configured, fall
 * back to `session_secret` so existing v1 records keep verifying (legacy
 * install, which remains rotation-unsafe until the operator opts into a
 * dedicated key).
 */
function resolveAtRestKey(cfg) {
  const dedicated = cfg?.secretstore_key;
  const k = (typeof dedicated === 'string' && dedicated.length > 0) ? dedicated : cfg?.session_secret;
  if (typeof k !== 'string' || k.length < 64) {
    throw new Error('secretstore: at-rest key required (>=64 chars; set secretstore_key or session_secret)');
  }
  return k;
}

function deriveKey(atRestKey, name) {
  // Use the at-rest master key as HKDF input keying material; hkdfSync returns
  // an ArrayBuffer.
  const ikm = Buffer.from(atRestKey, 'utf8');
  const info = Buffer.from(INFO_PREFIX + name, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, KEY_LEN));
}

/**
 * @param {object} cfg  frozen loadConfig() result (needs cfg.session_secret)
 * @param {object} deps { dir?: absolute secrets dir, log? }
 */
export function createSecretStore(cfg, deps = {}) {
  // A25: resolve once at construction — the dedicated at-rest key when set, else
  // session_secret (legacy). Rotating session_secret is safe only when a
  // dedicated secretstore_key is configured.
  const atRestKey = resolveAtRestKey(cfg);
  const dir = deps.dir || resolve(process.cwd(), 'memory', 'secrets');
  const log = deps.log || { info() {}, warn() {}, error() {} };

  function fileFor(name) {
    return join(dir, `${name}.enc`);
  }

  /**
   * Encrypt + persist a plaintext secret. Overwrites any prior value.
   * @param {string} name
   * @param {string} plaintext
   */
  async function put(name, plaintext) {
    assertName(name);
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('secretstore: plaintext must be a non-empty string');
    }
    const key = deriveKey(atRestKey, name);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = {
      v: ENVELOPE_VERSION,
      alg: 'A256GCM',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
      updated_at: new Date().toISOString(),
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(fileFor(name), JSON.stringify(envelope), { mode: 0o600 });
    // Never log the plaintext; a content-independent fingerprint is enough to
    // correlate "stored X" with "loaded X" in the audit trail.
    log.info(`[secretstore] stored ${name} (fp=${fingerprint(plaintext)})`);
    return { ok: true, fingerprint: fingerprint(plaintext) };
  }

  /**
   * Load + decrypt. Returns the plaintext string, or null when absent.
   * Throws only on a present-but-corrupt/tampered blob (fail closed — the
   * GCM tag check makes a flipped byte or wrong key a hard error, not a
   * silent empty).
   * @returns {Promise<string|null>}
   */
  async function get(name) {
    assertName(name);
    let raw;
    try {
      raw = await readFile(fileFor(name), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      throw new Error(`secretstore: ${name} envelope is not JSON`);
    }
    if (!env || env.v !== ENVELOPE_VERSION || env.alg !== 'A256GCM') {
      throw new Error(`secretstore: ${name} unsupported envelope`);
    }
    const key = deriveKey(atRestKey, name);
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    const ct = Buffer.from(env.ct, 'base64');
    if (iv.length !== IV_LEN || tag.length !== 16) {
      throw new Error(`secretstore: ${name} malformed iv/tag`);
    }
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    let pt;
    try {
      pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      // Wrong at-rest key (rotated WITHOUT a dedicated secretstore_key) or
      // tampered ciphertext.
      throw new Error(`secretstore: ${name} decrypt failed (rotated at-rest key or tampered blob)`);
    }
    return pt.toString('utf8');
  }

  /** Whether a secret is present on disk (no decryption). */
  async function has(name) {
    assertName(name);
    try {
      await readFile(fileFor(name), 'utf8');
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  /** Delete a secret. Idempotent — absent is treated as success. */
  async function remove(name) {
    assertName(name);
    try {
      await unlink(fileFor(name));
      log.info(`[secretstore] removed ${name}`);
      return { ok: true, removed: true };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, removed: false };
      throw e;
    }
  }

  /** List stored secret names (never contents). */
  async function list() {
    try {
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith('.enc')).map((f) => f.slice(0, -4));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /**
   * Encrypted-store health, DISTINCT from HTTP/agent health. Attempts to decrypt
   * every stored secret under the current at-rest key; a rotated key WITHOUT a
   * dedicated `secretstore_key` makes each record fail its GCM tag (undecryptable)
   * rather than merely absent. The rotation hold (A25) relies on this: a clean
   * login does not prove the NWC/Routstr records are still usable, but this check
   * does.
   */
  async function health() {
    const names = await list();
    const undecryptable = [];
    const readable = [];
    for (const name of names) {
      try {
        await get(name);
        readable.push(name);
      } catch {
        undecryptable.push(name);
      }
    }
    return { ok: undecryptable.length === 0, count: names.length, readable, undecryptable };
  }

  return { put, get, has, remove, list, health, _dir: dir };
}

/**
 * Content-independent short fingerprint for audit correlation. NOT reversible
 * and salted with a fixed label so it can never be used as an oracle against
 * a small secret space by anyone who only sees the log line.
 */
export function fingerprint(plaintext) {
  return createHash('sha256').update('ss:' + plaintext, 'utf8').digest('hex').slice(0, 12);
}
