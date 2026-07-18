/**
 * Cashu wallet — on-VPS float used to pay Routstr per request.
 *
 * Storage: memory/wallet/<mint-slug>.json holds the proofs for each mint.
 * Chmod 700, dedicated `continuum` OS user, never committed.
 *
 * Treat wallet files like cash. If /home/continuum/agent/memory/wallet/ is
 * destroyed or copied, the sats go with it. Back it up out-of-band if you
 * want any recovery story — the agent does not sync it anywhere.
 *
 * v1 surface (small on purpose):
 *   • init(): load or create wallet state for each mint
 *   • balance(): total sats across all mints
 *   • receive(token): accept a Cashu token from Plebeian Signer, add proofs
 *   • send(sats): request a token of `sats` value (used by Routstr client)
 *
 * The Routstr client never handles proofs directly — it calls send() to get a
 * token, hands it to the request, and either the request succeeds or the
 * token comes back and we return it via receive(). Atomicity: we persist
 * before returning, so a crash mid-request may lose the token but never
 * double-spend.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Mint, Wallet, getEncodedToken, getDecodedToken, CheckStateEnum } from '@cashu/cashu-ts';
import { agentRoot } from './config.mjs';

// Non-reversible short id for a mint URL — lets health output/logs reference a
// mint without echoing a full endpoint everywhere. Domain-separated label.
function mintFingerprint(url) {
  return 'sha256:' + createHash('sha256').update('mint:' + String(url), 'utf8').digest('hex').slice(0, 16);
}

// Wrap a promise with a wall-clock timeout. cashu-ts drives its own fetch, so
// we can't abort the socket, but we must never let a hung mint make the health
// probe hang forever. On timeout we stop waiting and report 'timeout'.
function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const t = new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Reduce a caught error to a short, non-sensitive reason. Never returns a raw
// stack, token, proof, or full endpoint — just a coarse category.
function sanitizeReason(e) {
  const msg = (e && typeof e.message === 'string') ? e.message : '';
  if (/timeout/i.test(msg)) return 'timeout';
  if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|getaddrinfo/i.test(msg)) return 'unreachable';
  if (/404|not found/i.test(msg)) return 'mint_not_found';
  if (/40[13]|unauthor|forbidden/i.test(msg)) return 'mint_refused';
  return 'mint_error';
}

const WALLET_DIR = join(agentRoot(), 'memory', 'wallet');

function slug(mintUrl) {
  return mintUrl.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function fileFor(dir, mintUrl) {
  return join(dir, `${slug(mintUrl)}.json`);
}

async function readProofs(dir, mintUrl) {
  try {
    const raw = await readFile(fileFor(dir, mintUrl), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.proofs) ? parsed.proofs : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeProofs(dir, mintUrl, proofs) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = fileFor(dir, mintUrl);
  const payload = JSON.stringify({ mint: mintUrl, proofs, updated_at: Date.now() }, null, 2);
  await writeFile(path, payload, { mode: 0o600 });
}

// Exact proof identity. `secret` is unique per proof; `C` (the unblinded
// signature point) pins it further. Used to quarantine proofs by identity
// rather than by amount, so we never drop the wrong proof.
function proofKey(p) {
  return `${p?.secret || ''}|${p?.C || ''}`;
}

/**
 * Recovery sweep. Ask the mint (NUT-07) which of our stored proofs are already
 * spent and quarantine them by EXACT identity. This is what un-pollutes a
 * wallet that still holds proofs a prior lost-refund left behind (a 520 where
 * Routstr melted the token but no X-Cashu-Refund came back, and an old
 * post-dispatch rollback re-added the now-spent proofs).
 *
 * Returns { spendable, pending } where:
 *   • spendable — UNSPENT proofs, the only ones safe to hand to a new send.
 *   • pending   — PENDING proofs, kept in storage (an in-flight melt may still
 *                 resolve) but excluded from selection.
 * SPENT proofs are dropped from storage. On any check failure (mint down,
 * NUT-07 unsupported) this is a best-effort no-op: the stored set is returned
 * unchanged so a transient mint issue never bricks send().
 */
