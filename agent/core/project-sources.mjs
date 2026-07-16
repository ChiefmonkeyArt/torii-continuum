/**
 * project-sources.mjs — READ-ONLY server-side adapters that import task-like
 * records from two kinds of operator-configured sources:
 *
 *   1. LOCAL Markdown to-do files  (parsed by lib/markdown-todo.mjs)
 *   2. PUBLIC GitHub issues        (unauthenticated api.github.com)
 *
 * The output is a set of NORMALIZED, read-only records the SPA merges into a
 * project's Kanban board without ever mutating the operator's local/manual
 * cards. Nothing here writes back to Markdown or GitHub — import is one-way.
 *
 * SECURITY POSTURE (hard requirements, enforced here)
 *   • ALLOWLISTS ONLY. A local file is read only when its resolved real path
 *     stays inside the configured `local_root`; a GitHub repo is fetched only
 *     when `owner/repo` is in `allow_github`. Anything else is refused before
 *     any I/O.
 *   • NO TRAVERSAL / NO SYMLINK ESCAPE. Local paths are realpath()-resolved and
 *     re-checked against the root, so `../` and symlinks that point outside the
 *     root are rejected.
 *   • BOUNDED. File size, per-response bytes, issue count, page count, and a
 *     request timeout are all capped. GitHub fetch pins the api.github.com
 *     origin, refuses redirects (SSRF), and hard-caps the streamed body.
 *   • NO CREDENTIALS. Public repos need no token; this module never reads,
 *     stores, sends, or logs any GitHub credential.
 *   • NO CONTENT/SECRET LOGGING. We log counts and sanitized reasons only —
 *     never file contents, issue bodies, tokens, or full paths.
 *   • SNAPSHOT RETENTION. The last VALID normalized snapshot per project is
 *     cached in memory; a later partial/offline/rate-limited refresh retains
 *     the previous snapshot and is reported as stale rather than dropping data.
 */

import { realpath, readFile, stat } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkdownTodos } from '../lib/markdown-todo.mjs';

const DEFAULTS = Object.freeze({
  github_api: 'https://api.github.com',
  max_file_bytes: 256 * 1024,
  max_response_bytes: 1024 * 1024,
  max_issues: 200,
  max_pages: 5,
  request_timeout_ms: 10000,
});

// Hard upper bounds so an accidental large operator value can't turn a bounded
// fetch into an unbounded one. Operator-trusted, but ceilinged as defense.
const CEILINGS = Object.freeze({
  max_file_bytes: 8 * 1024 * 1024,
  max_response_bytes: 16 * 1024 * 1024,
  max_issues: 2000,
  max_pages: 20,
  request_timeout_ms: 60000,
});

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const STATUSES = new Set(['backlog', 'todo', 'doing', 'done']);

// Non-reversible short id for a source reference (path/repo) so logs and record
// ids never carry a full filesystem path or can be correlated across logs.
function fp(s) {
  return createHash('sha256').update('projsrc:' + String(s), 'utf8').digest('hex').slice(0, 16);
}

