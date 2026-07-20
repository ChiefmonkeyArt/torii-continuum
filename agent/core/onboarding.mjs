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
  // Optional marker store for NWC-issued top-up invoices (v0.2.83-alpha). The
  // agent wires a disk-backed impl (memory/wallet/nwc-invoices/<hash>.json);
  // tests may omit it (default no-op) since the invoice/lookup logic does not
  // depend on the marker — it is an audit record only.
  const nwcInvoices = deps.nwcInvoices && typeof deps.nwcInvoices.save === 'function'
    ? deps.nwcInvoices
    : { async save() {} };
  if (!secretStore) throw new Error('createOnboarding: secretStore required');
  if (!routstrProvider) throw new Error('createOnboarding: routstrProvider required');
  if (typeof connectNwc !== 'function') throw new Error('createOnboarding: connectNwc required');

  // Display balance in whole sats, migrating legacy envelopes on read. Before
  // v0.2.38-alpha the Routstr provider returned its msat balance under
  // `balance_sats`, so a stored envelope with no `balance_units` marker holds
  // MILLISATS and must be divided by 1000 for display. Envelopes written by the
  // fixed code carry `balance_units:'sat'` and are used verbatim. Marker-guarded
  // so the migration only ever touches genuinely-legacy blobs.
  function displayBalanceSats(env) {
    const raw = env?.balance_sats;
    if (!Number.isFinite(raw)) return null;
    if (env.balance_units === 'sat') return raw;
    return Math.floor(raw / 1000);
  }

  // A bounded, secret-safe reason for a thrown error. Only ever logged — never
  // returned over the API. Redacts any long hex run (the NWC secret and wallet
  // pubkey are 64-hex) as defense in depth so a stray interpolated identifier
  // can't reach a log line, and truncates so an upstream message can't flood.
  function sanitizeReason(e) {
    const raw = (e && typeof e.message === 'string' && e.message) || (e && e.name) || 'unknown error';
    return raw.replace(/[0-9a-f]{16,}/gi, '[redacted]').slice(0, 120);
  }

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

    // get_info normally returns { ok:false, ... } on a wallet-side failure, but
    // a live transport can THROW (relay unreachable, encrypt/decrypt failure,
    // JSON parse). An uncaught throw here escapes the route handler and Fastify
    // answers a bare 500 "Internal Server Error". Catch it and fold it into the
    // same sanitized 502 shape the non-throwing failure uses so the frontend
    // treats both identically. The reason is deliberately generic — never the
    // URI/secret (secret-discipline invariant).
    let info;
    try {
      info = await client.getInfo();
    } catch (e) {
      log.warn(`[onboarding] get_info threw: ${sanitizeReason(e)}`);
      info = { ok: false };
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
    } catch (e) {
      log.warn(`[onboarding] get_info threw: ${sanitizeReason(e)}`);
      info = { ok: false };
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

  // ── Lightning-QR top-up: NWC-issued invoice (v0.2.83-alpha) ────────────
  //
  // The alternative funding source in the Routstr top-up modal. Issues a BOLT11
  // on the connected NWC wallet via make_invoice; the sats land in the NWC
  // wallet, NOT in Cashu — so this path NEVER mints proofs. Reuses the same
  // stored NWC envelope + live client as /api/onboarding/wallet/*.

  async function nwcMakeInvoice({ amountSats, memo, maxSats } = {}) {
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return { code: 400, body: { ok: false, error: 'amount_sats must be a positive integer' } };
    }
    const cap = Number.isFinite(maxSats) && maxSats > 0 ? maxSats : 100_000;
    if (amountSats > cap) {
      return { code: 400, body: { ok: false, error: `amount exceeds the max of ${cap} sats` } };
    }
    const env = await loadEnvelope(NWC_SECRET);
    if (env === null || env.error) return { code: 409, body: { ok: false, error: 'no wallet connected' } };
    if (env.capabilities?.can_make_invoice !== true) {
      return { code: 409, body: { ok: false, error: 'connected wallet cannot make invoices' } };
    }
    const parsed = parseNwcUri(env.uri);
    if (!parsed.ok) return { code: 409, body: { ok: false, error: 'stored wallet is unusable' } };

    let client;
    try {
      client = await connectNwc(parsed);
    } catch {
      return { code: 503, body: { ok: false, error: 'live NWC path unavailable on this runtime' } };
    }
    let made;
    try {
      made = await client.makeInvoice({ amountSats, memo });
    } catch (e) {
      log.warn(`[onboarding] make_invoice threw: ${sanitizeReason(e)}`);
      made = { ok: false, reason: 'wallet did not complete make_invoice' };
    } finally {
      await client.close?.();
    }
    if (!made.ok) return { code: 502, body: { ok: false, error: made.reason } };

    const hash = made.payment_hash || null;
    if (hash) {
      try {
        await nwcInvoices.save(hash, { payment_hash: hash, amount_sats: amountSats, created_at: new Date().toISOString() });
      } catch (e) {
        log.warn(`[onboarding] nwc invoice marker save failed: ${sanitizeReason(e)}`);
      }
    }
    return { code: 200, body: { ok: true, invoice: made.invoice, payment_hash: hash, expiry: made.expiry ?? null, amount_sats: amountSats } };
  }

  async function nwcLookupInvoice({ paymentHash } = {}) {
    if (typeof paymentHash !== 'string' || paymentHash.length === 0) {
      return { code: 400, body: { ok: false, error: 'payment hash required' } };
    }
    const env = await loadEnvelope(NWC_SECRET);
    if (env === null || env.error) return { code: 409, body: { ok: false, error: 'no wallet connected' } };
    const parsed = parseNwcUri(env.uri);
    if (!parsed.ok) return { code: 409, body: { ok: false, error: 'stored wallet is unusable' } };

    let client;
    try {
      client = await connectNwc(parsed);
    } catch {
      return { code: 503, body: { ok: false, error: 'live NWC path unavailable on this runtime' } };
    }
    let look;
    try {
      look = await client.lookupInvoice({ paymentHash });
    } catch (e) {
      log.warn(`[onboarding] lookup_invoice threw: ${sanitizeReason(e)}`);
      look = { ok: false, reason: 'wallet did not complete lookup_invoice' };
    } finally {
      await client.close?.();
    }
    if (!look.ok) return { code: 502, body: { ok: false, error: look.reason } };
    const body = { ok: true, state: look.state, paid: look.paid };
    if (look.settled_at != null) body.settled_at = look.settled_at;
    return { code: 200, body };
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
      // Marker: this balance is already in whole sats (see displayBalanceSats).
      balance_units: 'sat',
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
        balance_sats: displayBalanceSats(env),
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
    // Same throw-hardening as get_info: a live NWC pay can throw (relay/encrypt
    // failure) and must NOT escape as a bare 500. Fold a throw into the existing
    // 502 shape with a sanitized reason (never the URI/secret/bolt11).
    let paid;
    try {
      paid = await client.payInvoice(bolt11);
    } catch (e) {
      log.warn(`[onboarding] pay_invoice threw: ${sanitizeReason(e)}`);
      paid = { ok: false, reason: 'wallet did not complete pay_invoice' };
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

  // ── Recovery / resume (v0.2.37-alpha) ──────────────────────────────────

  // A single, redacted snapshot the Console reads on load to decide whether a
  // paid-but-unclaimed session needs resuming — WITHOUT ever exposing the
  // bolt11, key, or URI. `claimable` is the whole point: it is true only when a
  // pending funding invoice is stored AND no key has been claimed yet, so the
  // browser can call routstrRecover (with an empty body — the agent supplies
  // the stored bolt11) to finish the claim after a refresh/restart, never
  // re-paying. This is the source of truth for refresh-resume.
  async function recoveryState() {
    const nwc = await loadEnvelope(NWC_SECRET);
    const key = await loadEnvelope(ROUTSTR_SECRET);
    const pending = await loadEnvelope(ROUTSTR_PENDING);
    const keyStored = !!(key && !key.error && key.key);
    const pendingExists = !!(pending && !pending.error && pending.bolt11);
    return {
      code: 200,
      body: {
        ok: true,
        wallet: {
          connected: !!(nwc && !nwc.error),
          can_fund_routstr: nwc?.capabilities?.can_fund_routstr === true,
        },
        routstr: {
          connected: keyStored,
          key_preview: keyStored ? key.redacted?.key_preview ?? null : null,
          balance_sats: keyStored ? displayBalanceSats(key) : null,
        },
        pending: pendingExists
          ? {
              exists: true,
              amount_sats: pending.amount_sats ?? null,
              purpose: pending.purpose ?? null,
              created_at: pending.created_at ?? null,
              expires_at: pending.expires_at ?? null,
            }
          : null,
        // The resume signal: paid funds are represented by a stored pending
        // quote with no key yet. The claim path (routstrRecover) is idempotent
        // and never pays, so the Console may auto-invoke it on load.
        claimable: pendingExists && !keyStored,
      },
    };
  }

  // The default Recovery Kit: safe restoration data ONLY. Never the NWC
  // connection secret, never the full sk- key — only redacted previews,
  // fingerprints, the pinned provider host, the (public) admin npub, and
  // human instructions. Secrets require the separate, explicit
  // routstrExportKey action. The route serves this with Cache-Control:
  // no-store so it is never written to a browser/proxy cache.
  async function recoveryKit({ adminNpub = null, agentVersion = null } = {}) {
    const nwc = await loadEnvelope(NWC_SECRET);
    const key = await loadEnvelope(ROUTSTR_SECRET);
    const keyStored = !!(key && !key.error && key.key);
    const walletConnected = !!(nwc && !nwc.error);
    let walletView = null;
    if (walletConnected) {
      const parsed = parseNwcUri(nwc.uri);
      walletView = {
        connected: true,
        wallet: parsed.ok ? redactNwc(parsed) : null,
        can_fund_routstr: nwc.capabilities?.can_fund_routstr === true,
        alias: nwc.alias || null,
        network: nwc.network || null,
      };
    }
    return {
      code: 200,
      body: {
        ok: true,
        generated_at: new Date().toISOString(),
        agent_version: agentVersion,
        admin_npub: adminNpub, // public identity — safe to include
        provider_host: routstrProvider.providerHost,
        includes_secrets: false,
        routstr: keyStored
          ? {
              connected: true,
              key_preview: key.redacted?.key_preview ?? null,
              key_fingerprint: key.redacted?.key_fingerprint ?? null,
              balance_sats: displayBalanceSats(key),
              source: key.source ?? null,
            }
          : { connected: false },
        wallet: walletView || { connected: false },
        instructions: [
          'Store this kit somewhere only you control.',
          'Your NWC connection secret is NOT included. Re-pair your wallet from its own app if you ever need to reconnect.',
          'The recovery kit you DOWNLOAD embeds your full Routstr key so you can restore access from another client — treat the downloaded file like cash. This API response itself never contains the full key.',
          'The admin npub identifies the only key allowed to sign in. Keep your Nostr signer (nsec) safe — it is never held by the agent.',
        ],
        notes:
          'This API response is redacted: it never contains the NWC connection secret or the full Routstr key. ' +
          'The full Routstr key is fetched over the explicit, no-store export endpoint at download time and written only into the file you save.',
      },
    };
  }

  // One-time, no-store full-key reveal. This is the ONLY method that returns a
  // full sk- key, and it exists solely so an operator can move an already-paid
  // key to another client during recovery. Hard gates: explicit confirm===true
  // (an accidental GET can never leak it) and a stored key must exist. The
  // route MUST send Cache-Control: no-store. Each reveal is audited (count +
  // timestamp) so an operator can see the key was exported; the plaintext is
  // never logged.
  async function routstrExportKey({ confirm } = {}) {
    if (confirm !== true) {
      return { code: 400, body: { ok: false, error: 'explicit confirmation required', code: 'confirmation_required' } };
    }
    const env = await loadEnvelope(ROUTSTR_SECRET);
    if (env === null) return { code: 409, body: { ok: false, error: 'no routstr key stored' } };
    if (env.error) return { code: 409, body: { ok: false, error: `stored key ${env.error}` } };
    if (typeof env.key !== 'string' || env.key.length === 0) {
      return { code: 409, body: { ok: false, error: 'stored key is unusable' } };
    }
    // Audit the reveal (never the key itself) and persist the counter so the
    // export is visible after the fact.
    const exportCount = (Number.isInteger(env.export_count) ? env.export_count : 0) + 1;
    await secretStore.put(ROUTSTR_SECRET, JSON.stringify({ ...env, export_count: exportCount, last_exported_at: new Date().toISOString() }));
    log.warn(`[onboarding] routstr key exported (one-time reveal #${exportCount}, fp=${env.redacted?.key_fingerprint || 'unknown'})`);
    return {
      code: 200,
      body: {
        ok: true,
        key: env.key,
        routstr: env.redacted || null,
        provider_host: routstrProvider.providerHost,
        one_time: true,
        export_count: exportCount,
        // Advisory for the client: do not store, do not cache.
        no_store: true,
      },
    };
  }

  return {
    walletConnect,
    walletStatus,
    walletDisconnect,
    walletTest,
    nwcMakeInvoice,
    nwcLookupInvoice,
    routstrKey,
    routstrStatus,
    routstrDisconnect,
    routstrModels,
    routstrQuote,
    routstrPay,
    routstrRecover,
    recoveryState,
    recoveryKit,
    routstrExportKey,
  };
}
