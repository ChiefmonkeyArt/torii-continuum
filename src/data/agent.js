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
// The expiry the agent stated for the current session (unix seconds). Not a
// secret and not a credential — a token without this is still usable, and this
// without a token is meaningless. See setSessionExpiry for why it is stored
// rather than parsed back out of the token.
const SESSION_EXPIRY_KEY = 'continuum.session.exp.v1';
// Client state that belongs to the signed-in owner and must not survive a sign
// out on a shared browser. The local project store (`continuum.v1`) is
// deliberately NOT here: it is the operator's own local-first document set,
// already behind the route guard, and wiping it on sign-out would destroy work.
// `continuum.theme` is a display preference with no owner in it.
export const OWNER_SCOPED_KEYS = Object.freeze([
  'continuum.chat.threads',
  'continuum.routstr.focusTopUp',
]);

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

export function clearStoredToken() { setStoredToken(null); setSessionExpiry(null); }

/**
 * The auth epoch (CONT-SESSION-1).
 *
 * Two calls persist a session: the login verify and the background renewal.
 * Both used to store whatever came back the moment it came back, with no check
 * that the intent which started the request was still current. That is the
 * whole bug: sign out (or cancel a login) while one is in flight and the reply
 * lands afterwards, writing a live token underneath a UI that is now showing
 * the public login screen. Nothing on screen changes, so nobody notices — until
 * the next refresh reads storage, finds a valid session, and opens the
 * dashboard. Storage and screen disagreed, and on reload storage wins.
 *
 * So every auth write is stamped with the epoch that was current when its
 * request STARTED, and anything that invalidates in-flight auth intent (sign
 * out, an abandoned login attempt) bumps it. A reply from a superseded epoch is
 * reported, not persisted. The guard has to live here, in the module that owns
 * the storage, because a guard in the caller sits ABOVE the write and cannot
 * stop it — which is exactly how the previous attempt-generation check was
 * bypassed.
 */
let authEpoch = 0;

/** The current auth epoch. Capture before an auth request, compare after. */
export function authEpochNow() { return authEpoch; }

/**
 * Invalidate every auth write already in flight. Called by sign-out and by an
 * abandoned login attempt.
 * @returns {number} the new epoch
 */
export function invalidateAuthWrites() { authEpoch += 1; return authEpoch; }

/**
 * Persist (or clear) the expiry the AGENT stated when it issued this session.
 *
 * This is the authoritative signal, and it is why it is stored separately from
 * the token: the token is the agent's business and the browser should treat it
 * as opaque. Parsing it was what let the two drift apart — v0.2.92 added a
 * field, the client demanded exactly the new count, and against an agent that
 * had not been upgraded in lockstep the browser disowned a token the agent had
 * just legitimately issued. Sign-in then "succeeded" while the UI stayed signed
 * out. An expiry the agent told us cannot desynchronise from the token's shape.
 * @param {number|null} sec unix seconds, or null to clear
 */
export function setSessionExpiry(sec) {
  try {
    if (Number.isFinite(sec) && sec > 0) localStorage.setItem(SESSION_EXPIRY_KEY, String(Math.floor(sec)));
    else localStorage.removeItem(SESSION_EXPIRY_KEY);
  } catch (_e) {}
}

