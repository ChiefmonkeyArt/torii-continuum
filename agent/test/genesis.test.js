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
 *   • acknowledgeConstitution migrates an already-activated bot WITHOUT ever
 *     rewriting the version it was born under, and fails closed on every
 *     uncertainty (bad owner, no manifest, unknown/stale version, wrong digest)
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
import {
  getConstitution,
  getConstitutionByVersion,
  getSafetyFloor,
} from '../lib/constitution.mjs';

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

// ---------------------------------------------------------------------------
// Constitution migration for already-activated bots (GENESIS-1 / CONST-1.2.0)
// ---------------------------------------------------------------------------

const OLD = 'genesis-1.1.0';

/**
 * Rewrite an existing manifest so it looks like a bot BORN under an earlier
 * covenant — which is the only state in which an upgrade is on offer. The
 * manifest digest is recomputed so the bot is genuinely old, not tampered.
 */
function ageManifestTo(genesis, ownerHex, version) {
  const path = genesis._manifestPath(ownerHex);
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const old = getConstitutionByVersion(version);
  m.constitution.version = old.version;
  m.constitution.digest = old.digest;
  delete m.manifest_digest;
  m.manifest_digest = manifestDigest(m);
  writeFileSync(path, JSON.stringify(m, null, 2));
  return m;
}

