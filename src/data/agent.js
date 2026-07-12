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

function agentUrl() {
  // Priority: window override > build env > empty (offline)
  if (typeof window !== 'undefined' && window.__CONTINUUM_AGENT_URL__) {
    return String(window.__CONTINUUM_AGENT_URL__).replace(/\/$/, '');
  }
  try {
    if (import.meta.env?.VITE_AGENT_URL) {
      return String(import.meta.env.VITE_AGENT_URL).replace(/\/$/, '');
    }
  } catch (_e) {}
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

export function isLoggedIn() {
  const tok = getStoredToken();
  if (!tok) return false;
  // Cheap sanity check without HMAC verify — server verifies on every call.
  const parts = tok.split('.');
  if (parts.length !== 4) return false;
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 > Date.now();
}

async function req(method, path, body) {
  const base = agentUrl();
  if (!base) return { ok: false, reason: 'offline', offline: true };

  const headers = {};
  const tok = getStoredToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  let bodyStr;
  if (body !== undefined && body !== null) {
    bodyStr = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: bodyStr,
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
    return { ok: false, reason: json?.error || `http ${res.status}`, status: res.status };
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

export function logout() { clearStoredToken(); }

// ─── Wallet ─────────────────────────────────────────────────

export async function walletBalance() {
  return req('GET', '/api/wallet/balance');
}

export async function walletReceive(token) {
  return req('POST', '/api/wallet/receive', { token });
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
