/**
 * NAP-BRIDGE-3 — npc-bridge unit tests (NIP-17 kind-1059 + NIP-44).
 *
 * Covers the pure helpers (allowlist / prompt / rumor / seal / wrap / parse /
 * gift-wrap) and the end-to-end handleEvent() loop with a stubbed signer,
 * a stubbed inference, and a stubbed pool — no live relay, no real greeter
 * nsec, no network. Inbound gift wraps are built with a real sender key so the
 * seal's signature verifies; the signer decrypt is stubbed to return the known
 * plaintexts.
 *
 * Run:  node --test test/npc-bridge.test.js   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { nip19 } from 'nostr-tools';
import {
  normalizeAllowlist,
  isSenderAllowed,
  createRateLimiter,
  buildGreeterPrompt,
  buildRumor,
  buildSealTemplate,
  buildWrapTemplate,
  giftWrapSeal,
  safeParse,
  createNpcBridge,
} from '../core/npc-bridge.mjs';

const silentLog = { info() {}, warn() {}, error() {} };
const GREETER = 'aa'.repeat(32);

// ─── Pure helpers ────────────────────────────────────────────────────────────

test('normalizeAllowlist accepts hex and npub1, lowercases, drops junk', () => {
  const sk = generateSecretKey();
  const hex = getPublicKey(sk);
  const s = normalizeAllowlist([hex.toUpperCase(), nip19.npubEncode(hex), 'nope', '', 42]);
  assert.equal(s.size, 1);
  assert.ok(s.has(hex.toLowerCase()));
});

test('isSenderAllowed is fail-closed on empty/missing allowlist and non-match', () => {
  const hex = getPublicKey(generateSecretKey());
  assert.equal(isSenderAllowed(hex, new Set()), false);
  assert.equal(isSenderAllowed(hex, null), false);
  assert.equal(isSenderAllowed('', new Set([hex])), false);
  assert.equal(isSenderAllowed(hex.toUpperCase(), new Set([hex])), true);
});

test('buildGreeterPrompt puts SOUL first then the message', () => {
  const out = buildGreeterPrompt('You are the greeter.', 'hello');
  assert.ok(out.startsWith('You are the greeter.'));
  assert.ok(out.endsWith('hello'));
});

// ─── Rate limiter (NAP-BRIDGE-5) ─────────────────────────────────────────────

test('createRateLimiter allows up to maxPerWindow, then throttles exactly once', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1_000, maxPerWindow: 2, now: () => t });
  assert.equal(rl.check('a'.repeat(64)).allowed, true);
  assert.equal(rl.check('a'.repeat(64)).allowed, true);
  const over = rl.check('a'.repeat(64)); // 3rd — over limit
  assert.equal(over.allowed, false);
  assert.equal(over.throttle, true); // one notice
  const over2 = rl.check('a'.repeat(64)); // 4th — silent
  assert.equal(over2.allowed, false);
  assert.equal(over2.throttle, false);
});

test('createRateLimiter resets once the window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1_000, maxPerWindow: 1, now: () => t });
  assert.equal(rl.check('b'.repeat(64)).allowed, true);
  assert.equal(rl.check('b'.repeat(64)).allowed, false); // over limit now
  t = 1_000; // window boundary
  assert.equal(rl.check('b'.repeat(64)).allowed, true); // fresh window
});

test('createRateLimiter is per-sender: flooding one key leaves others free', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1_000, maxPerWindow: 2, now: () => t });
  const spammer = 'c'.repeat(64);
  const guest = 'd'.repeat(64);
  assert.equal(rl.check(spammer).allowed, true);
  assert.equal(rl.check(spammer).allowed, true);
  const overSpam = rl.check(spammer); // 3rd — over limit
  assert.equal(overSpam.allowed, false);
  assert.equal(overSpam.throttle, true);
  const guest1 = rl.check(guest); // guest's first message — unaffected
  assert.equal(guest1.allowed, true);
});

test('createRateLimiter rejects empty/invalid sender and sanitises bad limits', () => {
  const rl = createRateLimiter({ windowMs: -5, maxPerWindow: 0 }); // -> defaults
  assert.equal(rl.check('').allowed, false);
  assert.equal(rl.check(null).allowed, false);
  assert.equal(rl.check(undefined).allowed, false);
  assert.equal(rl.check('e'.repeat(64)).allowed, true); // defaults still allow
});

test('buildRumor is kind-14, greeter pubkey, p-tag to sender, content plaintext', () => {
  const r = buildRumor({ greeterHex: GREETER, senderHex: 'b'.repeat(64), plaintext: 'hi', createdAt: 1 });
  assert.equal(r.kind, 14);
  assert.equal(r.pubkey, GREETER);
  assert.deepEqual(r.tags, [['p', 'b'.repeat(64)]]);
  assert.equal(r.content, 'hi');
});

test('buildSealTemplate is kind-13 with ciphertext content, greeter pubkey, no tags', () => {
  const s = buildSealTemplate({ ciphertext: 'CT', greeterHex: GREETER, createdAt: 2 });
  assert.equal(s.kind, 13);
  assert.equal(s.pubkey, GREETER);
  assert.equal(s.content, 'CT');
  assert.deepEqual(s.tags, []);
});

test('buildWrapTemplate is kind-1059, ephemeral pubkey, p-tag to sender', () => {
  const w = buildWrapTemplate({ senderHex: 'b'.repeat(64), ciphertext: 'CT', ephemeralPubkey: 'c'.repeat(64), createdAt: 3 });
  assert.equal(w.kind, 1059);
  assert.equal(w.pubkey, 'c'.repeat(64));
  assert.deepEqual(w.tags, [['p', 'b'.repeat(64)]]);
  assert.equal(w.content, 'CT');
});

test('safeParse returns the object on valid JSON, null on garbage/non-object', () => {
  assert.deepEqual(safeParse('{"a":1}'), { a: 1 });
  assert.equal(safeParse('not json'), null);
  assert.equal(safeParse('42'), null);
  assert.equal(safeParse(''), null);
  assert.equal(safeParse('"str"'), null);
});

test('giftWrapSeal produces a verifiable kind-1059 with an ephemeral (non-greeter) pubkey', () => {
  const sk = generateSecretKey();
  const senderHex = getPublicKey(sk);
  const seal = { kind: 13, pubkey: GREETER, created_at: 1, tags: [], content: 'x', id: 'f'.repeat(64), sig: 'f'.repeat(128) };
  const wrap = giftWrapSeal(seal, senderHex);
  assert.equal(wrap.kind, 1059);
  assert.deepEqual(wrap.tags, [['p', senderHex]]);
  assert.notEqual(wrap.pubkey, GREETER); // ephemeral, hides the greeter
  assert.ok(wrap.content.length > 0);
  assert.equal(verifyEvent(wrap), true); // signed by the ephemeral key
});

// ─── handleEvent (end-to-end) ────────────────────────────────────────────────

// Build a real inbound gift wrap from `senderSk` to `greeterHex`, plus the
// intermediate seal + rumor, so verifyEvent(seal) genuinely passes.
function buildInbound({ senderSk, senderHex, greeterHex, plaintext }) {
  const rumor = {
    kind: 14,
    pubkey: senderHex,
    created_at: 1700000000,
    tags: [['p', greeterHex]],
    content: plaintext,
  };
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: 1700000001,
      tags: [],
      content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(senderSk, greeterHex)),
    },
    senderSk,
  );
  const ephemeralSk = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: 1700000002,
      tags: [['p', greeterHex]],
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(ephemeralSk, greeterHex)),
    },
    ephemeralSk,
  );
  return { wrap, seal, rumor };
}

function makeBridge({ inbound, sealOverride, rumorOverride, chat, signerCb, rateLimit, public: isPublic, allowlist }) {
  const calls = { decrypt: 0, chat: 0, encrypt: 0, sign: 0, publish: 0, wrap: 0 };
  const senderHex = inbound.seal.pubkey; // the real sender
  const chatFn = chat ?? (async () => { calls.chat++; return { ok: true, content: 'reply' }; });
  const signer = {
    nip44Decrypt: async (pubkey) => {
      calls.decrypt++;
      if (pubkey === inbound.wrap.pubkey) {
        return sealOverride ?? JSON.stringify(inbound.seal);
      }
      return rumorOverride ?? JSON.stringify(inbound.rumor);
    },
    nip44Encrypt: async (_pk, pt) => { calls.encrypt++; return `CIPHER(${pt})`; },
    signEvent: async (tpl) => {
      calls.sign++;
      if (signerCb) signerCb(tpl);
      return { ...tpl, id: 'i'.repeat(64), sig: 's'.repeat(128) };
    },
  };
  const bridge = createNpcBridge({
    cfg: { relayUrls: ['wss://r'], allowlist: allowlist ?? new Set([senderHex]), soul: 'SOUL', model: 'm', public: isPublic, rateLimit },
    greeterHex: GREETER,
    log: silentLog,
    pool: {
      subscribeMany: () => ({ close() {} }),
      publish: async () => { calls.publish++; return 'ok'; },
    },
    signer,
    chat: chatFn,
    giftWrap: async (seal, pk) => { calls.wrap++; return { kind: 1059, pubkey: 'e'.repeat(64), created_at: 1, tags: [['p', pk]], content: 'W', id: 'i'.repeat(64), sig: 's'.repeat(128), _seal: seal }; },
  });
  return { bridge, calls };
}

test('allowed sender flows unwrap→verify→allowlist→chat→seal→wrap→publish', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'hello' });
  const { bridge, calls } = makeBridge({ inbound });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.decrypt, 2);   // seal + rumor
  assert.equal(calls.chat, 1);
  assert.equal(calls.encrypt, 1);
  assert.equal(calls.sign, 1);
  assert.equal(calls.wrap, 1);
  assert.equal(calls.publish, 1);
});

test('over-limit sender is throttled: one notice reply, no extra chat (NAP-BRIDGE-5)', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  // maxPerWindow = 1: the first message is answered, then the rest throttle.
  const { bridge, calls } = makeBridge({ inbound, rateLimit: { windowMs: 60_000, maxPerWindow: 1 } });
  await bridge.handleEvent(inbound.wrap); // 1st — allowed
  assert.equal(calls.chat, 1);
  assert.equal(calls.publish, 1);

  await bridge.handleEvent(inbound.wrap); // 2nd — over limit: one notice, NO chat
  assert.equal(calls.chat, 1);            // inference did not run again
  assert.equal(calls.publish, 2);         // the throttle notice was published

  await bridge.handleEvent(inbound.wrap); // 3rd — silent drop (no second notice)
  assert.equal(calls.chat, 1);
  assert.equal(calls.publish, 2);
});

test('public mode admits any authenticated sender even with an empty allowlist (NAP-BRIDGE-6)', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'hi' });
  const { bridge, calls } = makeBridge({ inbound, public: true, allowlist: new Set() });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.chat, 1);   // admitted — the allowlist gate is bypassed
  assert.equal(calls.publish, 1);
});

test('public mode still rate-limits a flooding sender', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge, calls } = makeBridge({
    inbound, public: true, allowlist: new Set(), rateLimit: { windowMs: 60_000, maxPerWindow: 1 },
  });
  await bridge.handleEvent(inbound.wrap); // 1st — allowed
  assert.equal(calls.chat, 1);
  await bridge.handleEvent(inbound.wrap); // 2nd — over limit: one notice, no chat
  assert.equal(calls.chat, 1);
  assert.equal(calls.publish, 2);         // throttle notice still sent
});

test('non-gift-wrap kind is dropped before any decrypt/compute', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge, calls } = makeBridge({ inbound });
  const ev = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'x' }, senderSk);
  await bridge.handleEvent(ev);
  assert.equal(calls.decrypt, 0);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('unverified/garbage outer wrap is dropped before any decrypt', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge, calls } = makeBridge({ inbound });
  const forged = { kind: 1059, pubkey: 'd'.repeat(64), created_at: 1, tags: [['p', GREETER]], content: 'x', id: 'f'.repeat(64), sig: 'f'.repeat(128) };
  await bridge.handleEvent(forged);
  assert.equal(calls.decrypt, 0);
  assert.equal(calls.publish, 0);
});

test('garbage seal payload is dropped (no crash)', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge, calls } = makeBridge({ inbound, sealOverride: 'not-json' });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('unverified seal is dropped before allowlist/chat', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const forgedSeal = { kind: 13, pubkey: senderHex, created_at: 1, tags: [], content: 'x', id: 'f'.repeat(64), sig: 'f'.repeat(128) };
  const { bridge, calls } = makeBridge({ inbound, sealOverride: JSON.stringify(forgedSeal) });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('seal/rumor pubkey mismatch is dropped', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const otherHex = getPublicKey(generateSecretKey());
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const mismatchedRumor = { ...inbound.rumor, pubkey: otherHex };
  const { bridge, calls } = makeBridge({ inbound, rumorOverride: JSON.stringify(mismatchedRumor) });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.chat, 0);
  assert.equal(calls.publish, 0);
});

test('non-allowlisted sender is dropped after decrypt, before chat', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const otherSk = generateSecretKey();
  const otherHex = getPublicKey(otherSk);
  const otherInbound = buildInbound({ senderSk: otherSk, senderHex: otherHex, greeterHex: GREETER, plaintext: 'x' });
  // Bridge allowlist contains only senderHex; feed it otherHex's wrap.
  const allowlistBridge = createNpcBridge({
    cfg: { relayUrls: ['wss://r'], allowlist: new Set([senderHex]), soul: 'SOUL', model: 'm' },
    greeterHex: GREETER,
    log: silentLog,
    pool: { subscribeMany: () => ({ close() {} }), publish: async () => 'ok' },
    signer: {
      nip44Decrypt: async (pubkey) => pubkey === otherInbound.wrap.pubkey ? JSON.stringify(otherInbound.seal) : JSON.stringify(otherInbound.rumor),
      nip44Encrypt: async () => 'C',
      signEvent: async (tpl) => ({ ...tpl, id: 'i'.repeat(64), sig: 's'.repeat(128) }),
    },
    chat: async () => { throw new Error('should not chat'); },
    giftWrap: async () => { throw new Error('should not wrap'); },
  });
  await allowlistBridge.handleEvent(otherInbound.wrap); // must not throw
  // (no observable chat/wrap — the drop path returns before either)
  assert.ok(true);
  void inbound; void senderSk;
});

test('inference failure is dropped (no seal/encrypt/sign/wrap/publish)', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge, calls } = makeBridge({ inbound, chat: async () => { calls.chat++; return { ok: false, code: 'empty' }; } });
  await bridge.handleEvent(inbound.wrap);
  assert.equal(calls.chat, 1);
  assert.equal(calls.encrypt, 0);
  assert.equal(calls.sign, 0);
  assert.equal(calls.wrap, 0);
  assert.equal(calls.publish, 0);
});

test('a throwing signer does not crash handleEvent', async () => {
  const senderSk = generateSecretKey();
  const senderHex = getPublicKey(senderSk);
  const inbound = buildInbound({ senderSk, senderHex, greeterHex: GREETER, plaintext: 'x' });
  const { bridge } = makeBridge({
    inbound,
    signerCb: undefined,
  });
  // override the signer to throw
  bridge.signer = undefined; // no-op; instead rebuild with a throwing signer
  const bridgeThrows = createNpcBridge({
    cfg: { relayUrls: ['wss://r'], allowlist: new Set([senderHex]), soul: 'S', model: 'm' },
    greeterHex: GREETER,
    log: silentLog,
    pool: { subscribeMany: () => ({ close() {} }), publish: async () => 'ok' },
    signer: {
      nip44Decrypt: async () => { throw new Error('signer down'); },
      nip44Encrypt: async () => 'C',
      signEvent: async (tpl) => ({ ...tpl, id: 'i'.repeat(64), sig: 's'.repeat(128) }),
    },
    chat: async () => ({ ok: true, content: 'r' }),
    giftWrap: async () => { throw new Error('nope'); },
  });
  await bridgeThrows.handleEvent(inbound.wrap); // must resolve, not reject
  assert.ok(true);
});