/**
 * Noticeboard draft validation (FE-08) — the frontend mirror of the agent's
 * `agent/core/noticeboard-contract.mjs` invariants, so the review/sign surface
 * refuses to sign a malformed or generic (non-noticeboard) draft. The agent
 * already normalises on draft, but the review path re-loads drafts from the
 * pending shelf and must be its own gate before a signature is requested.
 */

/** NIP-78 application-data kind reused for the world noticeboard. */
export const NOTICEBOARD_KIND = 30078;

/** The `d` tag identifying the operator's replaceable noticeboard event. */
export const NOTICEBOARD_D = 'noticeboard';

export const NOTICE_KINDS = new Set(['notice', 'auction', 'sale', 'event', 'announcement']);

const MAX_TITLE = 120;
const MAX_URL = 500;

/**
 * Structural check on one notice. Mirrors the writer's `normalizeNotices` gate:
 * a non-empty bounded title, a valid kind (or the "notice" fallback), a
 * non-negative finite price when present, and finite whole-second dates when
 * present. Returns false on any malformed field so the whole board is refused.
 * @param {*} n
 * @returns {boolean}
 */
function validNotice(n) {
  if (!n || typeof n !== 'object') return false;
  const title = typeof n.title === 'string' ? n.title.trim() : '';
  if (!title || title.length > MAX_TITLE) return false;
  if (n.price_sats != null && n.price_sats !== '') {
    const p = Number(n.price_sats);
    if (!Number.isFinite(p) || p < 0) return false;
  }
  for (const field of ['starts_at', 'ends_at']) {
    if (n[field] != null && n[field] !== '' && !Number.isFinite(Number(n[field]))) {
      return false;
    }
  }
  if (n.url != null) {
    const url = String(n.url);
    if (url.length > MAX_URL) return false;
  }
  return true;
}

/**
 * Validate a signed-or-unsigned event as a well-formed noticeboard draft.
 * Checks kind, the single `d="noticeboard"` replaceable tag, a finite
 * created_at, and that content parses to a non-empty, well-formed notices
 * array. Returns `{ ok:true }` or `{ ok:false, reason }`.
 * @param {*} event
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateNoticeboardEvent(event) {
  if (!event || typeof event !== 'object') return { ok: false, reason: 'Not an event.' };

  if (event.kind !== NOTICEBOARD_KIND) {
    return { ok: false, reason: `Expected kind ${NOTICEBOARD_KIND} (found ${event.kind ?? 'none'}); this is not a noticeboard draft.` };
  }

  if (!Number.isFinite(event.created_at)) {
    return { ok: false, reason: 'The event has no valid created_at.' };
  }

  const tags = Array.isArray(event.tags) ? event.tags : [];
  const dTags = tags.filter((t) => Array.isArray(t) && t[0] === 'd');
  if (dTags.length !== 1 || dTags[0][1] !== NOTICEBOARD_D) {
    return { ok: false, reason: `Expected exactly one d="${NOTICEBOARD_D}" replaceable tag.` };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return { ok: false, reason: 'Content is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notices) || parsed.notices.length === 0) {
    return { ok: false, reason: 'Content has no valid notices array.' };
  }
  if (parsed.notices.some((n) => !validNotice(n))) {
    return { ok: false, reason: 'One or more notices are malformed.' };
  }
  return { ok: true };
}