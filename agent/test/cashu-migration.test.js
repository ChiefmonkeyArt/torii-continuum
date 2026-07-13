/**
 * Cashu v2 → v3-lts migration — offline deterministic regression fixtures.
 *
 * v0.2.28-alpha migrated @cashu/cashu-ts 2.5.3 → 3.7.1 (the `v3-lts`
 * security-fixes-only line). These tests pin the exact money-path boundaries
 * the agent depends on so a future bump can't silently drift the serialized
 * wire format or the decode/encode semantics of existing wallet state.
 *
 * Everything here is offline and deterministic: no mint, no network, no seed.
 * The frozen token strings below were produced by @cashu/cashu-ts@2.5.3 (the
 * pre-migration version) with synthetic proof material — they are literal
 * "v2-era serialized data on disk" fixtures. All secrets/points are dummy.
 *
 * Coverage (one boundary per describe-block of tests):
 *   1. v2-era serialized tokens decode under v3-lts.
 *   2. encode/decode round-trips preserve every semantically critical field.
 *   3. v3-lts re-encodes v2-era proofs to the byte-identical wire string.
 *   4. mint URL / unit / amount / keyset-id are read back correctly.
 *   5. proof/pending memory JSON serialization shape is unchanged.
 *   6. malformed / truncated data fails closed without echoing secret material.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';

// --- Frozen v2-era fixtures (encoded by @cashu/cashu-ts@2.5.3) ---------------
// Two proofs, unit "sat", memo "topup", against a synthetic mint. Default
// encoding is cashuB (token v4) in BOTH 2.5.3 and 3.7.1.
const V2_TOKEN_CASHUB =
  'cashuBpGFteBhodHRwczovL21pbnQuZXhhbXBsZS5jb21hdWNzYXRhdIGiYWlIAJofKTJT5B5hcIKjYWECYXN4IGFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWNYIQKrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6NhYQhhc3ggYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJhY1ghA83Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NYWRldG9wdXA';

// The exact proof material that was encoded into V2_TOKEN_CASHUB.
const EXPECTED_MINT = 'https://mint.example.com';
const EXPECTED_KEYSET_ID = '009a1f293253e41e';
const EXPECTED_UNIT = 'sat';
const EXPECTED_MEMO = 'topup';
const EXPECTED_PROOFS = [
  { id: EXPECTED_KEYSET_ID, amount: 2, secret: 'a'.repeat(32), C: '02' + 'ab'.repeat(32) },
  { id: EXPECTED_KEYSET_ID, amount: 8, secret: 'b'.repeat(32), C: '03' + 'cd'.repeat(32) },
];

test('v2-era cashuB token decodes under v3-lts', () => {
  const decoded = getDecodedToken(V2_TOKEN_CASHUB);
  assert.equal(decoded.mint, EXPECTED_MINT);
  assert.ok(Array.isArray(decoded.proofs));
  assert.equal(decoded.proofs.length, 2);
});

test('decode preserves every semantically critical proof field', () => {
  const { proofs } = getDecodedToken(V2_TOKEN_CASHUB);
  for (let i = 0; i < EXPECTED_PROOFS.length; i++) {
    const got = proofs[i];
    const want = EXPECTED_PROOFS[i];
    assert.equal(got.id, want.id, `proof[${i}].id (keyset)`);
    assert.equal(got.amount, want.amount, `proof[${i}].amount`);
    assert.equal(got.secret, want.secret, `proof[${i}].secret`);
    assert.equal(got.C, want.C, `proof[${i}].C`);
  }
});

test('mint URL, unit and memo survive the decode boundary', () => {
  const decoded = getDecodedToken(V2_TOKEN_CASHUB);
  assert.equal(decoded.mint, EXPECTED_MINT);
  assert.equal(decoded.unit, EXPECTED_UNIT);
  assert.equal(decoded.memo, EXPECTED_MEMO);
});

test('v3-lts re-encodes v2-era proofs to the byte-identical wire string', () => {
  // Strongest serialization-stability guarantee: decode a genuine 2.5.3 token,
  // re-encode with 3.7.1, and require an exact string match. Any wire-format
  // drift (field order, encoding version, rounding) fails here.
  const decoded = getDecodedToken(V2_TOKEN_CASHUB);
  const reencoded = getEncodedToken({
    mint: decoded.mint,
    proofs: decoded.proofs,
    unit: decoded.unit,
    memo: decoded.memo,
  });
  assert.equal(reencoded, V2_TOKEN_CASHUB);
});

test('encode → decode round trip is stable and amount-preserving', () => {
  const token = getEncodedToken({
    mint: EXPECTED_MINT,
    proofs: EXPECTED_PROOFS,
    unit: EXPECTED_UNIT,
  });
  const back = getDecodedToken(token);
  const total = back.proofs.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 10, 'summed amount must be preserved (2 + 8)');
  assert.equal(back.proofs.every((p) => p.id === EXPECTED_KEYSET_ID), true);
});

test('proof/pending memory JSON serialization shape is unchanged', () => {
  // wallet.mjs persists { mint, proofs, updated_at } as plain JSON. Decoded v3
  // proofs must survive a JSON round trip with the same money-critical fields,
  // otherwise on-disk memory/wallet/*.json state would read back wrong.
  const { proofs } = getDecodedToken(V2_TOKEN_CASHUB);
  const onDisk = JSON.stringify({ mint: EXPECTED_MINT, proofs, updated_at: 0 }, null, 2);
  const restored = JSON.parse(onDisk);
  assert.equal(restored.mint, EXPECTED_MINT);
  assert.equal(restored.proofs.length, 2);
  for (let i = 0; i < EXPECTED_PROOFS.length; i++) {
    assert.deepEqual(
      { id: restored.proofs[i].id, amount: restored.proofs[i].amount, secret: restored.proofs[i].secret, C: restored.proofs[i].C },
      EXPECTED_PROOFS[i],
    );
  }
  // A re-encode from the restored-from-disk proofs still matches the wire form.
  const reencoded = getEncodedToken({ mint: restored.mint, proofs: restored.proofs, unit: EXPECTED_UNIT, memo: EXPECTED_MEMO });
  assert.equal(reencoded, V2_TOKEN_CASHUB);
});

test('malformed token fails closed without echoing secret material', () => {
  assert.throws(() => getDecodedToken('not-a-cashu-token'), (err) => {
    const msg = String(err && err.message);
    // Fail closed: the error must not leak proof secrets / signatures.
    assert.doesNotMatch(msg, /a{16,}|b{16,}|ab{8,}|cd{8,}/, 'error leaked secret/C material');
    return true;
  });
});

test('truncated v2 token fails closed and does not leak the frozen secrets', () => {
  const truncated = V2_TOKEN_CASHUB.slice(0, V2_TOKEN_CASHUB.length - 12);
  let leaked = false;
  try {
    const d = getDecodedToken(truncated);
    // If it somehow decodes, it must not silently fabricate our exact secrets.
    leaked = JSON.stringify(d).includes(EXPECTED_PROOFS[0].secret) &&
             JSON.stringify(d).includes(EXPECTED_PROOFS[1].secret);
  } catch (err) {
    assert.doesNotMatch(String(err && err.message), /a{16,}|b{16,}/, 'error leaked secret material');
  }
  assert.equal(leaked, false);
});
