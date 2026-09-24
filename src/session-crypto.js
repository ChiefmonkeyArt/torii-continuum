/**
 * Client-side NIP-44 seal/unseal for chat sessions (OWNER-UI-1).
 *
 * Trust model (mirrors agent/lib/crypto.mjs — "no key material on the box"):
 * the browser seals each session's messages to the owner's npub with the
 * signer's `window.nostr.nip44.encrypt`, and the agent stores only the
 * ciphertext; the browser later unseals with `nip44.decrypt`. Plaintext never
 * leaves the browser, and the agent never holds or derives a key.
 *
 * Everything here is injected (`encrypt`/`decrypt`/`pubkey`), so it is pure and
 * unit-testable without a browser or a real signer.
 */

export const SESSION_BLOB_VERSION = 1;

/**
 * Coerce arbitrary decoded JSON into a valid message list, dropping malformed
 * entries. Defensive so a corrupted/foreign blob can never crash the renderer.
 * @param {unknown} raw
 * @returns {Array<{who:string,text:string,at:number,action?:string}>}
 */
export function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.who !== 'string' || typeof m.text !== 'string') continue;
    out.push({
      who: m.who,
      text: m.text,
      at: typeof m.at === 'number' ? m.at : 0,
      ...(typeof m.action === 'string' && m.action ? { action: m.action } : {}),
    });
  }
  return out;
}

/**
 * Seal a session (thread key + messages) into a NIP-44 ciphertext string for
 * the owner pubkey. The thread key rides inside the sealed blob so the chat
 * dock can restore the right thread on load without a lossy id round-trip.
 * @param {{encrypt:(pk:string,plaintext:string)=>Promise<string>|string, pubkey:string}} deps
 * @param {{threadKey:string, messages:Array}} session
 * @returns {Promise<string>}
 */
export async function sealSession(deps, session) {
  assertDeps(deps, 'encrypt');
  const threadKey = typeof (session && session.threadKey) === 'string' ? session.threadKey : '';
  const messages = session && session.messages;
  const plaintext = JSON.stringify({ v: SESSION_BLOB_VERSION, threadKey, messages: sanitizeMessages(messages),
    ...(session.metadata ? { metadata: sessionMetadata(session.metadata) } : {}) });
  return deps.encrypt(deps.pubkey, plaintext);
}

/**
 * Unseal a NIP-44 ciphertext back into { threadKey, messages }.
 * Throws on a bad blob so the caller can treat it as "unreadable / foreign".
 * @param {{decrypt:(pk:string,ciphertext:string)=>Promise<string>|string, pubkey:string}} deps
 * @param {string} ciphertext
 * @returns {Promise<{threadKey:string, messages:Array}>}
 */
export async function unsealSession(deps, ciphertext) {
  assertDeps(deps, 'decrypt');
  if (typeof ciphertext !== 'string' || !ciphertext) {
    throw new Error('unsealSession: ciphertext required');
  }
  const plaintext = await deps.decrypt(deps.pubkey, ciphertext);
  let obj;
  try {
    obj = JSON.parse(plaintext);
  } catch (_e) {
    throw new Error('unsealSession: blob is not valid JSON (foreign or corrupt)');
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) {
    throw new Error('unsealSession: blob has no message list (foreign or corrupt)');
  }
  return {
    threadKey: typeof obj.threadKey === 'string' ? obj.threadKey : '',
    messages: sanitizeMessages(obj.messages),
    ...(obj.metadata ? { metadata: sessionMetadata(obj.metadata) } : {}),
  };
}

export function sessionMetadata(value = {}) {
  return {
    title: typeof value.title === 'string' ? value.title.trim().slice(0, 120) : '',
    pinned: value.pinned === true,
    project: typeof value.project === 'string' && value.project.length > 0 && value.project.length <= 160 && !/[\u0000-\u001f]/.test(value.project) ? value.project : null,
  };
}

function assertDeps(deps, fn) {
  if (!deps || typeof deps !== 'object' || typeof deps[fn] !== 'function') {
    throw new Error(`session crypto: ${fn} is required`);
  }
  if (typeof deps.pubkey !== 'string' || !deps.pubkey) {
    throw new Error('session crypto: pubkey is required');
  }
}
