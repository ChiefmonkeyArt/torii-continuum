/**
 * Config loader. Reads config.yaml from the agent root, validates the
 * critical invariants, and returns a frozen object.
 *
 * Invariants enforced (fail fast, refuse to boot if violated):
 *   1. admin_npub must be a valid "npub1" string OR empty (first-touch claim)
 *   2. session_secret must be >=64 hex chars (32 bytes)
 *   3. server.host + server.port must be set
 *   4. routstr.endpoint must be https
 *   5. routstr.models.chat + .coding must be set
 *
 * Any of those failing = the daemon refuses to start. Better to crash on
 * boot than serve requests with a broken sovereignty story.
 *
 * First-touch admin bootstrap (v0.2.26-alpha, SUITE-VPS-READY-2):
 *   An empty/absent admin_npub is a valid "unclaimed" state. The daemon boots
 *   in bootstrap mode (cfg.admin_bootstrap === true); the first successfully
 *   verified NIP-07 caller claims admin and persistAdminNpub() writes their
 *   npub back to config.yaml. See core/auth.mjs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(__dirname, '..');

const REQUIRED_MSG =
  '\n[continuum-agent] refusing to start — invariant violated.\n' +
  'See agent/config.example.yaml for the required schema.\n';

export function loadConfig(path) {
  const configPath = path || resolve(AGENT_ROOT, 'config.yaml');
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    console.error(REQUIRED_MSG + `Could not read ${configPath}: ${e.message}`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = parse(raw);
  } catch (e) {
    console.error(REQUIRED_MSG + `YAML parse failed: ${e.message}`);
    process.exit(1);
  }

  // Validate invariants
  const errors = [];

  // admin_npub: empty/absent => first-touch bootstrap mode (allowed). If set,
  // it must be a real npub1 and not the example placeholder.
  const adminRaw = typeof cfg.admin_npub === 'string' ? cfg.admin_npub.trim() : '';
  const adminBootstrap = adminRaw === '';
  if (!adminBootstrap) {
    if (!adminRaw.startsWith('npub1')) {
      errors.push('admin_npub must be a valid npub1... string, or empty for first-touch claim');
    }
    if (adminRaw.includes('REPLACE')) {
      errors.push('admin_npub is still the example placeholder — replace it with your real npub or leave it empty');
    }
  }
  if (!cfg.session_secret || typeof cfg.session_secret !== 'string' || cfg.session_secret.length < 64) {
    errors.push('session_secret must be >=64 hex chars (32 bytes). Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (cfg.session_secret && cfg.session_secret.includes('REPLACE')) {
    errors.push('session_secret is still the example placeholder — generate a real one');
  }
  if (!cfg.server?.host || !cfg.server?.port) {
    errors.push('server.host and server.port must both be set');
  }
  if (!cfg.routstr?.endpoint || !cfg.routstr.endpoint.startsWith('https://')) {
    errors.push('routstr.endpoint must be a https:// URL');
  }
  if (!cfg.routstr?.models?.chat || !cfg.routstr?.models?.coding) {
    errors.push('routstr.models.chat and .coding must both be set');
  }

  if (errors.length) {
    console.error(REQUIRED_MSG + errors.map((e) => '  • ' + e).join('\n') + '\n');
    process.exit(1);
  }

  // Normalise admin fields + expose bootstrap state and the resolved config
  // path so the first-touch claim can persist back to the same file.
  cfg.admin_npub = adminRaw;
  cfg.admin_bootstrap = adminBootstrap;
  cfg._config_path = configPath;

  // Defaults for optional fields
  cfg.session_ttl_sec ??= 86400;
  cfg.server.cors_origins ??= [];
  cfg.cashu ??= { mints: [], low_balance_warn_sats: 500, hard_floor_sats: 100 };
  cfg.routstr.limits ??= { max_tokens_out: 2048, max_sats_per_request: 50 };
  cfg.routstr.fallback ??= { enabled: false };
  cfg.skills ??= {};
  cfg.logging ??= { destination: 'stdout', level: 'info' };
  cfg.logging.cost_log ??= 'memory/costs.jsonl';
  cfg.logging.audit_log ??= 'memory/audit.jsonl';

  // Rate-limit defaults (v0.2.14-alpha, SUITE-VPS-READY-1). Absent block =
  // enabled with sensible defaults. Existing v0.5.0-alpha installs get these
  // without any config file edits.
  cfg.rate_limit ??= {};
  cfg.rate_limit.enabled ??= true;
  cfg.rate_limit.auth_challenge_per_min ??= 10;
  cfg.rate_limit.auth_verify_per_min ??= 20;
  cfg.rate_limit.max_challenges ??= 1000;

  return Object.freeze(cfg);
}

export function agentRoot() {
  return AGENT_ROOT;
}

/**
 * Persist a first-touch admin claim back into config.yaml.
 *
 * Rewrites (or inserts) the single `admin_npub:` line in place, preserving
 * every other line — comments, ordering, and the rest of the config — so the
 * file stays valid YAML and human-readable. Writes in place (no temp+rename)
 * because the production systemd sandbox exposes config.yaml as a writable
 * file inside an otherwise read-only directory; a rename would need directory
 * write access we deliberately don't grant.
 *
 * @param {string} configPath absolute path to config.yaml
 * @param {string} npub       canonical npub1... to persist
 * @throws on I/O error or a malformed npub (caller must fail closed)
 */
export function persistAdminNpub(configPath, npub) {
  if (typeof configPath !== 'string' || !configPath) {
    throw new Error('persistAdminNpub: configPath required');
  }
  // Defence-in-depth: only ever write a well-formed npub. The value is derived
  // from a signature-verified pubkey, but validate the shape before it touches
  // disk so nothing else can be injected into the config line.
  if (typeof npub !== 'string' || !/^npub1[a-z0-9]{58,}$/.test(npub)) {
    throw new Error('persistAdminNpub: refusing to persist malformed npub');
  }

  const raw = readFileSync(configPath, 'utf8');
  const line = `admin_npub: "${npub}"`;
  let next;
  if (/^[ \t]*admin_npub:.*$/m.test(raw)) {
    next = raw.replace(/^[ \t]*admin_npub:.*$/m, line);
  } else {
    // No existing key — prepend so it lives at the top level.
    next = `${line}\n${raw}`;
  }

  // Sanity check: the rewritten text must still parse and carry our npub.
  const check = parse(next);
  if (!check || check.admin_npub !== npub) {
    throw new Error('persistAdminNpub: post-write YAML validation failed');
  }

  // mode is honoured only on create; an existing config.yaml keeps its 0600.
  writeFileSync(configPath, next, { mode: 0o600 });
}
