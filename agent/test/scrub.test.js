/**
 * scrub.mjs — the secret-safe redactor behind the app-level error handler
 * (FIX B, NWC-ERR-1 hardening). Asserts that a thrown error's message can never
 * carry a 64-hex secret/pubkey or a nostr+walletconnect URI into a log line.
 *
 * Tested directly (not via the Fastify server) for determinism.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../lib/scrub.mjs';

const HEX64 = 'a'.repeat(64);
const NWC = 'nostr+walletconnect://b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0?relay=wss://r.example&secret=deadbeefdeadbeefdeadbeefdeadbeef';

test('redacts a 64-hex secret/pubkey', () => {
  const out = scrub(`boom for ${HEX64} while signing`);
  assert.ok(!out.includes(HEX64));
  assert.ok(out.includes('[redacted]'));
});

test('redacts a nostr+walletconnect URI', () => {
  const out = scrub(`connect failed: ${NWC}`);
  assert.ok(!out.includes('nostr+walletconnect://'));
  assert.ok(!out.includes('deadbeef'));
  assert.ok(out.includes('[nwc-uri-redacted]'));
});

test('redacts the nostrwalletconnect (no plus) variant', () => {
  const out = scrub('uri nostrwalletconnect://cccccccccccccccc?x=1 end');
  assert.ok(!out.includes('nostrwalletconnect://'));
  assert.ok(out.includes('[nwc-uri-redacted]'));
});

test('truncates to ~200 chars', () => {
  const out = scrub('z'.repeat(500));
  assert.ok(out.length <= 200);
});

test('falls back for empty / non-string input', () => {
  assert.equal(scrub(''), 'unknown error');
  assert.equal(scrub(null), 'unknown error');
  assert.equal(scrub(undefined), 'unknown error');
  assert.equal(scrub(42), 'unknown error');
});

test('leaves an ordinary message intact', () => {
  assert.equal(scrub('validation failed: missing field'), 'validation failed: missing field');
});
