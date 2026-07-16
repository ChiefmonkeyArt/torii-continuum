/**
 * project-sources.mjs — READ-ONLY import adapters.
 *
 * Covers the security-critical surface with NO real network and NO real repo:
 *   • GitHub issue → record normalization + PR exclusion + status/priority map
 *   • Markdown task → record normalization
 *   • dedupe by fingerprint (all sources) + title-collapse for Markdown only
 *   • per-source retention on partial refresh; numeric-bound ceilings
 *   • local path allowlist: disabled, traversal, symlink escape, size cap
 *   • GitHub fetch: origin pin (SSRF), redirect refusal, pagination bound,
 *     issue cap, rate-limit detection, response-size cap, timeout
 *   • refresh(): dedup across sources + last-valid snapshot retention on outage
 *   • info-disclosure: records/logs never carry full local paths or secrets
 *
 * Fixtures use generic placeholder repos/paths only.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createProjectSources,
  mapGithubIssue,
  mapMarkdownTask,
  dedupeRecords,
} from '../core/project-sources.mjs';

function silentLog() { return { info() {}, warn() {}, error() {} }; }

// A minimal Response-like object with a byte-cap-friendly body reader.
function res(status, bodyObj, headers = {}) {
  const text = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const bytes = Buffer.from(text, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {},
        };
      },
    },
    async text() { return text; },
  };
}

// ── Pure normalization ──────────────────────────────────────────────

test('mapGithubIssue excludes pull requests', () => {
  const r = mapGithubIssue({ number: 1, title: 'a PR', pull_request: {} }, { project: 'p', repo: 'o/r' });
  assert.equal(r, null);
});

test('mapGithubIssue maps closed→done, open→todo, labels→doing/backlog/priority', () => {
  const closed = mapGithubIssue({ number: 2, title: 'shipped', state: 'closed' }, { project: 'p', repo: 'o/r' });
  assert.equal(closed.status, 'done');
  assert.equal(closed.readOnly, true);
  assert.equal(closed.source.type, 'github_issues');

  const wip = mapGithubIssue({ number: 3, title: 'x', state: 'open', labels: [{ name: 'in progress' }] }, { project: 'p', repo: 'o/r' });
  assert.equal(wip.status, 'doing');

  const back = mapGithubIssue({ number: 4, title: 'y', state: 'open', labels: ['blocked'] }, { project: 'p', repo: 'o/r' });
  assert.equal(back.status, 'backlog');

  const pri = mapGithubIssue({ number: 5, title: 'z', state: 'open', labels: ['P0'] }, { project: 'p', repo: 'o/r' });
  assert.equal(pri.priority, 'high');
});

test('mapGithubIssue only keeps https html_url', () => {
  const ok = mapGithubIssue({ number: 6, title: 't', state: 'open', html_url: 'https://example.com/i/6' }, { project: 'p', repo: 'o/r' });
  assert.equal(ok.url, 'https://example.com/i/6');
  const bad = mapGithubIssue({ number: 7, title: 't', state: 'open', html_url: 'javascript:alert(1)' }, { project: 'p', repo: 'o/r' });
  assert.equal(bad.url, null);
});

test('mapMarkdownTask normalizes and defaults unknown status to todo', () => {
  const r = mapMarkdownTask({ title: 'do thing', status: 'weird', priority: 'high', section: 'Todo' }, { project: 'p', ref: 'todo.md', pathFp: 'abc' });
  assert.equal(r.status, 'todo');
  assert.equal(r.priority, 'high');
  assert.equal(r.readOnly, true);
  assert.equal(r.source.type, 'markdown');
  assert.equal(r.source.ref, 'todo.md');
});

test('dedupeRecords collapses same fingerprint and same project+type+title', () => {
  const a = mapGithubIssue({ number: 1, title: 'same', state: 'open' }, { project: 'p', repo: 'o/r' });
  const aDup = mapGithubIssue({ number: 1, title: 'same', state: 'open' }, { project: 'p', repo: 'o/r' });
  const titleDup = mapMarkdownTask({ title: 'SAME', status: 'todo' }, { project: 'p', ref: 'f', pathFp: 'x' });
  // github + markdown share title but differ by source.type, so title-sig only
  // collapses within the same type; fingerprint collapses the exact dup.
  const out = dedupeRecords([a, aDup, titleDup]);
  assert.equal(out.length, 2);
});

// ── M2: stable native ids beat title collapse ───────────────────────

test('M2: two distinct GitHub issues sharing a title are both retained', () => {
  const a = mapGithubIssue({ number: 1, title: 'Bug', state: 'open' }, { project: 'p', repo: 'o/r' });
  const b = mapGithubIssue({ number: 2, title: 'Bug', state: 'open' }, { project: 'p', repo: 'o/r' });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(dedupeRecords([a, b]).length, 2);
});

test('M2: same title across two allowlisted repos are both retained', () => {
  const a = mapGithubIssue({ number: 1, title: 'Release checklist', state: 'open' }, { project: 'p', repo: 'o/a' });
  const b = mapGithubIssue({ number: 1, title: 'Release checklist', state: 'open' }, { project: 'p', repo: 'o/b' });
  assert.equal(dedupeRecords([a, b]).length, 2);
});

test('M2: an exact-repeat GitHub issue (same repo+number) still collapses by fingerprint', () => {
  const a = mapGithubIssue({ number: 9, title: 'dup', state: 'open' }, { project: 'p', repo: 'o/r' });
  const b = mapGithubIssue({ number: 9, title: 'dup', state: 'open' }, { project: 'p', repo: 'o/r' });
  assert.equal(dedupeRecords([a, b]).length, 1);
});

test('M2: duplicate Markdown tasks sharing a title still collapse (no stable native id)', () => {
  // Different pathFp → different fingerprint, so this exercises the markdown
  // title-collapse pass specifically (not the fingerprint pass).
  const a = mapMarkdownTask({ title: 'Write docs', status: 'todo' }, { project: 'p', ref: 'f', pathFp: 'x' });
  const b = mapMarkdownTask({ title: 'write DOCS', status: 'todo' }, { project: 'p', ref: 'g', pathFp: 'y' });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(dedupeRecords([a, b]).length, 1);
});

// ── M1: per-source retention on partial refresh ─────────────────────

function twoRepoCfg() {
  return {
    project_sources: {
      enabled: true,
      allow_github: ['octo/a', 'octo/b'],
      sources: [
        { project: 'demo', type: 'github_issues', repo: 'octo/a' },
        { project: 'demo', type: 'github_issues', repo: 'octo/b' },
      ],
    },
  };
}

test('M1: partial failure retains the failed source and updates the healthy one', async () => {
  const state = { a: 'ok', b: 'ok', aTitle: 'A issue' };
  const fetchImpl = async (url) => {
    const isA = url.includes('/repos/octo/a/');
    const key = isA ? 'a' : 'b';
    if (state[key] === 'down') throw new Error('down');
    return res(200, [{ number: isA ? 1 : 2, title: isA ? state.aTitle : 'B issue', state: 'open' }]);
  };
  const ps = createProjectSources(twoRepoCfg(), { log: silentLog(), fetchImpl });

  const first = await ps.refresh('demo');
  assert.equal(first.records.length, 2);

  // b fails; a stays healthy and its title changes to prove the healthy source
  // is genuinely refreshed (not just carried forward).
  state.b = 'down';
  state.aTitle = 'A issue v2';
  const partial = await ps.refresh('demo');
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true);
  assert.equal(partial.stale, false);
  assert.equal(partial.retained, true);
  assert.deepEqual(partial.records.map((r) => r.title).sort(), ['A issue v2', 'B issue']);

  // recovery: b returns, a now fails → a carried forward (v2), b fresh.
  state.b = 'ok';
  state.a = 'down';
  const recovered = await ps.refresh('demo');
  assert.equal(recovered.partial, true);
  assert.equal(recovered.retained, true);
  assert.deepEqual(recovered.records.map((r) => r.title).sort(), ['A issue v2', 'B issue']);

  // total failure: full last-valid snapshot preserved, reported stale.
  state.a = 'down';
  state.b = 'down';
  const dead = await ps.refresh('demo');
  assert.equal(dead.ok, false);
  assert.equal(dead.stale, true);
  assert.equal(dead.records.length, 2, 'full last-valid snapshot preserved on total failure');
});

// ── L7: numeric bounds are ceilinged ────────────────────────────────

test('L7: max_pages is clamped to the safe ceiling even if config asks for more', async () => {
  let pages = 0;
  const fetchImpl = async () => {
    pages += 1;
    return res(200, Array.from({ length: 100 }, (_, i) => ({ number: pages * 1000 + i, title: `p${pages}-${i}`, state: 'open' })));
  };
  const ps = createProjectSources(ghCfg({ max_pages: 9999, max_issues: 10_000_000 }), { log: silentLog(), fetchImpl });
  await ps.refresh('demo');
  assert.equal(pages, 20, 'page fetches are capped by the CEILING (20), not the 9999 config value');
});

// ── Local path allowlist ────────────────────────────────────────────

async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'torii-ps-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('local sources disabled when no local_root configured', async () => {
  const ps = createProjectSources({ project_sources: { enabled: true } }, { log: silentLog() });
  const r = await ps.resolveLocalPath('todo.md');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'local_sources_disabled');
});

test('traversal outside local_root is rejected', async () => {
  await withTmp(async (root) => {
    const ps = createProjectSources({ project_sources: { enabled: true, local_root: root } }, { log: silentLog() });
    const r = await ps.resolveLocalPath('../../etc/passwd');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'path_outside_root');
  });
});

test('symlink escaping local_root is rejected', async () => {
  await withTmp(async (root) => {
    // Put the escape target OUTSIDE root.
    const outside = mkdtempSync(join(tmpdir(), 'torii-ps-out-'));
    try {
      const secret = join(outside, 'secret.md');
      writeFileSync(secret, '- [ ] leaked');
      const link = join(root, 'link.md');
      symlinkSync(secret, link);
      const ps = createProjectSources({ project_sources: { enabled: true, local_root: root } }, { log: silentLog() });
      const r = await ps.resolveLocalPath('link.md');
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'symlink_escape');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('in-root markdown file loads and normalizes; ref never leaks full path', async () => {
  await withTmp(async (root) => {
    const sub = join(root, 'notes');
    mkdirSync(sub);
    writeFileSync(join(sub, 'todo.md'), '## Todo\n- [ ] first\n- [x] second\n');
    const ps = createProjectSources({
      project_sources: {
        enabled: true,
        local_root: root,
        sources: [{ project: 'demo', type: 'markdown', path: 'notes/todo.md' }],
      },
    }, { log: silentLog() });
    const out = await ps.refresh('demo');
    assert.equal(out.ok, true);
    assert.equal(out.records.length, 2);
    // The record ref is basename only — no directory path leaks.
    assert.equal(out.records[0].source.ref, 'todo.md');
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes(root), 'full local_root path must not appear in output');
  });
});

test('oversized markdown file is refused by size cap', async () => {
  await withTmp(async (root) => {
    writeFileSync(join(root, 'big.md'), '- [ ] x\n'.repeat(1000));
    const ps = createProjectSources({
      project_sources: {
        enabled: true,
        local_root: root,
        max_file_bytes: 16,
        sources: [{ project: 'demo', type: 'markdown', path: 'big.md' }],
      },
    }, { log: silentLog() });
    const out = await ps.refresh('demo');
    assert.equal(out.sources[0].ok, false);
    assert.equal(out.sources[0].reason, 'file_too_large');
  });
});

// ── GitHub fetch hardening ──────────────────────────────────────────

function ghCfg(extra = {}) {
  return {
    project_sources: {
      enabled: true,
      allow_github: ['octo/demo'],
      sources: [{ project: 'demo', type: 'github_issues', repo: 'octo/demo' }],
      ...extra,
    },
  };
}

test('non-allowlisted repo is refused before any fetch', async () => {
  let called = false;
  const ps = createProjectSources(
    { project_sources: { enabled: true, allow_github: [], sources: [{ project: 'demo', type: 'github_issues', repo: 'octo/demo' }] } },
    { log: silentLog(), fetchImpl: async () => { called = true; return res(200, []); } },
  );
  const out = await ps.refresh('demo');
  assert.equal(called, false);
  assert.equal(out.sources[0].reason, 'repo_not_allowlisted');
});

test('GitHub fetch pins the api.github.com origin (SSRF guard)', () => {
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl: async () => res(200, []) });
  // A non-absolute (full-URL) path is refused outright; a relative path that
  // would resolve off-origin is refused by the origin pin. Either way, no
  // off-origin request can be constructed.
  assert.throws(() => ps._ghPin('https://evil.example/repos/octo/demo/issues'), /path|SSRF|off-origin/);
  assert.throws(() => ps._ghPin('//evil.example/x'), /SSRF|off-origin|path/);
  assert.doesNotThrow(() => ps._ghPin('/repos/octo/demo/issues'));
});

test('a single successful page normalizes issues and excludes PRs', async () => {
  const page = [
    { number: 1, title: 'issue one', state: 'open', html_url: 'https://example.com/1' },
    { number: 2, title: 'a pr', state: 'open', pull_request: {}, html_url: 'https://example.com/2' },
  ];
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl: async () => res(200, page) });
  const out = await ps.refresh('demo');
  assert.equal(out.ok, true);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].title, 'issue one');
});

test('redirect refusal surfaces as a network failure, snapshot retained', async () => {
  const fetchImpl = async () => { const e = new Error('redirect'); throw e; };
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl });
  const out = await ps.refresh('demo');
  assert.equal(out.sources[0].ok, false);
  assert.equal(out.records.length, 0);
});

test('rate limiting is detected via x-ratelimit-remaining=0', async () => {
  const fetchImpl = async () => res(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' });
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl });
  const out = await ps.refresh('demo');
  assert.equal(out.sources[0].reason, 'rate_limited');
});

test('pagination stops at maxPages', async () => {
  let pages = 0;
  // Always return a full page (100) so the loop only stops on the page bound.
  const full = Array.from({ length: 100 }, (_, i) => ({ number: pages * 100 + i + 1, title: 't', state: 'open' }));
  const fetchImpl = async () => { pages += 1; return res(200, full); };
  const ps = createProjectSources(ghCfg({ max_pages: 2, max_issues: 100000 }), { log: silentLog(), fetchImpl });
  await ps.refresh('demo');
  assert.equal(pages, 2);
});

test('issue count is capped at maxIssues', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `unique title ${i}`, state: 'open' }));
  const ps = createProjectSources(ghCfg({ max_issues: 25, max_pages: 5 }), { log: silentLog(), fetchImpl: async () => res(200, full) });
  const out = await ps.refresh('demo');
  assert.equal(out.records.length, 25);
});

test('response larger than max_response_bytes is refused', async () => {
  const big = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 'x'.repeat(500), state: 'open' }));
  const ps = createProjectSources(ghCfg({ max_response_bytes: 64 }), { log: silentLog(), fetchImpl: async () => res(200, big) });
  const out = await ps.refresh('demo');
  assert.equal(out.sources[0].ok, false);
  assert.equal(out.sources[0].reason, 'response_too_large');
});

test('timeout (AbortError) is reported as timeout', async () => {
  const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl });
  const out = await ps.refresh('demo');
  assert.equal(out.sources[0].reason, 'timeout');
});

// ── refresh() dedup + snapshot retention ────────────────────────────

test('repeated refresh is idempotent — same fingerprints, no duplicate records', async () => {
  const page = [{ number: 1, title: 'stable', state: 'open' }];
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl: async () => res(200, page) });
  const first = await ps.refresh('demo');
  const second = await ps.refresh('demo');
  assert.equal(first.records.length, 1);
  assert.equal(second.records.length, 1);
  assert.equal(first.records[0].fingerprint, second.records[0].fingerprint);
});

test('a good snapshot is retained (stale) when a later refresh fully fails', async () => {
  let mode = 'ok';
  const fetchImpl = async () => (mode === 'ok'
    ? res(200, [{ number: 1, title: 'kept', state: 'open' }])
    : (() => { throw new Error('down'); })());
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl });
  const good = await ps.refresh('demo');
  assert.equal(good.records.length, 1);
  mode = 'down';
  const stale = await ps.refresh('demo');
  assert.equal(stale.stale, true);
  assert.equal(stale.records.length, 1, 'prior snapshot retained on outage');
  assert.equal(stale.records[0].title, 'kept');
});

test('disabled project_sources refuses refresh without I/O', async () => {
  const ps = createProjectSources({ project_sources: { enabled: false } }, { log: silentLog() });
  const out = await ps.refresh('demo');
  assert.equal(out.ok, false);
  assert.equal(out.enabled, false);
});

test('list() exposes configured sources + snapshot, never proofs or secrets', async () => {
  const ps = createProjectSources(ghCfg(), { log: silentLog(), fetchImpl: async () => res(200, [{ number: 1, title: 't', state: 'open' }]) });
  await ps.refresh('demo');
  const l = ps.list('demo');
  assert.equal(l.enabled, true);
  assert.equal(l.configured[0].type, 'github_issues');
  assert.equal(l.snapshot.records.length, 1);
});