/** The stored authoritative expiry, or null when absent/corrupt. */
export function readSessionExpiry() {
  try {
    const raw = localStorage.getItem(SESSION_EXPIRY_KEY);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * Cheap, HMAC-free liveness check of an agent session token. Applies the
 * agent's `exp < now` rule (the server still verifies the HMAC on every call —
 * this only decides whether the UI shows a logged-in state). Pure + exported so
 * the contract is unit-tested without a DOM. `now` is unix seconds.
 * @param {unknown} tok
 * @param {number} [now]
 */
export function tokenLooksLive(tok, now = Math.floor(Date.now() / 1000)) {
  const exp = tokenExpiry(tok);
  return exp !== null && exp > now;
}

/**
 * The `exp` a session token carries, or null when it is absent or unreadable.
 *
 * Deliberately SHAPE-TOLERANT: any token of at least four dot-separated fields
 * is read, and `exp` is taken from index 1 — the one position that has been
 * stable across every token version the agent has ever issued. An exact
 * field-count check is what turned "the agent added a field" into "the operator
 * cannot sign in", so the client no longer asserts a count it does not own.
 * Only a fallback; readSessionExpiry() is authoritative when present.
 * @param {unknown} tok
 * @returns {number|null} unix seconds
 */
export function tokenExpiry(tok) {
  if (typeof tok !== 'string' || !tok) return null;
  const parts = tok.split('.');
  if (parts.length < 4) return null;
  const exp = parseInt(parts[1], 10);
  return Number.isFinite(exp) ? exp : null;
}

/**
 * The single expiry the whole UI reasons about: what the agent said, else what
 * the token carries. Null means "no session", which is not the same as "a
 * session that ended" — the session state machine needs to tell those apart.
 * @returns {number|null} unix seconds
 */
export function sessionExpiry() {
  if (!getStoredToken()) return null;
  return readSessionExpiry() ?? tokenExpiry(getStoredToken());
}

/**
 * THE authoritative client-side answer to "is the operator signed in?".
 *
 * Every guard, the shell, the session control and the refresh loop must route
 * through this one function. Divergent re-derivations of the same question were
 * the bug: the login surface could believe sign-in had succeeded while the
 * router believed nobody was signed in.
 */
export function isLoggedIn(now = Math.floor(Date.now() / 1000)) {
  const exp = sessionExpiry();
  return exp !== null && exp > now;
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

/**
 * Client-side deadline for a chat turn (CONT-TIMEOUT-1).
 *
 * The browser fetch had NO deadline, so when the agent stalled behind a slow
 * provider the operator watched a spinner until nginx cut the socket at 120s —
 * and even then some browsers keep the request pending. The deadline chain, and
 * every link must hold:
 *
 *   agent turn budget 100s  <  this 115s  <=  nginx proxy_read_timeout 120s
 *
 * Sitting between the two means a slow-but-honest agent reply still lands (we
 * outwait its own budget), while a truly wedged connection surfaces as our own
 * `client_timeout` rather than a raw proxy 504.
 */
export const CHAT_CLIENT_TIMEOUT_MS = 115000;

/** Default deadline for ordinary agent calls (auth, memory, projects). */
const DEFAULT_CLIENT_TIMEOUT_MS = 30000;

async function req(method, path, body, { timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS } = {}) {
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

  // Bound the request AND the body read: a proxy can hold a response open after
  // the headers arrive, which would hang just as badly as a hung connection.
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = ctl && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs)
    : null;
  const clientTimeout = () => ({
    ok: false,
    code: 'client_timeout',
    reason: `timed out after ${Math.round(timeoutMs / 1000)}s`,
    timeout: true,
  });

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    // A timeout is NOT "offline" — the agent is reachable, just slow. Callers
    // branch on it separately so the UI can say so instead of claiming no network.
    if (timedOut) return clientTimeout();
    return { ok: false, reason: `network: ${e.message}`, offline: true };
  }

  let json = null;
  try { json = await res.json(); } catch (_e) {}
  if (timer) clearTimeout(timer);
  if (timedOut) return clientTimeout();

  if (!res.ok) {
    // 401 → session expired, clear it so UI drops back to logged-out
    if (res.status === 401) clearStoredToken();
    // Propagate the agent's structured `code` when present so callers can branch
    // on a stable token instead of pattern-matching the human reason string.
    return {
      ok: false,
      reason: errorReason(json, res.status),
      status: res.status,
      code: json && typeof json.code === 'string' ? json.code : null,
    };
  }

  return { ok: true, data: json };
}

// ─── Auth ───────────────────────────────────────────────────

// Both auth calls take an explicit deadline. Login is a click the operator is
// actively waiting on, so it sets far tighter per-stage budgets than the generic
// client default (which is sized for a model generating chat tokens) — see
// src/login-stages.js. Omitting the option keeps the default.
export async function requestChallenge(opts = {}) {
  return req('POST', '/api/auth/challenge', undefined, opts);
}

export async function verifyChallenge(event, opts = {}) {
  const epoch = authEpochNow();
  const r = await req('POST', '/api/auth/verify', { event }, opts);
  // Cancelled, timed out, or signed out while the agent was answering: the
  // operator is looking at the public login screen, so this signature must not
  // quietly become a session they never see and cannot get out of.
  if (epoch !== authEpochNow()) return { ok: false, code: 'superseded', superseded: true };
  if (r.ok && r.data?.token) {
    setStoredToken(r.data.token);
    // Record the agent's own expiry BEFORE anybody is told the login worked, so
    // there is no window in which the UI has been notified of a session it would
    // then fail to recognise.
    setSessionExpiry(r.data.expires_at ?? tokenExpiry(r.data.token));
  }
  return r;
}

