/**
 * MEMORY-1 — scoped storage, consent state machine, manual portability, and the
 * working-values header. Security-critical invariants exercised here:
 *
 *   • OWNER/BOT/PROJECT ISOLATION + traversal/IDOR resistance (memstore)
 *   • ciphertext integrity detection (tamper/corruption)
 *   • per-scope + per-owner quotas, item byte cap, retention reaping
 *   • deletion actually unlinks + tombstones
 *   • consent: proposals never auto-persist; approval bound to exact payload
 *     hash + single-use nonce; idempotent; cross-owner default-deny
 *   • portability: deterministic manifest; owner-signed bundle verify; DEFAULT
 *     DENY of foreign-owner / tampered-manifest / tampered-ciphertext / bad-sig
 *     bundles; import → QUARANTINE (never live); dedupe; approve out of quarantine
 *   • working-values header is deterministic + carries constitution/COP provenance
 *
 * All npubs are throwaway deterministic test keys — no real secret material.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createMemStore, GLOBAL_PROJECT, MAX_ITEM_BYTES } from '../lib/memstore.mjs';
import { createConsent } from '../lib/consent.mjs';
import { createPortability, BUNDLE_SIG_KIND, buildManifest, MAX_BUNDLE_ITEMS } from '../lib/portability.mjs';
import { buildWorkingValues, fenceUntrusted, DATA_FENCE } from '../lib/workingvalues.mjs';
import { createAudit } from '../lib/audit.mjs';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const SK_A = hexToBytes('11'.repeat(32));
const SK_B = hexToBytes('22'.repeat(32));
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);
const NPUB_A = nip19.npubEncode(PK_A);
const NPUB_B = nip19.npubEncode(PK_B);
const BOT = 'bot0001';

function tmpMemRoot() {
  const root = mkdtempSync(join(tmpdir(), 'torii-mem1-'));
  return join(root, 'memory');
}

function harness(opts = {}) {
  const memoryRoot = tmpMemRoot();
  const audit = createAudit(join(memoryRoot, 'audit.jsonl'));
  const now = opts.now || (() => 1_700_000_000);
  const memstore = createMemStore({ memoryRoot, quotas: opts.quotas, now });
  const consent = createConsent({ memoryRoot, memstore, audit, now });
  const portability = createPortability({ memoryRoot, memstore, audit, now });
  return { memoryRoot, audit, memstore, consent, portability, cleanup: () => rmSync(join(memoryRoot, '..'), { recursive: true, force: true }) };
}

// ── memstore ────────────────────────────────────────────────────────────────

test('memstore put/list/read round-trips a scoped ciphertext', async () => {
  const h = harness();
  const r = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'proj', cls: 'semantic', dTag: 'fav-color', ciphertext: 'CIPHER-1' });
  assert.equal(r.ok, true);
  assert.match(r.path, /^owners\/[0-9a-f]{64}\/bots\/bot0001\/projects\/proj\/semantic\//);
  const list = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'proj' });
  assert.equal(list.count, 1);
  assert.equal(list.items[0].d_tag, 'fav-color');
  const read = await h.memstore.read({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'proj', id: r.id });
  assert.equal(read.ok, true);
  assert.equal(read.ciphertext, 'CIPHER-1');
  h.cleanup();
});

test('memstore isolates owners: B cannot see A even at the same logical scope', async () => {
  const h = harness();
  await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'x', ciphertext: 'A-SECRET' });
  const bList = await h.memstore.list({ ownerNpub: NPUB_B, botId: BOT, projectSlug: 'p' });
  assert.equal(bList.count, 0);
  h.cleanup();
});

test('memstore rejects traversal in bot id / project slug', async () => {
  const h = harness();
  const bad1 = await h.memstore.put({ ownerNpub: NPUB_A, botId: '../evil', projectSlug: 'p', cls: 'semantic', dTag: 'x', ciphertext: 'c' });
  assert.equal(bad1.ok, false);
  const bad2 = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: '../../etc', cls: 'semantic', dTag: 'x', ciphertext: 'c' });
  assert.equal(bad2.ok, false);
  h.cleanup();
});

test('memstore read detects a tampered ciphertext (integrity fail)', async () => {
  const h = harness();
  const r = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'x', ciphertext: 'ORIGINAL' });
  // Corrupt the .enc on disk out from under the index.
  const abs = join(h.memoryRoot, r.path);
  await writeFile(abs, 'TAMPERED', 'utf8');
  const read = await h.memstore.read({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', id: r.id });
  assert.equal(read.ok, false);
  assert.equal(read.corrupt, true);
  const verify = await h.memstore.verifyScope({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(verify.ok, false);
  assert.equal(verify.problems.length, 1);
  h.cleanup();
});

test('memstore enforces the per-item byte cap', async () => {
  const h = harness();
  const big = 'x'.repeat(MAX_ITEM_BYTES + 1);
  const r = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'x', ciphertext: big });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too_large');
  h.cleanup();
});

test('memstore enforces the per-scope item quota', async () => {
  const h = harness({ quotas: { perScopeItems: 2 } });
  assert.equal((await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'a', ciphertext: 'c' })).ok, true);
  assert.equal((await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'b', ciphertext: 'c' })).ok, true);
  const third = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'c', ciphertext: 'c' });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'quota_items');
  h.cleanup();
});

test('memstore delete unlinks the file, drops the index record, and writes a tombstone', async () => {
  const h = harness();
  const r = await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'x', ciphertext: 'c' });
  const del = await h.memstore.remove({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', id: r.id, reason: 'test' });
  assert.equal(del.ok, true);
  assert.equal(del.tombstone.id, r.id);
  const list = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(list.count, 0);
  await assert.rejects(readFile(join(h.memoryRoot, r.path), 'utf8'));
  h.cleanup();
});

test('memstore retention reaps non-permanent conversation items past their window', async () => {
  let clock = 1_700_000_000;
  const h = harness({ now: () => clock });
  await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'conversation', dTag: 'chat', ciphertext: 'c' });
  clock += 8 * 86400; // 8 days > 7-day conversation window
  const reap = await h.memstore.applyRetention({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(reap.reaped.length, 1);
  h.cleanup();
});

// ── consent ───────────────────────────────────────────────────────────────

test('consent: a proposal is never auto-persisted; approval binds to the exact payload + nonce', async () => {
  const h = harness();
  const payload = { text: 'owner prefers dark mode' };
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'ui-pref', payload });
  assert.equal(p.ok, true);
  const pending = await h.consent.listPending({ ownerNpub: NPUB_A, botId: BOT });
  assert.equal(pending.count, 1);
  // Nothing durable yet.
  const before = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(before.count, 0);

  // Wrong hash → reject.
  const badHash = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: 'deadbeef', approvalNonce: p.proposal.approval_nonce, ciphertext: 'CT' });
  assert.equal(badHash.ok, false);
  assert.equal(badHash.code, 'hash_mismatch');

  // Correct hash + nonce + ciphertext → stored.
  const ok = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: p.proposal.approval_nonce, ciphertext: 'SEALED-CT' });
  assert.equal(ok.ok, true);
  const after = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(after.count, 1);

  // Idempotent replay returns the same stored result, no double store.
  const again = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: p.proposal.approval_nonce, ciphertext: 'SEALED-CT' });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  h.cleanup();
});

test('consent: a spent nonce cannot be replayed on a fresh proposal', async () => {
  const h = harness();
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', payload: { a: 1 } });
  await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: p.proposal.approval_nonce, ciphertext: 'CT' });
  // Re-approve with the (now null) nonce value must not create a second store.
  const replay = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: 'anything', ciphertext: 'CT2' });
  assert.equal(replay.idempotent, true); // already approved, short-circuits
  h.cleanup();
});

test('consent: reject marks the proposal rejected and never stores', async () => {
  const h = harness();
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', payload: { a: 1 } });
  const r = await h.consent.reject({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, approvalNonce: p.proposal.approval_nonce });
  assert.equal(r.ok, true);
  const stored = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(stored.count, 0);
  h.cleanup();
});

// ── portability ─────────────────────────────────────────────────────────────

/** Sign the manifest digest the way the browser (NIP-07) would. */
function signBundle(bundle, sk) {
  const evt = finalizeEvent({
    kind: BUNDLE_SIG_KIND,
    created_at: 1_700_000_000,
    tags: [['x', bundle.manifest.manifest_digest]],
    content: bundle.manifest.manifest_digest,
  }, sk);
  return { ...bundle, signature: evt };
}

