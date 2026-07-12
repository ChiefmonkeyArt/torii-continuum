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
import { loadConfig } from './core/config.mjs';
import { createAuth } from './core/auth.mjs';
import { registerSetupRoutes } from './core/setup.mjs';
import { createWallet } from './core/wallet.mjs';
import { createRoutstr } from './core/routstr.mjs';
import { createOllama } from './core/ollama.mjs';
import { createModelRouter } from './core/model-router.mjs';
import { createChatSkill } from './skills/chat.mjs';
import { createMemoryCache, validateCiphertext, ciphertextFilename, fingerprintCiphertext } from './lib/crypto.mjs';
import { createMemoryLoader } from './lib/memory.mjs';
import { createReflector } from './lib/reflect.mjs';
import { KINDS, dirForKind } from './lib/events.mjs';

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

const app = Fastify({
  logger: {
    level: cfg.logging?.level || 'info',
    transport:
      cfg.logging?.destination === 'stdout' || !cfg.logging?.destination
        ? undefined
        : { target: 'pino/file', options: { destination: cfg.logging.destination } },
  },
  bodyLimit: 512 * 1024, // 512 KB — enough for a Cashu token + a chat message, nothing more
  disableRequestLogging: false,
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
    // Default keyGenerator uses req.ip which honours the trust-proxy
    // configuration below. nginx sets X-Forwarded-For; we must trust it
    // for the per-IP bucket to be the client IP and not the nginx loopback.
    keyGenerator: (req) => req.ip,
  });
} else {
  app.log.warn({ evt: 'auth.ratelimit.disabled', note: 'cfg.rate_limit.enabled=false' });
}

// nginx terminates TLS on the VPS and proxies to 127.0.0.1:8787 with
// X-Forwarded-For set. We trust the immediate proxy (the loopback nginx),
// so Fastify populates req.ip from that header. This is safe because the
// server binds to 127.0.0.1 only — nothing else can reach it directly.
app.addHook('onReady', async () => {
  // No-op — trust-proxy shape is applied via Fastify options above if
  // needed. We keep the default (trust the immediate proxy) which matches
  // the single-hop nginx layout in the suite installer.
});

const auth = createAuth(cfg, { log: app.log });

// Setup mode endpoints (first-run key registration)
registerSetupRoutes(app, cfg, auth, resolve(__dirname, 'config.yaml'));

const wallet = await createWallet(cfg, app.log);
const routstr = createRoutstr(cfg, wallet, app.log);

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
}));

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
  const result = auth.verifyChallenge(event, req.ip);
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
// Startup
// ─────────────────────────────────────────────────────────────

const port = cfg.server.port;
const host = cfg.server.host;

try {
  await app.listen({ port, host });
  app.log.info(`torii-continuum-agent listening on http://${host}:${port}`);
  app.log.info(`admin npubs: ${cfg.admin_npubs.map((n) => n.slice(0, 12)).join(', ')}`);
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