/**
 * Slide the current session forward without a new signature (CONT-AUTH-1).
 *
 * The replacement token is only stored on a clean success, so a refusal or a
 * network fault leaves the existing — still valid — token exactly where it is.
 * Returns the agent's refusal `code` unchanged, because the session state
 * machine routes on it: only `max_lifetime_reached` is terminal.
 * @returns {Promise<{ok: boolean, code?: string, expires_at?: number}>}
 */
export async function refreshSession() {
  const epoch = authEpochNow();
  const r = await req('POST', '/api/auth/refresh');
  // Signed out mid-renewal. Storing this would resurrect the session the
  // operator just ended — and re-arm the renewal loop behind the login screen.
  if (epoch !== authEpochNow()) return { ok: false, code: 'superseded', superseded: true };
  if (r.ok && r.data?.token) {
    setStoredToken(r.data.token);
    const exp = r.data.expires_at ?? tokenExpiry(r.data.token);
    setSessionExpiry(exp);
    return { ok: true, expires_at: exp };
  }
  return { ok: false, code: r.data?.code || r.code || 'refresh_failed' };
}

// Sign-out must drop every auth-relevant token so a subsequent refresh reliably
// lands on the login modal. That means the SPA session slot AND the onboarding
// handoff envelope (torii.session) — otherwise a stale onboarding token would
// linger and be treated as a live agent hint after sign-out.
export function logout() {
  // Before clearing, so a reply already on the wire cannot land behind us.
  invalidateAuthWrites();
  clearStoredToken();
  try { localStorage.removeItem(ONBOARDING_SESSION_KEY); } catch (_e) {}
  // Owner-scoped client state goes with the session. The chat log in particular
  // is the operator's own conversation with their bot; leaving it behind meant
  // the next person to open this browser could read it after a sign-out.
  for (const k of OWNER_SCOPED_KEYS) {
    try { localStorage.removeItem(k); } catch (_e) {}
  }
}

// ─── Wallet ─────────────────────────────────────────────────

export async function walletBalance() {
  return req('GET', '/api/wallet/balance');
}

export async function walletReceive(token) {
  return req('POST', '/api/wallet/receive', { token });
}

// ─── Lightning-QR top-up (v0.2.83-alpha) ────────────────────
//
// Two funding sources for the Routstr top-up modal. The Cashu mint-quote path
// mints proofs into the agent's Cashu wallet on payment (balance rises); the
// NWC path issues an invoice on the linked NWC wallet (sats land there, NOT in
// Cashu). All four share the same offline short-circuit as the wrappers above.

/** POST /api/wallet/mint-quote — issue a Cashu mint-quote BOLT11 for `amountSats`. */
export async function walletMintQuote(amountSats, mint)  { return req('POST', '/api/wallet/mint-quote', { amount_sats: amountSats, mint }); }
/** GET /api/wallet/mint-quote/:quote — poll a mint quote; mints proofs on PAID. */
export async function walletMintQuoteStatus(quote)       { return req('GET',  `/api/wallet/mint-quote/${encodeURIComponent(quote)}`); }
/** POST /api/wallet/nwc-invoice — issue a BOLT11 on the connected NWC wallet. */
export async function walletNwcInvoice(amountSats, memo) { return req('POST', '/api/wallet/nwc-invoice', { amount_sats: amountSats, memo }); }
/** GET /api/wallet/nwc-invoice/:hash — poll NWC invoice settlement (never mints). */
export async function walletNwcInvoiceStatus(hash)       { return req('GET',  `/api/wallet/nwc-invoice/${encodeURIComponent(hash)}`); }
/** GET /api/wallet/quotes/pending — the caller's unminted top-up quotes (recovery). */
export async function walletPendingQuotes()              { return req('GET',  '/api/wallet/quotes/pending'); }
/** POST /api/wallet/quotes/:quote/resume — complete one stuck top-up (idempotent). */
export async function walletResumeQuote(quote)           { return req('POST', `/api/wallet/quotes/${encodeURIComponent(quote)}/resume`); }

