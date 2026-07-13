/**
 * onboarding.mjs — the agent-side logic for the wallet (Step 2) and Routstr
 * (Step 3) onboarding steps. Framework-agnostic: each method returns
 * { code, body } so index.mjs can wrap it in a thin Fastify route and tests can
 * call it directly with injected dependencies (no live relay, no live HTTP).
 *
 * SECRET DISCIPLINE (the whole point of this module)
 *   • The NWC URI and the Routstr sk- key enter ONLY through connect/key and
 *     leave the process ONLY as ciphertext (secretstore) or as NIP-04/HTTPS to
 *     their own service. No method ever returns a full URI or full key — only
 *     redactNwc()/redactRoutstrKey() shapes.
 *   • Stored payloads are JSON envelopes encrypted by secretstore. We keep the
 *     capability matrix / balance metadata alongside the secret so status and
 *     pay can answer without a re-connect, and so it all survives a restart
 *     under one encrypted blob.
 *   • The Routstr *payment* path is a hard confirmation boundary: routstrPay()
 *     refuses unless the caller passes confirm===true AND the connected wallet
 *     advertises pay_invoice. There is no autonomous spend anywhere.
 *
 * DEPENDENCY INJECTION
 *   connectNwc(parsed) → Promise<nwcClient>  builds a live NIP-47 client (or a
 *     fake in tests). May throw when the runtime can't support the live path
 *     (e.g. no global WebSocket) — we translate that into a 503.
 *   nwcClient: { getInfo(), payInvoice(invoice), close() }
 */

import { parseNwcUri, redactNwc } from './nwc.mjs';

const NWC_SECRET = 'nwc';
const ROUTSTR_SECRET = 'routstr_key';
const ROUTSTR_PENDING = 'routstr_pending';

