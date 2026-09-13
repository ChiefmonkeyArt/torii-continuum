/**
 * projectstore.mjs — server-resident, encrypted-at-rest project store
 * (OWNER-UI-2).
 *
 * Replaces the browser localStorage store (`src/data/store.js`) with a single
 * server-side document the agent owns: projects, sessions, milestones, todos,
 * files, board columns/cards, marketTasks, routstr, and the operator roster.
 * It is the single shared source of truth the UI reads/writes over
 * `GET`/`PUT /api/store`, and the foundation OWNER-UI-3 builds the agent's
 * write bridge on (the agent mutates this same document in-process).
 *
 * Trust model — deliberately DIFFERENT from memory/sessions:
 *   • memory + sessions are client-sealed (browser NIP-44 to the owner npub;
 *     the agent holds no key and never sees plaintext) because the agent only
 *     ever *relays* them.
 *   • the project store is server-side-encrypted-at-rest (AES-256-GCM via
 *     lib/secretstore.mjs, key derived from `session_secret`) because the
 *     agent must *read and write* it itself (OWNER-UI-3), with no browser in
 *     the loop. This is exactly the "smallest secure encrypted-at-rest
 *     mechanism for data the agent legitimately needs plaintext access to"
 *     that secretstore.mjs exists for.
 *   • Nothing here is relay-published. The document is private owner state on
 *     the operator's own VPS, encrypted on disk; the admin session gate carries
 *     the transport trust, and `session_secret` rotation renders the blob
 *     undecryptable (fail closed).
 *
 * One document, one resolved write (last-write-wins). A single-operator tool
 * does not need multi-writer coordination beyond the admin gate; if a second
 * live writer ever appears, that becomes an explicit revision/merge decision,
 * not an accidental one.
 */

const STORE_NAME = 'project_store';
const EMPTY = Object.freeze({
  projects: [],
  sessions: [],
  milestones: [],
  todos: [],
  files: [],
  columns: [],
  cards: [],
  marketTasks: [],
  routstr: null,
  members: [],
});

function sanitizeProjectState(raw) {
  const out = { ...EMPTY };
  if (!raw || typeof raw !== 'object') return out;
  const arr = (v) => (Array.isArray(v) ? v : []);
  out.projects = arr(raw.projects);
  out.sessions = arr(raw.sessions);
  out.milestones = arr(raw.milestones);
  out.todos = arr(raw.todos);
  out.files = arr(raw.files);
  out.columns = arr(raw.columns);
  out.cards = arr(raw.cards);
  out.marketTasks = arr(raw.marketTasks);
  out.members = arr(raw.members);
  out.routstr = raw.routstr && typeof raw.routstr === 'object' ? raw.routstr : null;
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.secretStore  a configured `createSecretStore()` instance
 * @param {object} [deps.log]
 */
export function createProjectStore(deps = {}) {
  const secretStore = deps.secretStore;
  if (!secretStore || typeof secretStore.get !== 'function' || typeof secretStore.put !== 'function') {
    throw new Error('createProjectStore: secretStore is required');
  }
  const log = deps.log || { info() {}, warn() {}, error() {} };
  let state = { ...EMPTY };

  /** Load + decrypt the stored document (once at boot). */
  async function load() {
    let plaintext = null;
    try {
      plaintext = await secretStore.get(STORE_NAME);
    } catch (e) {
      // Undecryptable after a session_secret rotation, or a tampered blob —
      // fail closed to empty rather than surfacing a half-readable document.
      log.warn(`[projectstore] load failed (${e.message}); starting empty`);
    }
    if (plaintext) {
      try {
        state = sanitizeProjectState(JSON.parse(plaintext));
      } catch (_e) {
        log.warn('[projectstore] stored document is not valid JSON; starting empty');
        state = { ...EMPTY };
      }
    }
    return state;
  }

  /** Current in-memory document (already loaded). */
  function get() {
    return state;
  }

  /** Replace the document and persist it encrypted-at-rest. */
  async function replace(next) {
    const clean = sanitizeProjectState(next);
    await secretStore.put(STORE_NAME, JSON.stringify(clean));
    state = clean;
    return state;
  }

  return { load, get, replace, name: STORE_NAME };
}

export { sanitizeProjectState, EMPTY as EMPTY_PROJECT_STATE };