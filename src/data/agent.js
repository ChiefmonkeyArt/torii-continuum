/**
 * Continuum ↔ Agent HTTP client.
 *
 * The agent daemon (VPS: agent/index.mjs) is the single source of truth for
 * wallet balance, Routstr calls, and any live-action state. This module
 * wraps fetch() with:
 *   • base URL from build-time env (VITE_AGENT_URL) or window override
 *   • session token injection from localStorage
 *   • graceful degradation when the agent is unreachable
 *
 * When AGENT_URL is empty (default for the pplx.app demo build), every
 * `agent.*` call short-circuits with { ok:false, reason:'offline' } so the
 * mockup UX keeps working without the daemon behind it.
 */

const TOKEN_KEY = 'continuum.session.v1';
// The onboarding wizard (preview-assets/onboarding-*) writes its session here.
// It is a JSON envelope { token, expires_at, pubkey, method, created_at } — the
// same HMAC session token the agent issues, never a secret key. The SPA does
// NOT adopt it as a login on boot (that silently established a session without
// an explicit user action); it is only used below to detect that a same-origin
// agent is reachable, and it is cleared on sign-out.
const ONBOARDING_SESSION_KEY = 'torii.session';

/**
 * Derive the same-origin agent base from the page's pathname. The SPA and the
 * agent are served from the same origin: at the `/continuum/` mount the agent
 * is proxied at `/continuum/api/*`, so the base is `/continuum`. At the site
 * root there is no prefix and the base is '' (calls hit `/api/*`). Pure so the
 * subpath contract is unit-tested without a DOM.
 * @param {string} pathname e.g. location.pathname
 * @returns {string} base with no trailing slash ('' at root)
 */
export function deriveSameOriginBase(pathname) {
  if (typeof pathname !== 'string' || !pathname) return '';
  const m = pathname.match(/^\/([^/]+)(?:\/|$)/);
  if (m && m[1] === 'continuum') return '/continuum';
  return '';
}

function hasOnboardingSession() {
  try {
    const raw = localStorage.getItem(ONBOARDING_SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && typeof s.token === 'string' && s.token.length);
  } catch { return false; }
}

function agentUrl() {
  // Priority: window override > build env > same-origin runtime fallback > empty
  if (typeof window !== 'undefined' && window.__CONTINUUM_AGENT_URL__) {
    return String(window.__CONTINUUM_AGENT_URL__).replace(/\/$/, '');
  }
  try {
    if (import.meta.env?.VITE_AGENT_URL) {
      return String(import.meta.env.VITE_AGENT_URL).replace(/\/$/, '');
    }
  } catch (_e) {}
  // Defensive runtime fallback: if the build shipped without VITE_AGENT_URL but
  // we can see a live onboarding session in this origin's storage, the agent IS
  // reachable same-origin — use the mount-derived base rather than going
  // offline and stranding a just-onboarded operator.
  if (typeof window !== 'undefined' && window.location && hasOnboardingSession()) {
    return deriveSameOriginBase(window.location.pathname);
  }
  return '';
}

export function isAgentConfigured() {
  return agentUrl().length > 0;
}

export function getStoredToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

export function setStoredToken(tok) {
  try {
    if (tok) localStorage.setItem(TOKEN_KEY, tok);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {}
}

export function clearStoredToken() { setStoredToken(null); }

/**
 * Cheap, HMAC-free liveness check of an agent session token. Mirrors the
 * agent's `iat.exp.pubkey.sig` shape and its `exp < now` rule (the server still
 * verifies the HMAC on every call — this only decides whether the UI shows a
 * logged-in state). Pure + exported so the contract is unit-tested without a
 * DOM. `now` is unix seconds.
 * @param {unknown} tok
 * @param {number} [now]
 */
export function tokenLooksLive(tok, now = Math.floor(Date.now() / 1000)) {
  if (typeof tok !== 'string' || !tok) return false;
  const parts = tok.split('.');
  if (parts.length !== 4) return false;
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(exp)) return false;
  return exp > now;
}

export function isLoggedIn() {
  return tokenLooksLive(getStoredToken());
}

/**
 * Build a human-readable, non-sensitive failure reason from an agent error
 * body. The agent's own handlers reply `{ error: <reason> }`; Fastify's
 * built-in errors reply `{ error: <generic>, message: <specific> }` (e.g.
 * error "Bad Request" + message "Body cannot be empty…"). We surface the
 * specific message when it adds detail over the generic label, else the label,
 * else the bare status. Values are short server-controlled strings (never
 * stack traces), and we cap the length so a malformed body can't flood the UI.
 * Pure + exported so the mapping is unit-tested without a network.
 * @param {any} json parsed response body (may be null)
 * @param {number} status HTTP status
 */
export function errorReason(json, status) {
  const clip = (s) => (typeof s === 'string' && s.length ? s.slice(0, 200) : '');
  const err = clip(json?.error);
  const msg = clip(json?.message);
  if (msg && msg !== err) return err ? `${err}: ${msg}` : msg;
  if (err) return err;
  return `http ${status}`;
}

