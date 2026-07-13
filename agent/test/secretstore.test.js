/**
 * secretstore.mjs — encrypted-at-rest store for operator secrets the agent
 * must USE (NWC URI, Routstr sk- key).
 *
 * Verifies: put/get round-trip; tamper + wrong-key fail CLOSED (GCM tag); the
 * info-string domain separation (a blob for "nwc" cannot be read as
 * "routstr_key"); rotating session_secret makes secrets undecryptable; file is
 * 0600; names are path-traversal safe; the audit fingerprint never leaks the
 * plaintext and is stable.
 *
 * All fixtures are dummy values. No real secret is ever written or logged.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretStore, fingerprint } from '../lib/secretstore.mjs';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'torii-ss-'));
}
function store(dir, sessionSecret = SECRET) {
  return createSecretStore({ session_secret: sessionSecret }, { dir });
}

test('put then get round-trips the plaintext', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    const pt = 'nostr+walletconnect://deadbeef?relay=wss://x&secret=cafe';
    await s.put('nwc', pt);
    assert.equal(await s.get('nwc'), pt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get returns null for an absent secret', async () => {
  const dir = tmpDir();
  try {
    assert.equal(await store(dir).get('nwc'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ciphertext file is 0600 and contains no plaintext', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    const pt = 'super-secret-plaintext-value';
    await s.put('nwc', pt);
    const file = join(dir, 'nwc.enc');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(pt), 'plaintext must not appear in the envelope');
    const env = JSON.parse(raw);
    assert.equal(env.v, 1);
    assert.equal(env.alg, 'A256GCM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a flipped ciphertext byte fails closed (GCM tag)', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    await s.put('nwc', 'value');
    const file = join(dir, 'nwc.enc');
    const env = JSON.parse(readFileSync(file, 'utf8'));
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] ^= 0xff;
    env.ct = ct.toString('base64');
    writeFileSync(file, JSON.stringify(env));
    await assert.rejects(() => s.get('nwc'), /decrypt failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotating session_secret makes the secret undecryptable', async () => {
  const dir = tmpDir();
  try {
    await store(dir, SECRET).put('nwc', 'value');
    await assert.rejects(() => store(dir, OTHER_SECRET).get('nwc'), /decrypt failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('domain separation: a blob stored as "nwc" cannot be read as "routstr_key"', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    await s.put('nwc', 'value');
    // Copy the nwc envelope onto routstr_key's filename — different info string
    // means a different derived key, so the GCM tag check must reject it.
    const raw = readFileSync(join(dir, 'nwc.enc'), 'utf8');
    writeFileSync(join(dir, 'routstr_key.enc'), raw);
    await assert.rejects(() => s.get('routstr_key'), /decrypt failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('has/remove/list behave', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    assert.equal(await s.has('nwc'), false);
    await s.put('nwc', 'v');
    assert.equal(await s.has('nwc'), true);
    assert.deepEqual((await s.list()).sort(), ['nwc']);
    assert.deepEqual(await s.remove('nwc'), { ok: true, removed: true });
    assert.deepEqual(await s.remove('nwc'), { ok: true, removed: false });
    assert.equal(await s.has('nwc'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bad secret names are rejected (path-traversal safe)', async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    for (const bad of ['../evil', 'a/b', 'UPPER', '9leading', '', 'has space']) {
      await assert.rejects(() => s.get(bad), /bad secret name/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('put rejects an empty plaintext', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(() => store(dir).put('nwc', ''), /non-empty string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('constructing without a >=64-char session_secret throws', () => {
  assert.throws(() => createSecretStore({ session_secret: 'short' }, { dir: '/tmp' }), /session_secret required/);
});

test('fingerprint is stable, short, and not the plaintext', () => {
  const fp = fingerprint('some-secret');
  assert.equal(fp, fingerprint('some-secret'));
  assert.equal(fp.length, 12);
  assert.notEqual(fp, fingerprint('some-secret2'));
  assert.ok(!'some-secret'.includes(fp));
});
