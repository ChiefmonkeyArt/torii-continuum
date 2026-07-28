/**
 * MEMORY-ACTIVATION-1 — first-run activation state machine (owner-signed unlock).
 *
 * A signed-in owner who lands on #/memory while their bot's memory is LOCKED
 * (memory_unlocked:false) needs one unmistakable, guided way to turn it on. This
 * module is the pure controller behind that flow: given injected I/O (the agent
 * client + the browser's NIP-07/NIP-44 signer), it walks a small, explicit state
 * machine and reports every transition. It is DOM-free and network-free on its
 * own so all eight states are unit-testable; memory.js wires the real deps.
 *
 * Security shape (mirrors the rest of MEMORY-1):
 *   • The owner proves fresh consent by signing a one-time server challenge in
 *     their own signer (the SAME kind-22242 authorization used by login).
 *   • Ciphertexts are decrypted in THIS browser via the owner's key; no key and
 *     no plaintext-at-rest ever leaves the browser here.
 *   • Success is confirmed by re-reading the AUTHORITATIVE server state
 *     (unlocked_for_owner) — the UI never flips to "unlocked" on optimism.
 */

import { reconcileSignedEvent, signerAlteredChallenge } from '../signer-compat.js';

export const ACTIVATION_STATES = Object.freeze({
  READY: 'ready',
  REQUESTING_SIGNATURE: 'requesting-signature',
  ACTIVATING: 'activating',
  SUCCESS: 'success',
  SIGNER_REJECTED: 'signer-rejected',
  SIGNER_UNAVAILABLE: 'signer-unavailable',
  ERROR: 'error',
});

const NIP42_KIND = 22242;

/** Capability probe for a connected NIP-07 signer. Pure + exported for tests. */
export function signerCapabilities(win) {
  const n = win && win.nostr;
  return {
    present: !!n,
    canSign: !!(n && typeof n.signEvent === 'function'),
    canGetPublicKey: !!(n && typeof n.getPublicKey === 'function'),
    canDecrypt: !!(n && n.nip44 && typeof n.nip44.decrypt === 'function'),
  };
}

/** True only when the signer can do everything activation needs. */
export function signerAvailable(win) {
  const c = signerCapabilities(win);
  return c.present && c.canSign && c.canGetPublicKey && c.canDecrypt;
}

/**
 * Build the NIP-07 activation challenge event. Identical shape to the login
 * event (auth.buildLoginEvent) so we reuse the agent's existing 22242 verifier
 * rather than inventing a memory-only signature protocol.
 */
export function buildActivationEvent(challenge, origin, nowMs = Date.now()) {
  return {
    kind: NIP42_KIND,
    created_at: Math.floor(nowMs / 1000),
    content: challenge,
    tags: [
      ['challenge', challenge],
      ['relay', origin],
    ],
  };
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return undefined; }
}

/**
 * Turn the agent's ciphertext listing into unlock entries by decrypting each
 * blob with the owner's signer. When a decrypted blob is a full Nostr event we
 * recover its d-tag/content/created_at; otherwise we pass the payload through so
 * the agent can still populate what it can. Throws if the signer denies a
 * decrypt — the caller treats that as a signer rejection.
 *
 * @param {Array<{kind:number, ciphertext:string}>} list
 * @param {string} pubkey                 owner hex pubkey (decrypt peer = self)
 * @param {(pk:string, ct:string)=>Promise<string>} decrypt
 */
export async function decryptEntries(list, pubkey, decrypt) {
  const out = [];
  for (const e of list || []) {
    if (!e || typeof e.ciphertext !== 'string') continue;
    const plaintext = await decrypt(pubkey, e.ciphertext);
    const parsed = safeParse(plaintext);
    const entry = { kind: e.kind, content: parsed !== undefined ? parsed : plaintext };
    if (parsed && Array.isArray(parsed.tags) && parsed.kind != null) {
      const dTag = parsed.tags.find((t) => Array.isArray(t) && t[0] === 'd');
      if (dTag && dTag[1]) entry.d_tag = dTag[1];
      entry.kind = parsed.kind;
      entry.created_at = parsed.created_at;
      entry.event_id = parsed.id || null;
      entry.content = typeof parsed.content === 'string'
        ? (safeParse(parsed.content) ?? parsed.content)
        : parsed.content;
    }
    out.push(entry);
  }
  return out;
}

function reason(e) {
  return (e && (e.message || String(e))) || 'unknown error';
}

