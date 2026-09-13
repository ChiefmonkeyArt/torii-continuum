/**
 * store-actions.mjs — pure parser for the agent's store-write bridge
 * (OWNER-UI-3).
 *
 * The chat skill instructs the model to append, when the operator asks to
 * create or update a milestone/todo, a fenced JSON block to its reply. This
 * module extracts, validates, and strips that block so the agent can apply
 * the writes to the shared project store in-process — without ever treating
 * arbitrary prose as a write.
 *
 * PURE: takes a string, returns data. No I/O, no imports with side effects.
 * Every bound is explicit so a hostile or buggy model output cannot force
 * unbounded work or write to an unexpected project.
 */

import { MILESTONE_STATUS } from './store-events.mjs';

/** Bounds on the action block — enough for a normal turn, hostile-proof. */
export const ACTION_LIMITS = Object.freeze({
  maxActions: 20, // a single chat turn never legitimately writes more
  textMax: 500, // milestone/todo title/note length
  projectMax: 100,
});

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

// A fenced code block: ```info\n body \n```. We accept any info string and
// only look *inside* for JSON whose entries carry an `action` key, which keeps
// us robust to the model labelling the fence `store`, `json`, or nothing.
const FENCE_RE = /```[ \t]*([^\n]*)\n([\s\S]*?)```/g;

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function clampText(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.slice(0, max);
}

/** Validate + normalize one raw action object, or null if it is not allowed. */
export function normalizeAction(raw) {
  if (!isObj(raw)) return null;
  const action = raw.action;
  const project = clampText(raw.project ?? raw.slug, ACTION_LIMITS.projectMax);
  if (!project || !SLUG_RE.test(project)) return null;

  switch (action) {
    case 'add_todo': {
      const text = clampText(raw.text, ACTION_LIMITS.textMax);
      if (!text) return null;
      return { action, project, text };
    }
    case 'toggle_todo': {
      const text = clampText(raw.text, ACTION_LIMITS.textMax);
      if (!text) return null;
      return { action, project, text };
    }
    case 'add_milestone': {
      const title = clampText(raw.title, ACTION_LIMITS.textMax);
      if (!title) return null;
      const status = MILESTONE_STATUS.includes(raw.status) ? raw.status : 'pending';
      const note = clampText(raw.note, ACTION_LIMITS.textMax);
      return { action, project, title, status, note };
    }
    case 'set_milestone_status': {
      const title = clampText(raw.title, ACTION_LIMITS.textMax);
      if (!title) return null;
      if (!MILESTONE_STATUS.includes(raw.status)) return null;
      return { action, project, title, status: raw.status };
    }
    default:
      return null;
  }
}

/** Parse the raw body of a candidate fence into normalized actions. */
function actionsFromBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const item of items) {
    const a = normalizeAction(item);
    if (a) out.push(a);
    if (out.length >= ACTION_LIMITS.maxActions) break;
    if (a && out.length === ACTION_LIMITS.maxActions) break;
  }
  return out;
}

/**
 * Extract store-write actions from a model reply and strip the block(s) from
 * the visible text.
 *
 * @param {string} reply
 * @returns {{ reply: string, actions: Array }}
 */
export function extractStoreActions(reply) {
  if (typeof reply !== 'string' || reply.length === 0) {
    return { reply: reply || '', actions: [] };
  }

  const actions = [];
  let cleaned = reply;

  // Collect actions from any fenced JSON block that carries an `action` key;
  // strip every fenced store-actions block so the operator never sees raw JSON.
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(reply)) !== null) {
    if (actions.length >= ACTION_LIMITS.maxActions) break;
    const parsed = actionsFromBody(m[2]);
    if (parsed.length === 0) continue; // not our block — leave it in place
    for (const a of parsed) {
      if (actions.length >= ACTION_LIMITS.maxActions) break;
      actions.push(a);
    }
    // Remove this specific block from the reply.
    cleaned = cleaned.replace(m[0], '');
  }

  return { reply: cleaned.replace(/\n{3,}/g, '\n\n').trim(), actions };
}