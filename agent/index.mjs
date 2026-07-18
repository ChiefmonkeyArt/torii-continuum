/**
 * Torii Continuum Agent — main entry.
 *
 * Boots:
 *   1. Load + validate config.yaml (fail fast on invariant violation).
 *   2. Init Cashu wallet(s).
 *   3. Init Routstr client.
 *   4. Init the chat skill.
 *   5. Start Fastify HTTP server on 127.0.0.1:<port>.
 *
 * Run:
 *   node agent/index.mjs
 *
 * Prod: as a systemd unit under the `continuum` user. See agent/README.md.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, mkdir, unlink, readdir, readFile } from 'node:fs/promises';
import { loadConfig, persistAdminNpub } from './core/config.mjs';
import { createAuth } from './core/auth.mjs';
import { createWallet } from './core/wallet.mjs';
import { createRoutstr } from './core/routstr.mjs';
import { createOllama } from './core/ollama.mjs';
import { createModelRouter } from './core/model-router.mjs';
import { createChatSkill } from './skills/chat.mjs';
import { createMemoryCache, validateCiphertext, ciphertextFilename, fingerprintCiphertext } from './lib/crypto.mjs';
import { scrub } from './lib/scrub.mjs';
import { createMemoryLoader } from './lib/memory.mjs';
import { createReflector } from './lib/reflect.mjs';
import { KINDS, dirForKind } from './lib/events.mjs';
import { createSecretStore } from './lib/secretstore.mjs';
import { createNwcClient, createLiveNwcTransport } from './core/nwc.mjs';
import { createRoutstrProvider } from './core/routstr-provider.mjs';
import { createOnboarding } from './core/onboarding.mjs';
import { createProjectSources } from './core/project-sources.mjs';
import { createReleaseChecker } from './core/release-check.mjs';
import { createUpdater } from './core/updater.mjs';
import { createGenesis } from './core/genesis.mjs';
import { createAudit } from './lib/audit.mjs';
import { getConstitution } from './lib/constitution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = __dirname;

// Read version once at boot from agent/package.json so /api/health and
// /api/health/models never drift from the shipped package. Fail loud if
// the file is missing so a broken container can't silently report a bogus
// version. Cheap (single sync-ish read at boot, no runtime cost).
let VERSION = 'unknown';
try {
  const pkgRaw = await readFile(join(AGENT_ROOT, 'package.json'), 'utf8');
  VERSION = JSON.parse(pkgRaw).version || 'unknown';
} catch (e) {
  console.error(`[boot] could not read agent/package.json for VERSION: ${e.message}`);
}

const cfg = loadConfig();

// trustProxy is a LOOPBACK-ONLY allow-list, never `true`. nginx terminates TLS
// and proxies from 127.0.0.1 (or ::1), so only a connection whose socket peer
// is loopback may set req.ip from X-Forwarded-For. If the agent is ever exposed
// beyond loopback, a direct remote peer is NOT in this list, so its forged
// X-Forwarded-For is ignored and req.ip stays the real socket address — the
// rate-limit bucket key cannot be spoofed from off-box. An unconditional
// `trustProxy: true` would trust XFF from ANY peer and collapse that guarantee.
const app = Fastify({
  trustProxy: ['127.0.0.1', '::1'],
  logger: {
    level: cfg.logging?.level || 'info',
    transport:
      cfg.logging?.destination === 'stdout' || !cfg.logging?.destination
        ? undefined
        : { target: 'pino/file', options: { destination: cfg.logging.destination } },
  },
  bodyLimit: 512 * 1024, // 512 KB — enough for a Cashu token + a chat message, nothing more
});

await app.register(cors, {
  origin: cfg.server.cors_origins,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
});

// Rate limiting (v0.2.14-alpha, SUITE-VPS-READY-1).
//
// Global registration with `global: false` means the plugin is available
// but NOT applied to every route by default — routes opt in via their
// `config.rateLimit` block (see /api/auth/challenge and /api/auth/verify
// below). Keeps admin routes and the model providers unrestricted while
// still bounding the public auth surface.
//
// Disable entirely via `rate_limit.enabled: false` in config.yaml (skips the
// plugin registration; per-route configs become inert).
const rateLimitEnabled = cfg.rate_limit?.enabled !== false;
if (rateLimitEnabled) {
  await app.register(rateLimit, {
    global: false,
    // keyGenerator uses req.ip, which reflects X-Forwarded-For only when the
    // socket peer is loopback (see the trustProxy allow-list on the Fastify
    // constructor). Behind the loopback nginx that means the bucket key is the
    // real client IP; a direct off-box peer's forged XFF is ignored, so the
    // per-IP buckets separate clients and cannot be collapsed by spoofing.
    keyGenerator: (req) => req.ip,
  });
} else {
  app.log.warn({ evt: 'auth.ratelimit.disabled', note: 'cfg.rate_limit.enabled=false' });
}

// App-level error handler (v0.2.49-alpha, NWC-ERR-1) — defense in depth so NO
// uncaught throw from a route handler ever surfaces as a bare "Internal Server
// Error" string or leaks a stack/secret to the client. The onboarding routes
// return structured { code, body } via reply.code().send() (NOT thrown), so
// those responses never reach here; likewise auth 401/403 and the rate-limit
// 429 (which @fastify/rate-limit builds via its own errorResponseBuilder). Only
// genuinely-thrown errors land here:
//   • client errors (Fastify validation / empty-body 400s, etc. — statusCode
//     < 500) are passed through unchanged so their shape is preserved;
//   • anything 5xx / unexpected is logged in full server-side and answered with
//     a sanitized JSON 500 that carries no message, stack, or secret material.
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status < 500) {
    reply.send(err);
    return;
  }
  app.log.error({
    url: req.url,
    code: err.statusCode || 500,
    name: err.name || 'Error',
    msg: scrub(err && err.message),
  }, 'unhandled route error');
  reply.code(500).send({ ok: false, error: 'internal error' });
});

// First-touch admin bootstrap (v0.2.26-alpha): the persister is injected so
// auth stays filesystem-agnostic + unit-testable. It writes the claimed npub
// back into the same config.yaml the daemon booted from.
const auth = createAuth(cfg, {
  log: app.log,
  persistAdmin: (npub) => persistAdminNpub(cfg._config_path, npub),
});
const wallet = await createWallet(cfg, app.log);
const routstr = createRoutstr(cfg, wallet, app.log);

// Read-only project-source adapters (v0.2.47-alpha, CONT-KANBAN-SYNC). Imports
// local Markdown to-do files + public GitHub issues into per-project Kanban
// boards under strict allowlists. Disabled unless cfg.project_sources.enabled.
const projectSources = createProjectSources(cfg, { log: app.log });

// Version/update stack (v0.2.69-alpha, VERSION-UPDATE-1). The release checker
// answers "is a newer same-channel release available?" for the public
// /api/version endpoint (cached, rate-limited, fail-soft — never blocks login).
// The updater spools an admin-vetted update request into the agent's ONLY
// writable path (memory/); a separate root-side ops applier re-validates it and
// rewrites the deploy pin. The agent itself never execs or touches root files.
const releaseChecker = createReleaseChecker({
  currentVersion: VERSION,
  owner: cfg.update?.repo_owner,
  repo: cfg.update?.repo_name,
});
const updateAllowlist = Array.isArray(cfg.update?.allowlist) ? cfg.update.allowlist : [];
const updater = createUpdater({
  requestPath: join(AGENT_ROOT, 'memory', 'update-request.json'),
  allowlist: updateAllowlist,
});

// Ollama fallback (CONT-AGENT-1b) — optional local-model provider.
// Disabled by default; enable via config.ollama.enabled: true when Ollama
// is running on the VPS. Router honours config.model_router.strategy.
const ollama = createOllama(cfg, app.log);
const router = createModelRouter({ routstr, ollama, cfg, log: app.log });

// Character + memory stack (CONT-CHARACTER-1)
const memoryCache = createMemoryCache(app.log);
const memory = createMemoryLoader({ cache: memoryCache, agentRoot: AGENT_ROOT, log: app.log });
const reflector = createReflector({ agentRoot: AGENT_ROOT, cache: memoryCache, log: app.log });
await memory.loadCharacter();

const chatSkill = createChatSkill(router, app.log, { memory, reflector });

// Genesis stack (GENESIS-1) — sovereign bot birth certificate bound to the
// verified Nostr owner, under the humanitarian starter constitution. The audit
// ledger is the hash-chained append-only log the agent already reserves at
// memory/audit.jsonl; genesis creation appends one line to it. No LoRA/RAG here
// — those are labelled subsequent stages in the manifest provenance + the UI.
const audit = createAudit(join(AGENT_ROOT, 'memory', 'audit.jsonl'), { log: app.log });
const genesis = createGenesis({ agentRoot: AGENT_ROOT, audit, log: app.log });

// Onboarding stack (v0.2.35-alpha) — encrypted-at-rest secret store for the
// operator secrets the agent must USE (NWC URI, Routstr sk- key), plus the
// pinned Routstr provider adapter. The live NIP-47 transport is built per-call
// so the onboarding logic stays testable with an injected client.
const secretStore = createSecretStore(cfg, { log: app.log });
const routstrProvider = createRoutstrProvider(cfg, { log: app.log });
const onboarding = createOnboarding({
  secretStore,
  routstrProvider,
  log: app.log,
  connectNwc: async (parsed) => {
    const transport = await createLiveNwcTransport(parsed, { log: app.log });
    return createNwcClient(parsed, {
      transport,
      log: app.log,
      timeoutMs: cfg.nwc?.request_timeout_ms || 15000,
    });
  },
});

// ─────────────────────────────────────────────────────────────
// Panic-key nudge state — one-time hint, per admin_npub
// ─────────────────────────────────────────────────────────────
//
// The 30097 emergency-wipe authority is OPTIONAL. On the first /api/memory/unlock
// where the ciphertext store contains no 30097, we return `panic_key_nudge: true`
// so the Console can show a skippable card. Dismissal is remembered on disk.
// Panic-key optionality is independent of this nudge — set config.panic_key.enabled
// or config.panic_key.nudge_on_first_unlock to silence it entirely.

const NUDGE_STATE_PATH = join(AGENT_ROOT, 'memory', 'panic-key-nudge.json');

async function readNudgeState() {
  try {
    const raw = await readFile(NUDGE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function writeNudgeState(state) {
  await mkdir(dirname(NUDGE_STATE_PATH), { recursive: true });
  await writeFile(NUDGE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function ciphertextsHavePanicKey() {
  const relDir = dirForKind(KINDS.EMERGENCY_WIPE);
  const absDir = join(AGENT_ROOT, relDir);
  try {
    const files = await readdir(absDir);
    return files.some((f) => f.endsWith('.enc'));
  } catch { return false; }
}

async function maybePanicKeyNudge(npub) {
  if (cfg.panic_key?.nudge_on_first_unlock === false) return false;
  if (cfg.panic_key?.enabled === true) return false; // already opted in
  const state = await readNudgeState();
  if (state[npub]?.dismissed) return false;
  if (await ciphertextsHavePanicKey()) return false;
  return true;
}

async function dismissPanicKeyNudge(npub) {
  const state = await readNudgeState();
  state[npub] = { dismissed: true, at: new Date().toISOString() };
  await writeNudgeState(state);
}

// ─────────────────────────────────────────────────────────────
// Auth middleware — attach to routes that require it
// ─────────────────────────────────────────────────────────────
async function requireAdmin(req, reply) {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return reply.code(401).send({ error: 'missing bearer token' });
  const check = auth.verifySessionToken(m[1]);
  if (!check.ok) return reply.code(401).send({ error: `session invalid: ${check.reason}` });
  req.session = { npub: check.npub, exp: check.exp };
}

// ─────────────────────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────────────────────

app.get('/api/health', async () => ({
  ok: true,
  service: 'torii-continuum-agent',
  version: VERSION,
  time: new Date().toISOString(),
  memory_unlocked: memoryCache.isUnlocked(),
  // First-touch state: false means the box is still unclaimed and the next
  // verified NIP-07 caller becomes admin. No pubkey is exposed either way.
  admin_claimed: auth.isClaimed(),
}));

// Public /api/version is polled by every open login page, so cap it per-IP.
const versionMax =
  Number.isFinite(cfg.rate_limit?.version_per_min) && cfg.rate_limit.version_per_min > 0
    ? cfg.rate_limit.version_per_min
    : 30;

// GET /api/version — PUBLIC, non-secret version summary (VERSION-UPDATE-1).
// Lets the logged-out login screen show current + latest-available release.
// The checker caches/rate-limits/fails-soft, so a GitHub outage never blocks
// login: it returns { source:'unreachable' } with the current version intact.
// Only version strings are exposed — no tokens, no repo internals.
app.get('/api/version', { config: rateLimitConfig(versionMax, '/api/version') }, async () => {
  return releaseChecker.get();
});

// GET /api/constitution — PUBLIC canonical humanitarian starter constitution
// (GENESIS-1). Exposes only the immutable covenant body + its version and
// stable digest — no user data, no secrets. Public by design: visible
// provenance is a founding principle, and a manifest's pinned digest is only
// meaningful if anyone can fetch the canonical artifact to compare against.
app.get('/api/constitution', async () => {
  const c = getConstitution();
  return { ok: true, version: c.version, digest: c.digest, constitution: c.body };
});

// GET /api/health/models — provider reachability probe.
// Returns Routstr + Ollama status so the Console can show which providers
// are live and which are enabled. Admin-gated to avoid leaking endpoints.
app.get('/api/health/models', { preHandler: requireAdmin }, async () => {
  const strategy = cfg.model_router?.strategy || 'routstr_first';
  const ollamaEnabled = cfg.ollama?.enabled === true;
  const ollamaProbe = ollamaEnabled ? await ollama.probe() : { ok: false, reason: 'disabled in config' };
  return {
    version: VERSION,
    strategy,
    routstr: {
      enabled: true,
      endpoint: cfg.routstr?.endpoint || null,
      model: cfg.routstr?.model || null,
    },
    ollama: {
      enabled: ollamaEnabled,
      endpoint: cfg.ollama?.endpoint || null,
      chat_model: cfg.ollama?.models?.chat || cfg.ollama?.model || null,
      reflect_model: cfg.ollama?.models?.reflect || cfg.ollama?.model || null,
      reachable: ollamaProbe.ok,
      reason: ollamaProbe.reason || null,
      models_available: ollamaProbe.models || null,
    },
    time: new Date().toISOString(),
  };
});

// ─────────────────────────────────────────────────────────────
// Rate-limit configs for the two auth routes.
//
// Only applied when cfg.rate_limit.enabled !== false. Defaults are 10/min
// on /challenge and 20/min on /verify per IP. Both send a 429 with a
// `Retry-After` header and a structured body. errorResponseBuilder emits
// the auth.ratelimited log line so operators see probes without needing
// to parse pino's built-in 429 line.
// ─────────────────────────────────────────────────────────────
const authChallengeMax =
  Number.isFinite(cfg.rate_limit?.auth_challenge_per_min) && cfg.rate_limit.auth_challenge_per_min > 0
    ? cfg.rate_limit.auth_challenge_per_min
    : 10;
const authVerifyMax =
  Number.isFinite(cfg.rate_limit?.auth_verify_per_min) && cfg.rate_limit.auth_verify_per_min > 0
    ? cfg.rate_limit.auth_verify_per_min
    : 20;
// Onboarding mutation/test/pay endpoints are admin-gated AND rate-limited so a
// stolen session can't hammer the wallet/provider or the pay path.
const onboardingMax =
  Number.isFinite(cfg.rate_limit?.onboarding_per_min) && cfg.rate_limit.onboarding_per_min > 0
    ? cfg.rate_limit.onboarding_per_min
    : 12;
const sourcesRefreshMax =
  Number.isFinite(cfg.rate_limit?.project_sources_refresh_per_min) && cfg.rate_limit.project_sources_refresh_per_min > 0
    ? cfg.rate_limit.project_sources_refresh_per_min
    : 12;
const walletHealthMax =
  Number.isFinite(cfg.rate_limit?.wallet_health_per_min) && cfg.rate_limit.wallet_health_per_min > 0
    ? cfg.rate_limit.wallet_health_per_min
    : 6;
// Admin-gated update queue/cancel. Low ceiling — an update is a rare, human act.
const updateMax =
  Number.isFinite(cfg.rate_limit?.update_per_min) && cfg.rate_limit.update_per_min > 0
    ? cfg.rate_limit.update_per_min
    : 6;
// Admin-gated genesis create. Genesis is a one-time act; keep the ceiling low so
// a stolen session cannot hammer the create path (idempotency already bounds the
// disk effect to a single manifest, but the ceiling bounds the request volume).
const genesisMax =
  Number.isFinite(cfg.rate_limit?.genesis_per_min) && cfg.rate_limit.genesis_per_min > 0
    ? cfg.rate_limit.genesis_per_min
    : 6;

// Continuum project slugs are lowercase kebab (see src/data/store.js slugify).
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

function rateLimitConfig(max, route) {
  if (!rateLimitEnabled) return undefined;
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      errorResponseBuilder: (req, context) => {
        app.log.warn({
          evt: 'auth.ratelimited',
          route,
          ip_prefix: (req.ip || '').slice(0, 12),
          max,
          remaining_ms: context.ttl,
        });
        const retryAfter = Math.ceil((context.ttl || 60000) / 1000);
        return {
          statusCode: 429,
          error: 'Too Many Requests',
          ok: false,
          reason: 'rate_limited',
          retry_after_sec: retryAfter,
        };
      },
    },
  };
}

app.post('/api/auth/challenge', { config: rateLimitConfig(authChallengeMax, '/api/auth/challenge') }, async (req, reply) => {
  const clientIp = req.ip;
  const { challenge, expires_in } = auth.issueChallenge(clientIp);
  return { challenge, expires_in, kind: 22242 };
});

app.post('/api/auth/verify', { config: rateLimitConfig(authVerifyMax, '/api/auth/verify') }, async (req, reply) => {
  const event = req.body?.event;
  if (!event) return reply.code(400).send({ error: 'body.event required' });
  const result = await auth.verifyChallenge(event, req.ip);
  if (!result.ok) {
    // auth.mjs already emitted the structured auth.verify.fail line.
    return reply.code(401).send({ error: result.reason });
  }
  // auth.mjs already emitted auth.verify.success.
  return { token: result.token, expires_at: result.expires_at };
});

// ─────────────────────────────────────────────────────────────
// Admin routes
// ─────────────────────────────────────────────────────────────

// POST /api/update — queue an admin-vetted self-update (VERSION-UPDATE-1).
// Admin-gated + rate-limited. The server independently re-validates the tag
// (strict grammar, strictly-newer, must be the vetted latest or allowlisted)
// and spools a request into the agent-writable memory/ dir. It NEVER execs and
// NEVER touches root-owned files — a separate root ops applier converges the
// deploy. `confirm:true` is required so a stray POST can't queue a deploy.
app.post(
  '/api/update',
  { preHandler: requireAdmin, config: rateLimitConfig(updateMax, '/api/update') },
  async (req, reply) => {
    const tag = typeof req.body?.tag === 'string' ? req.body.tag.trim() : '';
    if (req.body?.confirm !== true) {
      return reply.code(400).send({ ok: false, code: 'not_confirmed', reason: 'confirm:true required' });
    }
    const result = await updater.request({
      tag,
      currentVersion: VERSION,
      latestKnown: releaseChecker.latestKnown(),
      requestedBy: req.session?.npub || null,
    });
    if (!result.ok) {
      const status = result.code === 'pending' ? 409 : 400;
      app.log.warn({ evt: 'update.request.reject', code: result.code, tag });
      return reply.code(status).send(result);
    }
    app.log.info({ evt: 'update.request.queued', tag: result.tag, by: req.session?.npub || null });
    return result;
  },
);

// GET /api/update/status — admin view of the queued request (if any).
app.get('/api/update/status', { preHandler: requireAdmin }, async () => {
  const s = await updater.status();
  return { ok: true, ...s, current: VERSION, latest: releaseChecker.latestKnown() };
});

// POST /api/update/cancel — admin cancels a queued request.
app.post(
  '/api/update/cancel',
  { preHandler: requireAdmin, config: rateLimitConfig(updateMax, '/api/update/cancel') },
  async () => {
    const r = await updater.cancel();
    app.log.info({ evt: 'update.request.cancel', cancelled: r.cancelled });
    return r;
  },
);

app.get('/api/wallet/balance', { preHandler: requireAdmin }, async () => {
  const b = await wallet.balance();
  return {
    total_sats: b.total,
    per_mint: b.per_mint,
    warn_below: cfg.cashu?.low_balance_warn_sats || 500,
    floor: cfg.cashu?.hard_floor_sats || 100,
  };
});

app.post('/api/wallet/receive', { preHandler: requireAdmin }, async (req, reply) => {
  const token = req.body?.token;
  if (!token || typeof token !== 'string') {
    return reply.code(400).send({ error: 'body.token (cashuA...) required' });
  }
  const result = await wallet.receive(token);
  if (!result.ok) return reply.code(400).send({ error: result.reason });
  return { ok: true, added_sats: result.added_sats, mint: result.mint };
});

// GET /api/wallet/health — CONT-HEALTH-2. Non-mutating wallet + mint health.
// Admin-gated: it reveals mint identity + balance validation. Never spends,
// never mutates proofs, never returns proofs/secrets/tokens. Surfaces honest
// disabled/ok/degraded/unreachable states with sanitized reasons so the
// dashboard Provider card can show real wallet reachability.
//
// The dashboard auto-polls this every 20s, and each probe issues a NUT-07
// /checkstate to every mint. To keep an open dashboard (or several tabs) from
// driving steady mint load, the route is rate-limited AND the result is cached
// server-side for a short window — concurrent/rapid polls are served from cache
// instead of re-probing the mints.
const WALLET_HEALTH_CACHE_MS = 15000;
let walletHealthCache = { at: 0, body: null };
app.get(
  '/api/wallet/health',
  { preHandler: requireAdmin, config: rateLimitConfig(walletHealthMax, '/api/wallet/health') },
  async () => {
    const nowMs = Date.now();
    if (walletHealthCache.body && nowMs - walletHealthCache.at < WALLET_HEALTH_CACHE_MS) {
      return { ...walletHealthCache.body, cached: true };
    }
    const h = await wallet.health();
    const body = { version: VERSION, ...h };
    walletHealthCache = { at: nowMs, body };
    return body;
  },
);

app.post('/api/chat', { preHandler: requireAdmin }, async (req, reply) => {
  const message = req.body?.message;
  const context = req.body?.context || null;
  if (!message || typeof message !== 'string') {
    return reply.code(400).send({ error: 'body.message required' });
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) return reply.code(400).send({ error: 'empty message' });
  if (trimmed.length > 4000) return reply.code(400).send({ error: 'message too long (max 4000)' });

  const result = await chatSkill.handle({ message: trimmed, context });
  if (!result.ok) {
    // 502 = upstream failure (Routstr / wallet)
    return reply.code(502).send({ error: result.reason });
  }

  return {
    reply: result.reply,
    model: result.model,
    provider: result.provider,
    duration_ms: result.duration_ms,
    sats_spent: result.sats_spent,
  };
});

// ─────────────────────────────────────────────────────────────
// Project-source routes (v0.2.47-alpha, CONT-KANBAN-SYNC) — admin-gated.
//
// GET  /api/projects/:slug/sources         — what's configured + last snapshot
// POST /api/projects/:slug/sources/refresh — re-import (rate-limited)
//
// Read-only: these NEVER write back to Markdown or GitHub. The response carries
// normalized, read-only records the SPA merges into the project's Kanban board
// without touching local/manual cards.
// ─────────────────────────────────────────────────────────────
app.get('/api/projects/:slug/sources', { preHandler: requireAdmin }, async (req, reply) => {
  const slug = req.params.slug;
  if (!PROJECT_SLUG_RE.test(String(slug || ''))) {
    return reply.code(400).send({ error: 'bad project slug' });
  }
  return projectSources.list(slug);
});

app.post(
  '/api/projects/:slug/sources/refresh',
  { preHandler: requireAdmin, config: rateLimitConfig(sourcesRefreshMax, '/api/projects/:slug/sources/refresh') },
  async (req, reply) => {
    const slug = req.params.slug;
    if (!PROJECT_SLUG_RE.test(String(slug || ''))) {
      return reply.code(400).send({ error: 'bad project slug' });
    }
    return projectSources.refresh(slug);
  },
);

// ─────────────────────────────────────────────────────────────
// Genesis routes (GENESIS-1) — admin-gated.
//
// GET  /api/genesis  — read the authenticated owner's manifest (if any) plus a
//                      live tamper-evidence check of its pinned constitution
//                      digest against the running constitution.
// POST /api/genesis  — one-time create. The owner pubkey is taken from the
//                      VERIFIED session (req.session.npub), NEVER from the body,
//                      so a caller cannot mint a manifest for another key.
//                      Idempotent: a retry returns the existing manifest.
//
// Reads/writes are namespaced by the owner's pubkey inside core/genesis.mjs, so
// cross-owner access is structurally impossible (default-deny).
// ─────────────────────────────────────────────────────────────
app.get('/api/genesis', { preHandler: requireAdmin }, async (req, reply) => {
  const r = await genesis.read(req.session.npub);
  if (!r.ok) return reply.code(400).send({ ok: false, error: r.reason || 'bad request' });
  return r;
});

app.post(
  '/api/genesis',
  { preHandler: requireAdmin, config: rateLimitConfig(genesisMax, '/api/genesis') },
  async (req, reply) => {
    const body = req.body || {};
    const result = await genesis.create({
      // Authority comes from the verified session, not the request body.
      ownerNpub: req.session.npub,
      displayName: body.display_name,
      archetype: body.archetype,
      creativeIntent: body.creative_intent,
      agentVersion: VERSION,
    });
    if (!result.ok) {
      const status = result.code === 'validation' ? 400 : 400;
      app.log.warn({ evt: 'genesis.create.reject', code: result.code });
      return reply.code(status).send(result);
    }
    return reply.code(result.created ? 201 : 200).send(result);
  },
);

// ─────────────────────────────────────────────────────────────
// Character + memory routes (all admin-gated)
// ─────────────────────────────────────────────────────────────

// GET /api/character — the current character view (plaintext CHARACTER.md +
// its hash + whether the signed 30092 root matches).
app.get('/api/character', { preHandler: requireAdmin }, async () => {
  const status = memory.status();
  const fragments = memory.promptFragments();
  return {
    character_loaded: status.character_loaded,
    character_hash: status.character_hash,
    character_root_verified: status.character_root_verified,
    character_root_reason: status.character_root_reason,
    character_text: fragments.character,
    counts: fragments.counts,
  };
});

// GET /api/memory — non-sensitive status snapshot.
app.get('/api/memory', { preHandler: requireAdmin }, async () => {
  return memory.status();
});

// POST /api/memory/unlock — browser posts the decrypted plaintext bundle.
// Every entry has kind, d_tag, content (JSON), created_at, event_id (optional).
app.post('/api/memory/unlock', { preHandler: requireAdmin }, async (req, reply) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries)) {
    return reply.code(400).send({ error: 'body.entries[] required' });
  }
  const normalised = entries.map((e) => ({
    eventId: e.event_id || e.eventId || null,
    kind: e.kind,
    dTag: e.d_tag || e.dTag,
    content: e.content,
    createdAt: e.created_at || e.createdAt || Math.floor(Date.now() / 1000),
    source: 'unlock',
  }));
  const result = memoryCache.unlock(req.session.npub, normalised);
  const rootCheck = memory.verifyCharacterRoot();
  const panicNudge = await maybePanicKeyNudge(req.session.npub);
  return {
    ok: true,
    ...result,
    character_root_verified: rootCheck.ok,
    reason: rootCheck.reason || null,
    panic_key_nudge: panicNudge,
  };
});

// POST /api/memory/panic-nudge/dismiss — one-time "got it" acknowledgement
// from the Console. Writes memory/panic-key-nudge.json so we never show it
// again for this npub. Panic key remains optional either way.
app.post('/api/memory/panic-nudge/dismiss', { preHandler: requireAdmin }, async (req) => {
  await dismissPanicKeyNudge(req.session.npub);
  return { ok: true };
});

// POST /api/memory/lock — explicit relock. Panic sends `reason: "panic"`.
app.post('/api/memory/lock', { preHandler: requireAdmin }, async (req) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'operator-lock';
  memoryCache.clear(reason);
  return { ok: true };
});

// POST /api/memory/store — write a ciphertext blob to disk. Body:
//   { ciphertext, kind, d_tag, event_id? }
// Agent stores raw ciphertext keyed on event id (or a random draft tag).
app.post('/api/memory/store', { preHandler: requireAdmin }, async (req, reply) => {
  const { ciphertext, kind, d_tag, event_id } = req.body || {};
  const v = validateCiphertext(ciphertext);
  if (!v.ok) return reply.code(400).send({ error: `bad ciphertext: ${v.reason}` });
  if (!KINDS || !Object.values(KINDS).includes(kind)) {
    return reply.code(400).send({ error: `unknown kind ${kind}` });
  }
  if (typeof d_tag !== 'string' || d_tag.length === 0 || d_tag.length > 64) {
    return reply.code(400).send({ error: 'd_tag required (1..64 chars)' });
  }
  let filename;
  try {
    filename = ciphertextFilename(event_id || null);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
  const relDir = dirForKind(kind);
  const absDir = join(AGENT_ROOT, relDir);
  await mkdir(absDir, { recursive: true });
  const absPath = join(absDir, filename);
  await writeFile(absPath, ciphertext, 'utf8');
  app.log.info(`[memory] stored ${kind}:${d_tag} → ${relDir}/${filename} (fp=${fingerprintCiphertext(ciphertext)})`);
  return { ok: true, path: `${relDir}/${filename}`, fingerprint: fingerprintCiphertext(ciphertext) };
});

// GET /api/memory/ciphertexts — list all encrypted files so browser can
// pull them down, decrypt, and POST back to /api/memory/unlock.
app.get('/api/memory/ciphertexts', { preHandler: requireAdmin }, async () => {
  const out = [];
  for (const kind of Object.values(KINDS)) {
    const relDir = dirForKind(kind);
    const absDir = join(AGENT_ROOT, relDir);
    let files;
    try {
      files = await readdir(absDir);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.enc')) continue;
      const body = await readFile(join(absDir, f), 'utf8').catch(() => null);
      if (!body) continue;
      out.push({ kind, path: `${relDir}/${f}`, ciphertext: body });
    }
  }
  return { count: out.length, entries: out };
});

// POST /api/reflect — trigger an offline reflection pass. Never signs.
app.post('/api/reflect', { preHandler: requireAdmin }, async (req) => {
  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 50);
  const dryRun = req.body?.dry_run === true;
  const result = await reflector.reflect({ limit, dryRun });
  return result;
});

// GET /api/pending — list draft events awaiting operator signature.
app.get('/api/pending', { preHandler: requireAdmin }, async () => {
  const dir = join(AGENT_ROOT, 'pending');
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  const drafts = [];
  for (const f of files) {
    if (!f.endsWith('.draft.json')) continue;
    try {
      const buf = await readFile(join(dir, f), 'utf8');
      const obj = JSON.parse(buf);
      drafts.push({ file: f, kind: obj.kind, tags: obj.tags, proposed_at: obj._proposed_at });
    } catch { /* skip */ }
  }
  drafts.sort((a, b) => (b.proposed_at || 0) - (a.proposed_at || 0));
  return { count: drafts.length, drafts };
});