async function sweepSpent(wallet, dir, mintUrl, proofs) {
  if (!Array.isArray(proofs) || proofs.length === 0) return { spendable: [], pending: [] };
  let states;
  try {
    states = await wallet.checkProofsStates(proofs);
  } catch {
    return { spendable: proofs, pending: [] };
  }
  if (!Array.isArray(states) || states.length !== proofs.length) {
    return { spendable: proofs, pending: [] };
  }
  const spendable = [];
  const pending = [];
  let spentCount = 0;
  for (let i = 0; i < proofs.length; i++) {
    const st = states[i]?.state;
    if (st === CheckStateEnum.SPENT) { spentCount++; continue; }
    if (st === CheckStateEnum.PENDING) { pending.push(proofs[i]); continue; }
    spendable.push(proofs[i]);
  }
  if (spentCount > 0) {
    // Persist the cleaned set (drop spent, keep pending) before we spend.
    await writeProofs(dir, mintUrl, [...spendable, ...pending]);
  }
  return { spendable, pending };
}

/**
 * @param {object} cfg  frozen loadConfig() result
 * @param {object} log  logger
 * @param {object} [deps] test seams — never set in production:
 *   • walletDir:     override the proof-storage directory (default agent/memory/wallet)
 *   • walletFactory: (mintUrl) => cashu-ts-shaped Wallet, so send()/receive()
 *                    can be exercised offline against a fake mint.
 * @returns wallet API
 */