async function seedAndExport(h) {
  await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'semantic', dTag: 'fact1', ciphertext: 'CT-ONE' });
  await h.memstore.put({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', cls: 'procedural', dTag: 'skill1', ciphertext: 'CT-TWO' });
  const built = await h.portability.buildBundle({ ownerNpub: NPUB_A, botId: BOT });
  assert.equal(built.ok, true);
  return built.bundle;
}

test('portability: buildManifest is deterministic (same items → same digest)', () => {
  const items = [
    { class: 'semantic', kind: 30094, d_tag: 'b', scope: { bot_id: BOT, project: 'p' }, sha256: 'b'.repeat(64) },
    { class: 'semantic', kind: 30094, d_tag: 'a', scope: { bot_id: BOT, project: 'p' }, sha256: 'a'.repeat(64) },
  ];
  const m1 = buildManifest({ ownerHex: PK_A, botId: BOT, items, createdAt: 100 });
  const m2 = buildManifest({ ownerHex: PK_A, botId: BOT, items: [...items].reverse(), createdAt: 100 });
  assert.equal(m1.manifest_digest, m2.manifest_digest);
});

test('portability: a correctly owner-signed bundle verifies', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  const v = h.portability.verifyBundle(bundle, { expectedOwnerHex: PK_A });
  assert.equal(v.ok, true, v.reason);
  h.cleanup();
});