async function req(method, path, body) {
  const base = agentUrl();
  if (!base) return { ok: false, reason: 'offline', offline: true };

  // Only declare a JSON content-type when we actually send a JSON body. The
  // /api/auth/challenge call is bodyless; Fastify v5 rejects an empty body
  // carrying `Content-Type: application/json` with 400 FST_ERR_CTP_EMPTY_JSON_BODY
  // (error: "Bad Request") before the handler runs — which surfaced to the
  // operator as "Could not reach agent: Bad Request". Mirrors the onboarding
  // client's postJson so the two agent clients cannot drift apart again.
  const hasBody = body !== undefined && body !== null;
  const headers = hasBody ? { 'Content-Type': 'application/json' } : {};
  const tok = getStoredToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
  } catch (e) {
    return { ok: false, reason: `network: ${e.message}`, offline: true };
  }

  let json = null;
  try { json = await res.json(); } catch (_e) {}

  if (!res.ok) {
    // 401 → session expired, clear it so UI drops back to logged-out
    if (res.status === 401) clearStoredToken();
    return { ok: false, reason: errorReason(json, res.status), status: res.status };
  }

  return { ok: true, data: json };
}

// ─── Auth ───────────────────────────────────────────────────

export async function requestChallenge() {
  return req('POST', '/api/auth/challenge');
}

export async function verifyChallenge(event) {
  const r = await req('POST', '/api/auth/verify', { event });
  if (r.ok && r.data?.token) setStoredToken(r.data.token);
  return r;
}

// Sign-out must drop every auth-relevant token so a subsequent refresh reliably
// lands on the login modal. That means the SPA session slot AND the onboarding
// handoff envelope (torii.session) — otherwise a stale onboarding token would
// linger and be treated as a live agent hint after sign-out.
export function logout() {
  clearStoredToken();
  try { localStorage.removeItem(ONBOARDING_SESSION_KEY); } catch (_e) {}
}

// ─── Wallet ─────────────────────────────────────────────────

export async function walletBalance() {
  return req('GET', '/api/wallet/balance');
}

export async function walletReceive(token) {
  return req('POST', '/api/wallet/receive', { token });
}

/**
 * GET /api/wallet/health — CONT-HEALTH-2. Non-mutating wallet + mint health.
 * Admin-gated; returns { configured, overall, checked_at, mints:[...] } with
 * per-mint identity + validated balance. Logged-out callers get offline via req().
 */
export async function walletHealth() {
  return req('GET', '/api/wallet/health');
}

// ─── Project sources (read-only Kanban import) ──────────────

/**
 * GET /api/projects/:slug/sources — configured sources + last snapshot for a
 * project. Slug is path-segment safe (lowercase kebab); encode defensively.
 */
export async function projectSources(slug) {
  return req('GET', `/api/projects/${encodeURIComponent(slug)}/sources`);
}

/**
 * POST /api/projects/:slug/sources/refresh — re-import all configured sources
 * for a project. Returns { ok, enabled, partial, stale, sources, records,
 * syncedAt }. Records are read-only and merged into the board client-side.
 */
export async function refreshProjectSources(slug) {
  return req('POST', `/api/projects/${encodeURIComponent(slug)}/sources/refresh`, {});
}

// ─── Chat ───────────────────────────────────────────────────

export async function chat({ message, context }) {
  return req('POST', '/api/chat', { message, context });
}

// ─── Health ─────────────────────────────────────────────────

export async function health() {
  return req('GET', '/api/health');
}

/**
 * GET /api/health/models — provider reachability probe. Admin-gated.
 * Returns strategy + routstr + ollama shape (see agent/index.mjs).
 * Callers that aren't logged in get { ok:false, offline:true } via req().
 */
export async function healthModels() {
  return req('GET', '/api/health/models');
}

// ─── Version / self-update (VERSION-UPDATE-1) ───────────────

/**
 * GET /api/version — PUBLIC, non-secret version summary. Works logged out so
 * the login card can show current + latest. Returns { ok, data:{ current,
 * latest, update_available, channel, checked_at, source, stale } } or offline.
 */
export async function versionInfo() {
  return req('GET', '/api/version');
}

/**
 * POST /api/update — queue an admin-vetted self-update. Admin-gated; sends
 * confirm:true so a stray call can't trigger a deploy. The server independently
 * re-validates the tag (must be the vetted latest or allowlisted, strictly
 * newer). The client only ever passes the server-known latest tag.
 * @param {string} tag v-prefixed release tag
 */
export async function requestUpdate(tag) {
  return req('POST', '/api/update', { tag, confirm: true });
}

/** GET /api/update/status — admin view of any queued update request. */
export async function updateStatus() {
  return req('GET', '/api/update/status');
}

/** POST /api/update/cancel — admin cancels a queued update request. */
export async function cancelUpdate() {
  return req('POST', '/api/update/cancel', {});
}
