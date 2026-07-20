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
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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

// ── consent (ciphertext-only from proposal creation onward) ─────────────────

// Simulate the browser's NIP-44 seal: produce an OPAQUE ciphertext that does
// not encode the plaintext, plus the canonical-plaintext hash the browser would
// compute. The agent never sees plaintext — it only ever receives these two.
function seal(consent, payload) {
  return { ciphertext: randomBytes(80).toString('base64'), payloadSha256: consent.payloadHash(payload) };
}

test('consent: propose REFUSES plaintext payload (ciphertext-only)', async () => {
  const h = harness();
  const bad = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', payload: { text: 'secret' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'plaintext_refused');
  // Missing ciphertext is also refused.
  const noCt = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', payloadSha256: 'a'.repeat(64) });
  assert.equal(noCt.ok, false);
  assert.equal(noCt.code, 'ciphertext');
  h.cleanup();
});

test('consent: propose stores ONLY ciphertext + hash; publicView exposes no payload', async () => {
  const h = harness();
  const payload = { text: 'owner prefers dark mode' };
  const { ciphertext, payloadSha256 } = seal(h.consent, payload);
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'ui-pref', ciphertext, payloadSha256 });
  assert.equal(p.ok, true);
  assert.equal('payload' in p.proposal, false);
  assert.equal(p.proposal.ciphertext, ciphertext);
  assert.equal(p.proposal.payload_sha256, payloadSha256);
  // The on-disk proposal file must also carry no plaintext payload field.
  const ownerHex = PK_A;
  const dir = join(h.memoryRoot, 'owners', ownerHex, 'bots', BOT, 'pending');
  const files = await readdir(dir);
  const raw = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  assert.equal('payload' in raw, false);
  assert.equal('evidence' in raw, false);
  assert.equal(raw.ciphertext, ciphertext);
  h.cleanup();
});

test('consent: approval binds to the reviewed hash + nonce; promotes the sealed ciphertext', async () => {
  const h = harness();
  const payload = { text: 'owner prefers dark mode' };
  const { ciphertext, payloadSha256 } = seal(h.consent, payload);
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'ui-pref', ciphertext, payloadSha256 });
  const before = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(before.count, 0);

  // Wrong reviewed hash → fail closed.
  const badHash = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: 'deadbeef', approvalNonce: p.proposal.approval_nonce });
  assert.equal(badHash.ok, false);
  assert.equal(badHash.code, 'hash_mismatch');

  // Correct hash + nonce → the already-sealed ciphertext is promoted (no re-send).
  const ok = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: p.proposal.approval_nonce });
  assert.equal(ok.ok, true);
  const after = await h.memstore.read({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', id: ok.stored.id });
  assert.equal(after.ok, true);
  assert.equal(after.ciphertext, ciphertext); // exact sealed blob promoted

  // Pending ciphertext dropped after promotion.
  const pv = await h.consent.get({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id });
  assert.equal(pv.proposal.ciphertext, undefined);

  // Idempotent replay — no second store.
  const again = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: p.proposal.payload_sha256, approvalNonce: p.proposal.approval_nonce });
  assert.equal(again.idempotent, true);
  h.cleanup();
});

test('consent: reject securely UNLINKS the pending ciphertext file and never stores', async () => {
  const h = harness();
  const { ciphertext, payloadSha256 } = seal(h.consent, { a: 1 });
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', ciphertext, payloadSha256 });
  const dir = join(h.memoryRoot, 'owners', PK_A, 'bots', BOT, 'pending');
  assert.equal((await readdir(dir)).length, 1);
  const r = await h.consent.reject({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, approvalNonce: p.proposal.approval_nonce });
  assert.equal(r.ok, true);
  assert.equal((await readdir(dir)).length, 0); // file gone, no rejected shell left
  const stored = await h.memstore.list({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p' });
  assert.equal(stored.count, 0);
  h.cleanup();
});

test('consent: approve fails closed if the pending ciphertext is corrupt/missing', async () => {
  const h = harness();
  const { ciphertext, payloadSha256 } = seal(h.consent, { a: 1 });
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', ciphertext, payloadSha256 });
  // Corrupt the ciphertext on disk.
  const dir = join(h.memoryRoot, 'owners', PK_A, 'bots', BOT, 'pending');
  const files = await readdir(dir);
  const full = join(dir, files[0]);
  const raw = JSON.parse(await readFile(full, 'utf8'));
  delete raw.ciphertext;
  await writeFile(full, JSON.stringify(raw), 'utf8');
  const r = await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p.proposal.id, expectPayloadSha256: payloadSha256, approvalNonce: p.proposal.approval_nonce });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'corrupt');
  h.cleanup();
});

