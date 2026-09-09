/**
 * NAP-BRIDGE-1 — npc-bridge unit tests.
 *
 * Covers the pure helpers (allowlist / prompt / reply template) and the
 * end-to-end handleEvent() loop with a stubbed bunker signer, a stubbed
 * inference, and a stubbed pool — no live relay, no real nsec, no network.
 *
 * Run:  node --test test/npc-bridge.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import {
  normalizeAllowlist,
  isSenderAllowed,
  buildGreeterPrompt,
  buildReplyTemplate,
  createNpcBridge,
} from '../core/npc-bridge.mjs';

const silentLog = { info() {}, warn() {}, error() {} };

// A real sender identity used across the end-to-end tests.
const senderSk = generateSecretKey();
const senderHex = getPublicKey(senderSk);

// finalizeEvent sets the pubkey from the signing key (and stamps a
// verifiedSymbol cache), so we sign with the key whose identity we want.
function signedKind4(sk, content) {
  return finalizeEvent(
    { kind: 4, created_at: 1700000000, tags: [['p', 'deadbeef'.padEnd(64, '0')]], content },
    sk,
  );
}

// A genuinely-invalid event (bad id + sig, no verifiedSymbol cache).
function forgedKind4(pubkey, content) {
  return {
    kind: 4,
    pubkey,
    created_at: 1700000000,
    tags: [['p', 'deadbeef'.padEnd(64, '0')]],
    content,
    id: 'f'.repeat(64),
    sig: 'f'.repeat(128),
  };
}

// ─── normalizeAllowlist ──────────────────────────────────────────────────────

test('normalizeAllowlist accepts hex and npub1, lowercases, drops junk', () => {
  const npub = nip19.npubEncode(senderHex);
  const s = normalizeAllowlist([senderHex.toUpperCase(), npub, 'not-a-key', '', 42]);
  assert.equal(s.size, 1);
  assert.ok(s.has(senderHex.toLowerCase()));
});

test('normalizeAllowlist handles empty / non-array', () => {
  assert.equal(normalizeAllowlist().size, 0);
  assert.equal(normalizeAllowlist('x').size, 0);
  assert.equal(normalizeAllowlist([]).size, 0);
});

// ─── isSenderAllowed (fail-closed) ───────────────────────────────────────────

test('isSenderAllowed is fail-closed on empty/missing allowlist', () => {
  assert.equal(isSenderAllowed(senderHex, new Set()), false);
  assert.equal(isSenderAllowed(senderHex, null), false);
  assert.equal(isSenderAllowed('', new Set([senderHex])), false);
});

test('isSenderAllowed matches case-insensitively', () => {
  assert.equal(isSenderAllowed(senderHex.toUpperCase(), new Set([senderHex])), true);
  assert.equal(isSenderAllowed('0'.repeat(64), new Set([senderHex])), false);
});

// ─── buildGreeterPrompt / buildReplyTemplate ─────────────────────────────────

test('buildGreeterPrompt puts SOUL first then the message', () => {
  const out = buildGreeterPrompt('You are the greeter.', 'hello');
  assert.ok(out.startsWith('You are the greeter.'));
  assert.ok(out.endsWith('hello'));
  assert.ok(out.includes('\n\n'));
});

test('buildGreeterPrompt tolerates empty soul and empty message', () => {
  assert.ok(buildGreeterPrompt('', 'hi').endsWith('hi'));
  assert.ok(buildGreeterPrompt('soul', '').includes('(silent message)'));
});

test('buildReplyTemplate is kind-4, encrypted-only, addressed to sender', () => {
  const tpl = buildReplyTemplate({ senderHex, ciphertext: 'CT', createdAt: 123, greeterHex: 'aa'.repeat(32) });
  assert.equal(tpl.kind, 4);
  assert.equal(tpl.content, 'CT');
  assert.equal(tpl.pubkey, 'aa'.repeat(32));
  assert.deepEqual(tpl.tags, [['p', senderHex]]);
  assert.equal(tpl.created_at, 123);
});

// ─── createNpcBridge.handleEvent (end-to-end) ────────────────────────────────

function makeBridge(overrides = {}) {
  const calls = { decrypt: 0, chat: 0, encrypt: 0, sign: 0, publish: 0 };
  const bridge = createNpcBridge({
    cfg: { relayUrls: ['wss://r'], allowlist: new Set([senderHex]), soul: 'SOUL', model: 'm' },
    greeterHex: 'aa'.repeat(32),
    log: silentLog,
    pool: {
      subscribeMany: () => ({ close() {} }),
      publish: async () => { calls.publish++; return 'ok'; },
    },
    signer: {
      nip04Decrypt: async (_s, ct) => { calls.decrypt++; return `dec(${ct})`; },
      nip04Encrypt: async (_s, pt) => { calls.encrypt++; return `enc(${pt})`; },
      signEvent: async (tpl) => { calls.sign++; return { ...tpl, id: 'i'.repeat(64), sig: 's'.repeat(128) }; },
    },
    chat: async () => { calls.chat++; return { ok: true, content: 'reply' }; },
    ...overrides,
  });
  return { bridge, calls };
}

test('allowed sender flows decrypt→chat→encrypt→sign→publish', async () => {
  const { bridge, calls } = makeBridge();
  const ev = signedKind4(senderSk, 'ct');
  await bridge.handleEvent(ev);
  assert.equal(calls.decrypt, 1);
  assert.equal(calls.chat, 1);
  assert.equal(calls.encrypt, 1);
  assert.equal(calls.sign, 1);
  assert.equal(calls.publish, 1);
});

test('unverified event is dropped before any decrypt/compute', async () => {
  const { bridge, calls } = makeBridge();
  const ev = forgedKind4(senderHex, 'ct');
  await bridge.handleEvent(ev);
  assert.equal(calls.decrypt, 0);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('non-allowlisted sender is dropped before any decrypt/compute', async () => {
  const { bridge, calls } = makeBridge();
  const otherSk = generateSecretKey();
  const ev = signedKind4(otherSk, 'ct');
  await bridge.handleEvent(ev);
  assert.equal(calls.decrypt, 0);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('inference failure is dropped (no encrypt/sign/publish)', async () => {
  const { bridge, calls } = makeBridge({ chat: async () => { calls.chat++; return { ok: false, code: 'empty' }; } });
  const ev = signedKind4(senderSk, 'ct');
  await bridge.handleEvent(ev);
  assert.equal(calls.chat, 1);
  assert.equal(calls.encrypt, 0);
  assert.equal(calls.sign, 0);
  assert.equal(calls.publish, 0);
});

test('a throwing signer does not crash handleEvent', async () => {
  const { bridge } = makeBridge({ signer: { nip04Decrypt: async () => 'x', nip04Encrypt: async () => 'x', signEvent: async () => { throw new Error('bunker down'); } } });
  const ev = signedKind4(senderSk, 'ct');
  await bridge.handleEvent(ev); // must resolve, not reject
  assert.ok(true);
});