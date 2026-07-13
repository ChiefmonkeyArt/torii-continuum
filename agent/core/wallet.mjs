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
import { Mint, Wallet, getEncodedToken, getDecodedToken } from '@cashu/cashu-ts';
import { agentRoot } from './config.mjs';

const WALLET_DIR = join(agentRoot(), 'memory', 'wallet');

function slug(mintUrl) {
  return mintUrl.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function fileFor(mintUrl) {
  return join(WALLET_DIR, `${slug(mintUrl)}.json`);
}

async function readProofs(mintUrl) {
  try {
    const raw = await readFile(fileFor(mintUrl), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.proofs) ? parsed.proofs : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeProofs(mintUrl, proofs) {
  await mkdir(WALLET_DIR, { recursive: true, mode: 0o700 });
  const path = fileFor(mintUrl);
  const payload = JSON.stringify({ mint: mintUrl, proofs, updated_at: Date.now() }, null, 2);
  await writeFile(path, payload, { mode: 0o600 });
}

/**
 * @param {object} cfg  frozen loadConfig() result
 * @returns wallet API
 */
export async function createWallet(cfg, log) {
  const mints = new Map(); // mintUrl → CashuWallet
  const configuredMints = cfg.cashu?.mints || [];

  if (configuredMints.length === 0) {
    log.warn('[wallet] no Cashu mints configured — /api/wallet routes will 503');
  }

  for (const url of configuredMints) {
    try {
      const wallet = new Wallet(new Mint(url));
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
  async function ensureLoaded(wallet) {
    await wallet.loadMint();
  }

  async function balance() {
    let total = 0;
    const perMint = {};
    for (const url of mints.keys()) {
      const proofs = await readProofs(url);
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

    const existing = await readProofs(mintUrl);
    const combined = [...existing, ...received];
    await writeProofs(mintUrl, combined);

    const added = received.reduce((s, p) => s + (p.amount || 0), 0);
    log.info(`[wallet] received ${added} sats from ${mintUrl}`);
    return { ok: true, added_sats: added, mint: mintUrl };
  }

  /**
   * Cut a token of `sats` value for a Routstr request. Uses the first mint
   * that has enough balance. Returns the encoded token AND a rollback function
   * that puts the proofs back if the request fails.
   *
   * If no mint has enough balance, returns { ok: false, reason }.
   */
  async function send(sats) {
    if (sats < 1) return { ok: false, reason: 'sats must be >= 1' };
    if (sats < (cfg.cashu?.hard_floor_sats || 0)) {
      // hard_floor guards against draining below floor; separate from send size
    }

    for (const [mintUrl, wallet] of mints) {
      const proofs = await readProofs(mintUrl);
      const total = proofs.reduce((s, p) => s + (p.amount || 0), 0);
      if (total < sats + (cfg.cashu?.hard_floor_sats || 0)) continue;

      let sendResult;
      try {
        await ensureLoaded(wallet);
        // cashu-ts v3: wallet.send(amount, proofs) → { keep, send } (unchanged).
        sendResult = await wallet.send(sats, proofs);
      } catch (e) {
        return { ok: false, reason: `send failed on ${mintUrl}: ${e.message}` };
      }

      // Persist "keep" as new state immediately. If the request fails, caller
      // must call rollback(token) which re-receives the send-proofs.
      await writeProofs(mintUrl, sendResult.keep);
      const token = getEncodedToken({ mint: mintUrl, proofs: sendResult.send });

      return {
        ok: true,
        mint: mintUrl,
        sats,
        token,
        rollback: async () => {
          const cur = await readProofs(mintUrl);
          await writeProofs(mintUrl, [...cur, ...sendResult.send]);
          log.info(`[wallet] rolled back ${sats} sats to ${mintUrl}`);
        },
      };
    }

    return {
      ok: false,
      reason: `insufficient balance across all mints for ${sats} sats (need +${cfg.cashu?.hard_floor_sats || 0} floor)`,
    };
  }

  return { balance, receive, send, mints: [...mints.keys()] };
}
