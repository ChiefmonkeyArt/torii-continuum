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

import { readFileSync, openSync, writeSync, fsyncSync, fchmodSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
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

  // project_sources (v0.2.47-alpha, CONT-KANBAN-SYNC): read-only import of
  // local Markdown to-do files + public GitHub issues into per-project Kanban.
  // Validated FAIL-CLOSED: when enabled, every configured source must be inside
  // its allowlist (local_root for files, allow_github for repos). A source that
  // isn't allowlisted is a config error, not a silently-skipped entry — better
  // to refuse boot than to import from somewhere the operator didn't intend.
  const ps = cfg.project_sources;
  if (ps && ps.enabled === true) {
    const repoRe = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
    const allow = Array.isArray(ps.allow_github) ? ps.allow_github : [];
    for (const r of allow) {
      if (typeof r !== 'string' || !repoRe.test(r)) {
        errors.push(`project_sources.allow_github entry "${r}" must be "owner/repo"`);
      }
    }
    if (ps.local_root != null) {
      if (typeof ps.local_root !== 'string' || !ps.local_root) {
        errors.push('project_sources.local_root must be an absolute path string or null');
      } else if (!isAbsolute(ps.local_root)) {
        errors.push('project_sources.local_root must be an absolute path (got a relative path)');
      }
    }
    const srcs = Array.isArray(ps.sources) ? ps.sources : [];
    for (const s of srcs) {
      if (!s || typeof s.project !== 'string' || !s.project) {
        errors.push('project_sources.sources[] entries need a project slug');
        continue;
      }
      if (s.type === 'markdown') {
        if (typeof s.path !== 'string' || !s.path) {
          errors.push(`project_sources source for "${s.project}" (markdown) needs a path`);
        } else if (!ps.local_root) {
          errors.push(`project_sources markdown source for "${s.project}" requires project_sources.local_root to be set`);
        }
      } else if (s.type === 'github_issues') {
        if (!repoRe.test(String(s.repo || ''))) {
          errors.push(`project_sources github source for "${s.project}" needs repo "owner/repo"`);
        } else if (!allow.includes(s.repo)) {
          errors.push(`project_sources github source "${s.repo}" is not in project_sources.allow_github (fail-closed)`);
        }
      } else {
        errors.push(`project_sources source for "${s.project}" has unknown type "${s.type}"`);
      }
    }
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
  // Absolute ceiling on a refreshed session (v0.2.92-alpha, CONT-AUTH-1). A
  // sliding session may renew without a new signature, but never past this many
  // seconds from the ORIGINAL login — so refresh cannot quietly become a
  // permanent credential. Floored at one TTL: a cap below the window it extends
  // would refuse every refresh and is always a misconfiguration.
  cfg.session_max_lifetime_sec ??= 604800; // 7 days
  if (cfg.session_max_lifetime_sec < cfg.session_ttl_sec) {
    cfg.session_max_lifetime_sec = cfg.session_ttl_sec;
  }
  cfg.server.cors_origins ??= [];
  cfg.cashu ??= { mints: [], low_balance_warn_sats: 500, hard_floor_sats: 100 };
  // Hard cap on a single Lightning-QR top-up mint quote (v0.2.83-alpha). Applied
  // to both the Cashu mint-quote and the NWC-issued invoice paths so neither can
  // request an unbounded invoice from a stolen session.
  cfg.cashu.max_mint_sats ??= 100_000;
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
  // Onboarding wallet/Routstr mutation+test+pay endpoints (v0.2.35-alpha).
  cfg.rate_limit.onboarding_per_min ??= 12;
  // Project-source refresh endpoint (v0.2.47-alpha). Admin-gated + bounded so a
  // stolen session can't hammer local disk reads or the GitHub API.
  cfg.rate_limit.project_sources_refresh_per_min ??= 12;
  // Wallet-health endpoint (v0.2.47-alpha). Auto-polled by the dashboard every
  // 20s; rate-limited AND short-cached server-side (see index.mjs) so an open
  // dashboard can't drive steady NUT-07 /checkstate load against every mint.
  cfg.rate_limit.wallet_health_per_min ??= 6;

  // NWC (Nostr Wallet Connect) client tuning (v0.2.35-alpha). The URI itself is
  // never in config — it is submitted at runtime and stored encrypted at rest.
  cfg.nwc ??= {};
  cfg.nwc.request_timeout_ms ??= 15000;

  // Routstr provider adapter (v0.2.35-alpha) used by the onboarding Routstr
  // step. Pinned to a single https origin. Lightning paths default to the
  // source-grounded routstr-core contract (POST /lightning/invoice, GET
  // /lightning/invoice/{id}/status, POST /lightning/recover). Set any path to
  // null to disable it for a provider that lacks it (createInvoice then returns
  // a fail-closed blocked result). `??=` so an explicit null in config survives.
  cfg.routstr.provider ??= {};
  cfg.routstr.provider.base_url ??= cfg.routstr.endpoint;
  cfg.routstr.provider.min_topup_sats ??= 10;
  cfg.routstr.provider.max_topup_sats ??= 10000;
  cfg.routstr.provider.request_timeout_ms ??= 15000;
  cfg.routstr.provider.max_response_bytes ??= 64 * 1024;
  cfg.routstr.provider.poll_interval_ms ??= 3000;
  cfg.routstr.provider.poll_max_attempts ??= 20;
  cfg.routstr.provider.balance_path ??= '/v1/balance/info';
  cfg.routstr.provider.models_path ??= '/v1/models';
  cfg.routstr.provider.invoice_path ??= '/lightning/invoice';
  cfg.routstr.provider.invoice_status_path ??= '/lightning/invoice/{id}/status';
  cfg.routstr.provider.invoice_recover_path ??= '/lightning/recover';

  // project_sources (v0.2.47-alpha). Disabled by default so a demo/agentless
  // build imports nothing. When enabled, adapters read local Markdown + public
  // GitHub issues under strict allowlists (see core/project-sources.mjs). All
  // bounds have safe defaults; an operator only needs local_root / allow_github
  // / sources to turn it on.
  cfg.project_sources ??= {};
  cfg.project_sources.enabled ??= false;
  cfg.project_sources.local_root ??= null;
  cfg.project_sources.github_api ??= 'https://api.github.com';
  cfg.project_sources.allow_github ??= [];
  cfg.project_sources.max_file_bytes ??= 256 * 1024;
  cfg.project_sources.max_response_bytes ??= 1024 * 1024;
  cfg.project_sources.max_issues ??= 200;
  cfg.project_sources.max_pages ??= 5;
  cfg.project_sources.request_timeout_ms ??= 10000;
  cfg.project_sources.sources ??= [];

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
 * file stays valid YAML and human-readable.
 *
 * Crash-safety: we write in place and fsync the fd before returning, so a
 * power loss right after the claim can't leave the flushed data stranded in
 * the page cache. We deliberately do NOT use the usual temp-file + atomic
 * rename dance: the production systemd sandbox exposes config.yaml as a single
 * writable FILE inside an otherwise read-only directory (ProtectSystem=strict
 * + ReadWritePaths=.../config.yaml), so creating a sibling temp or renaming
 * over the target would need directory write access we deliberately don't
 * grant. In-place overwrite + fsync is the crash-safe path that fits the
 * sandbox. The full replacement text is validated as YAML in memory BEFORE any
 * byte is written, so we never truncate the live file only to fail mid-render.
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

  // Sanity check BEFORE touching the file: the rewritten text must still parse
  // and carry our npub. If this throws, the live config is untouched.
  const check = parse(next);
  if (!check || check.admin_npub !== npub) {
    throw new Error('persistAdminNpub: post-write YAML validation failed');
  }

  // Open the existing file for truncating write ('w'), write the full new
  // contents, re-assert 0600, fsync, then close. fsync flushes the data to
  // stable storage before we report success so the claim survives a crash.
  const fd = openSync(configPath, 'w');
  try {
    writeSync(fd, next, 0, 'utf8');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
