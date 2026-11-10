/**
 * Recent turns sent with each message (docs/adr-chat-history.md). The
 * conversation is sealed in the browser, so only the browser can send it.
 * The agent applies the same limits again (agent/lib/chat-history.mjs).
 */

export const MAX_HISTORY_ITEMS = 20;
export const MAX_HISTORY_ITEM_CHARS = 8000;
export const MAX_HISTORY_CHARS = 24000;

// The dock's note when the free local model answered; not part of the answer.
const FALLBACK_NOTE = /\n\n_\(answered by the local [^\n]*\)_$/;

/**
 * Earlier real exchanges in a thread: each owner message followed by an AI
 * reply marked `ok`. Greetings, errors and notices are left out (ADR §2).
 * @param {Array<{who:string, text:string, ok?:boolean}>} msgs
 * @returns {Array<{role:'user'|'assistant', text:string}>}
 */
export function buildHistory(msgs) {
  if (!Array.isArray(msgs)) return [];
  const pairs = [];
  for (let i = 0; i + 1 < msgs.length; i++) {
    const q = msgs[i];
    const a = msgs[i + 1];
    if (q?.who !== 'user' || a?.who !== 'ai' || a.ok !== true) continue;
    const qt = String(q.text || '').trim().slice(0, MAX_HISTORY_ITEM_CHARS);
    const at = String(a.text || '').replace(FALLBACK_NOTE, '').trim().slice(0, MAX_HISTORY_ITEM_CHARS);
    if (qt && at) pairs.push([{ role: 'user', text: qt }, { role: 'assistant', text: at }]);
    i++;
  }
  // Newest whole pairs within the limits.
  const out = [];
  let total = 0;
  for (let p = pairs.length - 1; p >= 0; p--) {
    const size = pairs[p][0].text.length + pairs[p][1].text.length;
    if (out.length + 2 > MAX_HISTORY_ITEMS || total + size > MAX_HISTORY_CHARS) break;
    out.unshift(...pairs[p]);
    total += size;
  }
  return out;
}
