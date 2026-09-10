/**
 * Noticeboard composer (NAP-BRIDGE-8) — the operator *write* side.
 *
 * Builds the UNSIGNED kind-30078 `d="noticeboard"` event the operator signs in
 * the browser (NIP-07) and publishes to their relay. This module never signs and
 * never holds a key; it only turns a list of notices into a well-formed event
 * template, so the node stays true to "the agent drafts, the human signs".
 *
 * The event shape is the read-path contract: `{ version, updated_at, notices }`
 * with each notice keyed the way `formatNotices` (npc-bridge) renders it —
 * `kind`, `title`, `body`, `price_sats`, `url`, `starts_at`, `ends_at`.
 */

import { NOTICEBOARD_KIND, NOTICEBOARD_D, NOTICE_KINDS, MAX_NOTICES } from './noticeboard-contract.mjs';

const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_URL = 500;

/**
 * Validate + normalise a raw notices list into the canonical shape, or null when
 * the input is not a well-formed notices array. Purely structural — this is the
 * gate that stops a malformed board from being signed into the relay.
 *
 * - every element must be an object with a non-empty `title` (<= MAX_TITLE)
 * - `kind` must be one of NOTICE_KINDS, else "notice"
 * - `price_sats`, when present, must be a non-negative finite number
 * - `starts_at`/`ends_at`, when present, are floored to whole seconds
 * - `body`/`url` are trimmed and length-capped
 * - the result is capped at MAX_NOTICES
 *
 * @param {*} input
 * @returns {Array|null}
 */
export function normalizeNotices(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;

    const title = String(raw.title ?? '').trim();
    if (!title || title.length > MAX_TITLE) return null;

    const kind = NOTICE_KINDS.has(String(raw.kind ?? '')) ? String(raw.kind) : 'notice';
    const body = String(raw.body ?? '').trim().slice(0, MAX_BODY);

    let price_sats;
    if (raw.price_sats != null && raw.price_sats !== '') {
      price_sats = Number(raw.price_sats);
      if (!Number.isFinite(price_sats) || price_sats < 0) return null;
      price_sats = Math.floor(price_sats);
    }

    const url = String(raw.url ?? '').trim().slice(0, MAX_URL);

    const notice = { kind, title };
    if (body) notice.body = body;
    if (price_sats !== undefined) notice.price_sats = price_sats;
    if (url) notice.url = url;
    if (raw.starts_at != null && raw.starts_at !== '') notice.starts_at = Math.floor(Number(raw.starts_at));
    if (raw.ends_at != null && raw.ends_at !== '') notice.ends_at = Math.floor(Number(raw.ends_at));

    out.push(notice);
    if (out.length > MAX_NOTICES) return null;
  }
  return out;
}

/**
 * Build the unsigned noticeboard event from a NORMALISED notices array.
 * `createdAt` is injectable for tests.
 * @param {Array} notices  already-normalised (see normalizeNotices)
 * @param {{createdAt?:number}} [opts]
 * @returns {{kind:number, created_at:number, tags:Array<Array<string>>, content:string}}
 */
export function buildNoticeboardEvent(notices, { createdAt = Math.floor(Date.now() / 1000) } = {}) {
  return {
    kind: NOTICEBOARD_KIND,
    created_at: createdAt,
    tags: [['d', NOTICEBOARD_D]],
    content: JSON.stringify({ version: 1, updated_at: createdAt, notices }),
  };
}

/**
 * Compose a full unsigned draft from a RAW notices input: normalise (validating)
 * then build the event. Returns `{ ok:true, event }` or `{ ok:false, reason }`.
 * @param {*} input  raw notices array (untrusted — comes from the operator UI)
 * @param {{createdAt?:number}} [opts]
 * @returns {{ok:boolean, event?:object, reason?:string}}
 */
export function composeNoticeboard(input, opts = {}) {
  const notices = normalizeNotices(input);
  if (!notices) return { ok: false, reason: 'notices must be a valid, non-empty list of notice objects' };
  return { ok: true, event: buildNoticeboardEvent(notices, opts) };
}