// GET /api/pending/:file — return one draft's full payload for signing.
app.get('/api/pending/:file', { preHandler: requireAdmin }, async (req, reply) => {
  const name = req.params.file;
  if (!/^[a-zA-Z0-9._-]+\.draft\.json$/.test(name)) {
    return reply.code(400).send({ error: 'bad filename' });
  }
  try {
    const buf = await readFile(join(AGENT_ROOT, 'pending', name), 'utf8');
    return JSON.parse(buf);
  } catch (e) {
    return reply.code(404).send({ error: `not found: ${e.message}` });
  }
});

// DELETE /api/pending/:file — discard a draft (after signing or reject).
app.delete('/api/pending/:file', { preHandler: requireAdmin }, async (req, reply) => {
  const name = req.params.file;
  if (!/^[a-zA-Z0-9._-]+\.draft\.json$/.test(name)) {
    return reply.code(400).send({ error: 'bad filename' });
  }
  try {
    await unlink(join(AGENT_ROOT, 'pending', name));
    return { ok: true };
  } catch (e) {
    return reply.code(404).send({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Onboarding routes (v0.2.35-alpha) — wallet (Step 2) + Routstr (Step 3)
//
// All admin-gated. Mutation/test/pay endpoints are additionally rate-limited.
// Handlers live in core/onboarding.mjs and return { code, body }; these routes
// are thin adapters. No secret is ever echoed back — only redacted shapes.
// ─────────────────────────────────────────────────────────────
function sendOnboarding(reply, r) {
  return reply.code(r.code).send(r.body);
}

// Step 2 — wallet (NWC)
app.post(
  '/api/onboarding/wallet/connect',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/wallet/connect') },
  async (req, reply) => sendOnboarding(reply, await onboarding.walletConnect({ nwcUri: req.body?.nwc_uri })),
);
app.get('/api/onboarding/wallet/status', { preHandler: requireAdmin }, async (req, reply) =>
  sendOnboarding(reply, await onboarding.walletStatus()),
);
app.post(
  '/api/onboarding/wallet/test',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/wallet/test') },
  async (req, reply) => sendOnboarding(reply, await onboarding.walletTest()),
);
app.post(
  '/api/onboarding/wallet/disconnect',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/wallet/disconnect') },
  async (req, reply) => sendOnboarding(reply, await onboarding.walletDisconnect()),
);

// Step 3 — Routstr
app.post(
  '/api/onboarding/routstr/key',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/key') },
  async (req, reply) => sendOnboarding(reply, await onboarding.routstrKey({ key: req.body?.key })),
);
app.get('/api/onboarding/routstr/status', { preHandler: requireAdmin }, async (req, reply) =>
  sendOnboarding(reply, await onboarding.routstrStatus()),
);
app.get('/api/onboarding/routstr/models', { preHandler: requireAdmin }, async (req, reply) =>
  sendOnboarding(reply, await onboarding.routstrModels()),
);
app.post(
  '/api/onboarding/routstr/quote',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/quote') },
  async (req, reply) => sendOnboarding(reply, await onboarding.routstrQuote({ amountSats: req.body?.amount_sats })),
);
app.post(
  '/api/onboarding/routstr/pay',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/pay') },
  async (req, reply) =>
    sendOnboarding(
      reply,
      await onboarding.routstrPay({
        invoice: req.body?.invoice,
        quoteId: req.body?.quote_id,
        confirm: req.body?.confirm,
      }),
    ),
);
app.post(
  '/api/onboarding/routstr/recover',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/recover') },
  async (req, reply) => sendOnboarding(reply, await onboarding.routstrRecover({ bolt11: req.body?.bolt11 })),
);
app.post(
  '/api/onboarding/routstr/disconnect',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/disconnect') },
  async (req, reply) => sendOnboarding(reply, await onboarding.routstrDisconnect()),
);

// ── Recovery / resume (v0.2.37-alpha) ────────────────────────────────────
//
// A refresh/restart during a paid-but-unclaimed Routstr session must NEVER
// require re-payment. recovery/state is the redacted resume snapshot the
// Console reads on load; when `claimable` is true it calls the existing,
// idempotent routstr/recover (empty body → the agent supplies the stored
// bolt11) to finish the claim. recovery-kit and routstr/export-key are served
// with Cache-Control: no-store so no secret-adjacent bytes are ever cached.

app.get('/api/onboarding/recovery/state', { preHandler: requireAdmin }, async (req, reply) =>
  sendOnboarding(reply, await onboarding.recoveryState()),
);

app.get('/api/onboarding/recovery-kit', { preHandler: requireAdmin }, async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  return sendOnboarding(
    reply,
    await onboarding.recoveryKit({ adminNpub: req.session?.npub || null, agentVersion: VERSION }),
  );
});

// One-time full-key reveal. Admin-gated, rate-limited, confirm-gated, no-store.
app.post(
  '/api/onboarding/routstr/export-key',
  { preHandler: requireAdmin, config: rateLimitConfig(onboardingMax, '/api/onboarding/routstr/export-key') },
  async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    return sendOnboarding(reply, await onboarding.routstrExportKey({ confirm: req.body?.confirm }));
  },
);

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────

const port = cfg.server.port;
const host = cfg.server.host;

try {
  await app.listen({ port, host });
  app.log.info(`torii-continuum-agent listening on http://${host}:${port}`);
  app.log.info(
    auth.isClaimed()
      ? `admin npub: ${(auth.adminNpub() || '').slice(0, 12)}...`
      : 'admin: UNCLAIMED — first verified NIP-07 caller will claim (first-touch)',
  );
  app.log.info(`cashu mints: ${wallet.mints.join(', ') || '(none)'}`);
  app.log.info(`routstr endpoint: ${cfg.routstr.endpoint}`);
  app.log.info(`ollama: enabled=${cfg.ollama?.enabled === true} endpoint=${cfg.ollama?.endpoint || '(default)'}`);
  app.log.info(`model router strategy: ${cfg.model_router?.strategy || 'routstr_first'}`);
  app.log.info(`character loaded: ${memory.status().character_loaded}, memory unlocked: ${memoryCache.isUnlocked()}`);
} catch (err) {
  app.log.error({ err }, 'listen failed');
  process.exit(1);
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log.info(`received ${signal}, shutting down`);
    memoryCache.clear(`signal ${signal}`);
    await app.close();
    process.exit(0);
  });
}
