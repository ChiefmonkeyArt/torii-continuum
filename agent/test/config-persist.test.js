/**
 * persistAdminNpub() — the disk side of the first-touch claim.
 *
 * Exercises the real file rewrite in an isolated temp tree: the admin_npub
 * line is replaced (or inserted), all other lines are preserved, the result
 * still parses as YAML, mode is 0600, and malformed npubs are refused.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { persistAdminNpub } from '../core/config.mjs';

const VALID_NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

function tmpConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'torii-cfg-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, contents, { mode: 0o600 });
  return { dir, path };
}

test('replaces an existing empty admin_npub, preserves everything else', () => {
  const { dir, path } = tmpConfig(
    [
      '# comment above',
      'admin_npub: ""',
      'session_secret: "' + 'a'.repeat(64) + '"',
      'server:',
      '  host: "127.0.0.1"',
      '  port: 8787',
    ].join('\n') + '\n',
  );
  try {
    persistAdminNpub(path, VALID_NPUB);
    const raw = readFileSync(path, 'utf8');
    const parsed = parse(raw);
    assert.equal(parsed.admin_npub, VALID_NPUB, 'npub written');
    assert.equal(parsed.session_secret.length, 64, 'secret untouched');
    assert.equal(parsed.server.port, 8787, 'server block untouched');
    assert.match(raw, /# comment above/, 'comments preserved');
    // mode preserved at 0600
    assert.equal(statSync(path).mode & 0o777, 0o600, 'still 0600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replaces a previously-set admin_npub (re-claim safety net)', () => {
  const { dir, path } = tmpConfig('admin_npub: "npub1old"\nsession_ttl_sec: 86400\n');
  try {
    persistAdminNpub(path, VALID_NPUB);
    const parsed = parse(readFileSync(path, 'utf8'));
    assert.equal(parsed.admin_npub, VALID_NPUB);
    assert.equal(parsed.session_ttl_sec, 86400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inserts admin_npub when absent', () => {
  const { dir, path } = tmpConfig('session_ttl_sec: 86400\n');
  try {
    persistAdminNpub(path, VALID_NPUB);
    const parsed = parse(readFileSync(path, 'utf8'));
    assert.equal(parsed.admin_npub, VALID_NPUB);
    assert.equal(parsed.session_ttl_sec, 86400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a malformed npub (injection guard)', () => {
  const { dir, path } = tmpConfig('admin_npub: ""\n');
  try {
    assert.throws(() => persistAdminNpub(path, 'not-an-npub'), /malformed npub/);
    assert.throws(() => persistAdminNpub(path, 'npub1"\nmalicious: true'), /malformed npub/);
    // File is unchanged.
    assert.equal(parse(readFileSync(path, 'utf8')).admin_npub, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
