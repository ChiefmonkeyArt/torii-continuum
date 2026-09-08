# Torii Continuum — v0.2.0-alpha · CONT-AGENT-1 slice report

**Scope:** invariants scaffold (NIP-07 login, Cashu wallet, Routstr chat) + marketing landing surface, mashed into one commit.

**Cadence:** one operator, one VPS, one npub. Multi-tenant is not on the table.

---

## What shipped

### Agent daemon (`agent/`)

New Fastify service that owns the sovereignty invariants for a single admin npub.

| File | Purpose |
| --- | --- |
| `agent/index.mjs` | Fastify server. Routes: `GET /api/health`, `POST /api/auth/challenge`, `POST /api/auth/verify`, `GET /api/wallet/balance`, `POST /api/wallet/receive`, `POST /api/chat`. CORS locked to configured origins. |
| `agent/core/config.mjs` | Loader + fail-fast validation (admin_npub decodes to hex; session_secret is 64 hex; whitelisted mints defined). |
| `agent/core/auth.mjs` | NIP-07 flow. Issues challenge (32 random bytes hex), verifies kind 22242 signed event via `nostr-tools` (`verifyEvent` + hash check), matches pubkey against admin. Session tokens are `iat.exp.pk.hmacSig` (HMAC-SHA256 over the header), 24h TTL, `timingSafeEqual`. |
| `agent/core/wallet.mjs` | Cashu wallet via `@cashu/cashu-ts@^2.1.0`. Per-mint proofs persisted to `memory/wallet/<slug>.json` (mode 0600). `receive()` rejects unknown mints; `send()` returns `{token, rollback}` so failed calls refund. |
| `agent/core/routstr.mjs` | OpenAI-compatible client. `Authorization: Cashu <token>` per request. Configurable fallback ladder walks on failure. Every call appends to `memory/costs.jsonl`. |
| `agent/skills/chat.mjs` | First real skill. System prompt grounds the model in Continuum context; default model is DeepSeek Chat V3, coding path uses DeepSeek-Coder-V2. |
| `agent/config.example.yaml` | Full schema with sensible defaults; requires operator to fill `admin_npub` + `session_secret`. |
| `agent/README.md` | 10-step VPS bring-up: dedicated user, systemd unit, nginx + Let's Encrypt, wallet top-up flow, rotation, uninstall. |
| `agent/PRIVACY.md` | Non-negotiable invariants: no nsec on VPS, no autonomous writes, gift-wrap-only for private data, single-tenant, no third-party analytics. |

### Frontend integration (`src/`)

| File | Change |
| --- | --- |
| `src/data/agent.js` (new) | HTTP client wrapping the agent API. `agentUrl()` reads `VITE_AGENT_URL` or `window.__CONTINUUM_AGENT_URL__`; empty ⇒ offline mode with graceful `{ok:false, offline:true}` returns. Manages the session token in `localStorage` under `continuum.session.v1`. |
| `src/auth.js` (new) | Login modal, NIP-07 signing flow, detection of missing signer, deep-link to Plebeian Signer install. Dispatches `continuum:session-changed` events. |
| `src/views/landing.js` (new) | Marketing surface: hero (torii arch + amber gradient), promises row, freedom-tech pillars, status list ("what ships today · what ships next"), footer. "Open the demo →" and "Login with Nostr" CTAs. |
| `src/styles/landing.css` (new) | Landing layout + torii arch + status dots. `#app.landing-mode` hides sidebar + chat dock. |
| `src/main.js` | Registers `'/'` → landing, toggles `.landing-mode`, listens for `continuum:session-changed` to re-render sidebar. |
| `src/router.js` | Default hash is now `#/` (landing) instead of `#/projects`. |
| `src/shell.js` | Sidebar footer gains a Login/Sign-out button next to the theme toggle. Brand click routes to landing. |
| `src/chat.js` | `getReply()` routes through `POST /api/chat` when a session is live; falls back to the canned mock reply otherwise, with a hint prefix on agent errors so the operator can debug. |
| `src/views/routstr.js` | **Connect Cashu wallet** now opens a modal that accepts a pasted Cashu token, POSTs to `/api/wallet/receive`, and polls `/api/wallet/balance` every 15s while the page is mounted. Falls back to mock behaviour on demo builds. |
| `index.html` | Loads `landing.css`. |

### Docs

- `torii-continuum-v0.2.0-cont-agent-1-report.md` (this file)
- `agent/README.md`, `agent/PRIVACY.md` (see above)

---

## Design decisions

- **One commit ("mash").** The operator asked for invariants and landing in the same slice so the sovereignty story lands with a public face. Split PRs would delay the demo experience.
- **`.landing-mode` class instead of separate router**. Simpler than layering a public-vs-app router; keeps the whole SPA behind a single entry point.
- **Session tokens are HMAC-signed strings, not JWTs.** No server-side session store; self-verifying, invalidated by rotating `session_secret`. Adequate for a single-operator system.
- **Cashu mints are whitelisted server-side.** `POST /api/wallet/receive` rejects anything not in `cashu.mints`. Operator controls trust.
- **Ollama deferred to CONT-AGENT-1b.** Getting DeepSeek via Routstr working end-to-end (login → wallet → chat) is the sovereignty story people care about. Local fallback is nice-to-have; it doesn't change the invariants.

---

## What's still theatre

- **Agent-less static demo build** intentionally has no `VITE_AGENT_URL`, so login says "requires self-hosted agent" and chat returns mock replies. This is by design — a live agent per user does not belong in an anonymous demo build.
- **Routstr chat** currently over-allocates `max_sats_per_request` per call and does not track refunds. Fine for a small float; needs refinement before the float grows.
- **`nostr_draft` skill** is toggled off in the config; the skills registry only has `chat.mjs` today.

---

## Next slices

- **CONT-AGENT-1b** — local Ollama fallback (Llama 3.1 8B on the VPS for offline reasoning; Routstr still primary).
- **CONT-AGENT-2** — `todo.patch` skill (writes to `torii-continuum-todo.md` via the agent, with browser-side signature for the eventual Nostr publish).
- **CONT-AGENT-3** — `brain.write` (drafts wiki page edits into `pending/` for a human click).
- **NGIT-1** — announce the repo on Nostr via NIP-34 (deferred until we have a real PoC to point at).
