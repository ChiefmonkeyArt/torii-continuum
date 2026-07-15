/**
 * Continuum data schema — Nostr-shaped, local-first.
 *
 * Everything is stored as an ADDRESSABLE Nostr event shape
 * (kind + pubkey + `d` tag → unique). MVP writes to localStorage,
 * but the same objects can be signed and published to a relay later
 * with zero re-shaping.
 *
 * Custom kinds (draft — not yet a NIP):
 *   30078 — Continuum Project      (addressable, `d` = project slug)
 *   30079 — Continuum Session      (addressable, `d` = project:session-id)
 *   30080 — Continuum Milestone    (addressable, `d` = project:milestone-id)
 *   30081 — Continuum Todo         (addressable, `d` = project:todo-id)
 *   30082 — Continuum File-ref     (addressable, `d` = project:file-path)
 *   30083 — Continuum Board column (addressable, `d` = project:col:column-id)
 *   30084 — Continuum Board card   (addressable, `d` = project:card:card-id)
 *   30090 — Marketplace task-listing
 *   30091 — Routstr wallet + prefs (addressable, `d` = 'default')
 *
 * All events carry `content` (JSON string in real Nostr; kept as an
 * object here for ergonomics) and `tags` (array of [key, ...values]).
 */

export const KIND = Object.freeze({
  PROJECT: 30078,
  SESSION: 30079,
  MILESTONE: 30080,
  TODO: 30081,
  FILE: 30082,
  BOARD_COLUMN: 30083,
  BOARD_CARD: 30084,
  MARKET_TASK: 30090,
  ROUTSTR: 30091,
});

let _counter = 0;
export function newId(prefix = 'id') {
  _counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}${_counter}`;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a Nostr-shaped event skeleton. `id`, `pubkey`, `sig` are
 * filled by the signer at publish time. Until then they stay null.
 */
export function makeEvent({ kind, d, content = {}, tags = [] }) {
  return {
    id: null,
    pubkey: null,
    created_at: nowSec(),
    kind,
    tags: d ? [['d', d], ...tags] : tags,
    content,
    sig: null,
  };
}

export function getTagValue(ev, key) {
  const t = (ev.tags || []).find((row) => row[0] === key);
  return t ? t[1] : null;
}
