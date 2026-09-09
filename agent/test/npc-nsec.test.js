/**
 * NAP-BRIDGE-3 — npc-nsec.mjs mint helper tests.
 *
 * Drives scripts/npc-nsec.mjs as a subprocess (env in, JSON out) and pins the
 * contract the installer depends on:
 *
 *   • a fresh run mints a 64-hex nsec whose npub matches the derived key,
 *   • nsec_bech32 round-trips to the same hex (so the operator can back it up),
 *   • NPC_NSEC reuse reproduces the SAME identity (restart/reinstall-stable),
 *   • an invalid NPC_NSEC fails closed (non-zero, error to stderr).
 *
 * No NIP-46 bunker exists anymore — there is no client secret, no connect URI.
 *
 * Run:  node --test test/npc-nsec.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

const script = fileURLToPath(new URL('../scripts/npc-nsec.mjs', import.meta.url));

function run(env = {}) {
  const clean = { ...process.env };
  delete clean.NPC_NSEC;
  try {
    const out = execFileSync(process.execPath, [script], {
      env: { ...clean, ...env },
      encoding: 'utf8',
    });
    return { ok: true, json: JSON.parse(out) };
  } catch (e) {
    return { ok: false, stderr: e.stderr || '', status: e.status };
  }
}

test('mints a 64-hex nsec whose npub matches the derived pubkey', () => {
  const r = run({});
  assert.equal(r.ok, true);
  assert.match(r.json.nsec_hex, /^[0-9a-f]{64}$/);
  const pubHex = getPublicKey(Buffer.from(r.json.nsec_hex, 'hex'));
  // npub encodes the PUBKEY (as hex), not the nsec.
  assert.equal(nip19.decode(r.json.npub).data, pubHex);
});

test('nsec_bech32 round-trips to the same hex', () => {
  const r = run({});
  assert.ok(r.json.nsec_bech32.startsWith('nsec1'));
  // nsec bech32 encodes the SECRET key (as bytes), so it round-trips to nsec_hex.
  assert.equal(Buffer.from(nip19.decode(r.json.nsec_bech32).data).toString('hex'), r.json.nsec_hex);
});

test('NPC_NSEC reuse reproduces the same identity (reinstall-stable)', () => {
  const first = run({});
  const second = run({ NPC_NSEC: first.json.nsec_hex });
  assert.equal(second.json.nsec_hex, first.json.nsec_hex);
  assert.equal(second.json.npub, first.json.npub);
});

test('NPC_NSEC reuse also accepts nsec1 bech32', () => {
  const first = run({});
  const second = run({ NPC_NSEC: first.json.nsec_bech32 });
  assert.equal(second.json.nsec_hex, first.json.nsec_hex);
});

test('invalid NPC_NSEC fails closed', () => {
  const r = run({ NPC_NSEC: 'not-a-nsec' });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /not 64-hex or nsec1/);
});