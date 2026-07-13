/**
 * nwc.mjs — NIP-47 URI parsing, redaction, capability parsing, and the
 * transport-injected client. No relay/WebSocket is touched: the client is
 * driven by a fake transport so request/response orchestration is verified
 * offline. All fixtures are dummy hex.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNwcUri,
  redactNwc,
  buildCapabilityMatrix,
  createNwcClient,
} from '../core/nwc.mjs';

const WP = 'ab'.repeat(32); // 64-hex wallet pubkey
const SK = 'cd'.repeat(32); // 64-hex secret
function uri({ pk = WP, relays = ['wss://relay.example.com'], secret = SK } = {}) {
  const q = relays.map((r) => `relay=${encodeURIComponent(r)}`).join('&') + `&secret=${secret}`;
  return `nostr+walletconnect://${pk}?${q}`;
}

test('parses a well-formed NWC URI', () => {
  const p = parseNwcUri(uri());
  assert.equal(p.ok, true);
  assert.equal(p.walletPubkey, WP);
  assert.equal(p.secret, SK);
  assert.equal(p.relays.length, 1);
});

test('parses multiple relays', () => {
  const p = parseNwcUri(uri({ relays: ['wss://a.example', 'wss://b.example'] }));
  assert.equal(p.ok, true);
  assert.equal(p.relays.length, 2);
});

test('rejects wrong scheme, missing relay, bad secret, bad pubkey, non-ws relay', () => {
  assert.equal(parseNwcUri('https://x').ok, false);
  assert.equal(parseNwcUri('').ok, false);
  assert.equal(parseNwcUri(`nostr+walletconnect://${WP}?secret=${SK}`).ok, false); // no relay
  assert.equal(parseNwcUri(`nostr+walletconnect://${WP}?relay=wss://x`).ok, false); // no secret
  assert.equal(parseNwcUri(uri({ secret: 'zz' })).ok, false); // short/non-hex secret
  assert.equal(parseNwcUri(uri({ pk: 'xy' })).ok, false); // bad pubkey
  assert.equal(parseNwcUri(uri({ relays: ['http://not-a-relay'] })).ok, false); // non-ws
});

test('redactNwc never exposes the secret or the full uri', () => {
  const r = redactNwc(uri());
  const s = JSON.stringify(r);
  assert.ok(!s.includes(SK), 'secret must not appear');
  assert.ok(!s.includes(WP), 'full pubkey must not appear (prefix only)');
  assert.equal(r.wallet_pubkey_prefix.length, 12);
  assert.deepEqual(r.relays, ['relay.example.com']);
  assert.equal(r.relay_count, 1);
  assert.match(r.secret_fingerprint, /^[0-9a-f]{12}$/);
});

test('redactNwc returns null for an unparseable input', () => {
  assert.equal(redactNwc('nope'), null);
});

test('capability matrix gates funding on pay_invoice', () => {
  const with_ = buildCapabilityMatrix(['pay_invoice', 'get_info', 'make_invoice']);
  assert.equal(with_.can_fund_routstr, true);
  assert.equal(with_.can_pay_invoice, true);
  assert.equal(with_.can_make_invoice, true);
  assert.equal(with_.can_get_balance, false);

  const without = buildCapabilityMatrix(['get_info', 'get_balance']);
  assert.equal(without.can_fund_routstr, false);
  assert.equal(without.can_pay_invoice, false);
  assert.equal(without.can_get_balance, true);

  assert.equal(buildCapabilityMatrix(null).can_fund_routstr, false);
});

function fakeTransport(handlers) {
  return {
    calls: [],
    async request({ method, params, timeoutMs }) {
      this.calls.push({ method, params, timeoutMs });
      return handlers[method] ? handlers[method](params) : { ok: false, code: 'NOT_IMPLEMENTED' };
    },
    async capabilities() {
      return handlers.__caps ? handlers.__caps() : { ok: false };
    },
    closed: false,
    close() { this.closed = true; },
  };
}

test('client.getInfo reads methods from the get_info result', async () => {
  const t = fakeTransport({
    get_info: () => ({ ok: true, result: { alias: 'my wallet', network: 'bitcoin', methods: ['pay_invoice', 'get_info'] } }),
  });
  const client = createNwcClient(parseNwcUri(uri()), { transport: t });
  const info = await client.getInfo();
  assert.equal(info.ok, true);
  assert.equal(info.can_fund_routstr, true);
  assert.equal(info.alias, 'my wallet');
  assert.equal(info.network, 'bitcoin');
});

test('client.getInfo falls back to the 13194 capabilities list', async () => {
  const t = fakeTransport({
    get_info: () => ({ ok: true, result: { alias: 'w' } }), // no methods echoed
    __caps: () => ({ ok: true, methods: ['pay_invoice', 'make_invoice'] }),
  });
  const client = createNwcClient(parseNwcUri(uri()), { transport: t });
  const info = await client.getInfo();
  assert.equal(info.ok, true);
  assert.deepEqual(info.methods.sort(), ['make_invoice', 'pay_invoice']);
  assert.equal(info.can_pay_invoice, true);
});

test('client.payInvoice returns a preimage on success and sanitises failure', async () => {
  const okT = fakeTransport({ pay_invoice: () => ({ ok: true, result: { preimage: 'deadbeef', fees_paid: 1000 } }) });
  const okClient = createNwcClient(parseNwcUri(uri()), { transport: okT });
  const paid = await okClient.payInvoice('lnbc1...');
  assert.equal(paid.ok, true);
  assert.equal(paid.preimage, 'deadbeef');
  assert.equal(paid.fees_paid_msat, 1000);

  const failT = fakeTransport({ pay_invoice: () => ({ ok: false, code: 'INSUFFICIENT_BALANCE' }) });
  const failClient = createNwcClient(parseNwcUri(uri()), { transport: failT });
  const failed = await failClient.payInvoice('lnbc1...');
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /INSUFFICIENT_BALANCE/);
  // The reason is a bounded label, never a raw upstream body.
  assert.ok(!failed.reason.includes('{'));
});

test('client.payInvoice requires a non-empty invoice', async () => {
  const client = createNwcClient(parseNwcUri(uri()), { transport: fakeTransport({}) });
  const r = await client.payInvoice('');
  assert.equal(r.ok, false);
  assert.match(r.reason, /invoice/);
});

test('createNwcClient requires a valid parse + transport', () => {
  assert.throws(() => createNwcClient({ ok: false }, { transport: {} }), /valid parseNwcUri/);
  assert.throws(() => createNwcClient(parseNwcUri(uri()), {}), /transport/);
});
