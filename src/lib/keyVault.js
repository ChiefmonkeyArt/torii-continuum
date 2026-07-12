/**
 * KeyVault — browser-local Nostr key management.
 *
 * Generates keys with Web Crypto, stores encrypted in IndexedDB,
 * and provides a NIP-07 shim so the SPA can sign without an extension.
 *
 * This is the self-custody path: the key NEVER leaves the browser.
 * The user can optionally export it to install in a NIP-07 extension later.
 */

import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';

const DB_NAME = 'continuum-keyvault';
const STORE_NAME = 'keys';
const KEY_ID = 'default';
const DB_VERSION = 1;

// ─── IndexedDB helpers ───────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    db.close();
  });
}

async function idbPut(value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Encryption helpers ──────────────────────────────

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-256-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptSecretKey(secretKeyBytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-256-GCM', iv },
    key,
    secretKeyBytes
  );

  return {
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(encrypted)),
  };
}

async function decryptSecretKey(encryptedData, password) {
  const salt = new Uint8Array(encryptedData.salt);
  const iv = new Uint8Array(encryptedData.iv);
  const ciphertext = new Uint8Array(encryptedData.ciphertext);
  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-256-GCM', iv },
    key,
    ciphertext
  );

  return new Uint8Array(decrypted);
}

// ─── KeyVault class ──────────────────────────────────

export class KeyVault {
  constructor(secretKey, pubkey) {
    this.secretKey = secretKey;  // Uint8Array(32)
    this.pubkey = pubkey;        // hex string
  }

  get hex() { return this.pubkey; }

  getNpub() {
    return nip19.npubEncode(this.pubkey);
  }

  getNsec() {
    return nip19.nsecEncode(this.secretKey);
  }

  /**
   * Sign a Nostr event. Used as the NIP-07 shim.
   */
  async signEvent(unsignedEvent) {
    return finalizeEvent(unsignedEvent, this.secretKey);
  }

  /**
   * Export encrypted backup (for download/restore on other devices).
   */
  async exportEncrypted(password) {
    const encData = await encryptSecretKey(this.secretKey, password);
    return {
      version: 1,
      type: 'continuum-key-backup',
      pubkey: this.pubkey,
      ...encData,
    };
  }

  // ─── Static factory methods ─────────────────────

  /**
   * Generate a new key, encrypt with password, store in IndexedDB.
   */
  static async generate(password) {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);

    const encData = await encryptSecretKey(secretKey, password);
    await idbPut({
      id: KEY_ID,
      pubkey,
      ...encData,
    });

    return new KeyVault(secretKey, pubkey);
  }

  /**
   * Load existing key from IndexedDB (decrypt with password).
   */
  static async load(password) {
    const record = await idbGet(KEY_ID);
    if (!record) return null;

    const secretKey = await decryptSecretKey(record, password);
    return new KeyVault(secretKey, record.pubkey);
  }

  /**
   * Check if a key exists in IndexedDB (without decrypting).
   */
  static async hasKey() {
    const record = await idbGet(KEY_ID);
    return record !== null;
  }

  /**
   * Get the pubkey without password (stored unencrypted alongside encrypted key).
   */
  static async getPubkey() {
    const record = await idbGet(KEY_ID);
    return record ? record.pubkey : null;
  }

  /**
   * Import an existing nsec (for extension migration or backup restore).
   */
  static async importNsec(nsec, password) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');

    const secretKey = decoded.data;
    const pubkey = getPublicKey(secretKey);

    const encData = await encryptSecretKey(secretKey, password);
    await idbPut({
      id: KEY_ID,
      pubkey,
      ...encData,
    });

    return new KeyVault(secretKey, pubkey);
  }

  /**
   * Import from encrypted backup file.
   */
  static async importEncrypted(backup, password) {
    const secretKey = await decryptSecretKey(backup, password);
    const pubkey = getPublicKey(secretKey);

    await idbPut({
      id: KEY_ID,
      pubkey,
      ...backup,
    });

    return new KeyVault(secretKey, pubkey);
  }

  /**
   * Delete key from IndexedDB (for migration completion).
   */
  static async delete() {
    await idbDelete(KEY_ID);
  }
}

// ─── NIP-07 shim installer ───────────────────────────

/**
 * If no NIP-07 extension is detected but a KeyVault key exists,
 * install a shim that makes window.nostr sign from the KeyVault.
 *
 * This lets the existing auth.js flow work unchanged — it calls
 * window.nostr.signEvent(), which either goes to the extension
 * or to our shim transparently.
 */
export async function installNip07Shim(vault) {
  if (typeof window === 'undefined') return;
  if (window.nostr) return; // Real extension present — don't override

  window.nostr = {
    getPublicKey: () => Promise.resolve(vault.hex),
    signEvent: async (event) => {
      return vault.signEvent(event);
    },
    // NIP-04 — required by some clients but rarely used in Continuum
    nip04: {
      encrypt: async () => { throw new Error('NIP-04 not supported by KeyVault shim'); },
      decrypt: async () => { throw new Error('NIP-04 not supported by KeyVault shim'); },
    },
  };

  // Tag the shim so we can detect it later
  window.__continuum_shim__ = true;
}

export function hasShim() {
  return typeof window !== 'undefined' && window.__continuum_shim__ === true;
}

export function hasExtension() {
  return typeof window !== 'undefined' && window.nostr && !window.__continuum_shim__;
}
