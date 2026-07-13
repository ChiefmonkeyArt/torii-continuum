/**
 * routstr-provider.mjs — pinned, SSRF-safe provider adapter.
 *
 * All HTTP is via an injected fake fetch: no network. Verifies key
 * verification + redaction, SSRF origin pinning, https-only construction,
 * amount bounds, the BLOCKED invoice path (default) + the configured path,
 * response-size cap, redirect refusal, and bounded polling with a fake clock.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutstrProvider, redactRoutstrKey } from '../core/routstr-provider.mjs';

const BASE = 'https://api.routstr.com';
function res(status, jsonObj, headers = {}) {
  const text = jsonObj === undefined ? '' : JSON.stringify(jsonObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    async text() { return text; },
  };
}
function cfg(provider = {}) {
  return { routstr: { endpoint: BASE, provider } };
}

test('construction requires https base_url', () => {
  assert.throws(() => createRoutstrProvider(cfg({ base_url: 'http://insecure.example' }), { fetchImpl: async () => res(200) }), /https/);
});

test('verifyKey returns redacted metadata, never the full key', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization, redirect: opts.redirect });
    if (url.endsWith('/v1/balance/info')) return res(200, { balance: 4200 });
    if (url.endsWith('/v1/models')) return res(200, { data: [{ id: 'a' }, { id: 'b' }] });
    return res(404);
  };
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.verifyKey('sk-abcdef123456');
  assert.equal(r.ok, true);
  assert.equal(r.balance_sats, 4200);
  assert.equal(r.models_available, 2);
  const s = JSON.stringify(r);
  assert.ok(!s.includes('sk-abcdef123456'), 'full key must not appear');
  assert.equal(r.key_preview, 'sk-…3456');
  // Every call carried the pinned origin and redirect:'error'.
  for (const c of seen) {
    assert.ok(c.url.startsWith(BASE), 'pinned origin');
    assert.equal(c.redirect, 'error', 'no redirect following (SSRF)');
  }
});

test('verifyKey rejects a bad key shape before any fetch', async () => {
  let called = false;
  const p = createRoutstrProvider(cfg(), { fetchImpl: async () => { called = true; return res(200); } });
  const r = await p.verifyKey('nope has spaces');
  assert.equal(r.ok, false);
  assert.equal(called, false, 'no network for a malformed key');
});

test('verifyKey surfaces unauthorized without leaking a body', async () => {
  const fetchImpl = async (url) => (url.endsWith('/v1/balance/info') ? res(401, { error: 'secret internal detail' }) : res(401));
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.verifyKey('sk-deadbeef');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unauthorized/);
  assert.ok(!r.reason.includes('secret internal detail'));
});

test('SSRF pin rejects off-origin and protocol-relative paths', () => {
  const p = createRoutstrProvider(cfg(), { fetchImpl: async () => res(200) });
  assert.throws(() => p._pin('https://evil.example/x'));
  assert.throws(() => p._pin('//evil.example/x'));
  assert.throws(() => p._pin('relative/path'));
  // A legit absolute path stays pinned.
  assert.equal(p._pin('/v1/models').origin, BASE);
});

test('amount bounds are enforced', () => {
  const p = createRoutstrProvider(cfg({ min_topup_sats: 10, max_topup_sats: 5000 }), { fetchImpl: async () => res(200) });
  assert.equal(p.checkAmountBounds(5).ok, false);
  assert.equal(p.checkAmountBounds(99999).ok, false);
  assert.equal(p.checkAmountBounds(10.5).ok, false);
  assert.equal(p.checkAmountBounds(100).ok, true);
});

test('createInvoice uses the source-grounded contract by default (purpose create, no auth)', async () => {
  // Verbatim routstr-core InvoiceCreateResponse shape.
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.ok(url.endsWith('/lightning/invoice'), 'default path is /lightning/invoice');
    assert.equal(opts.headers.Authorization, undefined, 'purpose=create sends no bearer');
    assert.deepEqual(JSON.parse(opts.body), { amount_sats: 100, purpose: 'create' });
    return res(200, {
      invoice_id: 'inv_abc123',
      bolt11: 'lnbc100n1pxyz',
      amount_sats: 100,
      expires_at: 1893456000,
      payment_hash: 'ph_deadbeef',
    });
  };
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.createInvoice({ amountSats: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.invoice, 'lnbc100n1pxyz');
  assert.equal(r.quote_id, 'inv_abc123');
  assert.equal(r.payment_hash, 'ph_deadbeef');
  assert.equal(r.expires_at, 1893456000);
  assert.equal(r.amount_sats, 100);
  assert.equal(r.purpose, 'create');
  assert.equal(r.provider_host, BASE);
});

test('createInvoice topup sends the Bearer sk- key; refuses topup without one', async () => {
  let sentAuth;
  const fetchImpl = async (url, opts) => {
    sentAuth = opts.headers.Authorization;
    assert.deepEqual(JSON.parse(opts.body), { amount_sats: 200, purpose: 'topup' });
    return res(200, { invoice_id: 'i2', bolt11: 'lnbc200', amount_sats: 200, expires_at: 1, payment_hash: 'p2' });
  };
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const ok = await p.createInvoice({ amountSats: 200, purpose: 'topup', key: 'sk-existingkey' });
  assert.equal(ok.ok, true);
  assert.equal(sentAuth, 'Bearer sk-existingkey');
  const bad = await p.createInvoice({ amountSats: 200, purpose: 'topup' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /topup requires an existing sk- key/);
});

test('createInvoice is BLOCKED only when invoice_path is explicitly nulled', async () => {
  const p = createRoutstrProvider(cfg({ invoice_path: null }), { fetchImpl: async () => res(200) });
  const r = await p.createInvoice({ amountSats: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'provider_invoice_disabled');
  assert.match(r.guidance, /disabled/);
});

test('response body over the byte cap is refused', async () => {
  const big = 'x'.repeat(200);
  const fetchImpl = async () => res(200, { pad: big }, { 'content-length': String(big.length + 50) });
  const p = createRoutstrProvider(cfg({ max_response_bytes: 32 }), { fetchImpl });
  const r = await p.verifyKey('sk-abc');
  // Both balance + models are refused as oversize → key can't be verified.
  assert.equal(r.ok, false);
});

test('pollInvoice uses the default status path and times out (recoverable) with a fake clock', async () => {
  // Explicitly-nulled status path is the only way to disable polling.
  const blocked = createRoutstrProvider(cfg({ invoice_status_path: null }), { fetchImpl: async () => res(200) });
  assert.equal((await blocked.pollInvoice({ quoteId: 'q1' })).blocked, true);

  // By default (source-grounded /lightning/invoice/{id}/status) polling runs and,
  // when the invoice stays pending, exhausts to a RECOVERABLE timeout.
  let calls = 0;
  const fetchImpl = async (url) => {
    assert.ok(url.endsWith('/lightning/invoice/q1/status'), 'default status path with {id} substituted');
    calls++;
    return res(200, { status: 'pending', api_key: null });
  };
  const p = createRoutstrProvider(cfg({ poll_max_attempts: 3, poll_interval_ms: 1 }), { fetchImpl });
  const r = await p.pollInvoice({ quoteId: 'q1' }, { sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.recoverable, true);
  assert.match(r.reason, /timed out/);
  assert.equal(calls, 3);
});

test('pollInvoice returns the minted key (redacted) once status is paid', async () => {
  const fetchImpl = async () => res(200, { status: 'paid', api_key: 'sk-minted9999' });
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.pollInvoice({ quoteId: 'q1' }, { sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'paid');
  assert.equal(r.key, 'sk-minted9999');
  assert.equal(r.key_preview, 'sk-…9999');
});

test('pollInvoice reports an expired invoice as a terminal, non-recoverable failure', async () => {
  const fetchImpl = async () => res(200, { status: 'expired', api_key: null });
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.pollInvoice({ quoteId: 'q1' }, { sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'expired');
  assert.notEqual(r.recoverable, true);
});

test('recoverInvoice claims the minted key from a bolt11 (source-grounded /lightning/recover)', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, method: opts.method, body: opts.body });
    return res(200, { status: 'paid', api_key: 'sk-recovered4242' });
  };
  const p = createRoutstrProvider(cfg(), { fetchImpl });
  const r = await p.recoverInvoice({ bolt11: 'lnbc100n1pxyz' });
  assert.equal(r.ok, true);
  assert.equal(r.key, 'sk-recovered4242');
  assert.equal(r.key_preview, 'sk-…4242');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith('/lightning/recover'));
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].body), { bolt11: 'lnbc100n1pxyz' });
});

test('recoverInvoice is non-terminal (recoverable) while the invoice is still pending', async () => {
  const p = createRoutstrProvider(cfg(), { fetchImpl: async () => res(200, { status: 'pending', api_key: null }) });
  const r = await p.recoverInvoice({ bolt11: 'lnbc100n1pxyz' });
  assert.equal(r.ok, false);
  assert.equal(r.recoverable, true);
  assert.equal(r.status, 'pending');
});

test('recoverInvoice rejects a malformed bolt11 before any fetch; blocked when path nulled', async () => {
  let called = false;
  const p = createRoutstrProvider(cfg(), { fetchImpl: async () => { called = true; return res(200); } });
  const bad = await p.recoverInvoice({ bolt11: 'not a bolt11' });
  assert.equal(bad.ok, false);
  assert.equal(called, false);

  const disabled = createRoutstrProvider(cfg({ invoice_recover_path: null }), { fetchImpl: async () => res(200) });
  const r = await disabled.recoverInvoice({ bolt11: 'lnbc100n1pxyz' });
  assert.equal(r.blocked, true);
});

test('redactRoutstrKey never returns the full key', () => {
  const r = redactRoutstrKey('sk-supersecretvalue');
  assert.equal(r.key_preview, 'sk-…alue');
  assert.ok(!JSON.stringify(r).includes('supersecret'));
});