export async function createWallet(cfg, log, deps = {}) {
  const walletDir = deps.walletDir || WALLET_DIR;
  const makeWallet = typeof deps.walletFactory === 'function'
    ? deps.walletFactory
    : (url) => new Wallet(new Mint(url));
  const mints = new Map(); // mintUrl → Wallet
  const configuredMints = cfg.cashu?.mints || [];

  if (configuredMints.length === 0) {
    log.warn('[wallet] no Cashu mints configured — /api/wallet routes will 503');
  }

  for (const url of configuredMints) {
    try {
      const wallet = makeWallet(url);
      // Warm mint info + keysets + keys so we fail fast on unreachable mints at
      // boot. cashu-ts v3 splits this from getMintInfo() (now a synchronous
      // cached getter) into loadMint(), which does the network fetch. A boot
      // failure here is non-fatal — the mint is still registered and money-path
      // calls re-run loadMint() lazily via ensureLoaded().
      await wallet.loadMint().catch((e) => {
        log.warn(`[wallet] mint ${url} unreachable at boot: ${e.message}`);
      });
      mints.set(url, wallet);
    } catch (e) {
      log.error(`[wallet] init failed for ${url}: ${e.message}`);
    }
  }

  // cashu-ts v3 requires loadMint() before receive()/send(); it is idempotent
  // (skips both network fetches once keysets are cached), so calling it before
  // each money-path op restores v2's lazy load-on-demand without extra traffic.
  // No in-flight promise dedup: loadMint() is idempotent server-side and the
  // boot warm-up above already primes each mint, so the only un-deduped case is
  // two concurrent first-ever ops after a boot warm-up failure — which fire
  // duplicate (idempotent) fetches, never a double-spend. Left simple on purpose.
  async function ensureLoaded(wallet) {
    await wallet.loadMint();
  }

  async function balance() {
    let total = 0;
    const perMint = {};
    for (const url of mints.keys()) {
      const proofs = await readProofs(walletDir, url);
      const sats = proofs.reduce((sum, p) => sum + (p.amount || 0), 0);
      perMint[url] = sats;
      total += sats;
    }
    return { total, per_mint: perMint };
  }

  /**
   * Accept a Cashu token from Plebeian Signer. Decodes, validates the mint is
   * whitelisted, receives the proofs into the wallet for that mint.
   */
  async function receive(encodedToken) {
    let decoded;
    try {
      decoded = getDecodedToken(encodedToken);
    } catch (e) {
      return { ok: false, reason: `bad token encoding: ${e.message}` };
    }

    // cashu-ts token shape { mint, proofs, unit?, memo? } — unchanged in v3.
    const mintUrl = decoded.mint;
    if (!mintUrl) return { ok: false, reason: 'token missing mint' };
    if (!mints.has(mintUrl)) {
      return { ok: false, reason: `mint not whitelisted: ${mintUrl}. Add it to cashu.mints in config.yaml.` };
    }

    const wallet = mints.get(mintUrl);
    let received;
    try {
      await ensureLoaded(wallet);
      // cashu-ts v3: receive(token) → Proof[] (unchanged shape from v2).
      received = await wallet.receive(encodedToken);
    } catch (e) {
      return { ok: false, reason: `mint refused token: ${e.message}` };
    }

    const existing = await readProofs(walletDir, mintUrl);
    const combined = [...existing, ...received];
    await writeProofs(walletDir, mintUrl, combined);

    const added = received.reduce((s, p) => s + (p.amount || 0), 0);
    log.info(`[wallet] received ${added} sats from ${mintUrl}`);
    return { ok: true, added_sats: added, mint: mintUrl };
  }

  /**
   * Cut a FRESH payment token of `sats` value for a Routstr request. Uses the
   * first mint that has enough spendable balance.
   *
   * Wallet-state contract (v0.2.76-alpha):
   *   1. Sweep: before selecting, drop any stored proofs the mint already marked
   *      SPENT (recovery for a wallet polluted by a prior lost-refund rollback).
   *   2. Swap/select: wallet.send(sats, spendable) consumes the inputs and yields
   *      { keep (change), send (the fresh payment proofs) }.
   *   3. Atomic persist: the change (keep) — plus any PENDING proofs we set aside
   *      — is written as the new state BEFORE returning, so the outgoing payment
   *      proofs are never left in spendable balance after dispatch.
   *
   * The returned object carries two seams used ONLY before the HTTP request is
   * dispatched OR to quarantine a spent token — never to restore spent inputs:
   *   • rollback()  — re-adds the FRESH payment proofs (send). SAFE ONLY as a
   *     pre-dispatch undo (the swap succeeded but we chose not to fetch). Once
   *     the token is handed to fetch() it must NEVER be rolled back.
   *   • markSpent() — remove the exact payment proofs from storage by identity.
   *     Used on a Routstr `token_already_spent` (400) so a retry can't reuse them.
   *
   * If no mint has enough balance, returns { ok: false, reason }.
   */
  async function send(sats) {
    if (sats < 1) return { ok: false, reason: 'sats must be >= 1' };
    const floor = cfg.cashu?.hard_floor_sats || 0;

    for (const [mintUrl, wallet] of mints) {
      const stored = await readProofs(walletDir, mintUrl);
      if (stored.length === 0) continue;

      // Load keysets/keys (idempotent) then sweep spent proofs before selecting.
      try {
        await ensureLoaded(wallet);
      } catch (e) {
        return { ok: false, reason: `send failed on ${mintUrl}: ${e.message}` };
      }
      const { spendable, pending } = await sweepSpent(wallet, walletDir, mintUrl, stored);

      const total = spendable.reduce((s, p) => s + (p.amount || 0), 0);
      if (total < sats + floor) continue;

      let sendResult;
      try {
        // cashu-ts v3: wallet.send(amount, proofs) → { keep, send }. Consumes the
        // input proofs at the mint (swap) and returns fresh payment proofs.
        sendResult = await wallet.send(sats, spendable);
      } catch (e) {
        return { ok: false, reason: `send failed on ${mintUrl}: ${e.message}` };
      }

      // Persist change (keep) + preserved pending atomically as the new state.
      // The payment proofs (send) are intentionally NOT stored — once created
      // they belong to the request, not to spendable balance.
      await writeProofs(walletDir, mintUrl, [...sendResult.keep, ...pending]);
      // Force cashuA v3. Without an explicit version, cashu-ts 3.7.1 defaults to
      // cashuB v4 (CBOR) for hex-keyset mints (Minibits, Coinos both use hex
      // keyset ids) — Routstr accepts v3 but crashes its melt/forward step on v4
      // (Cloudflare 520). `unit: 'sat'` keeps the v3 token self-describing.
      const token = getEncodedToken({ mint: mintUrl, unit: 'sat', proofs: sendResult.send }, { version: 3 });
      const sentKeys = new Set(sendResult.send.map(proofKey));

      return {
        ok: true,
        mint: mintUrl,
        sats,
        token,
        // PRE-DISPATCH ONLY. Re-adds the fresh payment proofs. Never call after
        // the token has been handed to fetch() — those proofs are then spent.
        rollback: async () => {
          const cur = await readProofs(walletDir, mintUrl);
          await writeProofs(walletDir, mintUrl, [...cur, ...sendResult.send]);
          log.info(`[wallet] rolled back ${sats} sats to ${mintUrl}`);
        },
        // Drop the exact payment proofs from storage by identity, if a
        // pre-dispatch rollback ever put them back. Idempotent no-op otherwise.
        markSpent: async () => {
          const cur = await readProofs(walletDir, mintUrl);
          const cleaned = cur.filter((p) => !sentKeys.has(proofKey(p)));
          if (cleaned.length !== cur.length) {
            await writeProofs(walletDir, mintUrl, cleaned);
            log.info(`[wallet] quarantined ${cur.length - cleaned.length} spent proof(s) on ${mintUrl}`);
          }
        },
      };
    }

    return {
      ok: false,
      reason: `insufficient balance across all mints for ${sats} sats (need +${floor} floor)`,
    };
  }

  /**
   * NON-MUTATING wallet + mint health probe (CONT-HEALTH-2, v0.2.47-alpha).
   *
   * For each configured mint this performs the STRONGEST real validation the
   * pinned cashu-ts (^3.7.1) supports WITHOUT ever mutating proofs or wallet
   * state:
   *   1. loadMint()            — proves the mint is reachable and fetches its
   *                              info + keysets + keys (no proof mutation).
   *   2. getMintInfo()         — reads mint identity: name, version, pubkey
   *                              (fingerprinted), and NUT-07 support.
   *   3. groupProofsByState()  — NUT-07 read-only state check of OUR proofs,
   *                              partitioning them into unspent/pending/spent
   *                              so we can validate that the stored balance is
   *                              actually spendable. This is a pure read (no
   *                              swap, no melt, no send) so it cannot spend or
   *                              rewrite proofs.
   *
   * Never returns proofs, secrets, tokens, or a full mint endpoint beyond the
   * URL the admin already configured (parity with /api/wallet/balance). All
   * failures collapse to a coarse, sanitized reason.
   *
   * States: disabled | ok | degraded | unreachable.
   */
  async function health() {
    const checkedAt = new Date().toISOString();
    if (mints.size === 0) {
      return { configured: false, overall: 'disabled', checked_at: checkedAt, mints: [] };
    }
    const timeoutMs = Number.isFinite(cfg.cashu?.health_timeout_ms) && cfg.cashu.health_timeout_ms > 0
      ? cfg.cashu.health_timeout_ms
      : 10000;

    const out = [];
    for (const [url, wallet] of mints) {
      const proofs = await readProofs(walletDir, url); // read-only
      out.push(await mintHealth({ url, wallet, proofs, timeoutMs }));
    }
    return { configured: true, overall: deriveOverall(out), checked_at: checkedAt, mints: out };
  }

  return { balance, receive, send, health, mints: [...mints.keys()] };
}

