/**
 * loadConfig() — project_sources validation + defaults.
 *
 * loadConfig() fails CLOSED (process.exit(1)) on an invariant violation, so the
 * validation branches are exercised in a child process and we assert on exit
 * code + sanitized stderr. The happy path (defaults applied, frozen result) is
 * checked in-process.
 *
 * Fixtures use generic placeholder repos/paths only — no real hostnames.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_MJS = resolve(__dirname, '../core/config.mjs');

const BASE = [
  'admin_npub: ""',
  'session_secret: "' + 'a'.repeat(64) + '"',
  'server:',
  '  host: "127.0.0.1"',
  '  port: 8787',
  'routstr:',
  '  endpoint: "https://api.example.test"',
  '  models:',
  '    chat: "model-a"',
  '    coding: "model-b"',
].join('\n');

function tmpConfig(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'torii-ps-cfg-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, BASE + '\n' + (extra || '') + '\n', { mode: 0o600 });
  return { dir, path };
}

// Run loadConfig(path) in a child process; return { code, stderr }.
function loadInChild(path) {
  const script = `import('${CONFIG_MJS}').then(m => { m.loadConfig(${JSON.stringify(path)}); console.log('OK'); });`;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('disabled project_sources needs no allowlist and boots fine', () => {
  const { dir, path } = tmpConfig('project_sources:\n  enabled: false');
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enabled github source not in allow_github refuses boot (fail-closed)', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  allow_github: []',
    '  sources:',
    '    - project: demo',
    '      type: github_issues',
    '      repo: octo/demo',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /allow_github|fail-closed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('malformed allow_github entry refuses boot', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  allow_github:',
    '    - "not-a-repo"',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /owner\/repo|allow_github/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('markdown source without local_root refuses boot', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  sources:',
    '    - project: demo',
    '      type: markdown',
    '      path: todo.md',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /local_root/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown source type refuses boot', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  local_root: "/tmp/x"',
    '  sources:',
    '    - project: demo',
    '      type: carrier_pigeon',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown type/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L6: relative local_root refuses boot (must be absolute)', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  local_root: "relative/path"',
    '  sources:',
    '    - project: demo',
    '      type: markdown',
    '      path: todo.md',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /absolute/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L6: absolute local_root boots', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  local_root: "/tmp/x"',
    '  sources:',
    '    - project: demo',
    '      type: markdown',
    '      path: todo.md',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('valid enabled config with allowlisted repo boots', () => {
  const extra = [
    'project_sources:',
    '  enabled: true',
    '  local_root: "/tmp/x"',
    '  allow_github:',
    '    - octo/demo',
    '  sources:',
    '    - project: demo',
    '      type: github_issues',
    '      repo: octo/demo',
  ].join('\n');
  const { dir, path } = tmpConfig(extra);
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('defaults are applied and result is frozen (in-process)', () => {
  const { dir, path } = tmpConfig('');
  try {
    const cfg = loadConfig(path);
    assert.equal(Object.isFrozen(cfg), true);
    assert.equal(cfg.project_sources.enabled, false);
    assert.equal(cfg.project_sources.max_issues, 200);
    assert.equal(cfg.project_sources.github_api, 'https://api.github.com');
    assert.equal(cfg.rate_limit.project_sources_refresh_per_min, 12);
    // L8: dead cache_ttl_sec option removed.
    assert.equal('cache_ttl_sec' in cfg.project_sources, false);
    // L4: wallet-health endpoint gets a rate-limit default.
    assert.equal(cfg.rate_limit.wallet_health_per_min, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── audit A20: config normalization + persistence contracts ────────────────

test('A20: a null/empty YAML root reports validation errors, not a TypeError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torii-null-cfg-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, 'null\n', { mode: 0o600 });
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /session_secret must be at least 64 characters/);
    assert.ok(!/TypeError/.test(r.stderr), 'must not surface a null-dereference TypeError');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A20: a config with NO routstr block still loads (routstr is optional)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torii-noroutstr-'));
  const path = join(dir, 'config.yaml');
  // Minimal valid config minus any routstr: block.
  writeFileSync(path, [
    'admin_npub: ""',
    'session_secret: "' + 'a'.repeat(64) + '"',
    'server:',
    '  host: "127.0.0.1"',
    '  port: 8787',
  ].join('\n') + '\n', { mode: 0o600 });
  try {
    const out = loadInChild(path);
    assert.equal(out.code, 0, out.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A20: session_secret validation does not claim hex it never enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torii-sec-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'admin_npub: ""',
    'session_secret: "short"',
    'server:',
    '  host: "127.0.0.1"',
    '  port: 8787',
  ].join('\n') + '\n', { mode: 0o600 });
  try {
    const r = loadInChild(path);
    assert.equal(r.code, 1);
    // No false "hex" claim; the enforced contract is minimum length.
    assert.match(r.stderr, /at least 64 characters/);
    assert.ok(!/hex chars/.test(r.stderr));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