test('consent: proposals survive a restart (new instance over same root)', async () => {
  const h = harness();
  const { ciphertext, payloadSha256 } = seal(h.consent, { a: 1 });
  const p = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k', ciphertext, payloadSha256 });
  // Simulate a daemon restart: brand-new consent/memstore over the same disk.
  const memstore2 = createMemStore({ memoryRoot: h.memoryRoot, now: () => 1_700_000_000 });
  const consent2 = createConsent({ memoryRoot: h.memoryRoot, memstore: memstore2, audit: h.audit, now: () => 1_700_000_000 });
  const pending = await consent2.listPending({ ownerNpub: NPUB_A, botId: BOT });
  assert.equal(pending.count, 1);
  assert.equal(pending.proposals[0].id, p.proposal.id);
  h.cleanup();
});

test('consent: migration purges legacy v0.2.82 plaintext proposals without exposing them', async () => {
  const h = harness();
  // Hand-write a retired v1 proposal that carries plaintext (the old bug).
  const dir = join(h.memoryRoot, 'owners', PK_A, 'bots', BOT, 'pending');
  await mkdir(dir, { recursive: true });
  const legacyId = 'a'.repeat(32);
  const legacy = {
    schema: 'torii.continuum.memory_proposal/1', id: legacyId, status: 'pending',
    owner_hex: PK_A, bot_id: BOT, project: 'p', kind: 30094, class: 'semantic', d_tag: 'k',
    payload: { text: 'LEAKED_PLAINTEXT_MARKER' }, payload_sha256: 'b'.repeat(64),
    evidence: ['LEAKED_PLAINTEXT_MARKER'], approval_nonce: 'c'.repeat(32), proposed_at: 1, decided_at: null,
  };
  await writeFile(join(dir, `${legacyId}.json`), JSON.stringify(legacy), 'utf8');
  // A legacy proposal must NEVER be surfaced through the API.
  assert.equal((await h.consent.listPending({ ownerNpub: NPUB_A, botId: BOT })).count, 0);
  assert.equal((await h.consent.get({ ownerNpub: NPUB_A, botId: BOT, id: legacyId })).ok, false);
  // Migration purges it and records a metadata-only audit entry.
  const res = await h.consent.migratePlaintextProposals();
  assert.equal(res.purged, 1);
  assert.equal((await readdir(dir)).length, 0);
  const auditRaw = await readFile(join(h.memoryRoot, 'audit.jsonl'), 'utf8').catch(() => '');
  assert.ok(auditRaw.includes('purge_plaintext_proposal'));
  assert.equal(auditRaw.includes('LEAKED_PLAINTEXT_MARKER'), false); // never logged content
  h.cleanup();
});

// ── PRIVACY INVARIANT: no memory plaintext anywhere under memory/ ───────────

async function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

test('privacy: no memory plaintext marker persists in pending/quarantine/audit/index/enc trees', async () => {
  const MARKER = 'TOP_SECRET_MEMORY_PLAINTEXT_MARKER';
  const h = harness();
  const payload = { text: MARKER, nested: { more: MARKER } };
  const { ciphertext, payloadSha256 } = seal(h.consent, payload);

  // 1) A pending proposal.
  const p1 = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k1', ciphertext, payloadSha256 });
  // 2) An approved (promoted) durable item.
  const p2 = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k2', ...seal(h.consent, payload) });
  await h.consent.approve({ ownerNpub: NPUB_A, botId: BOT, id: p2.proposal.id, expectPayloadSha256: p2.proposal.payload_sha256, approvalNonce: p2.proposal.approval_nonce });
  // 3) A rejected proposal (file unlinked).
  const p3 = await h.consent.propose({ ownerNpub: NPUB_A, botId: BOT, projectSlug: 'p', kind: 30094, dTag: 'k3', ...seal(h.consent, payload) });
  await h.consent.reject({ ownerNpub: NPUB_A, botId: BOT, id: p3.proposal.id, approvalNonce: p3.proposal.approval_nonce });
  // 4) A quarantined import.
  const bundle = signBundle(await seedAndExport(h), SK_A);
  const h2 = harness();
  await h2.portability.importToQuarantine({ ownerNpub: NPUB_A, bundle });

  for (const root of [h.memoryRoot, h2.memoryRoot]) {
    for (const f of await walkFiles(root)) {
      const body = await readFile(f, 'utf8').catch(() => '');
      assert.equal(body.includes(MARKER), false, `plaintext marker leaked into ${f}`);
    }
  }
  // Sanity: the pending proposal is still retrievable as ciphertext only.
  const pv = await h.consent.get({ ownerNpub: NPUB_A, botId: BOT, id: p1.proposal.id });
  assert.equal(pv.proposal.ciphertext, ciphertext);
  assert.equal('payload' in pv.proposal, false);
  h.cleanup(); h2.cleanup();
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
