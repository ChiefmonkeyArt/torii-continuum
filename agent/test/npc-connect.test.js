/**
 * NAP-BRIDGE-1 — npc-connect.mjs setup helper tests.
 *
 * Drives scripts/npc-connect.mjs as a subprocess (env in, JSON out) and pins
 * the contract the installer, and therefore the whole NIP-46 setup, depends on:
 *
 *   • a fresh run mints a 64-hex client secret (NOT a greeter nsec),
 *   • the derived client pubkey matches getPublicKey(bytes(secret)),
 *   • the nostrconnect:// URI carries the relay(s), the same secret, the four
 *     scoped perms (sign_event:13, nip44_encrypt/decrypt, get_public_key) and a
 *     name — and nothing wider,
 *   • NPC_CLIENT_SECRET reuse reproduces the SAME key (restart-stable),
 *   • a missing/empty NPC_RELAYS fails closed (non-zero, error to stderr).
 *
 * Run:  node --test test/npc-connect.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPublicKey } from 'nostr-tools/pure';

const script = fileURLToPath(new URL('../scripts/npc-connect.mjs', import.meta.url));

function run(env = {}) {
  try {
    const out = execFileSync(process.execPath, [script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { ok: true, json: JSON.parse(out) };
  } catch (e) {
    return { ok: false, stderr: e.stderr || '', status: e.status };
  }
}

const RELAYS = 'wss://relay.damus.io,wss://relay.nostr.band';

test('mints a 64-hex client secret whose pubkey matches the derived key', () => {
  const r = run({ NPC_RELAYS: RELAYS });
  assert.equal(r.ok, true);
  assert.match(r.json.client_secret, /^[0-9a-f]{64}$/);
  const expectPub = getPublicKey(Buffer.from(r.json.client_secret, 'hex'));
  assert.equal(r.json.client_pubkey, expectPub);
});

test('connect URI carries relays, the secret, the four scoped perms, and a name', () => {
  const r = run({ NPC_RELAYS: RELAYS, NPC_NAME: 'Test Greeter' });
  const uri = r.json.connect_uri;
  assert.ok(uri.startsWith('nostrconnect://'));
  assert.ok(uri.includes('relay=wss%3A%2F%2Frelay.damus.io'));
  assert.ok(uri.includes('secret=' + r.json.client_secret));
  assert.ok(uri.includes('perms=sign_event%3A13%2Cnip44_encrypt%2Cnip44_decrypt%2Cget_public_key'));
  assert.ok(uri.includes('name=Test+Greeter'));
});

test('NPC_CLIENT_SECRET reuse reproduces the same key (restart-stable)', () => {
  const first = run({ NPC_RELAYS: RELAYS });
  const second = run({ NPC_RELAYS: RELAYS, NPC_CLIENT_SECRET: first.json.client_secret });
  assert.equal(second.json.client_secret, first.json.client_secret);
  assert.equal(second.json.client_pubkey, first.json.client_pubkey);
});

test('missing/empty NPC_RELAYS fails closed', () => {
  assert.equal(run({}).ok, false);
  assert.match(run({}).stderr, /NPC_RELAYS is required/);
  assert.equal(run({ NPC_RELAYS: '   ' }).ok, false);
});