export function createOnboarding(deps = {}) {
  const { secretStore, routstrProvider, connectNwc } = deps;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  if (!secretStore) throw new Error('createOnboarding: secretStore required');
  if (!routstrProvider) throw new Error('createOnboarding: routstrProvider required');
  if (typeof connectNwc !== 'function') throw new Error('createOnboarding: connectNwc required');

  async function loadEnvelope(name) {
    let raw;
    try {
      raw = await secretStore.get(name);
    } catch (e) {
      // Fail closed: a tampered/rotated blob is treated as "not usable".
      log.warn(`[onboarding] ${name} unreadable: ${e.message.split(':').slice(-1)[0].trim()}`);
      return { error: 'unreadable' };
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { error: 'corrupt' };
    }
  }

  // ── Step 2: wallet (NWC) ───────────────────────────────────────────────

  async function walletConnect({ nwcUri } = {}) {
    const parsed = parseNwcUri(nwcUri);
    if (!parsed.ok) {
      // parsed.reason is a structural message with NO secret material.
      return { code: 400, body: { ok: false, error: parsed.reason } };
    }

    let client;
    try {
      client = await connectNwc(parsed);
    } catch (e) {
      log.warn(`[onboarding] live NWC transport unavailable: ${e.message}`);
      return {
        code: 503,
        body: { ok: false, error: 'live NWC path unavailable on this runtime' },
      };
    }

    let info;
    try {
      info = await client.getInfo();
    } finally {
      await client.close?.();
    }
    if (!info.ok) {
      return { code: 502, body: { ok: false, error: 'wallet did not respond to get_info' } };
    }

    const capabilities = {
      methods: info.methods,
      matrix: info.matrix,
      can_pay_invoice: info.can_pay_invoice,
      can_make_invoice: info.can_make_invoice,
      can_lookup_invoice: info.can_lookup_invoice,
      can_get_balance: info.can_get_balance,
      can_fund_routstr: info.can_fund_routstr,
    };

    const envelope = {
      uri: nwcUri.trim(),
      capabilities,
      alias: info.alias || null,
      network: info.network || null,
      connected_at: new Date().toISOString(),
    };
    await secretStore.put(NWC_SECRET, JSON.stringify(envelope));

    return {
      code: 200,
      body: {
        ok: true,
        wallet: redactNwc(parsed),
        capabilities,
        can_fund_routstr: capabilities.can_fund_routstr,
        // Honest, non-blocking notice: connection succeeded even without
        // pay_invoice, but Routstr funding-by-payment stays gated.
        notice: capabilities.can_pay_invoice
          ? null
          : 'Wallet connected, but it does not advertise pay_invoice — Routstr funding by payment is disabled for this wallet.',
      },
    };
  }

  async function walletStatus() {
    const env = await loadEnvelope(NWC_SECRET);
    if (env === null) return { code: 200, body: { connected: false } };
    if (env.error) return { code: 200, body: { connected: false, error: env.error } };
    const parsed = parseNwcUri(env.uri);
    return {
      code: 200,
      body: {
        connected: true,
        wallet: parsed.ok ? redactNwc(parsed) : null,
        capabilities: env.capabilities || null,
        can_fund_routstr: env.capabilities?.can_fund_routstr === true,
        alias: env.alias || null,
        network: env.network || null,
        connected_at: env.connected_at || null,
      },
    };
  }

  async function walletDisconnect() {
    const res = await secretStore.remove(NWC_SECRET);
    return { code: 200, body: { ok: true, removed: res.removed } };
  }

  // Re-run get_info against the stored wallet and refresh cached capabilities.
  async function walletTest() {
    const env = await loadEnvelope(NWC_SECRET);
    if (env === null || env.error) {
      return { code: 409, body: { ok: false, error: 'no wallet connected' } };
    }
    const parsed = parseNwcUri(env.uri);
    if (!parsed.ok) return { code: 409, body: { ok: false, error: 'stored wallet is unusable' } };

    let client;
    try {
      client = await connectNwc(parsed);
    } catch {
      return { code: 503, body: { ok: false, error: 'live NWC path unavailable on this runtime' } };
    }
    let info;
    try {
      info = await client.getInfo();
    } finally {
      await client.close?.();
    }
    if (!info.ok) return { code: 502, body: { ok: false, error: 'wallet did not respond to get_info' } };

    const capabilities = {
      methods: info.methods,
      matrix: info.matrix,
      can_pay_invoice: info.can_pay_invoice,
      can_make_invoice: info.can_make_invoice,
      can_lookup_invoice: info.can_lookup_invoice,
      can_get_balance: info.can_get_balance,
      can_fund_routstr: info.can_fund_routstr,
    };
    await secretStore.put(NWC_SECRET, JSON.stringify({ ...env, capabilities, tested_at: new Date().toISOString() }));
    return {
      code: 200,
      body: { ok: true, wallet: redactNwc(parsed), capabilities, can_fund_routstr: capabilities.can_fund_routstr },
    };
  }

  // ── Step 3: Routstr ────────────────────────────────────────────────────

  // Verify a key against the provider, store it encrypted, and return the
  // redacted 200 body. Shared by the existing-key path and the funding path so
  // both persist an identical envelope shape. `funded` supplies a fallback
  // balance (the sats just paid) when the provider's balance read is not yet
  // conclusive right after minting.
  async function storeVerifiedKey(key, source, { fundedSats = null } = {}) {
    const verified = await routstrProvider.verifyKey(key);
    if (!verified.ok) return { ok: false, reason: verified.reason };
    const balanceSats = verified.balance_sats ?? fundedSats;
    const envelope = {
      key,
      redacted: { key_preview: verified.key_preview, key_fingerprint: verified.key_fingerprint },
      balance_sats: balanceSats,
      models_available: verified.models_available,
      capabilities: verified.capabilities || {},
      source,
      connected_at: new Date().toISOString(),
    };
    await secretStore.put(ROUTSTR_SECRET, JSON.stringify(envelope));
    return { ok: true, envelope, balance_sats: balanceSats, verified };
  }

  async function routstrKey({ key } = {}) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      return { code: 400, body: { ok: false, error: 'key required' } };
    }
    const stored = await storeVerifiedKey(key.trim(), 'existing_key');
    if (!stored.ok) return { code: 400, body: { ok: false, error: stored.reason } };
    return {
      code: 200,
      body: {
        ok: true,
        routstr: stored.envelope.redacted,
        balance_sats: stored.balance_sats,
        models_available: stored.verified.models_available,
        capabilities: stored.verified.capabilities || {},
        provider_host: routstrProvider.providerHost,
      },
    };
  }

  async function routstrStatus() {
    const env = await loadEnvelope(ROUTSTR_SECRET);
    if (env === null) return { code: 200, body: { connected: false } };
    if (env.error) return { code: 200, body: { connected: false, error: env.error } };
    return {
      code: 200,
      body: {
        connected: true,
        routstr: env.redacted || null,
        balance_sats: env.balance_sats ?? null,
        models_available: env.models_available ?? null,
        source: env.source || null,
        connected_at: env.connected_at || null,
      },
    };
  }

  async function routstrDisconnect() {
    const res = await secretStore.remove(ROUTSTR_SECRET);
    await secretStore.remove(ROUTSTR_PENDING);
    return { code: 200, body: { ok: true, removed: res.removed } };
  }

  async function routstrModels() {
    const res = await routstrProvider.listModels();
    if (!res.ok) return { code: 502, body: { ok: false, error: res.reason } };
    return { code: 200, body: { ok: true, count: res.count, models: res.models } };
  }

  // Quote a funding invoice via POST /lightning/invoice (purpose "create" —
  // fund a fresh session, no key yet). Returns 501 (blocked) only if an operator
  // explicitly disabled invoice_path. This NEVER pays. The pending quote
  // (invoice_id + bolt11) is stashed encrypted so pay/recover can retrieve the
  // minted key even if the browser loses the quote_id.
  async function routstrQuote({ amountSats } = {}) {
    const bounds = routstrProvider.checkAmountBounds(amountSats);
    if (!bounds.ok) return { code: 400, body: { ok: false, error: bounds.reason, bounds: routstrProvider.bounds } };
    const quote = await routstrProvider.createInvoice({ amountSats, purpose: 'create' });
    if (quote.blocked) {
      return {
        code: 501,
        body: { ok: false, blocked: true, reason: quote.reason, guidance: quote.guidance, bounds: routstrProvider.bounds },
      };
    }
    if (!quote.ok) return { code: 502, body: { ok: false, error: quote.reason } };

    await secretStore.put(ROUTSTR_PENDING, JSON.stringify({
      quote_id: quote.quote_id,
      bolt11: quote.invoice,
      amount_sats: quote.amount_sats,
      purpose: quote.purpose,
      expires_at: quote.expires_at,
      created_at: new Date().toISOString(),
    }));

    return {
      code: 200,
      body: {
        ok: true,
        invoice: quote.invoice,
        amount_sats: quote.amount_sats,
        provider_host: quote.provider_host,
        quote_id: quote.quote_id,
        payment_hash: quote.payment_hash,
        expires_at: quote.expires_at,
        // The frontend MUST show this and require an explicit confirm before
        // calling routstrPay. No payment happens here.
        requires_confirmation: true,
      },
    };
  }

  // Pay a quoted invoice via the connected NWC wallet, THEN poll the provider
  // for the minted sk- key and store it. HARD confirmation boundary: refuses
  // unless confirm===true and the wallet can pay_invoice. If the wallet pays but
  // key retrieval times out, returns a precise RECOVERABLE state (200,
  // recoverable:true) carrying the bolt11 — the payment is real and the key can
  // be claimed later via routstrRecover; we never lose the operator's sats.
  async function routstrPay({ invoice, quoteId, confirm } = {}) {
    if (confirm !== true) {
      return { code: 400, body: { ok: false, error: 'explicit confirmation required', code: 'confirmation_required' } };
    }
    // Fall back to the stashed pending quote so the browser need only send the
    // confirm flag.
    const pending = await loadEnvelope(ROUTSTR_PENDING);
    const bolt11 = (typeof invoice === 'string' && invoice.trim()) || pending?.bolt11 || null;
    const qid = (typeof quoteId === 'string' && quoteId) || pending?.quote_id || null;
    const fundedSats = pending?.amount_sats ?? null;
    if (!bolt11) return { code: 400, body: { ok: false, error: 'invoice (bolt11) required' } };

    const env = await loadEnvelope(NWC_SECRET);
    if (env === null || env.error) {
      return { code: 409, body: { ok: false, error: 'no wallet connected' } };
    }
    if (env.capabilities?.can_pay_invoice !== true) {
      return { code: 409, body: { ok: false, error: 'connected wallet cannot pay invoices' } };
    }
    const parsed = parseNwcUri(env.uri);
    if (!parsed.ok) return { code: 409, body: { ok: false, error: 'stored wallet is unusable' } };

    let client;
    try {
      client = await connectNwc(parsed);
    } catch {
      return { code: 503, body: { ok: false, error: 'live NWC path unavailable on this runtime' } };
    }
    let paid;
    try {
      paid = await client.payInvoice(bolt11);
    } finally {
      await client.close?.();
    }
    if (!paid.ok) return { code: 502, body: { ok: false, error: paid.reason } };
    log.info('[onboarding] routstr invoice paid via NWC');

    // Payment settled from the wallet's side. Now claim the minted key.
    if (qid) {
      const claimed = await routstrProvider.pollInvoice({ quoteId: qid });
      if (claimed.ok && claimed.key) {
        const stored = await storeVerifiedKey(claimed.key, 'funded_session', { fundedSats });
        await secretStore.remove(ROUTSTR_PENDING);
        if (stored.ok) {
          return {
            code: 200,
            body: {
              ok: true,
              preimage: paid.preimage || null,
              routstr: stored.envelope.redacted,
              balance_sats: stored.balance_sats,
              key_stored: true,
              provider_host: routstrProvider.providerHost,
            },
          };
        }
        // Key claimed but verify/store hiccuped — still recoverable.
        return {
          code: 200,
          body: { ok: true, preimage: paid.preimage || null, key_stored: false, recoverable: true, reason: stored.reason, bolt11 },
        };
      }
      // Paid, but the key isn't retrievable yet (watcher lag / poll timeout).
      return {
        code: 200,
        body: {
          ok: true,
          preimage: paid.preimage || null,
          key_stored: false,
          recoverable: true,
          reason: claimed.reason || 'key not yet issued',
          bolt11,
        },
      };
    }
    return { code: 200, body: { ok: true, preimage: paid.preimage || null, key_stored: false, recoverable: true, reason: 'no quote id to claim key', bolt11 } };
  }

  // Claim (or re-claim) the minted key for an already-paid invoice via
  // POST /lightning/recover — the precise recoverable path when routstrPay
  // reported recoverable:true. Idempotent: safe to call repeatedly until the
  // provider's watcher has credited and issued the key.
  async function routstrRecover({ bolt11 } = {}) {
    const pending = await loadEnvelope(ROUTSTR_PENDING);
    const inv = (typeof bolt11 === 'string' && bolt11.trim()) || pending?.bolt11 || null;
    const fundedSats = pending?.amount_sats ?? null;
    if (!inv) return { code: 400, body: { ok: false, error: 'bolt11 required' } };

    const rec = await routstrProvider.recoverInvoice({ bolt11: inv });
    if (rec.blocked) return { code: 501, body: { ok: false, blocked: true, reason: rec.reason } };
    if (rec.ok && rec.key) {
      const stored = await storeVerifiedKey(rec.key, 'funded_session', { fundedSats });
      await secretStore.remove(ROUTSTR_PENDING);
      if (!stored.ok) return { code: 502, body: { ok: false, error: stored.reason } };
      return {
        code: 200,
        body: {
          ok: true,
          routstr: stored.envelope.redacted,
          balance_sats: stored.balance_sats,
          key_stored: true,
          provider_host: routstrProvider.providerHost,
        },
      };
    }
    // Not settled yet — honest, non-terminal.
    return { code: 202, body: { ok: false, recoverable: true, status: rec.status || 'pending', reason: rec.reason || 'invoice not yet settled' } };
  }

  return {
    walletConnect,
    walletStatus,
    walletDisconnect,
    walletTest,
    routstrKey,
    routstrStatus,
    routstrDisconnect,
    routstrModels,
    routstrQuote,
    routstrPay,
    routstrRecover,
  };
}
