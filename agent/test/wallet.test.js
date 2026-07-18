/**
 * Cashu wallet — offline guard + failure-path coverage.
 *
 * These tests never touch a live mint or the network: the wallet is built with
 * zero configured mints, so no Wallet.loadMint() / receive() / send()
 * network call is ever reached. They pin the error/rejection paths in
 * core/wallet.mjs AND act as a regression guard that the @cashu/cashu-ts token
 * codec (getEncodedToken / getDecodedToken) still returns the { mint, proofs }
 * shape wallet.mjs depends on after the dependency-tree bump.
 *
 * No proofs, secrets, or tokens are logged — the fixtures use dummy field
 * values only.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { createWallet } from '../core/wallet.mjs';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

// A structurally valid token for a mint the wallet does NOT whitelist. Built
// via the real cashu-ts encoder so the whitelist gate is exercised against a
// genuinely decodable token, not a hand-rolled string. Dummy proof material.
function tokenForMint(mint) {
  const C = '02' + 'ab'.repeat(32); // 66-hex compressed-point placeholder
  return getEncodedToken({ mint, proofs: [{ id: '009a1f293253e41e', amount: 2, secret: 'deadbeef', C }] });
}

const noMintsCfg = { cashu: { mints: [] } };

test('createWallet with no mints exposes an empty mint list', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  assert.deepEqual(wallet.mints, []);
});

test('balance() with no mints is zero', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  const b = await wallet.balance();
  assert.equal(b.total, 0);
  assert.deepEqual(b.per_mint, {});
});

test('send() rejects sub-satoshi amounts before any mint call', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  const r = await wallet.send(0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /sats must be >= 1/);
});

test('send() with no funded mint returns insufficient balance', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  const r = await wallet.send(10);
  assert.equal(r.ok, false);
  assert.match(r.reason, /insufficient balance/);
});

test('receive() rejects a malformed token encoding', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  const r = await wallet.receive('not-a-cashu-token');
  assert.equal(r.ok, false);
  assert.match(r.reason, /bad token encoding/);
});

test('receive() rejects a token whose mint is not whitelisted', async () => {
  const wallet = await createWallet(noMintsCfg, silentLog());
  const r = await wallet.receive(tokenForMint('https://mint.not-allowed.example'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not whitelisted/);
});

test('cashu-ts token codec still round-trips the { mint, proofs } shape', () => {
  const mint = 'https://mint.example.com';
  const decoded = getDecodedToken(tokenForMint(mint));
  assert.equal(decoded.mint, mint);
  assert.ok(Array.isArray(decoded.proofs));
  assert.equal(decoded.proofs.length, 1);
});

// Regression: with a HEX keyset id (as Minibits/Coinos use) and NO version
// option, cashu-ts 3.7.1 defaults to cashuB v4 — which crashes Routstr's melt
// step (Cloudflare 520). wallet.send() must pin version:3 → cashuA. This pins
// both the buggy default AND the fix so a future dependency bump can't silently
// flip the wire format back to v4.
test('getEncodedToken version:3 forces cashuA v3 for a hex-keyset mint', () => {
  const C = '02' + 'ab'.repeat(32);
  const token = {
    mint: 'https://mint.minibits.cash/Bitcoin',
    unit: 'sat',
    proofs: [{ id: '009a1f293253e41e', amount: 1, secret: 'deadbeef', C }],
  };
  // Unversioned default is v4 (the bug) for a hex keyset id.
  assert.ok(getEncodedToken(token).startsWith('cashuB'), 'default encoding is v4 cashuB for a hex keyset');
  // version:3 is the fix wallet.send() applies.
  assert.ok(getEncodedToken(token, { version: 3 }).startsWith('cashuA'), 'version:3 must produce cashuA v3');
});
