/**
 * Earlier turns sent with a chat message (docs/adr-chat-history.md).
 * The conversation is sealed in the browser, so the browser sends the recent
 * turns; this re-applies the limits so a modified client cannot send more.
 */

export const MAX_HISTORY_ITEMS = 20;
export const MAX_HISTORY_ITEM_CHARS = 8000;
export const MAX_HISTORY_CHARS = 24000;
export const LOCAL_HISTORY_ITEMS = 4;

const ROLES = new Set(['user', 'assistant']);
// A past "store" block must not be echoed into a new write (ADR §5).
const STORE_BLOCK = /```store\b[\s\S]*?(```|$)/g;

/**
 * @param {unknown} raw body.history
 * @returns {{ok:true, messages:Array<{role:string, content:string}>} | {ok:false, error:string}}
 */
export function parseHistory(raw) {
  if (raw === undefined || raw === null) return { ok: true, messages: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'history must be a list' };
  if (raw.length > MAX_HISTORY_ITEMS) return { ok: false, error: `history has more than ${MAX_HISTORY_ITEMS} items` };
  const items = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object' || !ROLES.has(h.role) || typeof h.text !== 'string') {
      return { ok: false, error: 'history items need a role (user or assistant) and text' };
    }
    let text = h.role === 'assistant' ? h.text.replace(STORE_BLOCK, '') : h.text;
    text = text.trim().slice(0, MAX_HISTORY_ITEM_CHARS);
    if (text) items.push({ role: h.role, content: text });
  }
  return { ok: true, messages: fitBudget(items, MAX_HISTORY_CHARS) };
}

/** Keep the newest items within `budget` characters; never start on an assistant turn. */
export function fitBudget(items, budget) {
  let total = 0;
  let start = items.length;
  while (start > 0 && total + items[start - 1].content.length <= budget) {
    total += items[start - 1].content.length;
    start -= 1;
  }
  const kept = items.slice(start);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

/**
 * The local model gets only the last few earlier turns (ADR §6).
 * `messages` is [system?, ...history, current user].
 */
export function trimForLocal(messages, keep = LOCAL_HISTORY_ITEMS) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const current = messages[messages.length - 1];
  const history = messages.slice(head.length, -1);
  if (history.length <= keep) return messages;
  const tail = history.slice(history.length - keep);
  while (tail.length && tail[0].role !== 'user') tail.shift();
  return [...head, ...tail, current];
}
