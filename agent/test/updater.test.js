/**
 * updater.mjs — admin update-request spooler (VERSION-UPDATE-1).
 *
 * Covers the authorization matrix (pure) and the spool lifecycle against a
 * real temp dir:
 *   • isValidUpdateTag grammar (v REQUIRED)
 *   • authorizeUpdate: invalid_tag / already_current / not_newer / not_allowed
 *     / allowlisted / latest-known ok
 *   • request → status → cancel round trip; atomic write; 0600 perms
 *   • concurrency lock: second request rejected 'pending'
 *   • corrupt spool surfaced, cancel clears it
 *   • unauthorized request never writes a spool file
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isValidUpdateTag,
  authorizeUpdate,
  createUpdater,
} from '../core/updater.mjs';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'updater-'));
  return { dir: d, path: join(d, 'update-request.json'), cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

// ── isValidUpdateTag ─────────────────────────────────────────────────

test('isValidUpdateTag requires v-prefix', () => {
  assert.equal(isValidUpdateTag('v0.2.70-alpha'), true);
  assert.equal(isValidUpdateTag('0.2.70-alpha'), false); // bare not allowed here
  assert.equal(isValidUpdateTag('v1.0.0'), true);
  assert.equal(isValidUpdateTag('nope'), false);
  assert.equal(isValidUpdateTag(null), false);
});

// ── authorizeUpdate matrix ───────────────────────────────────────────

test('authorizeUpdate: invalid_tag', () => {
  const r = authorizeUpdate({ tag: 'garbage', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_tag');
});

test('authorizeUpdate: already_current', () => {
  const r = authorizeUpdate({ tag: 'v0.2.69-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'already_current');
});

test('authorizeUpdate: not_newer (downgrade/sidegrade)', () => {
  const r = authorizeUpdate({ tag: 'v0.2.68-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.68-alpha' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_newer');
});

test('authorizeUpdate: not_allowed when neither latest nor allowlisted', () => {
  const r = authorizeUpdate({ tag: 'v0.2.99-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_allowed');
});

test('authorizeUpdate: ok when tag is the vetted latest', () => {
  const r = authorizeUpdate({ tag: 'v0.2.70-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
  assert.deepEqual(r, { ok: true });
});

test('authorizeUpdate: ok when tag is allowlisted (not latest)', () => {
  const r = authorizeUpdate({
    tag: 'v0.2.99-alpha',
    currentVersion: '0.2.69-alpha',
    latestKnown: 'v0.2.70-alpha',
    allowlist: ['v0.2.99-alpha'],
  });
  assert.deepEqual(r, { ok: true });
});

test('authorizeUpdate: allowlist entries must themselves be valid', () => {
  const r = authorizeUpdate({
    tag: 'garbage',
    currentVersion: '0.2.69-alpha',
    latestKnown: null,
    allowlist: ['garbage'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_tag');
});

// ── spool lifecycle ──────────────────────────────────────────────────

test('request → status → cancel round trip', async () => {
  const { path, cleanup } = tmp();
  try {
    const u = createUpdater({ requestPath: path, now: () => 1700000000000 });

    let s = await u.status();
    assert.equal(s.pending, false);

    const q = await u.request({
      tag: 'v0.2.70-alpha',
      currentVersion: '0.2.69-alpha',
      latestKnown: 'v0.2.70-alpha',
      requestedBy: 'npub1admin',
    });
    assert.equal(q.ok, true);
    assert.equal(q.status, 'queued');
    assert.equal(q.tag, 'v0.2.70-alpha');

    // Spool exists with 0600 perms
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(written.tag, 'v0.2.70-alpha');
    assert.equal(written.from_version, '0.2.69-alpha');
    assert.equal(written.requested_by, 'npub1admin');
    assert.equal(written.schema, 1);
    assert.ok(written.nonce);

    s = await u.status();
    assert.equal(s.pending, true);
    assert.equal(s.tag, 'v0.2.70-alpha');
    assert.equal(s.requested_by, 'npub1admin');

    const c = await u.cancel();
    assert.equal(c.ok, true);
    assert.equal(c.cancelled, true);
    assert.equal(existsSync(path), false);

    // cancel is idempotent
    const c2 = await u.cancel();
    assert.equal(c2.cancelled, false);
  } finally {
    cleanup();
  }
});

test('concurrency lock: second request rejected pending', async () => {
  const { path, cleanup } = tmp();
  try {
    const u = createUpdater({ requestPath: path });
    const first = await u.request({ tag: 'v0.2.70-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
    assert.equal(first.ok, true);

    const second = await u.request({ tag: 'v0.2.70-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'pending');
    assert.equal(second.current, 'v0.2.70-alpha');
  } finally {
    cleanup();
  }
});

test('unauthorized request writes nothing', async () => {
  const { path, cleanup } = tmp();
  try {
    const u = createUpdater({ requestPath: path });
    const r = await u.request({ tag: 'garbage', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_tag');
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test('allowlist passed to createUpdater is honored', async () => {
  const { path, cleanup } = tmp();
  try {
    const u = createUpdater({ requestPath: path, allowlist: ['v0.2.99-alpha'] });
    const r = await u.request({ tag: 'v0.2.99-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
    assert.equal(r.ok, true);
  } finally {
    cleanup();
  }
});

test('corrupt spool surfaced and cancellable', async () => {
  const { path, cleanup } = tmp();
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf8');
    const u = createUpdater({ requestPath: path });

    const s = await u.status();
    assert.equal(s.pending, true);
    assert.equal(s.corrupt, true);

    // corrupt counts as pending → new request blocked
    const r = await u.request({ tag: 'v0.2.70-alpha', currentVersion: '0.2.69-alpha', latestKnown: 'v0.2.70-alpha' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'pending');

    await u.cancel();
    assert.equal((await u.status()).pending, false);
  } finally {
    cleanup();
  }
});
