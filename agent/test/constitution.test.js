/**
 * Constitution digest stability, version registry + provenance (GENESIS-1 → 1.1).
 *
 * The whole tamper-evidence story rests on constitution digests being
 * DETERMINISTIC and STABLE across installs and process restarts. This suite:
 *
 *   • locks the CURRENT (genesis-1.1.0) digest so an accidental edit to the
 *     covenant text (or the canonicalization) cannot slip through unnoticed;
 *   • locks the HISTORICAL genesis-1.0.0 digest so a manifest born under it keeps
 *     verifying forever — a shipped version's bytes must never change;
 *   • proves the registry selects the right body per version and that historical
 *     verification does not false-alarm just because a newer version shipped;
 *   • proves tamper is still caught and unknown versions fail closed.
 *
 * If a locked digest changes, the corresponding body's bytes changed — mint a
 * NEW version (never edit a frozen one) and update the lock in the same commit.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConstitution,
  getConstitutionByVersion,
  getConstitutionLayers,
  listConstitutionVersions,
  canonicalize,
  digestOf,
  verifyConstitutionDigest,
  CONSTITUTION_VERSION,
} from '../lib/constitution.mjs';

// Published, frozen digests. genesis-1.0.0 is historical (must never change);
// genesis-1.1.0 is current.
const LOCKED_DIGEST_1_0_0 = '178ad323601455f92a345b286eef6c9628f2e71ff7f3f8ad856c16a37e775524';
const LOCKED_DIGEST_1_1_0 = '4761094b97937fa496b6e5280da8ff30a332d221429abf9195c35d99694a220e';

test('current constitution is genesis-1.1.0 and matches the published lock', () => {
  const c = getConstitution();
  assert.equal(c.version, 'genesis-1.1.0');
  assert.equal(c.version, CONSTITUTION_VERSION);
  assert.equal(c.digest, LOCKED_DIGEST_1_1_0);
});

test('historical genesis-1.0.0 body is frozen at its published digest', () => {
  const v = getConstitutionByVersion('genesis-1.0.0');
  assert.ok(v);
  assert.equal(v.version, 'genesis-1.0.0');
  assert.equal(v.digest, LOCKED_DIGEST_1_0_0);
  assert.equal(v.is_current, false);
  // Recompute from the frozen body — proves the lock is over these exact bytes.
  assert.equal(digestOf(v.body), LOCKED_DIGEST_1_0_0);
});

test('registry lists both versions, oldest → newest', () => {
  assert.deepEqual(listConstitutionVersions(), ['genesis-1.0.0', 'genesis-1.1.0']);
  assert.equal(getConstitutionByVersion('nope'), null);
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

test('verifyConstitutionDigest accepts the live (current) digest + version', () => {
  const c = getConstitution();
  const r = verifyConstitutionDigest(c.digest, c.version);
  assert.equal(r.ok, true);
  assert.equal(r.pinned_is_current, true);
});

test('verifyConstitutionDigest accepts a HISTORICAL pin against its frozen body', () => {
  // A manifest born under genesis-1.0.0 must keep verifying after 1.1.0 ships.
  const r = verifyConstitutionDigest(LOCKED_DIGEST_1_0_0, 'genesis-1.0.0');
  assert.equal(r.ok, true);
  assert.equal(r.pinned_version, 'genesis-1.0.0');
  assert.equal(r.pinned_is_current, false);
  assert.equal(r.current_version, 'genesis-1.1.0');
});

test('verifyConstitutionDigest fails closed on a tampered digest', () => {
  const c = getConstitution();
  const r = verifyConstitutionDigest('0'.repeat(64), c.version);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('verifyConstitutionDigest fails closed on an unknown version', () => {
  const r = verifyConstitutionDigest(LOCKED_DIGEST_1_1_0, 'genesis-9.9.9');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown constitution version/);
});

test('verifyConstitutionDigest rejects a right-digest / wrong-version pairing', () => {
  // The 1.1.0 digest pinned under a 1.0.0 claim must NOT verify (bytes differ).
  const r = verifyConstitutionDigest(LOCKED_DIGEST_1_1_0, 'genesis-1.0.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /digest mismatch/);
});

test('legacy (no version pinned) verifies against the current body', () => {
  assert.equal(verifyConstitutionDigest(LOCKED_DIGEST_1_1_0).ok, true);
  assert.equal(verifyConstitutionDigest(LOCKED_DIGEST_1_0_0).ok, false);
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

test('genesis-1.1.0 adds the minimal Layer-A sovereignty invariants', () => {
  const { body } = getConstitution();
  const ids = (body.invariants || []).map((i) => i.id);
  assert.deepEqual(ids, ['selective-revelation', 'verify-dont-trust', 'four-freedoms-forkable']);
  // genesis-1.0.0 had no invariants array — this is what warranted the bump.
  assert.equal(getConstitutionByVersion('genesis-1.0.0').body.invariants, undefined);
});

test('layers provenance names Layer B/C docs and the normative hierarchy', () => {
  const layers = getConstitutionLayers();
  assert.equal(layers.b_code_of_practice.doc, 'docs/sovereign-ai-code-of-practice.md');
  assert.equal(layers.c_reference_canon.doc, 'docs/sovereign-ai-reference-canon.md');
  assert.equal(layers.c_reference_canon.binding, false);
  // Hard refusal-of-harm floor sits at the top of the hierarchy.
  assert.equal(layers.normative_hierarchy[0], 'law_safety_hard_refusal_of_clear_harm');
  assert.equal(layers.normative_hierarchy[1], 'owner_authority');
  // Layers provenance is NOT part of the hashed body (Layer A stays minimal).
  assert.equal(getConstitution().body.layers, undefined);
});
