/**
 * NWC-issued invoice top-up (v0.2.83-alpha) — onboarding.nwcMakeInvoice /
 * nwcLookupInvoice.
 *
 * Uses a REAL secretstore over a temp dir plus a fake NWC client (no relay /
 * network). Verifies: amount validation + cap, the pay_invoice/make_invoice
 * capability gate, that a settlement marker is persisted by payment_hash, and
 * that no bolt11/secret leaks into the response beyond the invoice the caller
 * needs. Mirrors onboarding.test.js's harness.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretStore } from '../lib/secretstore.mjs';
import { createOnboarding } from '../core/onboarding.mjs';
import { buildCapabilityMatrix } from '../core/nwc.mjs';

const SESSION = 'a'.repeat(64);
const WP = 'ab'.repeat(32);
const SK = 'cd'.repeat(32);
const NWC_URI = `nostr+walletconnect://${WP}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${SK}`;

function tmp() { return mkdtempSync(join(tmpdir(), 'torii-nwcinv-')); }

// Fake NWC client factory. `methods` controls the advertised capability matrix;
// makeInvoice/lookupInvoice return canned, non-secret shapes.
function fakeConnect({ methods = ['pay_invoice', 'make_invoice', 'lookup_invoice', 'get_info'], paid = false } = {}) {
  return async () => ({
    async getInfo() {
      return { ok: true, ...buildCapabilityMatrix(methods), alias: 'test wallet', network: 'bitcoin' };
    },
    async makeInvoice({ amountSats }) {
      return { ok: true, invoice: 'lnbc_fake_invoice', payment_hash: 'ph_deadbeef', amount_sats: amountSats, expiry: 3600 };
    },
    async lookupInvoice() {
      return { ok: true, paid, state: paid ? 'PAID' : 'UNPAID', settled_at: paid ? 123 : null };
    },
    close() {},
  });
}

function fakeProvider() {
  return {
    providerHost: 'https://api.routstr.com',
    bounds: { min: 10, max: 10000 },
    checkAmountBounds(sats) { return { ok: true, sats }; },
    async verifyKey() { return { ok: true }; },
    async listModels() { return { ok: true, count: 0, models: [] }; },
    async createInvoice() { return { ok: true }; },
    async pollInvoice() { return { ok: true }; },
    async recoverInvoice() { return { ok: true }; },
  };
}

function build(dir, { connectNwc, nwcInvoices } = {}) {
  const secretStore = createSecretStore({ session_secret: SESSION }, { dir });
  const onboarding = createOnboarding({
    secretStore,
    routstrProvider: fakeProvider(),
    connectNwc: connectNwc || fakeConnect(),
    nwcInvoices,
    log: { info() {}, warn() {}, error() {} },
  });
  return { secretStore, onboarding };
}

async function connectWallet(onboarding, methods) {
  const r = await onboarding.walletConnect({ nwcUri: NWC_URI });
  assert.equal(r.code, 200, 'precondition: wallet connects');
  return r;
}

test('nwcMakeInvoice rejects a non-positive amount', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await connectWallet(onboarding);
    const r = await onboarding.nwcMakeInvoice({ amountSats: 0 });
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /positive integer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcMakeInvoice enforces the max cap', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await connectWallet(onboarding);
    const r = await onboarding.nwcMakeInvoice({ amountSats: 5000, maxSats: 1000 });
    assert.equal(r.code, 400);
    assert.match(r.body.error, /exceeds the max of 1000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcMakeInvoice returns 409 when no wallet is connected', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.nwcMakeInvoice({ amountSats: 1000 });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /no wallet connected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcMakeInvoice is gated on the make_invoice capability', async () => {
  const dir = tmp();
  try {
    // Wallet advertises pay_invoice but NOT make_invoice.
    const { onboarding } = build(dir, { connectNwc: fakeConnect({ methods: ['pay_invoice', 'get_info'] }) });
    await connectWallet(onboarding);
    const r = await onboarding.nwcMakeInvoice({ amountSats: 1000 });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /cannot make invoices/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcMakeInvoice issues an invoice and persists a settlement marker', async () => {
  const dir = tmp();
  try {
    const saved = [];
    const nwcInvoices = { async save(hash, data) { saved.push({ hash, data }); } };
    const { onboarding } = build(dir, { nwcInvoices });
    await connectWallet(onboarding);
    const r = await onboarding.nwcMakeInvoice({ amountSats: 2100, memo: 'top up' });
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.invoice, 'lnbc_fake_invoice');
    assert.equal(r.body.payment_hash, 'ph_deadbeef');
    assert.equal(r.body.amount_sats, 2100);
    // Marker saved keyed by payment hash so the poll route can find it.
    assert.equal(saved.length, 1);
    assert.equal(saved[0].hash, 'ph_deadbeef');
    assert.equal(saved[0].data.amount_sats, 2100);
    // The response must not leak the connection secret.
    assert.ok(!JSON.stringify(r.body).includes(SK));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcLookupInvoice reports UNPAID then PAID', async () => {
  const dir = tmp();
  try {
    const unpaid = build(dir, { connectNwc: fakeConnect({ paid: false }) });
    await connectWallet(unpaid.onboarding);
    const u = await unpaid.onboarding.nwcLookupInvoice({ paymentHash: 'ph_deadbeef' });
    assert.equal(u.code, 200);
    assert.equal(u.body.paid, false);
    assert.equal(u.body.state, 'UNPAID');

    // Fresh onboarding wired to a wallet that now reports the invoice settled.
    const paid = build(dir, { connectNwc: fakeConnect({ paid: true }) });
    const p = await paid.onboarding.nwcLookupInvoice({ paymentHash: 'ph_deadbeef' });
    assert.equal(p.code, 200);
    assert.equal(p.body.paid, true);
    assert.equal(p.body.state, 'PAID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nwcLookupInvoice requires a payment hash', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await connectWallet(onboarding);
    const r = await onboarding.nwcLookupInvoice({ paymentHash: '' });
    assert.equal(r.code, 400);
    assert.match(r.body.error, /payment hash required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
