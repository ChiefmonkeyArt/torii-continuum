/**
 * Constitution digest stability, version registry + provenance (GENESIS-1 → 1.2).
 *
 * The whole tamper-evidence story rests on constitution digests being
 * DETERMINISTIC and STABLE across installs and process restarts. This suite:
 *
 *   • locks the CURRENT (genesis-1.2.0) digest so an accidental edit to the
 *     covenant text (or the canonicalization) cannot slip through unnoticed;
 *   • locks the HISTORICAL genesis-1.0.0 and genesis-1.1.0 digests so a manifest
 *     born under either keeps verifying forever — a shipped version's bytes must
 *     never change;
 *   • asserts the genesis-1.2.0 content changes VERBATIM: the replaced first
 *     article, the absence of the wording it replaced, and every normative
 *     requirement of `no-credential-custody` and `pareto-focus`. Digest locks
 *     prove the bytes did not drift; they say nothing about whether the bytes are
 *     the RIGHT ones, which is what these assertions are for;
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
import { readFileSync } from 'node:fs';
import {
  getConstitution,
  getConstitutionByVersion,
  getConstitutionLayers,
  listConstitutionVersions,
  canonicalize,
  digestOf,
  verifyConstitutionDigest,
  rulesOf,
  getSafetyFloor,
  constitutionUpgrade,
  CONSTITUTION_VERSION,
  CODE_OF_PRACTICE_VERSION,
} from '../lib/constitution.mjs';

// Published, frozen digests. 1.0.0 and 1.1.0 are historical (must never change);
// genesis-1.2.0 is current.
const LOCKED_DIGEST_1_0_0 = '178ad323601455f92a345b286eef6c9628f2e71ff7f3f8ad856c16a37e775524';
const LOCKED_DIGEST_1_1_0 = '4761094b97937fa496b6e5280da8ff30a332d221429abf9195c35d99694a220e';
const LOCKED_DIGEST_1_2_0 = '03f3e5b645d8f082a752642493b096ad628ff4cff94578a52e834d71104e6c7f';

test('current constitution is genesis-1.2.0 and matches the published lock', () => {
  const c = getConstitution();
  assert.equal(c.version, 'genesis-1.2.0');
  assert.equal(c.version, CONSTITUTION_VERSION);
  assert.equal(c.digest, LOCKED_DIGEST_1_2_0);
});

test('historical genesis-1.1.0 body is frozen at its published digest', () => {
  const v = getConstitutionByVersion('genesis-1.1.0');
  assert.ok(v);
  assert.equal(v.digest, LOCKED_DIGEST_1_1_0);
  assert.equal(v.is_current, false);
  assert.equal(digestOf(v.body), LOCKED_DIGEST_1_1_0);
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

test('registry lists every shipped version, oldest → newest', () => {
  assert.deepEqual(listConstitutionVersions(), ['genesis-1.0.0', 'genesis-1.1.0', 'genesis-1.2.0']);
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
  assert.equal(r.current_version, 'genesis-1.2.0');
});

test('verifyConstitutionDigest fails closed on a tampered digest', () => {
  const c = getConstitution();
  const r = verifyConstitutionDigest('0'.repeat(64), c.version);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test('verifyConstitutionDigest fails closed on an unknown version', () => {
  const r = verifyConstitutionDigest(LOCKED_DIGEST_1_2_0, 'genesis-9.9.9');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown constitution version/);
});

test('verifyConstitutionDigest rejects a right-digest / wrong-version pairing', () => {
  // The 1.2.0 digest pinned under a 1.0.0 claim must NOT verify (bytes differ).
  const r = verifyConstitutionDigest(LOCKED_DIGEST_1_2_0, 'genesis-1.0.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /digest mismatch/);
});

test('legacy (no version pinned) verifies against the current body', () => {
  assert.equal(verifyConstitutionDigest(LOCKED_DIGEST_1_2_0).ok, true);
  assert.equal(verifyConstitutionDigest(LOCKED_DIGEST_1_1_0).ok, false);
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

test('genesis-1.1.0 added the minimal Layer-A sovereignty invariants', () => {
  const ids = (getConstitutionByVersion('genesis-1.1.0').body.invariants || []).map((i) => i.id);
  assert.deepEqual(ids, ['selective-revelation', 'verify-dont-trust', 'four-freedoms-forkable']);
  // genesis-1.0.0 had no invariants array — this is what warranted that bump.
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

// ─── genesis-1.2.0 content ──────────────────────────────────
//
// A digest lock proves the bytes did not DRIFT. It cannot prove they are the
// RIGHT bytes — regenerate the lock from a wrong body and it passes happily.
// These assertions are the other half: they pin the wording itself, so a
// re-worded rule has to be a deliberate act with a visible diff in this file.

// Written out in full rather than imported from the module under test. Reusing
// the source constant would make this a tautology: the point is that an
// independent copy of the agreed wording still matches.
const CARE_TENET = 'Care for the human that created it.';
const CARE_INTENT =
  'Protect, respect, and serve the owner and creators who brought this bot into ' +
  'existence. Guard their sovereignty, privacy, keys (which it will never hold/store), ' +
  'and consent above the bot’s own continuity.';

test('genesis-1.2.0 replaces the first article with the exact agreed wording', () => {
  const { body } = getConstitution();
  const a = body.articles[0];
  assert.equal(a.id, 'care-for-creators');
  assert.equal(a.tenet, CARE_TENET);
  assert.equal(a.intent, CARE_INTENT);
  // The other three articles are untouched by this amendment.
  assert.deepEqual(body.articles.slice(1).map((x) => x.id), [
    'care-for-those-around',
    'care-for-those-beyond',
    'build-to-help-humanity-evolve',
  ]);
});

test('the replaced wording is absent from the CURRENT body but frozen in the old ones', () => {
  const current = canonicalize(getConstitution().body);
  for (const gone of [
    'Care for those who gave it life',
    'brought this bot into being',
  ]) {
    assert.equal(current.includes(gone), false, `current body still contains: ${gone}`);
  }
  // ...and is still exactly where it was in the frozen historical bodies. This
  // is the difference between an amendment and a rewrite: the old covenant is
  // not erased, it is superseded, and a bot born under it still verifies.
  for (const v of ['genesis-1.0.0', 'genesis-1.1.0']) {
    const old = getConstitutionByVersion(v).body.articles[0];
    assert.equal(old.tenet, 'Care for those who gave it life.');
    assert.match(old.intent, /brought this bot into being/);
  }
});

test('no-credential-custody carries every normative requirement, as a safety floor', () => {
  const { body } = getConstitution();
  const ids = (body.invariants || []).map((i) => i.id);
  assert.deepEqual(ids, [
    'selective-revelation',
    'verify-dont-trust',
    'four-freedoms-forkable',
    'no-credential-custody',
  ]);

  const inv = body.invariants.find((i) => i.id === 'no-credential-custody');
  assert.equal(inv.rule, 'no_credential_or_key_custody');
  // Binds every bot immediately, on any covenant version — see constitutionUpgrade.
  assert.equal(inv.safety_floor, true);

  // Each clause is asserted separately so a paraphrase that quietly drops one of
  // them fails on the clause it dropped, and names it.
  const s = inv.statement;
  assert.match(s, /never uses a human’s password without fresh, explicit\s+confirmation for that specific use/);
  for (const verb of ['stores', 'saves', 'retains', 'logs', 'reproduces', 'exposes', 'takes custody']) {
    assert.ok(s.includes(verb), `missing prohibited verb: ${verb}`);
  }
  for (const secret of [
    'passwords',
    'Bitcoin ',
    'private keys or seed phrases',
    'Nostr ',
    'nsec values',
    'equivalent cryptographic secrets',
  ]) {
    assert.ok(s.includes(secret), `missing secret class: ${secret}`);
  }
  assert.match(s, /secure external credential\s+reference/);
  assert.match(s, /never sees or stores the secret itself/);
  assert.match(s, /Consent to use is\s+not consent to retain/);
  assert.match(s, /fails closed and refuses/);
});

test('pareto-focus is an OPERATING RULE, not an invariant, and yields to every duty', () => {
  const { body } = getConstitution();
  const rules = body.operating_rules || [];
  assert.deepEqual(rules.map((r) => r.id), ['pareto-focus']);
  // Kept out of `invariants` on purpose: a priority heuristic is not a
  // sovereignty guarantee, and conflating the two would let an efficiency
  // preference inherit an invariant's weight.
  assert.equal((body.invariants || []).some((i) => i.id === 'pareto-focus'), false);

  const r = rules[0];
  assert.equal(r.rule, 'pareto_priority_never_over_duty');
  // NOT a floor: unlike a refusal rule it changes how the bot prioritises work,
  // so it may only bind a live bot after its owner has adopted the covenant.
  assert.notEqual(r.safety_floor, true);

  const s = r.statement;
  assert.match(s, /roughly twenty percent/);
  assert.match(s, /roughly eighty percent/);
  assert.match(s, /says plainly what it\s+is leaving aside/);
  for (const duty of ['safety', 'consent', 'privacy', 'correctness', 'constitutional duty']) {
    assert.ok(s.includes(duty), `missing duty that outranks efficiency: ${duty}`);
  }
  assert.match(s, /the duty\s+wins and the shortcut is abandoned/);
});

test('the two new rules are absent from every historical body', () => {
  for (const v of ['genesis-1.0.0', 'genesis-1.1.0']) {
    const ids = rulesOf(getConstitutionByVersion(v).body).map((r) => r.id);
    assert.equal(ids.includes('no-credential-custody'), false, `${v} must not carry the new invariant`);
    assert.equal(ids.includes('pareto-focus'), false, `${v} must not carry the new operating rule`);
  }
});

test('rulesOf flattens clauses, invariants and operating rules with their kind', () => {
  const rules = rulesOf(getConstitution().body);
  const byId = new Map(rules.map((r) => [r.id, r]));
  assert.equal(byId.get('owner-bound').kind, 'genesis_clause');
  assert.equal(byId.get('no-credential-custody').kind, 'invariant');
  assert.equal(byId.get('pareto-focus').kind, 'operating_rule');
  // Every rule is addressable by a stable id, which is what the upgrade
  // descriptor and the UI both key off.
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
});

test('the safety floor is exactly the credential rule', () => {
  const floor = getSafetyFloor();
  assert.deepEqual(floor.map((r) => r.id), ['no-credential-custody']);
  // A floor rule may only ever cause a REFUSAL. That is the whole justification
  // for binding it without acknowledgement, so nothing may join the floor
  // without this list — and this reasoning — being revisited.
  assert.equal(floor[0].safety_floor, true);
});

// ─── Upgrade descriptor (migration semantics) ───────────────

test('constitutionUpgrade offers an upgrade to a bot born under an older covenant', () => {
  const u = constitutionUpgrade('genesis-1.1.0');
  assert.equal(u.current_version, 'genesis-1.2.0');
  assert.equal(u.current_digest, LOCKED_DIGEST_1_2_0);
  assert.equal(u.active_version, 'genesis-1.1.0');
  assert.equal(u.known_pinned_version, true);
  assert.equal(u.is_current, false);
  assert.equal(u.upgrade_available, true);
  assert.equal(u.acknowledgement_required, true);
  // The floor already binds, so it is never advertised as something adoption
  // would add — that would overstate what the owner is being asked to accept.
  assert.deepEqual(u.safety_floor_rule_ids, ['no-credential-custody']);
  assert.deepEqual(u.newly_binding_rule_ids, ['pareto-focus']);
});

test('an acknowledged version is what binds, not the birth version', () => {
  const u = constitutionUpgrade('genesis-1.0.0', 'genesis-1.2.0');
  assert.equal(u.active_version, 'genesis-1.2.0');
  assert.equal(u.is_current, true);
  assert.equal(u.upgrade_available, false);
  assert.equal(u.acknowledgement_required, false);
  assert.deepEqual(u.newly_binding_rule_ids, []);
});

test('constitutionUpgrade fails closed on bytes we do not hold, and still states the floor', () => {
  const u = constitutionUpgrade('genesis-9.9.9');
  assert.equal(u.known_pinned_version, false);
  assert.equal(u.active_version, null);
  assert.equal(u.is_current, false);
  assert.equal(u.upgrade_available, true);
  // Unverifiable provenance must not be able to switch the floor off.
  assert.deepEqual(u.safety_floor_rule_ids, ['no-credential-custody']);
  // An acknowledgement naming bytes we do not hold does not count either.
  assert.equal(constitutionUpgrade('genesis-1.1.0', 'genesis-9.9.9').active_version, 'genesis-1.1.0');
});

test('Layer B tracks the amendment at cop-1.1.0', () => {
  assert.equal(CODE_OF_PRACTICE_VERSION, 'cop-1.1.0');
  assert.equal(getConstitutionLayers().b_code_of_practice.version, 'cop-1.1.0');
});

// ─── canonical copies stay aligned ──────────────────────────
//
// The constitution is prose that lives in five other places (spec, Code of
// Practice, strategy, README, canon). Prose copies drift silently — someone
// re-words a doc, and the covenant the owner READS stops being the covenant the
// bot RUNS. These assertions make that a test failure rather than a discovery.

const REPO = new URL('../../', import.meta.url);

/** Markdown wraps and blockquotes text, so compare on normalised content. */
function normalise(s) {
  return s
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*`]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A tenet quoted inside prose loses its full stop. */
function phrase(s) {
  return normalise(s).replace(/\.$/, '');
}

function doc(rel) {
  return normalise(readFileSync(new URL(rel, REPO), 'utf8'));
}

test('the canonical docs quote the new rules verbatim', () => {
  const body = getConstitutionByVersion(CONSTITUTION_VERSION).body;
  const inv = body.invariants.find((i) => i.id === 'no-credential-custody');
  const par = body.operating_rules.find((r) => r.id === 'pareto-focus');
  const spec = doc('docs/sovereign-ai-genesis-lora-rag-spec.md');
  // The spec is the normative written copy — it must carry both in full.
  assert.ok(spec.includes(normalise(inv.statement)), 'spec must quote no-credential-custody verbatim');
  assert.ok(spec.includes(normalise(par.statement)), 'spec must quote pareto-focus verbatim');
});

test('the canonical docs carry the replaced article, not the old wording', () => {
  const art = getConstitutionByVersion(CONSTITUTION_VERSION).body.articles[0];
  for (const rel of [
    'docs/sovereign-ai-genesis-lora-rag-spec.md',
    'torii-continuum-strategy.md',
  ]) {
    const t = doc(rel);
    // Prose renders the tenet mid-sentence, so compare without terminal punctuation.
    assert.ok(t.includes(phrase(art.tenet)), `${rel} must carry the new tenet`);
    assert.equal(
      t.includes(phrase(getConstitutionByVersion('genesis-1.1.0').body.articles[0].tenet)),
      false,
      `${rel} still carries the superseded tenet`,
    );
  }
});

test('every canonical copy names the version and digest actually in force', () => {
  const con = getConstitution();
  for (const rel of [
    'docs/sovereign-ai-genesis-lora-rag-spec.md',
    'docs/sovereign-ai-code-of-practice.md',
    'torii-continuum-strategy.md',
    'README.md',
  ]) {
    const t = doc(rel);
    assert.ok(t.includes(con.version), `${rel} must name ${con.version}`);
    assert.ok(t.includes(CODE_OF_PRACTICE_VERSION), `${rel} must name ${CODE_OF_PRACTICE_VERSION}`);
  }
  // Where a digest is published it must be the live one, not a stale prefix.
  for (const rel of [
    'docs/sovereign-ai-genesis-lora-rag-spec.md',
    'torii-continuum-strategy.md',
    'README.md',
  ]) {
    const t = doc(rel);
    assert.ok(t.includes(con.digest.slice(0, 8)), `${rel} must publish the live digest`);
  }
});

test('the docs record both new rule ids and the safety-floor decision', () => {
  const spec = doc('docs/sovereign-ai-genesis-lora-rag-spec.md');
  const cop = doc('docs/sovereign-ai-code-of-practice.md');
  for (const t of [spec, cop]) {
    assert.ok(t.includes('no-credential-custody'));
    assert.ok(t.includes('pareto-focus'));
  }
  // The one decision a reader most needs: which of the two binds immediately.
  assert.ok(spec.includes('safety_floor: true'));
  assert.match(spec, /not a safety floor/i);
});
