/**
 * OWNER-UI-1 — sealed session store.
 *
 * Security-critical invariants exercised here:
 *   • owner isolation (traversal/IDOR resistance)
 *   • ciphertext integrity detection (tamper/corruption)
 *   • per-owner session-count quota + NIP-44 byte cap
 *   • deletion actually unlinks the blob + index entry
 *
 * All npubs are throwaway deterministic test keys — no real secret material.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { ownerHexFromNpub } from '../core/genesis.mjs';
import { createSessionStore, MAX_SESSION_BYTES } from '../lib/sessions.mjs';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const SK_A = hexToBytes('33'.repeat(32));
const SK_B = hexToBytes('44'.repeat(32));
const NPUB_A = nip19.npubEncode(getPublicKey(SK_A));
const NPUB_B = nip19.npubEncode(getPublicKey(SK_B));
const HEX_A = ownerHexFromNpub(NPUB_A);

function harness(opts = {}) {
  const memoryRoot = join(mkdtempSync(join(tmpdir(), 'torii-sessions-')), 'memory');
  let t = opts.now || 1_700_000_000;
  const now = () => t++;
  const store = createSessionStore({ memoryRoot, maxSessions: opts.maxSessions, now, log: {} });
  const blobPath = (id) => join(memoryRoot, 'owners', HEX_A, 'sessions', `${id}.enc`);
  return { memoryRoot, store, blobPath, cleanup: () => rmSync(join(memoryRoot, '..'), { recursive: true, force: true }) };
}

test('upsert → list → read round-trips a sealed session', async () => {
  const h = harness();
  const up = await h.store.upsert(NPUB_A, { id: 'sess-1', ciphertext: 'SEALED-1' });
  assert.equal(up.ok, true);

  const list = await h.store.list(NPUB_A);
  assert.equal(list.ok, true);
  assert.equal(list.count, 1);
  assert.equal(list.sessions[0].id, 'sess-1');
  assert.equal(list.sessions[0].bytes, 8);

  const r = await h.store.read(NPUB_A, 'sess-1');
  assert.equal(r.ok, true);
  assert.equal(r.ciphertext, 'SEALED-1');
  h.cleanup();
});

test('upsert with the same id replaces the blob and keeps created_at', async () => {
  const h = harness();
  const a = await h.store.upsert(NPUB_A, { id: 's', ciphertext: 'ONE' });
  const b = await h.store.upsert(NPUB_A, { id: 's', ciphertext: 'TWO-LONGER' });
  assert.equal(b.ok, true);
  assert.equal(b.created_at, a.created_at, 'created_at must be preserved across replacement');
  assert.ok(b.updated_at > a.updated_at);

  const r = await h.store.read(NPUB_A, 's');
  assert.equal(r.ciphertext, 'TWO-LONGER');
  assert.equal((await h.store.list(NPUB_A)).count, 1, 'replacement must not duplicate the index entry');
  h.cleanup();
});

test('list sorts most-recently-updated first', async () => {
  const h = harness();
  await h.store.upsert(NPUB_A, { id: 'a', ciphertext: 'A' });
  await h.store.upsert(NPUB_A, { id: 'b', ciphertext: 'B' });
  const list = await h.store.list(NPUB_A);
  assert.deepEqual(list.sessions.map((s) => s.id), ['b', 'a']);
  h.cleanup();
});

test('remove unlinks the blob and removes the index entry', async () => {
  const h = harness();
  await h.store.upsert(NPUB_A, { id: 's', ciphertext: 'X' });
  assert.equal((await h.store.remove(NPUB_A, 's')).ok, true);

  assert.equal((await h.store.list(NPUB_A)).count, 0);
  assert.equal((await h.store.read(NPUB_A, 's')).ok, false);

  await assert.rejects(() => access(h.blobPath('s')), 'blob file must be unlinked');
  h.cleanup();
});

test('rejects unsafe session ids (traversal / dotfiles)', async () => {
  const h = harness();
  for (const bad of ['../etc', '..', '.hidden', 'a/b', 'UPPER', 'space id', '', null]) {
    const r = await h.store.upsert(NPUB_A, { id: bad, ciphertext: 'X' });
    assert.equal(r.ok, false, `id ${JSON.stringify(bad)} must be rejected`);
  }
  h.cleanup();
});

test('rejects empty and oversized ciphertext', async () => {
  const h = harness();
  assert.equal((await h.store.upsert(NPUB_A, { id: 's', ciphertext: '' })).ok, false);
  assert.equal((await h.store.upsert(NPUB_A, { id: 's', ciphertext: null })).ok, false);
  assert.equal((await h.store.upsert(NPUB_A, { id: 's', ciphertext: 'x'.repeat(MAX_SESSION_BYTES + 1) })).ok, false);
  h.cleanup();
});

test('detects ciphertext tampering on read', async () => {
  const h = harness();
  await h.store.upsert(NPUB_A, { id: 's', ciphertext: 'ORIGINAL' });
  await writeFile(h.blobPath('s'), 'TAMPERED');
  const r = await h.store.read(NPUB_A, 's');
  assert.equal(r.ok, false);
  assert.equal(r.corrupt, true, 'tampered blob must be flagged corrupt');
  h.cleanup();
});

test('enforces the per-owner session quota', async () => {
  const h = harness({ maxSessions: 2 });
  assert.equal((await h.store.upsert(NPUB_A, { id: 's1', ciphertext: '1' })).ok, true);
  assert.equal((await h.store.upsert(NPUB_A, { id: 's2', ciphertext: '2' })).ok, true);
  const over = await h.store.upsert(NPUB_A, { id: 's3', ciphertext: '3' });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'quota');
  assert.equal((await h.store.list(NPUB_A)).count, 2);
  h.cleanup();
});

test('owner isolation: A cannot read or delete B sessions', async () => {
  const h = harness();
  await h.store.upsert(NPUB_A, { id: 'priv', ciphertext: 'SECRET' });
  assert.equal((await h.store.read(NPUB_B, 'priv')).ok, false);
  assert.equal((await h.store.remove(NPUB_B, 'priv')).ok, false);
  assert.equal((await h.store.list(NPUB_A)).count, 1, 'B must not disturb A sessions');
  h.cleanup();
});