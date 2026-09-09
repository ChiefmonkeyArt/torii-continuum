/**
 * NAP-BRIDGE-3 — the isolated Nostr gateway for the hermes-npc greeter.
 *
 * Wire format: NIP-17 gift-wrapped DMs (kind 1059) + NIP-44 encryption.
 *   rumor (kind 14) ──▶ seal (kind 13) ──▶ gift wrap (kind 1059)
 *
 * The greeter signs with a LOCAL per-install ephemeral nsec (see
 * core/npc-signer.mjs): no NIP-46 bunker. The signer does the inner NIP-44
 * encrypt/decrypt (rumor ↔ seal) and signs the seal. The OUTER gift wrap uses a
 * fresh ephemeral key generated locally — that is what hides the greeter from
 * relay observers (the wrap's pubkey is random).
 *
 * Trust boundary (see docs/nap-bridge-1.md): it never reads the Continuum
 * agent, the owner's Routstr key, the Cashu float, or owner memory. Fail-closed:
 * an empty allowlist admits nobody; a seal that does not verify against its own
 * (signed) pubkey is never answered; the sender is only trusted after the inner
 * rumor is unwrapped and authenticated — an attacker's gift wrap costs a decrypt
 * but can never elicit a reply to a non-allowlisted identity.
 *
 * The pure helpers are exported for unit tests; the loop is a factory with
 * injected deps (pool, signer, chat, giftWrap) so tests never touch a live
 * relay.
 */

import {
  verifyEvent,
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { nip19 } from 'nostr-tools';

const KIND_RUMOR = 14;    // inner private direct message
const KIND_SEAL = 13;     // NIP-44-encrypted rumor, signed by the sender
const KIND_WRAP = 1059;   // NIP-44-encrypted seal, signed by an ephemeral key

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalise allowlist entries (npub1… or raw hex) to a Set of lowercase hex
 * pubkeys. Invalid entries are dropped (never a crash), so the caller stays
 * fail-closed: an allowlist that normalises to empty admits nobody.
 * @param {(string)[]} entries
 * @returns {Set<string>}
 */
export function normalizeAllowlist(entries = []) {
  const out = new Set();
  if (!Array.isArray(entries)) return out;
  for (const raw of entries) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s) continue;
    // hex pubkey (64 lowercase chars)
    if (/^[0-9a-f]{64}$/i.test(s)) {
      out.add(s.toLowerCase());
      continue;
    }
    // npub1… Bech32
    if (s.startsWith('npub1')) {
      try {
        const { type, data } = nip19.decode(s);
        if (type === 'npub' && typeof data === 'string') out.add(data.toLowerCase());
      } catch {
        /* drop invalid */
      }
    }
  }
  return out;
}

/**
 * Fail-closed allowlist gate. A missing/empty set admits nobody.
 * @param {string} senderHex lowercase hex pubkey of the sender
 * @param {Set<string>} allowlist normalised allowlist
 * @returns {boolean}
 */
export function isSenderAllowed(senderHex, allowlist) {
  if (!senderHex || typeof senderHex !== 'string') return false;
  if (!allowlist || !(allowlist instanceof Set) || allowlist.size === 0) return false;
  return allowlist.has(senderHex.toLowerCase());
}

/**
 * Assemble the greeter prompt: SOUL.md (identity + hard limits) as the system
 * turn, then the sender's plaintext as the user turn.
 * @param {string} soul greeter SOUL.md text
 * @param {string} incoming plaintext from the allowed sender
 * @returns {string}
 */
export function buildGreeterPrompt(soul, incoming) {
  const soulText = (soul || '').trim();
  const userText = String(incoming ?? '').trim();
  const parts = [];
  if (soulText) parts.push(soulText);
  parts.push(userText.length ? userText : '(silent message)');
  return parts.join('\n\n');
}

/**
 * Build the inner rumor (kind 14) for a reply. Signed indirectly by the seal
 * that wraps it — the rumor itself is unsigned, matching nostr-tools' NIP-17.
 * @param {{greeterHex:string, senderHex:string, plaintext:string, createdAt:number}} p
 * @returns {object} unsigned rumor event (kind 14)
 */