/**
 * NON-MUTATING per-mint health probe. PURE with respect to the wallet: it never
 * reads or writes disk — the caller injects `proofs` (already read read-only)
 * and a `wallet`/mint object exposing the cashu-ts ^3.7.1 read primitives
 * (loadMint, getMintInfo, groupProofsByState). Exported so the connected path is
 * unit-testable with a fake wallet/mint. Never returns proofs, secrets, tokens,
 * or anything beyond the configured URL + coarse sanitized reasons.
 *
 * State derivation:
 *   unreachable — loadMint() fails/times out.
 *   degraded    — reachable but info unavailable, OR NUT-07 unsupported (balance
 *                 unvalidated), OR proof-state check failed, OR some stored
 *                 proofs are already spent/pending.
 *   ok          — reachable, identity read, NUT-07 validated all-unspent (or an
 *                 empty wallet with NUT-07 support).
 */
export async function mintHealth({ url, wallet, proofs = [], timeoutMs = 10000 }) {
  const safeProofs = Array.isArray(proofs) ? proofs : [];
  const balanceSats = safeProofs.reduce((s, p) => s + (p.amount || 0), 0);
  const base = {
    mint: url,
    mint_fingerprint: mintFingerprint(url),
    balance_sats: balanceSats,
    proof_count: safeProofs.length,
  };

  // 1. Reachability + key/info load.
  try {
    await withTimeout(wallet.loadMint(), timeoutMs);
  } catch (e) {
    return { ...base, state: 'unreachable', reachable: false, identity: null, validated: null, reason: sanitizeReason(e) };
  }

  // 2. Identity (read-only, from the just-loaded cache).
  let identity = null;
  let nut07 = false;
  try {
    const info = wallet.getMintInfo();
    let pubkey = null;
    try { pubkey = info.pubkey || null; } catch { pubkey = null; }
    try { nut07 = !!info.isSupported(7)?.supported; } catch { nut07 = false; }
    identity = {
      name: safeStr(readGetter(() => info.name), 80),
      version: safeStr(readGetter(() => info.version), 40),
      pubkey_fingerprint: pubkey ? mintFingerprint(pubkey) : null,
      nut07_supported: nut07,
    };
  } catch {
    identity = null;
  }

  // 3. Read-only proof-state validation (NUT-07). Only when supported and we
  // actually hold proofs — a mint without NUT-07 can't be validated, and an
  // empty wallet has nothing to check.
  let validated = null;
  if (nut07 && safeProofs.length > 0) {
    try {
      const grouped = await withTimeout(wallet.groupProofsByState(safeProofs), timeoutMs);
      validated = {
        checked: true,
        unspent_sats: sumAmt(grouped.unspent),
        pending_sats: sumAmt(grouped.pending),
        spent_sats: sumAmt(grouped.spent),
        unspent_count: grouped.unspent.length,
        pending_count: grouped.pending.length,
        spent_count: grouped.spent.length,
      };
    } catch (e) {
      validated = { checked: false, reason: sanitizeReason(e) };
    }
  }

  // Derive per-mint state.
  let state = 'ok';
  let reason = null;
  if (!identity) {
    state = 'degraded';
    reason = 'mint reachable but info unavailable';
  } else if (!nut07) {
    state = 'degraded';
    reason = 'mint does not support NUT-07 proof-state checks; balance is unvalidated';
  } else if (validated && validated.checked === false) {
    state = 'degraded';
    reason = `proof-state check failed: ${validated.reason}`;
  } else if (validated && (validated.spent_sats > 0 || validated.pending_sats > 0)) {
    state = 'degraded';
    reason = 'some stored proofs are already spent or pending; spendable balance is lower than stored';
  }

  return { ...base, state, reachable: true, identity, validated, reason };
}

function deriveOverall(mintHealths) {
  if (mintHealths.length === 0) return 'disabled';
  if (mintHealths.every((m) => m.state === 'ok')) return 'ok';
  if (mintHealths.every((m) => m.state === 'unreachable')) return 'unreachable';
  return 'degraded';
}

function sumAmt(proofs) {
  return Array.isArray(proofs) ? proofs.reduce((s, p) => s + (p.amount || 0), 0) : 0;
}

function readGetter(fn) {
  try { return fn(); } catch { return null; }
}

function safeStr(v, max) {
  return typeof v === 'string' && v.length ? v.slice(0, max) : null;
}
