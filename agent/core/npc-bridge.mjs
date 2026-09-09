/**
 * NAP-BRIDGE-1 — the isolated Nostr gateway for the hermes-npc greeter.
 *
 * This module is a SEPARATE runtime from the Continuum agent. It signs nothing
 * with any key it holds: the greeter's nsec lives in a NIP-46 bunker, and every
 * decrypt / encrypt / sign operation is a bunker RPC. The gateway holds only a
 * NIP-46 *client* secret key (identity to talk to the bunker), the public
 * npub allowlist, the local Ollama endpoint, and the greeter SOUL.md.
 *
 * Trust boundary (see docs/nap-bridge-1.md): it never reads the Continuum
 * agent, the owner's Routstr key, the Cashu float, or owner memory. It is
 * fail-closed: an empty allowlist admits nobody, and any signature that does
 * not verify against the bunker is never published.
 *
 * The pure helpers are exported for unit tests; the loop is a factory with
 * injected deps (pool, signer, chat) so tests never touch a live relay/bunker.
 */

import { verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

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
 * Build the unsigned kind-4 reply template. `ciphertext` is already
 * NIP-04-encrypted to the recipient. The signer fills id/sig (and the bunker
 * enforces pubkey). Never contains the plaintext.
 * @param {{senderHex:string, ciphertext:string, createdAt:number, greeterHex:string}} p
 * @returns {object} unsigned event template
 */
export function buildReplyTemplate({ senderHex, ciphertext, createdAt, greeterHex }) {
  return {
    kind: 4,
    pubkey: greeterHex,
    created_at: createdAt,
    tags: [['p', senderHex]],
    content: ciphertext,
  };
}

// ─── Bridge factory ──────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.cfg      { relayUrls:string[], allowlist:Set<string>, soul:string, model:string }
 * @param {string} deps.greeterHex  greeter pubkey (hex) — learned from the bunker at connect
 * @param {object} deps.log      { info, warn, error } (or console-shaped)
 * @param {object} deps.pool     nostr-tools SimplePool (or compatible stub)
 * @param {object} deps.signer   BunkerSigner-like: { signEvent, nip04Decrypt, nip04Encrypt }
 * @param {function} deps.chat   async ({messages}) => {ok:true, content}|{ok:false, code, reason}
 * @returns {{ start:function():Promise<void>, stop:function():void, handleEvent:function(object):Promise<void> }}
 */
export function createNpcBridge({ cfg, greeterHex, log, pool, signer, chat }) {
  let sub = null;
  let stopped = false;

  /**
   * Process one inbound kind-4 event end-to-end. Silently drops anything that
   * fails verification / allowlist / inference, so an unauthorised or malformed
   * sender can never see a reply and never costs compute.
   */
  async function handleEvent(event) {
    try {
      // 1. Verify the sender's own signature before trusting their pubkey.
      if (!event || !verifyEvent(event)) {
        log.warn('[npc-gateway] dropped unverified event');
        return;
      }
      const senderHex = (event.pubkey || '').toLowerCase();

      // 2. Fail-closed allowlist gate — before any decrypt or compute.
      if (!isSenderAllowed(senderHex, cfg.allowlist)) {
        log.warn('[npc-gateway] dropped non-allowlisted sender');
        return;
      }

      // 3. Decrypt inbound via the bunker (greeter nsec never leaves it).
      const plaintext = await signer.nip04Decrypt(senderHex, event.content);

      // 4. Local inference with the greeter persona in the system turn.
      const messages = [
        { role: 'system', content: cfg.soul },
        { role: 'user', content: plaintext },
      ];
      const reply = await chat({ messages });
      if (!reply || reply.ok !== true || !reply.content) {
        log.warn('[npc-gateway] no reply from inference', reply?.code || 'unknown');
        return;
      }

      // 5. Encrypt the reply to the sender (bunker), then sign it (bunker).
      const ciphertext = await signer.nip04Encrypt(senderHex, reply.content);
      const template = buildReplyTemplate({
        senderHex,
        ciphertext,
        createdAt: Math.floor(Date.now() / 1000),
        greeterHex,
      });
      const signed = await signer.signEvent(template);

      // 6. Publish to the configured relays.
      const pubs = await Promise.allSettled(
        cfg.relayUrls.map((url) => pool.publish([url], signed)),
      );
      const okCount = pubs.filter((p) => p.status === 'fulfilled').length;
      log.info(`[npc-gateway] replied to ${senderHex.slice(0, 8)}… (${okCount}/${cfg.relayUrls.length} relays)`);
    } catch (err) {
      // Never crash the loop on a single bad message.
      log.warn('[npc-gateway] handle error', err?.message || err);
    }
  }

  /** Open the subscription and run until stop() is called. */
  async function start() {
    if (stopped) return;
    stopped = false;
    sub = pool.subscribeMany(
      cfg.relayUrls,
      [{ kinds: [4], '#p': [greeterHex] }],
      { onevent: (e) => { handleEvent(e); } },
    );
    log.info(`[npc-gateway] subscribed to kind-4 for ${greeterHex.slice(0, 8)}… on ${cfg.relayUrls.length} relay(s)`);
  }

  function stop() {
    stopped = true;
    if (sub && typeof sub.close === 'function') sub.close();
  }

  return { start, stop, handleEvent };
}