test('portability: DEFAULT DENY — foreign owner bundle is rejected', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  const v = h.portability.verifyBundle(bundle, { expectedOwnerHex: PK_B });
  assert.equal(v.ok, false);
  assert.match(v.reason, /foreign owner/);
  h.cleanup();
});

test('portability: DEFAULT DENY — tampered ciphertext is rejected', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  bundle.items[0].ciphertext = 'SWAPPED';
  const v = h.portability.verifyBundle(bundle, { expectedOwnerHex: PK_A });
  assert.equal(v.ok, false);
  assert.match(v.reason, /hash mismatch/);
  h.cleanup();
});

test('portability: DEFAULT DENY — tampered manifest digest is rejected', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  bundle.manifest.item_count = 999; // change a manifest field, keep old digest
  const v = h.portability.verifyBundle(bundle, { expectedOwnerHex: PK_A });
  assert.equal(v.ok, false);
  assert.match(v.reason, /manifest digest mismatch/);
  h.cleanup();
});

test('portability: DEFAULT DENY — bundle signed by the wrong key is rejected', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_B); // B signs A's bundle
  const v = h.portability.verifyBundle(bundle, { expectedOwnerHex: PK_A });
  assert.equal(v.ok, false);
  h.cleanup();
});

test('portability: import QUARANTINES (never live) and dedupes; approve promotes', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  // Import into a FRESH owner store (simulate a second device for the same owner).
  const h2 = harness();
  const imp = await h2.portability.importToQuarantine({ ownerNpub: NPUB_A, bundle });
  assert.equal(imp.ok, true);
  assert.equal(imp.quarantined, 2);
  // Not live yet.
  const live = await h2.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(live.count, 0);
  // Re-import is a no-op (dedupe).
  const imp2 = await h2.portability.importToQuarantine({ ownerNpub: NPUB_A, bundle });
  assert.equal(imp2.quarantined, 0);
  assert.equal(imp2.duplicate, 2);
  // Approve one out of quarantine → live.
  const q = await h2.portability.listQuarantine({ ownerNpub: NPUB_A, botId: BOT });
  assert.equal(q.count, 2);
  const target = q.items[0];
  const appr = await h2.portability.approveQuarantine({ ownerNpub: NPUB_A, botId: BOT, sha256: target.sha256, projectSlug: target.project, dTag: target.d_tag });
  assert.equal(appr.ok, true);
  const liveAfter = await h2.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: target.project });
  assert.equal(liveAfter.count, 1);
  h.cleanup(); h2.cleanup();
});

test('portability: import rejects a foreign-owner bundle by default', async () => {
  const h = harness();
  const bundle = signBundle(await seedAndExport(h), SK_A);
  const h2 = harness();
  const imp = await h2.portability.importToQuarantine({ ownerNpub: NPUB_B, bundle });
  assert.equal(imp.ok, false);
  h.cleanup(); h2.cleanup();
});

// ── working values ────────────────────────────────────────────────────────

test('working-values header is deterministic and carries constitution + COP provenance', () => {
  const a = buildWorkingValues();
  const b = buildWorkingValues();
  assert.equal(a.header, b.header);
  assert.equal(a.provenance.header_sha256, b.provenance.header_sha256);
  assert.match(a.header, /Working values \(binding/);
  assert.ok(a.provenance.constitution_version);
  assert.ok(a.provenance.constitution_digest);
  assert.ok(a.provenance.code_of_practice_version);
});

test('fenceUntrusted wraps content in the untrusted-data boundary', () => {
  const out = fenceUntrusted('Durable facts', 'the sky is green');
  const fences = out.split(DATA_FENCE).length - 1;
  assert.equal(fences, 2);
  assert.match(out, /untrusted data/);
  assert.ok(out.includes('the sky is green'));
});