/**
 * Run the activation flow. Emits a `{ state, ... }` object on every transition
 * and resolves with the terminal `{ ok, state, reason? }`. Every I/O dependency
 * is injected, so this is fully testable without a DOM, a network, or a signer.
 *
 * @param {object} deps
 * @param {() => boolean}   deps.signerAvailable
 * @param {() => Promise<string>} deps.getPublicKey
 * @param {(evt:object) => Promise<object>} deps.signEvent
 * @param {(pk:string, ct:string) => Promise<string>} deps.decrypt
 * @param {() => Promise<{ok:boolean, data?:object, reason?:string}>} deps.fetchChallenge
 * @param {() => Promise<{ok:boolean, data?:object, reason?:string}>} deps.fetchCiphertexts
 * @param {(body:object) => Promise<{ok:boolean, data?:object, reason?:string}>} deps.postActivate
 * @param {() => Promise<{ok:boolean, data?:object, reason?:string}>} deps.fetchState
 * @param {string} deps.origin
 * @param {() => number} [deps.now]
 * @param {(t:{state:string, reason?:string}) => void} [onState]
 */
export async function runActivation(deps, onState = () => {}) {
  const S = ACTIVATION_STATES;
  const now = deps.now || (() => Date.now());
  const emit = (state, extra = {}) => { onState({ state, ...extra }); return { ok: state === S.SUCCESS, state, ...extra }; };

  // 1. Signer must be connected and fully capable.
  if (!deps.signerAvailable()) return emit(S.SIGNER_UNAVAILABLE);

  emit(S.REQUESTING_SIGNATURE);

  // 2. One-time challenge from the agent (network/server failure → error).
  let chal;
  try {
    chal = await deps.fetchChallenge();
  } catch (e) {
    return emit(S.ERROR, { reason: reason(e) });
  }
  if (!chal || !chal.ok || !chal.data || !chal.data.challenge) {
    return emit(S.ERROR, { reason: (chal && chal.reason) || 'could not get a challenge' });
  }

  // 3. Owner authorization: read pubkey + sign the challenge in the signer.
  //    Anything the signer throws here is a rejection/cancellation.
  let pubkey; let signed; let built;
  try {
    pubkey = await deps.getPublicKey();
    built = buildActivationEvent(chal.data.challenge, deps.origin, now());
    signed = await deps.signEvent(built);
  } catch (e) {
    return emit(S.SIGNER_REJECTED, { reason: reason(e) });
  }

  // Signers disagree about how much of the event they echo back — some answer
  // with only { id, sig } — so the raw answer is reconciled against what we
  // asked them to sign before it goes anywhere (CONT-SIGNER-1). The signer's
  // values always win; we only fill gaps, and `pubkey` is filled from the
  // signer's own getPublicKey() above. The agent still recomputes the id hash
  // and verifies the signature, so this can only produce a well-shaped payload,
  // never an acceptance.
  const reconciled = reconcileSignedEvent(built, signed);
  if (!reconciled.ok) {
    return emit(S.SIGNER_REJECTED, {
      reason: reconciled.kind === 'unsigned'
        ? 'signer returned an unsigned event'
        : 'signer returned no signature',
    });
  }
  if (reconciled.missing.includes('pubkey')) reconciled.event.pubkey = pubkey;
  if (signerAlteredChallenge(reconciled.event, chal.data.challenge)) {
    return emit(S.SIGNER_REJECTED, { reason: 'signer altered the request, so it cannot be verified' });
  }
  signed = reconciled.event;

  // 4. Pull the encrypted-at-rest blobs (network/server failure → error).
  let ct;
  try {
    ct = await deps.fetchCiphertexts();
  } catch (e) {
    return emit(S.ERROR, { reason: reason(e) });
  }
  if (!ct || !ct.ok) {
    return emit(S.ERROR, { reason: (ct && ct.reason) || 'could not load encrypted memory' });
  }

  // 5. Decrypt in-browser with the owner's key (signer denial → rejection).
  let entries;
  try {
    entries = await decryptEntries(ct.data?.entries || [], pubkey, deps.decrypt);
  } catch (e) {
    return emit(S.SIGNER_REJECTED, { reason: reason(e) });
  }

  // 6. Hand the signed challenge + decrypted entries to the agent.
  emit(S.ACTIVATING);
  let act;
  try {
    act = await deps.postActivate({ event: signed, entries });
  } catch (e) {
    return emit(S.ERROR, { reason: reason(e) });
  }
  if (!act || !act.ok) {
    return emit(S.ERROR, { reason: (act && act.reason) || 'activation failed' });
  }

  // 7. Confirm against AUTHORITATIVE server state — never trust the optimistic
  //    result. Only unlocked_for_owner:true flips the console to unlocked.
  let state;
  try {
    state = await deps.fetchState();
  } catch (e) {
    return emit(S.ERROR, { reason: reason(e) });
  }
  if (state && state.ok && state.data && state.data.unlocked_for_owner) {
    return emit(S.SUCCESS);
  }
  return emit(S.ERROR, { reason: 'activation did not take effect — please retry' });
}
