/**
 * Config loader. Reads config.yaml from the agent root, validates the
 * critical invariants, and returns a frozen object.
 *
 * Invariants enforced (fail fast, refuse to boot if violated):
 *   1. admin_npub must be present and start with "npub1"
 *   2. session_secret must be >=64 hex chars (32 bytes)
 *   3. server.host + server.port must be set
 *   4. routstr.endpoint must be https
 *   5. routstr.models.chat + .coding must be set
 *
 * Any of those failing = the daemon refuses to start. Better to crash on
 * boot than serve requests with a broken sovereignty story.
 */

import { readFileSync } from 'node:fs';
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

  if (!cfg.admin_npub || typeof cfg.admin_npub !== 'string' || !cfg.admin_npub.startsWith('npub1')) {
    errors.push('admin_npub must be set to a valid npub1... string');
  }
  if (cfg.admin_npub && cfg.admin_npub.includes('REPLACE')) {
    errors.push('admin_npub is still the example placeholder — replace it with your real npub');
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
