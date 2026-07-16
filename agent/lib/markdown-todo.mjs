/**
 * markdown-todo.mjs — a PURE, bounded parser that turns a Markdown to-do
 * document into normalized task records. No I/O, no network, no `import`
 * side effects: it only takes a string and returns data, so it is trivially
 * unit-testable and cannot be a source of SSRF, path traversal, or injection.
 *
 * WHAT IT UNDERSTANDS (conservative on purpose)
 *   • GitHub-style task list items:
 *       - [ ] open task           → status "todo"
 *       - [x] / [X] done task     → status "done"
 *       - [-] / [/] / [~] wip     → status "doing"
 *   • Section headings (#..######). A heading whose text matches a status
 *     keyword (Backlog / To do / Todo / In progress / Doing / WIP / Done /
 *     Completed) sets the "section status" for the bullets beneath it.
 *   • Plain bullets (`-`, `*`, `+`) WITHOUT a checkbox are imported ONLY when
 *     they sit under a status-mapped heading — so arbitrary prose bullets are
 *     never mistaken for tasks. A checkbox marker always wins over the heading.
 *   • An inline priority token `(P0)`..`(P3)` or `#p0`..`#p3` (case-insensitive)
 *     is lifted into the `priority` field and stripped from the title.
 *
 * WHY THE BOUNDS
 *   The document is operator-configured but may be large or hostile. Every
 *   loop is bounded: we stop reading after `maxLines`, never emit more than
 *   `maxTasks`, and clamp every title. A parser that can't be forced to
 *   allocate without limit can't be used to DoS the agent.
 *
 * STATUS VOCABULARY  backlog | todo | doing | done   (matches the Kanban lanes)
 */

export const MD_LIMITS = Object.freeze({
  maxLines: 5000,
  maxTasks: 500,
  titleMax: 200,
});

// Heading text → lane. Kept small and explicit; anything not listed leaves the
// section "unmapped" so plain bullets under it are skipped.
const HEADING_STATUS = [
  [/^(backlog|icebox|someday|later)\b/i, 'backlog'],
  [/^(to\s*do|todo|to-do|open|planned|next)\b/i, 'todo'],
  [/^(in\s*progress|doing|wip|active|started|current)\b/i, 'doing'],
  [/^(done|complete|completed|shipped|closed|finished)\b/i, 'done'],
];

function headingStatus(text) {
  for (const [re, status] of HEADING_STATUS) {
    if (re.test(text)) return status;
  }
  return null;
}

// Checkbox marker → lane. `[ ]` is an open todo; `[x]` done; a small set of
// community "in progress" markers map to doing.
function checkboxStatus(mark) {
  if (mark === ' ' || mark === '') return 'todo';
  const m = mark.toLowerCase();
  if (m === 'x') return 'done';
  if (m === '-' || m === '/' || m === '~' || m === '>') return 'doing';
  // Any other single non-space char (e.g. a stray letter) → treat as done-ish
  // only when it is a known "checked" glyph; otherwise be conservative → todo.
  return 'todo';
}

const PRIORITY_TOKEN = /(?:\(p([0-3])\)|#p([0-3]))/i;

function liftPriority(title) {
  const m = title.match(PRIORITY_TOKEN);
  if (!m) return { title, priority: null };
  const n = Number(m[1] ?? m[2]);
  const priority = n <= 1 ? 'high' : n === 2 ? 'med' : 'low';
  const stripped = title.replace(PRIORITY_TOKEN, '').replace(/\s{2,}/g, ' ').trim();
  return { title: stripped || title.trim(), priority };
}

// Strip inline Markdown emphasis/link syntax down to visible text so titles are
// clean. Never interprets HTML — this is plain text extraction, and the caller
// renders via textContent regardless.
function flattenInline(s) {
  return String(s)
    // links [text](url) → text
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    // bold/italic/code fences
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TASK_RE = /^\s*[-*+]\s+\[([ xX\-/~>])\]\s+(.*\S)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*\S)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/;

/**
 * Parse Markdown into task records.
 * @param {string} text raw Markdown
 * @param {object} [opts] { maxLines, maxTasks, titleMax }
 * @returns {{ tasks: Array, truncated: boolean, lineCount: number }}
 *   task = { title, status, priority, section, line }
 */
export function parseMarkdownTodos(text, opts = {}) {
  const maxLines = clampInt(opts.maxLines, MD_LIMITS.maxLines, 1, 100000);
  const maxTasks = clampInt(opts.maxTasks, MD_LIMITS.maxTasks, 1, 100000);
  const titleMax = clampInt(opts.titleMax, MD_LIMITS.titleMax, 1, 2000);

  const tasks = [];
  let truncated = false;
  let sectionText = null;
  let sectionStatus = null;

  if (typeof text !== 'string' || text.length === 0) {
    return { tasks, truncated: false, lineCount: 0 };
  }

  const lines = text.split(/\r\n|\r|\n/);
  const lineCount = lines.length;
  const scan = Math.min(lines.length, maxLines);
  if (lines.length > maxLines) truncated = true;

  for (let i = 0; i < scan; i++) {
    if (tasks.length >= maxTasks) { truncated = true; break; }
    const line = lines[i];
    if (line.length > 10000) continue; // skip pathological single line

    const hm = line.match(HEADING_RE);
    if (hm) {
      sectionText = flattenInline(hm[2]).slice(0, titleMax);
      sectionStatus = headingStatus(hm[2].trim());
      continue;
    }

    const tm = line.match(TASK_RE);
    if (tm) {
      const status = checkboxStatus(tm[1].trim());
      pushTask(tasks, flattenInline(tm[2]), status, sectionText, i + 1, titleMax);
      continue;
    }

    // Plain bullet: only a task when the enclosing heading is status-mapped.
    if (sectionStatus) {
      const bm = line.match(BULLET_RE);
      if (bm) {
        pushTask(tasks, flattenInline(bm[1]), sectionStatus, sectionText, i + 1, titleMax);
      }
    }
  }

  return { tasks, truncated, lineCount };
}

function pushTask(out, rawTitle, status, section, line, titleMax) {
  const cleaned = String(rawTitle).trim();
  if (!cleaned) return;
  const { title, priority } = liftPriority(cleaned);
  const finalTitle = title.slice(0, titleMax);
  if (!finalTitle) return;
  out.push({ title: finalTitle, status, priority, section: section || null, line });
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
