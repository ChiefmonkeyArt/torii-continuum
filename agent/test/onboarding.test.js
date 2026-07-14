/**
 * onboarding.mjs — the agent-side wallet (Step 2) + Routstr (Step 3) logic.
 *
 * Uses a REAL secretstore over a temp dir (so encryption + restart persistence
 * are exercised end to end) plus a fake NWC client and a fake Routstr provider
 * (so no relay/network is touched). Verifies the secret invariants the slice
 * requires: no URI/key ever crosses the response boundary, secrets survive a
 * simulated restart as ciphertext, the pay path is a hard confirmation
 * boundary, and funding is gated on pay_invoice.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecretStore } from '../lib/secretstore.mjs';
import { createOnboarding } from '../core/onboarding.mjs';
import { buildCapabilityMatrix } from '../core/nwc.mjs';

const SESSION = 'a'.repeat(64);
const WP = 'ab'.repeat(32);
const SK = 'cd'.repeat(32);
const NWC_URI = `nostr+walletconnect://${WP}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${SK}`;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'torii-onb-'));
}

// A fake NWC client factory. `methods` controls advertised capabilities.
function fakeConnect({ methods = ['pay_invoice', 'get_info'], payResult } = {}) {
  return async () => ({
    async getInfo() {
      return { ok: true, ...buildCapabilityMatrix(methods), alias: 'test wallet', network: 'bitcoin' };
    },
    async payInvoice() {
      return payResult || { ok: true, preimage: 'deadbeef' };
    },
    close() {},
  });
}

function fakeProvider(overrides = {}) {
  return {
    providerHost: 'https://api.routstr.com',
    bounds: { min: 10, max: 10000 },
    checkAmountBounds(sats) {
      if (!Number.isInteger(sats)) return { ok: false, reason: 'integer required' };
      if (sats < 10) return { ok: false, reason: 'too low' };
      if (sats > 10000) return { ok: false, reason: 'too high' };
      return { ok: true, sats };
    },
    async verifyKey(key) {
      if (overrides.verifyKey) return overrides.verifyKey(key);
      return { ok: true, key_preview: `sk-…${key.slice(-4)}`, key_fingerprint: 'abc123abc123', balance_sats: 500, models_available: 3, capabilities: {} };
    },
    async listModels() { return { ok: true, count: 1, models: [{ id: 'm' }] }; },
    // Source-grounded default: invoice creation is ENABLED (POST /lightning/invoice
    // with purpose "create"). A blocked result only appears when an operator
    // explicitly nulls invoice_path — exercised via an override below.
    async createInvoice({ amountSats, purpose }) {
      if (overrides.createInvoice) return overrides.createInvoice({ amountSats, purpose });
      return { ok: true, invoice: 'lnbc_fake', amount_sats: amountSats, provider_host: 'https://api.routstr.com', quote_id: 'inv_fake', payment_hash: 'ph_fake', expires_at: 1893456000, purpose: purpose || 'create' };
    },
    async pollInvoice({ quoteId }) {
      if (overrides.pollInvoice) return overrides.pollInvoice({ quoteId });
      return { ok: true, key: 'sk-minted12345678', status: 'paid', key_preview: 'sk-…5678', key_fingerprint: 'def456def456' };
    },
    async recoverInvoice({ bolt11 }) {
      if (overrides.recoverInvoice) return overrides.recoverInvoice({ bolt11 });
      return { ok: true, key: 'sk-recovered0000', status: 'paid', key_preview: 'sk-…0000', key_fingerprint: 'aaa000aaa000' };
    },
    ...overrides,
  };
}

function build(dir, { connectNwc, provider } = {}) {
  const secretStore = createSecretStore({ session_secret: SESSION }, { dir });
  const onboarding = createOnboarding({
    secretStore,
    routstrProvider: provider || fakeProvider(),
    connectNwc: connectNwc || fakeConnect(),
    log: { info() {}, warn() {}, error() {} },
  });
  return { secretStore, onboarding };
}

// ── wallet ────────────────────────────────────────────────────────────────

test('walletConnect stores encrypted + returns redacted, never the URI', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.walletConnect({ nwcUri: NWC_URI });
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.can_fund_routstr, true);
    const s = JSON.stringify(r.body);
    assert.ok(!s.includes(SK), 'secret must never be in the response');
    assert.ok(!s.includes(NWC_URI), 'raw URI must never be in the response');
    assert.equal(r.body.wallet.wallet_pubkey_prefix.length, 12);
    // On disk it is ciphertext with no plaintext URI.
    const enc = readdirSync(dir).find((f) => f.startsWith('nwc'));
    const raw = readFileSync(join(dir, enc), 'utf8');
    assert.ok(!raw.includes(SK) && !raw.includes(NWC_URI), 'store holds ciphertext only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walletConnect rejects a malformed URI (400)', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.walletConnect({ nwcUri: 'not-a-uri' });
    assert.equal(r.code, 400);
    assert.equal(r.body.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walletConnect returns 503 when the live transport is unavailable', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir, {
      connectNwc: async () => { throw new Error('global WebSocket unavailable'); },
    });
    const r = await onboarding.walletConnect({ nwcUri: NWC_URI });
    assert.equal(r.code, 503);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wallet without pay_invoice connects but cannot fund', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir, { connectNwc: fakeConnect({ methods: ['get_info', 'get_balance'] }) });
    const r = await onboarding.walletConnect({ nwcUri: NWC_URI });
    assert.equal(r.code, 200);
    assert.equal(r.body.can_fund_routstr, false);
    assert.match(r.body.notice, /pay_invoice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wallet secret survives a simulated restart (fresh store, same dir+secret)', async () => {
  const dir = tmp();
  try {
    await build(dir).onboarding.walletConnect({ nwcUri: NWC_URI });
    // "Restart": a brand-new store + onboarding over the same dir.
    const { onboarding: after } = build(dir);
    const status = await after.walletStatus();
    assert.equal(status.body.connected, true);
    assert.equal(status.body.can_fund_routstr, true);
    assert.ok(!JSON.stringify(status.body).includes(SK));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walletDisconnect removes the secret', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    const d = await onboarding.walletDisconnect();
    assert.equal(d.body.removed, true);
    assert.equal((await onboarding.walletStatus()).body.connected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Routstr ─────────────────────────────────────────────────────────────

test('routstrKey verifies + stores + returns redacted, never the full key', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.routstrKey({ key: 'sk-livekey999999' });
    assert.equal(r.code, 200);
    assert.ok(!JSON.stringify(r.body).includes('sk-livekey999999'));
    assert.equal(r.body.balance_sats, 500);
    const status = await onboarding.routstrStatus();
    assert.equal(status.body.connected, true);
    assert.ok(!JSON.stringify(status.body).includes('sk-livekey999999'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrKey rejects an invalid key (provider says no)', async () => {
  const dir = tmp();
  try {
    const provider = fakeProvider({ verifyKey: async () => ({ ok: false, reason: 'provider rejected the key (unauthorized)' }) });
    const { onboarding } = build(dir, { provider });
    const r = await onboarding.routstrKey({ key: 'sk-bad' });
    assert.equal(r.code, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrQuote returns an invoice + requires_confirmation by default (never pays)', async () => {
  const dir = tmp();
  try {
    const { onboarding, secretStore } = build(dir);
    const r = await onboarding.routstrQuote({ amountSats: 100 });
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.requires_confirmation, true);
    assert.equal(r.body.invoice, 'lnbc_fake');
    assert.equal(r.body.quote_id, 'inv_fake');
    // The pending quote is stashed encrypted (so pay/recover survive a lost quote_id).
    const pending = JSON.parse(await secretStore.get('routstr_pending'));
    assert.equal(pending.bolt11, 'lnbc_fake');
    assert.equal(pending.amount_sats, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrQuote enforces amount bounds (400)', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    assert.equal((await onboarding.routstrQuote({ amountSats: 5 })).code, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrQuote returns 501 blocked only when the provider path is disabled', async () => {
  const dir = tmp();
  try {
    const provider = fakeProvider({
      createInvoice: async () => ({ ok: false, blocked: true, reason: 'provider_invoice_disabled', guidance: 'disabled' }),
    });
    const { onboarding } = build(dir, { provider });
    const r = await onboarding.routstrQuote({ amountSats: 100 });
    assert.equal(r.code, 501);
    assert.equal(r.body.blocked, true);
    assert.equal(r.body.reason, 'provider_invoice_disabled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── pay path: the hard confirmation boundary ───────────────────────────────

test('routstrPay refuses without explicit confirm', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    const r = await onboarding.routstrPay({ invoice: 'lnbc1...', confirm: false });
    assert.equal(r.code, 400);
    assert.equal(r.body.code, 'confirmation_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrPay refuses when no wallet is connected', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.routstrPay({ invoice: 'lnbc1...', confirm: true });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /no wallet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrPay refuses when the connected wallet cannot pay_invoice', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir, { connectNwc: fakeConnect({ methods: ['get_info'] }) });
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    const r = await onboarding.routstrPay({ invoice: 'lnbc1...', confirm: true });
    assert.equal(r.code, 409);
    assert.match(r.body.error, /cannot pay/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrPay pays via NWC after confirm, polls, stores the minted key redacted', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    // Quote first so the pending bolt11/quote_id is stashed; the browser then
    // only needs to send the confirm flag.
    await onboarding.routstrQuote({ amountSats: 100 });
    const r = await onboarding.routstrPay({ confirm: true });
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.preimage, 'deadbeef');
    assert.equal(r.body.key_stored, true);
    // The minted key never crosses the boundary — only its redaction.
    assert.ok(!JSON.stringify(r.body).includes('sk-minted12345678'));
    assert.equal(r.body.routstr.key_preview, 'sk-…5678');
    // Key is now stored + the pending quote is cleared.
    const status = await onboarding.routstrStatus();
    assert.equal(status.body.connected, true);
    assert.equal(status.body.source, 'funded_session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrPay returns a RECOVERABLE state when the key is not yet mintable', async () => {
  const dir = tmp();
  try {
    const provider = fakeProvider({
      pollInvoice: async () => ({ ok: false, recoverable: true, reason: 'polling timed out before settlement' }),
    });
    const { onboarding } = build(dir, { provider });
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    await onboarding.routstrQuote({ amountSats: 100 });
    const r = await onboarding.routstrPay({ confirm: true });
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.key_stored, false);
    assert.equal(r.body.recoverable, true);
    assert.equal(r.body.bolt11, 'lnbc_fake');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrRecover claims the minted key from the stashed bolt11 and stores it', async () => {
  const dir = tmp();
  try {
    const provider = fakeProvider({
      pollInvoice: async () => ({ ok: false, recoverable: true, reason: 'polling timed out before settlement' }),
    });
    const { onboarding } = build(dir, { provider });
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    await onboarding.routstrQuote({ amountSats: 100 });
    await onboarding.routstrPay({ confirm: true }); // paid, but key not yet mintable
    const r = await onboarding.routstrRecover({});
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.key_stored, true);
    assert.ok(!JSON.stringify(r.body).includes('sk-recovered0000'));
    assert.equal(r.body.routstr.key_preview, 'sk-…0000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrRecover is non-terminal (202) while the invoice is still pending', async () => {
  const dir = tmp();
  try {
    const provider = fakeProvider({
      recoverInvoice: async () => ({ ok: false, recoverable: true, status: 'pending', reason: 'invoice not yet settled' }),
    });
    const { onboarding } = build(dir, { provider });
    const r = await onboarding.routstrRecover({ bolt11: 'lnbc_fake' });
    assert.equal(r.code, 202);
    assert.equal(r.body.recoverable, true);
    assert.equal(r.body.status, 'pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── recovery state (refresh-resume, never re-pays) ─────────────────────────

test('recoveryState reports claimable=true for a paid-but-unclaimed session (survives restart)', async () => {
  const dir = tmp();
  try {
    // Poll times out so the pay leaves a stored pending quote and NO key.
    const provider = fakeProvider({
      pollInvoice: async () => ({ ok: false, recoverable: true, reason: 'polling timed out before settlement' }),
    });
    await (async () => {
      const { onboarding } = build(dir, { provider });
      await onboarding.walletConnect({ nwcUri: NWC_URI });
      await onboarding.routstrQuote({ amountSats: 10000 });
      const paid = await onboarding.routstrPay({ confirm: true });
      assert.equal(paid.body.key_stored, false);
    })();
    // "Restart / refresh": a brand-new store + onboarding over the same dir.
    const { onboarding: after } = build(dir, { provider });
    const st = await after.recoveryState();
    assert.equal(st.code, 200);
    assert.equal(st.body.claimable, true, 'paid-unclaimed must be claimable after refresh');
    assert.equal(st.body.routstr.connected, false);
    assert.equal(st.body.pending.exists, true);
    assert.equal(st.body.pending.amount_sats, 10000);
    // No secret material of any kind in the resume snapshot.
    const s = JSON.stringify(st.body);
    assert.ok(!s.includes(SK) && !s.includes(NWC_URI) && !s.includes('lnbc_fake'), 'resume snapshot leaks no secrets/bolt11');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoveryState reports claimable=false once the key is stored', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    await onboarding.routstrQuote({ amountSats: 100 });
    await onboarding.routstrPay({ confirm: true }); // stores the key, clears pending
    const st = await onboarding.recoveryState();
    assert.equal(st.body.claimable, false);
    assert.equal(st.body.routstr.connected, true);
    assert.equal(st.body.pending, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── recovery kit (safe by default, no secrets) ─────────────────────────────

test('recoveryKit excludes the NWC secret and the full key, includes redacted restoration data', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.walletConnect({ nwcUri: NWC_URI });
    await onboarding.routstrKey({ key: 'sk-livekey999999' });
    const kit = await onboarding.recoveryKit({ adminNpub: 'npub1testadmin', agentVersion: '0.2.37-alpha' });
    assert.equal(kit.code, 200);
    assert.equal(kit.body.includes_secrets, false);
    assert.equal(kit.body.admin_npub, 'npub1testadmin');
    assert.equal(kit.body.agent_version, '0.2.37-alpha');
    assert.equal(kit.body.routstr.connected, true);
    assert.equal(kit.body.wallet.connected, true);
    assert.ok(Array.isArray(kit.body.instructions) && kit.body.instructions.length > 0);
    const s = JSON.stringify(kit.body);
    assert.ok(!s.includes(SK), 'kit must not contain the NWC secret');
    assert.ok(!s.includes(NWC_URI), 'kit must not contain the NWC URI');
    assert.ok(!s.includes('sk-livekey999999'), 'kit must not contain the full Routstr key');
    // Only the redacted preview is present.
    assert.equal(kit.body.routstr.key_preview, 'sk-…9999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── one-time full-key export (explicit, no-store) ──────────────────────────

test('routstrExportKey refuses without explicit confirm', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.routstrKey({ key: 'sk-livekey999999' });
    const r = await onboarding.routstrExportKey({ confirm: false });
    assert.equal(r.code, 400);
    assert.equal(r.body.code, 'confirmation_required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrExportKey refuses when no key is stored (409)', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    const r = await onboarding.routstrExportKey({ confirm: true });
    assert.equal(r.code, 409);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routstrExportKey returns the full key ONLY on explicit confirm, and audits the reveal', async () => {
  const dir = tmp();
  try {
    const { onboarding } = build(dir);
    await onboarding.routstrKey({ key: 'sk-livekey999999' });
    const r = await onboarding.routstrExportKey({ confirm: true });
    assert.equal(r.code, 200);
    assert.equal(r.body.key, 'sk-livekey999999', 'export must return the full key on explicit confirm');
    assert.equal(r.body.one_time, true);
    assert.equal(r.body.no_store, true);
    assert.equal(r.body.export_count, 1);
    // A second reveal increments the audit counter (visible after the fact).
    const r2 = await onboarding.routstrExportKey({ confirm: true });
    assert.equal(r2.body.export_count, 2);
    // Redacted status never exposes the key even after an export.
    const status = await onboarding.routstrStatus();
    assert.ok(!JSON.stringify(status.body).includes('sk-livekey999999'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
