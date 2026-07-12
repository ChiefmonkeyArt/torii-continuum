/**
 * Setup mode — first-run key registration.
 *
 * When setup_mode: true in config, the agent exposes endpoints that let
 * a browser-generated key claim the instance. A setup_token (printed by
 * Ansible at deploy time) gates access — bots scanning the web don't have it.
 *
 * Flow:
 *   1. Browser GET /api/setup/status → { setup_mode: true }
 *   2. Browser POST /api/setup/verify { token } → { ok: true }
 *   3. Browser generates key (Web Crypto), POST /api/setup/register { pubkey, signed_event }
 *   4. Agent verifies token + signature, writes pubkey to config, exits setup_mode
 *   5. Agent issues session token — user is logged in immediately
 *
 * After setup completes, all /api/setup/* endpoints return 404.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

export function isSetupMode(cfg) {
  return cfg.setup_mode === true;
}

export function registerSetupRoutes(app, cfg, auth, configFilePath) {
  if (!isSetupMode(cfg)) {
    // Not in setup mode — register a status endpoint that says so.
    // All other setup endpoints return 404.
    app.get('/api/setup/status', async () => ({ setup_mode: false }));
    return;
  }

  const token = cfg.setup_token;
  if (!token) {
    app.log.error('[setup] setup_mode is true but no setup_token in config — refusing to start setup endpoints');
    return;
  }

  // GET /api/setup/status — public, tells frontend to show setup wizard
  app.get('/api/setup/status', async () => ({
    setup_mode: true,
    setup_token_required: true,
  }));

  // POST /api/setup/verify — verify the setup token
  app.post('/api/setup/verify', async (req, reply) => {
    const { token: provided } = req.body || {};
    if (!provided || provided !== token) {
      app.log.warn({ evt: 'setup.verify.fail' }, 'setup token mismatch');
      return reply.code(403).send({ ok: false, error: 'invalid setup token' });
    }
    app.log.info({ evt: 'setup.verify.ok' }, 'setup token verified');
    return { ok: true };
  });

  // POST /api/setup/register — register admin pubkey and exit setup mode
  app.post('/api/setup/register', async (req, reply) => {
    const { token: provided, signed_event } = req.body || {};

    // 1. Verify setup token
    if (!provided || provided !== token) {
      return reply.code(403).send({ ok: false, error: 'invalid setup token' });
    }

    // 2. Verify the signed event
    if (!signed_event || typeof signed_event !== 'object') {
      return reply.code(400).send({ ok: false, error: 'signed_event required' });
    }

    // 3. Verify the event signature and kind
    const isValid = verifyEvent(signed_event);
    if (!isValid) {
      app.log.warn({ evt: 'setup.register.badsig' }, 'invalid event signature');
      return reply.code(400).send({ ok: false, error: 'invalid event signature' });
    }

    if (signed_event.kind !== 22242) {
      return reply.code(400).send({ ok: false, error: 'event must be kind 22242' });
    }

    // 4. Decode pubkey from hex to npub for config storage
    const hexPubkey = signed_event.pubkey;
    let npub;
    try {
      npub = nip19.npubEncode(hexPubkey);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: 'invalid pubkey format' });
    }

    // 5. Write to config file
    try {
      const rawConfig = readFileSync(configFilePath, 'utf8');
      const cfgObj = parse(rawConfig);

      // Set admin npub (both formats for backward compat)
      cfgObj.admin_npubs = [npub];
      delete cfgObj.admin_npub;

      // Exit setup mode
      cfgObj.setup_mode = false;
      delete cfgObj.setup_token;

      writeFileSync(configFilePath, stringify(cfgObj), 'utf8');
      app.log.info({ evt: 'setup.register.ok', npub_prefix: npub.slice(0, 12) }, 'admin pubkey registered, setup mode exited');
    } catch (e) {
      app.log.error({ evt: 'setup.register.writefail', err: e.message }, 'failed to write config');
      return reply.code(500).send({ ok: false, error: 'failed to persist config' });
    }

    // 6. Issue session token so user is immediately logged in.
    //    Register the pubkey in auth's in-memory admin list so the
    //    issued token actually verifies on subsequent requests.
    //    Also add to cfg.admin_npubs (mutable since setup_mode skips freeze).
    if (Array.isArray(cfg.admin_npubs)) {
      if (!cfg.admin_npubs.includes(npub)) {
        cfg.admin_npubs.push(npub);
      }
    } else {
      cfg.admin_npubs = [npub];
    }

    // Dynamically register so verifySessionToken() finds this pubkey
    auth.registerAdminPubkey(hexPubkey, npub);

    const result = auth.verifyChallenge(signed_event, req.ip);
    if (!result.ok) {
      // Signature verified above but challenge verification failed —
      // likely no matching challenge (this is a setup flow, not normal auth).
      // Issue a token directly since we've already verified the signature.
      const tokenResult = auth.issueSessionTokenForPubkey(hexPubkey);
      return { ok: true, token: tokenResult.token, expires_at: tokenResult.expiresAt };
    }

    return { ok: true, token: result.token, expires_at: result.expires_at };
  });
}
