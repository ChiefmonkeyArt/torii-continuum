/**
 * Constitution digest stability + provenance (GENESIS-1).
 *
 * The whole tamper-evidence story rests on the constitution digest being
 * DETERMINISTIC and STABLE across installs and process restarts. This suite
 * locks the published digest so an accidental edit to the covenant text (or a
 * change to the canonicalization) cannot slip through unnoticed — the digest
 * changing is a deliberate versioned act, never a silent one.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConstitution,
  canonicalize,
  digestOf,
  verifyConstitutionDigest,
  CONSTITUTION_VERSION,
} from '../lib/constitution.mjs';

// The published genesis-1.0.0 digest. If this changes, the constitution text or
// its canonicalization changed — bump CONSTITUTION_VERSION deliberately and
// update this lock in the same commit.
const LOCKED_DIGEST = '178ad323601455f92a345b286eef6c9628f2e71ff7f3f8ad856c16a37e775524';

test('constitution digest is stable and matches the published lock', () => {
  const c = getConstitution();
  assert.equal(c.version, 'genesis-1.0.0');
  assert.equal(c.version, CONSTITUTION_VERSION);
  assert.equal(c.digest, LOCKED_DIGEST);
});

test('digest is reproducible across repeated computation', () => {
  const a = getConstitution().digest;
  const b = getConstitution().digest;
  assert.equal(a, b);
  assert.equal(a, digestOf(getConstitution().body));
});

test('canonicalize is key-order independent', () => {
  const x = { b: 1, a: { d: 4, c: 3 }, e: [3, 2, 1] };
  const y = { e: [3, 2, 1], a: { c: 3, d: 4 }, b: 1 };
  assert.equal(canonicalize(x), canonicalize(y));
  // Arrays are ordered data — different order must NOT canonicalize equal.
  assert.notEqual(canonicalize({ e: [1, 2, 3] }), canonicalize({ e: [3, 2, 1] }));
});

test('canonicalize refuses non-finite numbers', () => {
  assert.throws(() => canonicalize({ n: Infinity }));
  assert.throws(() => canonicalize({ n: NaN }));
});

test('verifyConstitutionDigest accepts the live digest + version', () => {
  const c = getConstitution();
  const r = verifyConstitutionDigest(c.digest, c.version);
  assert.equal(r.ok, true);
});

test('verifyConstitutionDigest fails closed on a tampered digest', () => {
  const c = getConstitution();
  const r = verifyConstitutionDigest('0'.repeat(64), c.version);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('constitution body carries the foundational tenets and honest amendability', () => {
  const { body } = getConstitution();
  const ids = body.articles.map((a) => a.id);
  assert.deepEqual(ids, [
    'care-for-creators',
    'care-for-those-around',
    'care-for-those-beyond',
    'build-to-help-humanity-evolve',
  ]);
  // Honesty boundary: we never claim immutability/tamper-proofing.
  assert.equal(body.amendability.machine_owner_can_alter_source, true);
  assert.ok(body.amendability.guarantees_not_provided.includes('immutability'));
  assert.ok(body.amendability.guarantees_not_provided.includes('tamper_proofing'));
  assert.ok(body.amendability.guarantees_provided.includes('tamper_evidence'));
});