/**
 * GET /api/wallet/health — CONT-HEALTH-2. Non-mutating wallet + mint health.
 * Admin-gated; returns { configured, overall, checked_at, mints:[...] } with
 * per-mint identity + validated balance. Logged-out callers get offline via req().
 */
export async function walletHealth() {
  return req('GET', '/api/wallet/health');
}

// ─── NWC wallet (NIP-47 Nostr Wallet Connect) ───────────────
//
// These wrap the agent's existing onboarding wallet routes so the Routstr page
// can surface NWC status/connect/test/disconnect without duplicating logic.
// NOTE: the agent implements NWC (NIP-47) only — there is NO NIP-60 protocol
// support here, so UI must label this an "NWC wallet", not NIP-60.

/** GET /api/onboarding/wallet/status — { connected, wallet, capabilities, can_fund_routstr, alias, network, connected_at }. */
export async function nwcStatus() {
  return req('GET', '/api/onboarding/wallet/status');
}

/** POST /api/onboarding/wallet/connect — store an NWC (nostr+walletconnect://…) URI. */
export async function nwcConnect(nwcUri) {
  return req('POST', '/api/onboarding/wallet/connect', { nwc_uri: nwcUri });
}

/** POST /api/onboarding/wallet/test — re-run get_info against the stored wallet. */
export async function nwcTest() {
  return req('POST', '/api/onboarding/wallet/test', {});
}

/** POST /api/onboarding/wallet/disconnect — forget the stored NWC wallet. */
export async function nwcDisconnect() {
  return req('POST', '/api/onboarding/wallet/disconnect', {});
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
  // Longer than any other call: a chat turn legitimately waits on a model.
  // See CHAT_CLIENT_TIMEOUT_MS for the agent/nginx ordering this has to respect.
  return req('POST', '/api/chat', { message, context }, { timeoutMs: CHAT_CLIENT_TIMEOUT_MS });
}

// ─── Genesis (GENESIS-1) ────────────────────────────────────
//
// The sovereign-bot birth certificate. The owner pubkey is bound server-side
// from the verified session — the client NEVER sends a pubkey. LoRA training and
// RAG retrieval are labelled subsequent stages; nothing here fakes them.

/**
 * GET /api/constitution — PUBLIC canonical humanitarian starter constitution.
 * Returns { ok, data:{ version, digest, constitution } } or offline. Works
 * logged out so the covenant + its digest are always inspectable (visible
 * provenance).
 */
export async function constitution() {
  return req('GET', '/api/constitution');
}

/**
 * GET /api/genesis — read the authenticated owner's manifest (if any) plus a
 * live tamper-evidence check. Returns { ok, data:{ exists, manifest?,
 * constitution_ok?, manifest_digest_ok? } } or offline/401 via req().
 */
export async function genesisRead() {
  return req('GET', '/api/genesis');
}

/**
 * POST /api/genesis — one-time create. Only non-authority fields are sent; the
 * agent binds the owner pubkey from the verified session. Idempotent server-side.
 * @param {{ display_name: string, archetype?: string, creative_intent?: string }} fields
 */
export async function genesisCreate(fields) {
  return req('POST', '/api/genesis', {
    display_name: fields?.display_name,
    archetype: fields?.archetype,
    creative_intent: fields?.creative_intent,
  });
}

// ─── MEMORY-1: consent, scoped storage, portability ─────────
//
// Durable AI memory is a PROPOSAL until the owner explicitly approves it, and
// approval is bound to the exact payload hash the owner reviewed. All ciphertext
// is sealed in the browser (NIP-44) — the agent never sees plaintext or a key.
// Portability is manual (download/upload) and owner-signed; import quarantines.

/** GET /api/memory/working-values — which constitution/COP covenant is live (provenance only, no secrets). */
export async function memoryWorkingValues() {
  return req('GET', '/api/memory/working-values');
}

/** GET /api/memory/usage — per-owner usage, quotas, per-scope breakdown. */
export async function memoryUsage() {
  return req('GET', '/api/memory/usage');
}

/** GET /api/memory/scoped?project=&class= — item metadata for a scope (no ciphertext). */
export async function memoryScoped({ project, cls } = {}) {
  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (cls) qs.set('class', cls);
  const q = qs.toString();
  return req('GET', `/api/memory/scoped${q ? `?${q}` : ''}`);
}