export function buildRumor({ greeterHex, senderHex, plaintext, createdAt }) {
  return {
    kind: KIND_RUMOR,
    pubkey: greeterHex,
    created_at: createdAt,
    tags: [['p', senderHex]],
    content: plaintext,
  };
}

/**
 * Build the seal (kind 13) template: the rumor NIP-44-encrypted to the sender.
 * `ciphertext` is already produced by the signer (`signer.nip44Encrypt`).
 * @param {{ciphertext:string, greeterHex:string, createdAt:number}} p
 * @returns {object} unsigned seal template (kind 13), pubkey filled by the signer
 */
export function buildSealTemplate({ ciphertext, greeterHex, createdAt }) {
  return {
    kind: KIND_SEAL,
    pubkey: greeterHex,
    created_at: createdAt,
    tags: [],
    content: ciphertext,
  };
}

/**
 * Build the gift-wrap (kind 1059) template: the seal NIP-44-encrypted to the
 * sender under a fresh ephemeral key. `ciphertext` is produced locally.
 * @param {{senderHex:string, ciphertext:string, ephemeralPubkey:string, createdAt:number}} p
 * @returns {object} unsigned wrap template (kind 1059)
 */
export function buildWrapTemplate({ senderHex, ciphertext, ephemeralPubkey, createdAt }) {
  return {
    kind: KIND_WRAP,
    pubkey: ephemeralPubkey,
    created_at: createdAt,
    tags: [['p', senderHex]],
    content: ciphertext,
  };
}

/**
 * Parse a JSON string into an object, returning null on failure. A malformed or
 * non-object payload is a clean drop, never a crash.
 * @param {string} s
 * @returns {object|null}
 */
