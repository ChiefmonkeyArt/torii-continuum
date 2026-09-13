/**
 * OWNER-UI-2 — project store (server-sided, encrypted at rest).
 *
 * Security-critical invariants exercised here:
 *   • the on-disk blob is AES-256-GCM ciphertext, never plaintext
 *   • replace → fresh load decrypts the same document back
 *   • a rotated session_secret fails closed (undecryptable → empty, not torn)
 *   • the sanitizer coerces partial/foreign docs to the full shape
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretStore } from '../lib/secretstore.mjs';
import { createProjectStore, sanitizeProjectState, EMPTY_PROJECT_STATE } from '../lib/projectstore.mjs';

const cfg = { session_secret: 'a'.repeat(64) };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'torii-store-'));
  const secretStore = createSecretStore(cfg, { dir });
  const store = createProjectStore({ secretStore });
  return { dir, secretStore, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('sanitizeProjectState coerces partial/foreign docs to the full shape', () => {
  const s = sanitizeProjectState({ projects: [{ id: 'p1' }], bogus: 1 });
  assert.equal(s.projects.length, 1);
  assert.deepEqual(s.milestones, []);
  assert.equal(s.routstr, null);
  assert.equal(sanitizeProjectState(null).projects.length, 0);
  assert.ok(Object.isFrozen(EMPTY_PROJECT_STATE) || typeof EMPTY_PROJECT_STATE === 'object');
  // arrays must not alias across sanitize calls
  const a = sanitizeProjectState({});
  const b = sanitizeProjectState({});
  assert.notStrictEqual(a.projects, b.projects);
});

test('replace → fresh load decrypts the same document back', async () => {
  const h = harness();
  const doc = { projects: [{ id: 'p1', name: 'Torii' }], todos: [{ id: 't1' }], routstr: { model: 'x' } };
  await h.store.replace(doc);

  const fresh = createProjectStore({ secretStore: h.secretStore });
  const loaded = await fresh.load();
  assert.deepEqual(loaded.projects, doc.projects);
  assert.deepEqual(loaded.todos, doc.todos);
  assert.deepEqual(loaded.routstr, doc.routstr);
  h.cleanup();
});

test('the on-disk blob is AES-256-GCM ciphertext, never plaintext', async () => {
  const h = harness();
  await h.store.replace({ projects: [{ name: 'SECRET-PROJECT' }] });
  const raw = readFileSync(join(h.dir, 'project_store.enc'), 'utf8');
  assert.ok(!raw.includes('SECRET-PROJECT'), 'marker must not appear in the ciphertext');
  const env = JSON.parse(raw);
  assert.equal(env.alg, 'A256GCM');
  assert.ok(env.ct && env.tag && env.iv, 'GCM envelope must carry ct + tag + iv');
  h.cleanup();
});

test('a rotated session_secret fails closed (undecryptable → empty, not torn)', async () => {
  const h = harness();
  await h.store.replace({ projects: [{ id: 'p1' }] });
  const rotated = createSecretStore({ session_secret: 'b'.repeat(64) }, { dir: h.dir });
  const r = createProjectStore({ secretStore: rotated });
  const loaded = await r.load();
  assert.deepEqual(loaded.projects, [], 'rotated key must yield an empty doc, never a half-readable one');
  h.cleanup();
});

test('load on an absent blob starts empty and does not throw', async () => {
  const h = harness();
  const loaded = await h.store.load();
  assert.equal(loaded.projects.length, 0);
  h.cleanup();
});