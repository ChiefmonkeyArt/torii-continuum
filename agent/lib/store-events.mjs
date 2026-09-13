/**
 * store-events.mjs — server-side event factory for the project store
 * (OWNER-UI-3).
 *
 * The client (`src/data/schema.js` + `src/data/store.js`) persists milestones
 * and todos as "Nostr-shaped" events (kind + `d` tag + `content` object). The
 * agent's write bridge mints the SAME shape here, so a todo/milestone the owner
 * AI creates in chat is byte-for-byte compatible with one the operator adds by
 * hand in the UI, and vice-versa. No relay publish — these are private owner
 * events on the operator's own VPS.
 *
 * Deliberately minimal and self-contained: it depends on nothing but the
 * standard library, so it is trivially unit-testable and cannot be a source of
 * network or filesystem side effects.
 */

const KIND = Object.freeze({
  PROJECT: 30078,
  MILESTONE: 30080,
  TODO: 30081,
});

export { KIND };

let _counter = 0;
function newId(prefix = 'id') {
  _counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}${_counter}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a Nostr-shaped event skeleton — a faithful mirror of
 * `src/data/schema.js` `makeEvent`. `id`/`pubkey`/`sig` stay null (nothing here
 * is signed or published); the UI treats them as local-first records.
 */
function makeEvent({ kind, d, content = {}, tags = [] }) {
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

/** Mirror of `src/data/store.js` `addTodo` (kind 30081). */
export function makeTodoEvent(slug, text, order = 0) {
  return makeEvent({
    kind: KIND.TODO,
    d: `${slug}:${newId('todo')}`,
    content: {
      projectSlug: slug,
      text,
      done: false,
      order,
      createdAt: nowSec(),
    },
    tags: [['a', `${KIND.PROJECT}:${slug}`], ['t', 'todo']],
  });
}

/**
 * Mirror of the client's milestone shape (kind 30080). Status vocabulary is
 * `pending | active | done` (matches `src/data/seed.js` + the UI lanes).
 */
export function makeMilestoneEvent(slug, { title, status = 'pending', note = '', index = 1 }) {
  return makeEvent({
    kind: KIND.MILESTONE,
    d: `${slug}:m${index}`,
    content: {
      projectSlug: slug,
      index,
      title,
      status,
      note,
    },
  });
}

export const MILESTONE_STATUS = Object.freeze(['pending', 'active', 'done']);