// Stable per-record fingerprint: (project, source key, native id). Re-importing
// the same source yields the same fingerprint, which is what makes repeated
// refreshes idempotent (no duplicate cards).
function recordFingerprint(project, sourceKey, nativeId) {
  return 'sha256:' + createHash('sha256')
    .update(`${project}\x00${sourceKey}\x00${nativeId}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function num(v, dflt, max) {
  const n = Number.isFinite(v) && v > 0 ? v : dflt;
  return max != null && n > max ? max : n;
}

// ── GitHub label → lane / priority mapping (conservative) ──────────────────

const DOING_LABELS = /(in[\s-]?progress|doing|wip|started|in[\s-]?review)/i;
const BACKLOG_LABELS = /(backlog|icebox|someday|blocked|on[\s-]?hold)/i;
const PRIORITY_LABELS = [
  [/(^|[^a-z])(p0|p1|priority[\s:/-]*high|high[\s-]?priority|urgent|critical)([^a-z]|$)/i, 'high'],
  [/(^|[^a-z])(p2|priority[\s:/-]*med|medium)([^a-z]|$)/i, 'med'],
  [/(^|[^a-z])(p3|priority[\s:/-]*low|low[\s-]?priority)([^a-z]|$)/i, 'low'],
];

function labelNames(issue) {
  if (!Array.isArray(issue?.labels)) return [];
  return issue.labels
    .map((l) => (typeof l === 'string' ? l : (l && typeof l.name === 'string' ? l.name : '')))
    .filter(Boolean)
    .slice(0, 40);
}

function issueStatus(issue, labels) {
  if (issue?.state === 'closed') return 'done';
  for (const name of labels) {
    if (BACKLOG_LABELS.test(name)) return 'backlog';
  }
  for (const name of labels) {
    if (DOING_LABELS.test(name)) return 'doing';
  }
  return 'todo';
}

function issuePriority(labels) {
  for (const name of labels) {
    for (const [re, pri] of PRIORITY_LABELS) {
      if (re.test(name)) return pri;
    }
  }
  return null;
}

/**
 * Map one GitHub issue payload into a normalized record. PURE + exported for
 * unit tests. Returns null for pull requests (the issues endpoint includes
 * them) so PRs never leak in as tasks.
 */
export function mapGithubIssue(issue, { project, repo, titleMax = 200, descMax = 500 } = {}) {
  if (!issue || typeof issue !== 'object') return null;
  if (issue.pull_request) return null; // exclude PRs
  if (!Number.isFinite(issue.number)) return null;
  const labels = labelNames(issue);
  const title = clip(issue.title, titleMax) || `#${issue.number}`;
  const sourceKey = `github:${repo}`;
  return {
    fingerprint: recordFingerprint(project, sourceKey, `gh:issue:${issue.number}`),
    project,
    source: { type: 'github_issues', ref: repo, label: repo, id: `#${issue.number}` },
    title,
    description: clip(issue.body, descMax),
    status: issueStatus(issue, labels),
    priority: issuePriority(labels),
    labels: labels.slice(0, 10),
    url: typeof issue.html_url === 'string' && /^https:\/\//.test(issue.html_url) ? issue.html_url : null,
    readOnly: true,
    createdAt: gh_ts(issue.created_at),
    updatedAt: gh_ts(issue.updated_at),
  };
}

/**
 * Map one parsed Markdown task into a normalized record. PURE + exported.
 * @param task from parseMarkdownTodos()
 * @param ctx  { project, ref (sanitized label), pathFp }
 */
export function mapMarkdownTask(task, { project, ref, pathFp, titleMax = 200 } = {}) {
  if (!task || typeof task.title !== 'string') return null;
  const title = clip(task.title, titleMax);
  if (!title) return null;
  const status = STATUSES.has(task.status) ? task.status : 'todo';
  const sourceKey = `markdown:${pathFp}`;
  // Native id is the normalized title (Markdown tasks have no stable id); this
  // keeps re-imports idempotent even as line numbers shift.
  const nativeId = `md:${title.toLowerCase()}`;
  return {
    fingerprint: recordFingerprint(project, sourceKey, nativeId),
    project,
    source: { type: 'markdown', ref, label: ref, id: task.section || null },
    title,
    description: '',
    status,
    priority: task.priority || null,
    labels: task.section ? [task.section].slice(0, 1) : [],
    url: null,
    readOnly: true,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Drop duplicates. The primary (and, for sources with a stable native id, the
 * ONLY) key is the record fingerprint, which already folds in the source's
 * native id (e.g. a GitHub issue number). Two DISTINCT GitHub issues that happen
 * to share a title therefore have different fingerprints and are both retained.
 *
 * A secondary title-collapse pass runs ONLY for Markdown tasks, which genuinely
 * lack a stable native id (their fingerprint is derived from the normalized
 * title), so a file that lists the same task twice still yields one card. Order
 * is preserved (first wins).
 */
export function dedupeRecords(records) {
  const byFp = new Set();
  const bySig = new Set();
  const out = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (byFp.has(r.fingerprint)) continue;
    if (r.source?.type === 'markdown') {
      const sig = `${r.project}\x00markdown\x00${(r.title || '').toLowerCase()}`;
      if (bySig.has(sig)) continue;
      bySig.add(sig);
    }
    byFp.add(r.fingerprint);
    out.push(r);
  }
  return out;
}

/**
 * @param {object} cfg  frozen loadConfig() result
 * @param {object} deps { log?, fetchImpl?, now?, agentRoot? }
 */
export function createProjectSources(cfg, deps = {}) {
  const psc = cfg?.project_sources || {};
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now || (() => Date.now());

  const enabled = psc.enabled === true;
  const localRootRaw = typeof psc.local_root === 'string' && psc.local_root ? psc.local_root : null;
  const allowGithub = new Set(
    Array.isArray(psc.allow_github)
      ? psc.allow_github.filter((r) => typeof r === 'string' && REPO_RE.test(r))
      : [],
  );
  const sources = Array.isArray(psc.sources) ? psc.sources : [];

  const opt = {
    githubApi: typeof psc.github_api === 'string' && psc.github_api.startsWith('https://')
      ? psc.github_api : DEFAULTS.github_api,
    maxFileBytes: num(psc.max_file_bytes, DEFAULTS.max_file_bytes, CEILINGS.max_file_bytes),
    maxResponseBytes: num(psc.max_response_bytes, DEFAULTS.max_response_bytes, CEILINGS.max_response_bytes),
    maxIssues: num(psc.max_issues, DEFAULTS.max_issues, CEILINGS.max_issues),
    maxPages: num(psc.max_pages, DEFAULTS.max_pages, CEILINGS.max_pages),
    timeoutMs: num(psc.request_timeout_ms, DEFAULTS.request_timeout_ms, CEILINGS.request_timeout_ms),
  };

  // GitHub origin pin — every request URL must resolve to this exact origin.
  let ghOrigin;
  try { ghOrigin = new URL(opt.githubApi).origin; } catch { ghOrigin = new URL(DEFAULTS.github_api).origin; }

  // In-memory last-valid snapshots per project slug:
  //   { bySource: Map<sourceKey, records[]>, records, sources, syncedAt }
  // Keeping records keyed by source is what lets a partial refresh carry forward
  // a FAILED source's last-good records while replacing the succeeded ones.
  const snapshots = new Map();

  function sourcesForProject(slug) {
    return sources.filter((s) => s && s.project === slug);
  }

  // Stable identity for a configured source, used to match this run's result to
  // the prior snapshot's per-source records. Derived from config (not runtime
  // resolution) so it is stable across refreshes.
  function sourceKey(s) {
    if (s?.type === 'markdown') return `markdown:${fp(s.path)}`;
    if (s?.type === 'github_issues') return `github:${s.repo}`;
    return `unknown:${fp(JSON.stringify(s || null))}`;
  }

  /** Public, side-effect-free description of what is configured for a project. */
  function list(slug) {
    const cfgd = sourcesForProject(slug).map(describeSource);
    const snap = snapshots.get(slug) || null;
    return {
      enabled,
      configured: cfgd,
      snapshot: snap ? publicSnapshot(snap) : null,
    };
  }

  function describeSource(s) {
    if (s.type === 'markdown') {
      return { type: 'markdown', ref: safeRef(s.path), configured: !!localRootRaw };
    }
    if (s.type === 'github_issues') {
      return { type: 'github_issues', ref: s.repo, allowed: allowGithub.has(s.repo) };
    }
    return { type: String(s.type || 'unknown'), ref: null, allowed: false };
  }

  /**
   * Resolve + validate a configured local path against the allowlisted root.
   * Rejects: local sources disabled (no root), traversal, and symlink escape.
   * Returns the realpath on success. Exposed for unit tests.
   */
  async function resolveLocalPath(p) {
    if (!localRootRaw) {
      return { ok: false, reason: 'local_sources_disabled' };
    }
    if (typeof p !== 'string' || p.length === 0) {
      return { ok: false, reason: 'invalid_path' };
    }
    let rootReal;
    try {
      rootReal = await realpath(resolve(localRootRaw));
    } catch {
      return { ok: false, reason: 'local_root_unavailable' };
    }
    // Lexical containment first (cheap, catches obvious ../ before touching fs).
    const lexical = resolve(rootReal, p);
    if (lexical !== rootReal && !lexical.startsWith(rootReal + sep)) {
      return { ok: false, reason: 'path_outside_root' };
    }
    // realpath resolves symlinks; re-check containment so a symlink inside the
    // root that points outside is rejected.
    let real;
    try {
      real = await realpath(lexical);
    } catch {
      return { ok: false, reason: 'not_found' };
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      return { ok: false, reason: 'symlink_escape' };
    }
    return { ok: true, real };
  }

  async function loadMarkdownSource(slug, s) {
    const ref = safeRef(s.path);
    const resolved = await resolveLocalPath(s.path);
    if (!resolved.ok) {
      return { ref, ok: false, reason: resolved.reason, records: [] };
    }
    let st;
    try {
      st = await stat(resolved.real);
    } catch {
      return { ref, ok: false, reason: 'not_found', records: [] };
    }
    if (!st.isFile()) return { ref, ok: false, reason: 'not_a_file', records: [] };
    if (st.size > opt.maxFileBytes) return { ref, ok: false, reason: 'file_too_large', records: [] };

    let text;
    try {
      text = await readFile(resolved.real, 'utf8');
    } catch {
      return { ref, ok: false, reason: 'read_failed', records: [] };
    }
    const { tasks, truncated } = parseMarkdownTodos(text, { maxTasks: opt.maxIssues });
    const pathFp = fp(resolved.real);
    const records = [];
    for (const t of tasks) {
      const rec = mapMarkdownTask(t, { project: slug, ref, pathFp });
      if (rec) records.push(rec);
    }
    log.info(`[project-sources] markdown ${fp(ref)} → ${records.length} tasks${truncated ? ' (truncated)' : ''}`);
    return { ref, ok: true, reason: null, records, truncated };
  }

  // ── GitHub hardened fetch (pinned, no redirects, bounded) ──

  function ghPin(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('project-sources: github path must be an absolute /path');
    }
    const u = new URL(path, opt.githubApi);
    if (u.origin !== ghOrigin || u.protocol !== 'https:') {
      throw new Error('project-sources: refusing off-origin GitHub request (SSRF guard)');
    }
    return u;
  }

  async function ghCall(path) {
    let url;
    try { url = ghPin(path); } catch (e) { return { ok: false, status: 0, reason: e.message, json: null, headers: null }; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opt.timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'torii-continuum-agent',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, status: 0, reason: e?.name === 'AbortError' ? 'timeout' : 'network', json: null, headers: null };
    }
    clearTimeout(timer);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opt.maxResponseBytes) {
      return { ok: false, status: res.status, reason: 'response_too_large', json: null, headers: res.headers };
    }
    const text = await readCapped(res, opt.maxResponseBytes);
    if (text === null) {
      return { ok: false, status: res.status, reason: 'response_too_large', json: null, headers: res.headers };
    }
    let json = null;
    if (text.length) { try { json = JSON.parse(text); } catch { json = null; } }
    return { ok: res.ok, status: res.status, json, headers: res.headers, reason: null };
  }

  function ghReason(res) {
    if (res.reason === 'timeout' || res.reason === 'network') return res.reason;
    if (res.reason === 'response_too_large') return 'response_too_large';
    if (res.status === 404) return 'not_found';
    if (res.status === 401 || res.status === 403) {
      // Distinguish rate-limit from auth without echoing any header value.
      const remaining = res.headers ? res.headers.get('x-ratelimit-remaining') : null;
      if (remaining === '0') return 'rate_limited';
      return 'forbidden';
    }
    if (res.status === 429) return 'rate_limited';
    return `github_status_${res.status || 0}`;
  }

  async function loadGithubSource(slug, s) {
    const repo = s.repo;
    if (!REPO_RE.test(String(repo || '')) || !allowGithub.has(repo)) {
      return { ref: repo || null, ok: false, reason: 'repo_not_allowlisted', records: [] };
    }
    const state = s.state === 'all' || s.state === 'closed' ? s.state : 'open';
    const wantLabels = Array.isArray(s.labels)
      ? s.labels.filter((l) => typeof l === 'string' && l.length && l.length < 60).slice(0, 10)
      : [];
    const labelQ = wantLabels.length ? `&labels=${encodeURIComponent(wantLabels.join(','))}` : '';

    const records = [];
    let truncated = false;
    for (let page = 1; page <= opt.maxPages; page++) {
      const path = `/repos/${repo}/issues?state=${state}&per_page=100&page=${page}${labelQ}`;
      const res = await ghCall(path);
      if (!res.ok) {
        // Fail this source but keep any records gathered from earlier pages.
        const reason = ghReason(res);
        log.warn(`[project-sources] github ${fp(repo)} page ${page} failed: ${reason}`);
        return { ref: repo, ok: false, reason, records, partial: records.length > 0 };
      }
      const arr = Array.isArray(res.json) ? res.json : [];
      for (const issue of arr) {
        if (records.length >= opt.maxIssues) { truncated = true; break; }
        const rec = mapGithubIssue(issue, { project: slug, repo });
        if (rec) records.push(rec);
      }
      if (truncated || arr.length < 100) break; // last page
    }
    log.info(`[project-sources] github ${fp(repo)} → ${records.length} issues${truncated ? ' (truncated)' : ''}`);
    return { ref: repo, ok: true, reason: null, records, truncated };
  }

  /**
   * Refresh all configured sources for a project. Normalizes + dedupes, updates
   * the last-valid snapshot, and — on partial/total failure — RETAINS the prior
   * snapshot's records so the board never loses data on a transient outage.
   */
  async function refresh(slug) {
    if (!enabled) {
      return { ok: false, enabled: false, reason: 'disabled', sources: [], records: [], syncedAt: null };
    }
    const configured = sourcesForProject(slug);
    if (configured.length === 0) {
      const empty = { records: [], sources: [], syncedAt: now() };
      snapshots.set(slug, empty);
      return { ok: true, enabled: true, sources: [], records: [], syncedAt: empty.syncedAt, empty: true };
    }

    const results = [];
    for (const s of configured) {
      if (s.type === 'markdown') results.push(await loadMarkdownSource(slug, s));
      else if (s.type === 'github_issues') results.push(await loadGithubSource(slug, s));
      else results.push({ ref: null, ok: false, reason: 'unknown_source_type', records: [] });
    }

    const anyOk = results.some((r) => r.ok);
    const allOk = results.every((r) => r.ok);
    const prior = snapshots.get(slug);
    const priorBySource = prior && prior.bySource instanceof Map ? prior.bySource : new Map();

    // Build the next per-source record map: a succeeded source contributes its
    // fresh records; a FAILED source carries forward its last-good records from
    // the prior snapshot (so its cards are never dropped on a transient outage).
    // Only if there is no prior for a failed source do we fall back to whatever
    // partial records this run gathered.
    const nextBySource = new Map();
    let retained = false;
    for (let i = 0; i < configured.length; i++) {
      const key = sourceKey(configured[i]);
      const r = results[i];
      if (r.ok) {
        nextBySource.set(key, Array.isArray(r.records) ? r.records : []);
      } else {
        const priorRecs = priorBySource.get(key);
        if (Array.isArray(priorRecs) && priorRecs.length) {
          nextBySource.set(key, priorRecs);
          retained = true;
        } else if (Array.isArray(r.records) && r.records.length) {
          nextBySource.set(key, r.records);
        }
      }
    }

    const sources = results.map(sourceStatus);
    const partial = anyOk && !allOk;
    const stale = !anyOk && prior != null;

    let records;
    let syncedAt;
    if (anyOk) {
      // At least one source refreshed cleanly — commit a new last-valid snapshot
      // (partial refreshes retain failed sources via nextBySource above).
      records = dedupeRecords([...nextBySource.values()].flat());
      syncedAt = now();
      snapshots.set(slug, { bySource: nextBySource, records, sources, syncedAt });
    } else if (prior && Array.isArray(prior.records) && prior.records.length) {
      // Total failure with a prior snapshot: preserve the full last-valid
      // snapshot untouched and report it as stale.
      records = prior.records;
      syncedAt = prior.syncedAt;
    } else {
      // Total failure with no usable prior: surface whatever partial data exists
      // (may be empty). Do not persist a failed run as the last-valid snapshot.
      records = dedupeRecords([...nextBySource.values()].flat());
      syncedAt = prior ? prior.syncedAt : now();
    }

    return {
      ok: anyOk,
      enabled: true,
      partial,
      stale,
      retained,
      sources,
      records,
      syncedAt,
    };
  }

  function snapshot(slug) {
    const snap = snapshots.get(slug);
    return snap ? publicSnapshot(snap) : null;
  }

  return { list, refresh, snapshot, resolveLocalPath, _ghPin: ghPin };
}

// ── helpers ──

function sourceStatus(r) {
  return {
    type: r.type || (r.ref && r.ref.includes('/') ? 'github_issues' : 'markdown'),
    ref: r.ref || null,
    ok: !!r.ok,
    reason: r.reason || null,
    count: Array.isArray(r.records) ? r.records.length : 0,
    truncated: !!r.truncated,
    partial: !!r.partial,
  };
}

function publicSnapshot(snap) {
  return {
    records: snap.records || [],
    sources: snap.sources || [],
    syncedAt: snap.syncedAt || null,
  };
}

// A source ref that never leaks a full local path: markdown sources are shown
// by basename only.
function safeRef(p) {
  if (typeof p !== 'string' || !p) return null;
  return basename(p).slice(0, 80);
}

function gh_ts(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function clip(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

async function readCapped(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* noop */ }
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const text = await res.text();
  return text.length > maxBytes ? null : text;
}
