/**
 * Pure, DOM-free helpers for the page-aware chat dock (CHAT-CONTEXT-1).
 *
 * The chat keeps a separate message history per "thread". A thread key is
 * derived from the current context + mode so that:
 *   • general mode  → one shared 'general' thread (side conversations)
 *   • page mode in a project → 'project:<slug>' (ALL pages of one project —
 *     home, board, notes, files — share that project's conversation)
 *   • page mode elsewhere → 'page:<route>' (per-page thread, e.g. dashboard)
 *
 * Kept free of DOM/localStorage so the derivation + trimming are unit-tested
 * without a browser. chat.js owns rendering, storage, and the router glue.
 */

export const THREAD_CAP = 100;

/**
 * Best-effort project slug from a context object. Prefers an explicit
 * `projectSlug` (set from router params), else parses the `where` string the
 * views emit: 'project:<slug>' (project home) or 'project-board:<slug>' (board).
 * Non-project `where` values ('projects', 'dashboard', 'marketplace', …) yield
 * null — note 'projects' starts with 'project' but carries no ':' so it is not
 * treated as a single project's thread.
 * @param {{projectSlug?:string, where?:string}|null|undefined} ctx
 * @returns {string|null}
 */
export function projectSlugFrom(ctx) {
  if (!ctx) return null;
  if (typeof ctx.projectSlug === 'string' && ctx.projectSlug) return ctx.projectSlug;
  const where = typeof ctx.where === 'string' ? ctx.where : '';
  if (where.startsWith('project') && where.includes(':')) {
    const slug = where.slice(where.indexOf(':') + 1).trim();
    return slug || null;
  }
  return null;
}

/**
 * Map a router pattern to a coarse page type sent to the agent as context.
 * @param {string|null|undefined} pattern e.g. '/projects/:slug/board'
 * @returns {string}
 */
export function pageTypeFor(pattern) {
  switch (pattern) {
    case '/':
    case '/about': return 'landing';
    case '/projects': return 'projects';
    case '/projects/:slug': return 'project-home';
    case '/projects/:slug/board': return 'project-board';
    case '/marketplace': return 'marketplace';
    case '/routstr': return 'routstr';
    case '/dashboard': return 'dashboard';
    default: return 'unknown';
  }
}

/**
 * Derive the active thread key from a context object + mode.
 * @param {object} ctx context (label/where/route/projectSlug/…)
 * @param {'page'|'general'} mode
 * @returns {string}
 */
export function threadKeyFor(ctx, mode) {
  if (mode === 'general') return 'general';
  const slug = projectSlugFrom(ctx);
  if (slug) return 'project:' + slug;
  const route = (ctx && typeof ctx.route === 'string' && ctx.route) || '/';
  return 'page:' + route;
}

/**
 * Return the tail of a message list bounded to `cap` (oldest trimmed). Pure —
 * returns a new array, never mutates the input.
 * @param {Array} msgs
 * @param {number} [cap]
 */
export function trimThread(msgs, cap = THREAD_CAP) {
  if (!Array.isArray(msgs)) return [];
  if (msgs.length <= cap) return msgs.slice();
  return msgs.slice(msgs.length - cap);
}

/**
 * Coerce arbitrary parsed JSON into a valid { key: message[] } thread map,
 * dropping malformed entries and trimming each thread to `cap`. Defensive so a
 * corrupted localStorage payload can never crash the app.
 * @param {unknown} raw
 * @param {number} [cap]
 * @returns {Record<string, Array>}
 */
export function sanitizeThreads(raw, cap = THREAD_CAP) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!Array.isArray(val)) continue;
    const msgs = val.filter(
      (m) => m && typeof m === 'object' && typeof m.who === 'string' && typeof m.text === 'string',
    );
    out[key] = trimThread(msgs, cap);
  }
  return out;
}
