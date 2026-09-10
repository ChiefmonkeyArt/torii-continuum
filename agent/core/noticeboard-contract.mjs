/**
 * The noticeboard wire contract (NAP-BRIDGE-8) — shared, dependency-free.
 *
 * Both sides of the noticeboard read this one file so the event kind and `d`
 * tag can never drift apart: the greeter read path (npc-gateway.mjs) and the
 * operator write path (noticeboard.mjs / the Continuum publish surface).
 */

/** NIP-78 application-data kind reused for the world noticeboard. */
export const NOTICEBOARD_KIND = 30078;

/** The `d` tag that identifies the operator's replaceable noticeboard event. */
export const NOTICEBOARD_D = 'noticeboard';

/**
 * The notice `kind` values the composer accepts. Kept as a free string back to
 * the reader (formatNotices renders whatever kind it gets), but the writer
 * normalises unknown kinds to "notice" so a stray input can't smuggle junk.
 */
export const NOTICE_KINDS = new Set(['notice', 'auction', 'sale', 'event', 'announcement']);

/** Hard ceiling on notices per board — it is a notice, not an archive. */
export const MAX_NOTICES = 20;