/** POST /api/memory/scoped/verify — recompute item hashes (corruption check) for a scope. */
export async function memoryVerify({ project } = {}) {
  return req('POST', '/api/memory/scoped/verify', { project });
}

/** POST /api/memory/scoped/delete — enact deletion (unlink + tombstone + audit). Requires confirm. */
export async function memoryDelete({ id, project, reason } = {}) {
  return req('POST', '/api/memory/scoped/delete', { id, project, reason, confirm: true });
}

/** GET /api/memory/proposals — pending AI/owner memory proposals awaiting review. */
export async function memoryProposals() {
  return req('GET', '/api/memory/proposals');
}

/**
 * POST /api/memory/proposals — create a pending proposal (never auto-persisted).
 * Ciphertext-only: the caller seals the proposed payload with NIP-44 v2 in the
 * browser and sends ONLY the ciphertext + a canonical-plaintext hash. No
 * plaintext ever reaches the agent — a `payload` field is refused server-side.
 */
export async function memoryPropose({ project, kind, cls, d_tag, ciphertext, payload_sha256, source } = {}) {
  return req('POST', '/api/memory/proposals', { project, kind, cls, d_tag, ciphertext, payload_sha256, source });
}

/**
 * POST /api/memory/proposals/:id/approve — ratify the EXACT reviewed payload.
 * The ciphertext is ALREADY sealed on the pending proposal (stored at creation),
 * so approval sends ONLY the reviewed payload hash + single-use nonce — never a
 * re-sent ciphertext or plaintext.
 */
export async function memoryApprove(id, { payload_sha256, approval_nonce, event_id } = {}) {
  return req('POST', `/api/memory/proposals/${encodeURIComponent(id)}/approve`, { payload_sha256, approval_nonce, event_id });
}

/** POST /api/memory/proposals/:id/reject — explicit, audited rejection. */
export async function memoryReject(id, { approval_nonce } = {}) {
  return req('POST', `/api/memory/proposals/${encodeURIComponent(id)}/reject`, { approval_nonce });
}

/** POST /api/memory/export — assemble an UNSIGNED bundle for the browser to sign + download. Requires confirm. */
export async function memoryExport() {
  return req('POST', '/api/memory/export', { confirm: true });
}

/** POST /api/memory/import — verify a signed bundle and quarantine its items (default-deny foreign/tampered). */
export async function memoryImport(bundle) {
  return req('POST', '/api/memory/import', { bundle });
}

/** GET /api/memory/quarantine — imported, untrusted items awaiting owner approval. */
export async function memoryQuarantine() {
  return req('GET', '/api/memory/quarantine');
}

/** POST /api/memory/quarantine/:sha/approve — promote a reviewed quarantine item into live memory. */
export async function memoryQuarantineApprove(sha, { sha256, project, d_tag } = {}) {
  return req('POST', `/api/memory/quarantine/${encodeURIComponent(sha)}/approve`, { sha256, project, d_tag });
}

/** POST /api/memory/quarantine/:sha/reject — discard a quarantine item. */
export async function memoryQuarantineReject(sha) {
  return req('POST', `/api/memory/quarantine/${encodeURIComponent(sha)}/reject`, {});
}

// ─── Memory activation (MEMORY-ACTIVATION-1) ─────────────────

/**
 * GET /api/memory — authoritative memory state for the signed-in owner.
 * `data.unlocked_for_owner` is the single source of truth the console trusts
 * to decide first-run activation vs. the normal Memory Console.
 */
export async function memoryState() {
  return req('GET', '/api/memory');
}

/**
 * GET /api/memory/ciphertexts — the encrypted-at-rest blobs for the browser to
 * decrypt with the owner's signer before activation. Never returns plaintext.
 */
export async function memoryCiphertexts() {
  return req('GET', '/api/memory/ciphertexts');
}

/** POST /api/memory/activate/challenge — one-time challenge for the owner to sign. */
export async function memoryActivateChallenge() {
  return req('POST', '/api/memory/activate/challenge');
}

/**
 * POST /api/memory/activate — hand the agent the owner-signed challenge + the
 * browser-decrypted entries. The agent verifies the signature (owner-bound,
 * single-use) before unlocking. Sends no plaintext beyond the entries the owner
 * just decrypted in their own browser; carries no key.
 */
export async function memoryActivate({ event, entries } = {}) {
  return req('POST', '/api/memory/activate', { event, entries });
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