test('read offers an upgrade to a bot born under an older covenant', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, OLD);

    const r = await genesis.read(NPUB_A);
    // An older-but-valid version is honest provenance, not drift.
    assert.equal(r.constitution_ok, true);
    assert.equal(r.manifest_digest_ok, true);
    assert.equal(r.constitution_is_current, false);

    const up = r.constitution_upgrade;
    const con = getConstitution();
    assert.equal(up.pinned_version, OLD);
    assert.equal(up.active_version, OLD);
    assert.equal(up.current_version, con.version);
    assert.equal(up.current_digest, con.digest);
    assert.equal(up.is_current, false);
    assert.equal(up.upgrade_available, true);
    assert.equal(up.acknowledgement_required, true);
    // The floor binds regardless of which version it was born under.
    assert.ok(up.safety_floor_rule_ids.includes('no-credential-custody'));
    // Pareto changes prioritisation, so it waits for consent rather than
    // binding silently.
    assert.ok(up.newly_binding_rule_ids.includes('pareto-focus'));
    assert.ok(!up.safety_floor_rule_ids.includes('pareto-focus'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acknowledge adopts the current covenant WITHOUT rewriting the birth pin', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    const born = ageManifestTo(genesis, PK_A, OLD);
    const con = getConstitution();

    const r = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: con.version, toDigest: con.digest,
    });
    assert.equal(r.ok, true);
    assert.equal(r.acknowledged, true);

    const m = r.manifest;
    // The birth certificate is untouched — that is what makes this a migration
    // and not a forgery.
    assert.equal(m.constitution.version, OLD);
    assert.equal(m.constitution.digest, born.constitution.digest);
    // Adoption is recorded ALONGSIDE it.
    assert.equal(m.constitution.acknowledged_version, con.version);
    assert.equal(m.constitution.acknowledged_digest, con.digest);
    assert.equal(typeof m.constitution.acknowledged_at, 'number');
    // Append-only history with the transition it represents.
    assert.equal(m.constitution_acknowledgements.length, 1);
    assert.equal(m.constitution_acknowledgements[0].from_version, OLD);
    assert.equal(m.constitution_acknowledgements[0].to_version, con.version);
    assert.equal(m.constitution_acknowledgements[0].to_digest, con.digest);
    // Digest recomputed, so the manifest still self-verifies on disk.
    assert.equal(manifestDigest(m), m.manifest_digest);

    const after = await genesis.read(NPUB_A);
    assert.equal(after.manifest_digest_ok, true);
    assert.equal(after.constitution_upgrade.active_version, con.version);
    assert.equal(after.constitution_upgrade.is_current, true);
    assert.equal(after.constitution_upgrade.upgrade_available, false);
    assert.deepEqual(after.constitution_upgrade.newly_binding_rule_ids, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acknowledge is idempotent — a repeat click changes nothing', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, OLD);
    const con = getConstitution();
    const args = { ownerNpub: NPUB_A, toVersion: con.version, toDigest: con.digest };

    const first = await genesis.acknowledgeConstitution(args);
    assert.equal(first.acknowledged, true);
    const second = await genesis.acknowledgeConstitution(args);
    assert.equal(second.ok, true);
    assert.equal(second.acknowledged, false);
    // History does not grow on a no-op.
    assert.equal(second.manifest.constitution_acknowledgements.length, 1);
    assert.equal(
      second.manifest.constitution.acknowledged_at,
      first.manifest.constitution.acknowledged_at,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acknowledge fails closed on every uncertainty', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    const con = getConstitution();

    // No manifest yet — nothing to migrate.
    const none = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: con.version, toDigest: con.digest,
    });
    assert.equal(none.ok, false);
    assert.equal(none.code, 'no_manifest');

    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, OLD);
    const path = genesis._manifestPath(PK_A);
    const before = readFileSync(path, 'utf8');

    const bad = await genesis.acknowledgeConstitution({
      ownerNpub: 'nope', toVersion: con.version, toDigest: con.digest,
    });
    assert.equal(bad.code, 'bad_owner');

    const unknown = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: 'genesis-9.9.9', toDigest: con.digest,
    });
    assert.equal(unknown.code, 'unknown_version');

    // A real, known, but superseded version cannot be adopted.
    const stale = getConstitutionByVersion(OLD);
    const notCurrent = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: stale.version, toDigest: stale.digest,
    });
    assert.equal(notCurrent.code, 'not_current');

    // The digest shown to the owner must be the digest of the bytes we hold —
    // otherwise they consented to text they never read.
    const mismatch = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: con.version, toDigest: 'f'.repeat(64),
    });
    assert.equal(mismatch.code, 'digest_mismatch');

    // Not one of those wrote a byte.
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acknowledge is default-deny across owners', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, OLD);
    const con = getConstitution();

    // B has no manifest of their own and cannot reach into A's namespace.
    const r = await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_B, toVersion: con.version, toDigest: con.digest,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no_manifest');

    const a = await genesis.read(NPUB_A);
    assert.equal(a.manifest.constitution.acknowledged_version, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acknowledge appends a verifiable audit line naming both versions', async () => {
  const root = tmpRoot();
  try {
    const { genesis, audit } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, OLD);
    const con = getConstitution();
    await genesis.acknowledgeConstitution({
      ownerNpub: NPUB_A, toVersion: con.version, toDigest: con.digest,
    });

    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);

    const lines = readFileSync(join(root, 'memory', 'audit.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const ack = lines.find((l) => l.event === 'genesis.constitution.acknowledge');
    assert.ok(ack, 'acknowledge is auditable');
    assert.equal(ack.born_version, OLD);
    assert.equal(ack.acknowledged_version, con.version);
    assert.equal(ack.acknowledged_digest, con.digest);
    // No key material ever reaches the log — only a short public prefix.
    assert.equal(ack.owner_pubkey_prefix, PK_A.slice(0, 12));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the safety floor binds an un-acknowledged bot regardless of birth version', async () => {
  const root = tmpRoot();
  try {
    const { genesis } = harness(root);
    await genesis.create({ ownerNpub: NPUB_A, displayName: 'Aria' });
    ageManifestTo(genesis, PK_A, 'genesis-1.0.0');

    const up = (await genesis.read(NPUB_A)).constitution_upgrade;
    const floorIds = getSafetyFloor().map((r) => r.id);
    assert.ok(floorIds.includes('no-credential-custody'));
    assert.deepEqual(up.safety_floor_rule_ids, floorIds);
    // A floor rule can only ever produce a refusal, so it is never listed as
    // "would newly bind" — it already does.
    for (const id of floorIds) assert.ok(!up.newly_binding_rule_ids.includes(id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
