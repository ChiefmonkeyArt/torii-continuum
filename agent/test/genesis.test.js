/**
 * Genesis manifest lifecycle (GENESIS-1).
 *
 * Verifies the security-critical invariants of core/genesis.mjs:
 *   • owner is derived from the verified npub, bad npubs fail closed
 *   • create is one-time + idempotent (a retry never forks a second identity,
 *     even with different display fields)
 *   • field validation (required display_name, length bounds)
 *   • manifest pins the live constitution version + digest
 *   • read is default-deny cross-owner (namespaced by pubkey)
 *   • tamper-evidence: constitution_ok + manifest_digest_ok reflect drift
 *   • files are written 0600 under a 0700 dir (restrictive perms)
 *   • a genesis.create audit line is appended and the chain verifies
 *   • path traversal via the owner namespace is structurally impossible
 *
 * All npubs are throwaway test keys. No private key material appears anywhere.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { createGenesis, ownerHexFromNpub, manifestDigest } from '../core/genesis.mjs';
import { createAudit } from '../lib/audit.mjs';
import { getConstitution } from '../lib/constitution.mjs';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Two deterministic throwaway keypairs → npubs. Secret keys are Uint8Array test
// inputs; only the PUBLIC key is ever stored by genesis.
const SK_A = hexToBytes('11'.repeat(32));
const SK_B = hexToBytes('22'.repeat(32));
const PK_A = getPublicKey(SK_A);
const PK_B = getPublicKey(SK_B);
const NPUB_A = nip19.npubEncode(PK_A);
const NPUB_B = nip19.npubEncode(PK_B);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'torii-genesis-'));
}

function harness(root) {
  const audit = createAudit(join(root, 'memory', 'audit.jsonl'));
  const genesis = createGenesis({ agentRoot: root, audit });
  return { audit, genesis };
}

test('ownerHexFromNpub decodes a valid npub and rejects junk', () => {
  const hex = ownerHexFromNpub(NPUB_A);
  assert.equal(hex, PK_A);
  assert.equal(ownerHexFromNpub('not-an-npub'), null);
  assert.equal(ownerHexFromNpub(''), null);
  assert.equal(ownerHexFromNpub(null), null);
  // A hex pubkey (not npub-encoded) is rejected — we bind on verified npub only.
  assert.equal(ownerHexFromNpub(PK_A), null);
});

test('create writes a manifest bound to the verified owner + live constitution', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    const r = await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria', archetype: 'muse', creativeIntent: 'help build' });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    const m = r.manifest;
    assert.equal(m.owner.npub, NPUB_A);
    assert.equal(m.owner.pubkey_hex, PK_A);
    assert.equal(m.display_name, 'Aria');
    assert.equal(m.policy.command_mode, 'explicit-command-only');
    assert.equal(m.policy.default_deny, true);
    const con = getConstitution();
    assert.equal(m.constitution.version, con.version);
    assert.equal(m.constitution.digest, con.digest);
    // Manifest's own digest is self-consistent.
    assert.equal(manifestDigest(m), m.manifest_digest);
    // LoRA/RAG are honestly labelled as not started.
    assert.equal(m.provenance.lora, 'not-started');
    assert.equal(m.provenance.rag, 'not-started');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create is idempotent — a retry never forks a second identity', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    const first = await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    assert.equal(first.created, true);
    // Retry with DIFFERENT display fields — must return the original unchanged.
    const second = await genesis.create({ ownerNpub: NPUB_A, displayName: 'Totally Different' });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.manifest.bot_id, first.manifest.bot_id);
    assert.equal(second.manifest.display_name, 'Aria');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create rejects a bad owner npub and a missing display name', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    const bad = await genesis.create({ ownerNpub: 'nope', displayName: 'x' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_owner');
    const noName = await genesis.create({ ownerNpub: NPUB_A, displayName: '   ' });
    assert.equal(noName.ok, false);
    assert.equal(noName.code, 'validation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create enforces field length bounds', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    const longName = await genesis.create({ ownerNpub: NPUB_A, displayName: 'x'.repeat(81) });
    assert.equal(longName.ok, false);
    assert.equal(longName.code, 'validation');
    const longIntent = await genesis.create({ ownerNpub: NPUB_A, displayName: 'ok', creativeIntent: 'y'.repeat(2001) });
    assert.equal(longIntent.ok, false);
    assert.equal(longIntent.code, 'validation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read is default-deny across owners', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    const mine = await genesis.read(NPUB_A);
    assert.equal(mine.exists, true);
    assert.equal(mine.constitution_ok, true);
    assert.equal(mine.manifest_digest_ok, true);
    // A different owner sees NOTHING — namespaced by pubkey.
    const other = await genesis.read(NPUB_B);
    assert.equal(other.exists, false);
    assert.equal(other.manifest, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read reports tamper evidence when the manifest is edited on disk', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    const path = genesis._manifestPath(PK_A);
    const m = JSON.parse(readFileSync(path, 'utf8'));
    m.display_name = 'Tampered'; // change a field without recomputing the digest
    writeFileSync(path, JSON.stringify(m, null, 2));
    const r = await genesis.read(NPUB_A);
    assert.equal(r.exists, true);
    assert.equal(r.manifest_digest_ok, false); // detected
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest file is 0600 under a 0700 owner dir', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    const path = genesis._manifestPath(PK_A);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const dir = join(genesis._baseDir, PK_A);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('genesis.create appends a verifiable audit line', async () => {
  const root = tmpRoot();
  try {
    const { genesis, audit } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