export function safeParse(s) {
  if (typeof s !== 'string' || !s.length) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Gift-wrap an already-signed seal to a recipient under a fresh ephemeral key.
 * Pure (no network). The wrap's pubkey is random, so observers cannot link the
 * reply back to the greeter.
 * @param {object} seal signed seal event (kind 13)
 * @param {string} senderHex recipient pubkey (hex)
 * @param {number} [createdAt]
 * @returns {object} signed gift-wrap event (kind 1059)
 */
export function giftWrapSeal(seal, senderHex, createdAt = Math.floor(Date.now() / 1000)) {
  const ephemeralSk = generateSecretKey();
  const ciphertext = nip44Encrypt(
    JSON.stringify(seal),
    getConversationKey(ephemeralSk, senderHex),
  );
  const tpl = buildWrapTemplate({
    senderHex,
    ciphertext,
    ephemeralPubkey: getPublicKey(ephemeralSk),
    createdAt,
  });
  return finalizeEvent(tpl, ephemeralSk);
}

// ─── Bridge factory ──────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.cfg      { relayUrls:string[], allowlist:Set<string>, soul:string, model:string }
 * @param {string} deps.greeterHex  greeter pubkey (hex) — derived from the local nsec
 * @param {object} deps.log      { info, warn, error } (or console-shaped)
 * @param {object} deps.pool     nostr-tools SimplePool (or compatible stub)
 * @param {object} deps.signer   signer-like: { nip44Encrypt, nip44Decrypt, signEvent, getPublicKey }
 * @param {function} deps.chat   async ({messages}) => {ok:true, content}|{ok:false, code, reason}
 * @param {function} [deps.giftWrap] async (seal, senderHex) => wrap; default giftWrapSeal
 * @returns {{ start:function():Promise<void>, stop:function():void, handleEvent:function(object):Promise<void> }}
 */
export function createNpcBridge({ cfg, greeterHex, log, pool, signer, chat, giftWrap = giftWrapSeal }) {
  let sub = null;
  let stopped = false;
  const now = () => Math.floor(Date.now() / 1000);

  /**
   * Process one inbound gift wrap (kind 1059) end-to-end. Silently drops
   * anything that fails verification / unwrap / allowlist / inference, so an
   * unauthorised or malformed sender never sees a reply and never costs
   * inference. A spammer can force a decrypt (the cost of sender anonymity) but
   * can never elicit a reply to a non-allowlisted identity.
   */
  async function handleEvent(event) {
    try {
      // 1. Must be a gift wrap addressed to us, with a well-formed (ephemeral) sig.
      if (!event || event.kind !== KIND_WRAP || !verifyEvent(event)) {
        log.warn('[npc-gateway] dropped unverified / non-gift-wrap event');
        return;
      }

      // 2. Unwrap the seal with the local signer.
      const sealStr = await signer.nip44Decrypt(event.pubkey, event.content);
      const parsed0 = safeParse(sealStr);
      if (!parsed0) {
        log.warn('[npc-gateway] dropped garbage seal payload');
        return;
      }
      const seal = parsed0;

      // 3. Unwrap the rumor with the local signer.
      const rumorStr = await signer.nip44Decrypt(seal.pubkey, seal.content);
      const parsed1 = safeParse(rumorStr);
      if (!parsed1) {
        log.warn('[npc-gateway] dropped garbage rumor payload');
        return;
      }
      const rumor = parsed1;

      // 4. Authenticate the sender: the seal's signature proves seal.pubkey, and
      //    the rumor must be attributed to that same pubkey.
      if (
        !verifyEvent(seal) ||
        !rumor.pubkey ||
        seal.pubkey.toLowerCase() !== String(rumor.pubkey).toLowerCase()
      ) {
        log.warn('[npc-gateway] dropped seal/rumor with mismatched or unverified sender');
        return;
      }
      const senderHex = seal.pubkey.toLowerCase();

      // 5. Fail-closed allowlist gate — before any inference.
      if (!isSenderAllowed(senderHex, cfg.allowlist)) {
        log.warn('[npc-gateway] dropped non-allowlisted sender');
        return;
      }

      const plaintext = typeof rumor.content === 'string' ? rumor.content : '';

      // 6. Local inference with the greeter persona in the system turn.
      const messages = [
        { role: 'system', content: cfg.soul },
        { role: 'user', content: plaintext },
      ];
      const reply = await chat({ messages });
      if (!reply || reply.ok !== true || !reply.content) {
        log.warn('[npc-gateway] no reply from inference', reply?.code || 'unknown');
        return;
      }

      // 7. Rumor → seal (local encrypt + sign) → gift wrap (local ephemeral).
      const rumorOut = buildRumor({ greeterHex, senderHex, plaintext: reply.content, createdAt: now() });
      const sealCipher = await signer.nip44Encrypt(senderHex, JSON.stringify(rumorOut));
      const sealTpl = buildSealTemplate({ ciphertext: sealCipher, greeterHex, createdAt: now() });
      const signedSeal = await signer.signEvent(sealTpl);
      const wrap = await giftWrap(signedSeal, senderHex);

      // 8. Publish the wrap to the configured relays.
      const pubs = await Promise.allSettled(
        cfg.relayUrls.map((url) => pool.publish([url], wrap)),
      );
      const okCount = pubs.filter((p) => p.status === 'fulfilled').length;
      log.info(`[npc-gateway] replied to ${senderHex.slice(0, 8)}… (${okCount}/${cfg.relayUrls.length} relays)`);
    } catch (err) {
      // Never crash the loop on a single bad message.
      log.warn('[npc-gateway] handle error', err?.message || err);
    }
  }

  /** Open the gift-wrap subscription and run until stop() is called. */
  async function start() {
    if (stopped) return;
    stopped = false;
    sub = pool.subscribeMany(
      cfg.relayUrls,
      [{ kinds: [KIND_WRAP], '#p': [greeterHex] }],
      { onevent: (e) => { handleEvent(e); } },
    );
    log.info(`[npc-gateway] subscribed to kind-${KIND_WRAP} for ${greeterHex.slice(0, 8)}… on ${cfg.relayUrls.length} relay(s)`);
  }

  function stop() {
    stopped = true;
    if (sub && typeof sub.close === 'function') sub.close();
  }

  return { start, stop, handleEvent };
}