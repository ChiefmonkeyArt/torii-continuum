# Torii Continuum — Contributor / Agent Handoff

> Single-page onboarding for the next contributor — human or AI agent (Perplexity,
> DeepSeek, perplexica, routstr, or a FOSS human). It captures repo state, the
> hard constraints, where the source of truth lives, and how to build/test/ship.
> It is a working template: keep it current as the codebase moves. It describes
> the project as it is today; it does not promise API/behaviour compatibility
> across versions (this is a pre-1.0 alpha).

---

## 1. What this is

Torii Continuum is the **sovereign agent + operator console** for the Torii
ecosystem. A Vite-built static SPA (dark canonical, vermilion accent `#d94f2c`)
paired with a Node/Express agent server that routes LLM calls between a Cashu-paid
Routstr proxy and a local Ollama instance. Continuum is the "brain that runs on
your box" — mounted by torii-base at `/continuum/` alongside Plebeian and Quest
on one domain with shared identity/wallet.

- **Current version:** v0.2.106-alpha — not yet deployed on the VPS. Deployed VPS
  agent + frontend remain on v0.2.105-alpha (`3b99a13`) pending the matching
  suite-side PR that pulls `qwen3:0.6b` during install.
- **Active focus:** Ollama fallback tune-up + `qwen3:0.6b` swap. `agent/core/ollama.mjs`
  now sends `keep_alive: -1` and `options.num_ctx: 4096` on every request (both
  config-overridable) so the fallback path stops paying a 2–8s cold-start on every
  degraded turn and no longer silently truncates context at 4096. Default chat
  model in `agent/config.example.yaml` swapped from `qwen2.5:0.5b` to `qwen3:0.6b`
  (same footprint, agent-loop tool-calling score 0.880 vs 0.640). 464 agent tests
  green. Router primary remains Routstr Core v0.1.0 discovery-driven routing
  (Nostr kind-38421 + bootstrap list → runtime `/v1/models` catalog → cheapest
  provider with failover) shipped in v0.2.105-alpha and LIVE-verified (3 reachable
  providers / 870 models, 2026-09-05). Suite installer resolves `origin/<ref>`
  (torii-suite v0.9.5-alpha) so redeploys always land on the latest tag.
- **Live:** https://continuum-torii.pplx.app (see §7)
- **Repo:** https://github.com/ChiefmonkeyArt/torii-continuum
- **License:** GPL-3.0

## 2. Hard constraints (do NOT break these)

1. **Version bump on every deploy.** Every source change that ships bumps the
   version in ALL markers in §3. Publish to `continuum-torii.pplx.app` after
   each iteration — the user's standing rule.
2. **Dark is canonical.** The dark theme is the default; a light theme is
   optional. Do not ship a build where light is default.
3. **Base-path awareness stays intact.** `vite.config.js` MUST keep
   `base: './'` so the SPA works both at `/` (standalone at
   `continuum-torii.pplx.app`) and at `/continuum/` (mounted by torii-base).
   Agent URLs come from `VITE_AGENT_URL` — never hardcode `http://localhost:...`
   into the shipped bundle.
4. **Model router provider field is authoritative.** Every model-router return
   MUST carry `provider ∈ {routstr, ollama, both}` alongside `ok`, `content`,
   `model`, `tokens_in`, `tokens_out`, `sats_spent`, `duration_ms`. Consumers
   read `provider` to distinguish paid Routstr calls from free Ollama fallback;
   dropping this field silently breaks accounting.
5. **Ollama fallback is OFF by default.** The router default strategy is
   `routstr_first`; `ollama_first`, `ollama_only`, `routstr_only` are opt-in via
   `config.yaml`. Never flip the default without a version bump + doc change —
   users are paying real sats via Routstr and expect that path first.
6. **Session cookies must use the `__Host-` prefix.** The pplx.app proxy strips
   any request cookie whose name does not start with `__Host-`. Default
   framework names (`connect.sid`, `sessionid`) silently stop working after
   publish. If session state is ever added, configure the name explicitly, e.g.
   `express-session({ name: '__Host-sid', cookie: { secure: true, path: '/' } })`.
7. **Published sandbox has NO LLM API access and NO connector bridge.** The
   `api_credentials=['llm-api:website']` preset and `call_external_tool` are
   development-only. Any real LLM traffic in the shipped agent must go through
   the operator's OWN Routstr / Ollama endpoints — never through the pplx.app
   credential proxy.
8. **Privacy first: pseudonym only.** Author/committer name is
   **`ChiefmonkeyArt`** (`chiefmonkey@hodlr.rocks`). Never commit under a real
   name. `git -c user.name="ChiefmonkeyArt" -c user.email="chiefmonkey@hodlr.rocks"
   commit -m "..."` is the required pattern.
9. **Do not name Google, Cloudflare, Microsoft, or Babylon.js in docs.**
   (Ecosystem-wide rule inherited from Quest §2.12.)
10. **No hardcoded secrets in the repo.** `.gitignore` covers `config.yaml`,
    `.env*`, `*.token`, `*.secret`. `config.example.yaml` is the only committed
    config artifact.
11. **Never let the turn budget exceed the nginx proxy bound (CONT-TIMEOUT-1).**
    The model router opens ONE wall-clock budget per chat turn
    (`model_router.total_budget_ms`, default 100000ms) shared across every
    provider attempt. It MUST stay under nginx `proxy_read_timeout` (200s on the
    VPS); raising the budget to or above the nginx bound reintroduces the 504.
    Raise both together or neither.

## 3. Version markers (bump together)

| File | Location |
|---|---|
| `package.json` | `"version"` — valid SemVer (e.g. `0.2.6-alpha`) |
| `agent/package.json` | `"version"` — matches root |
| `src/config.js` (or equivalent) | `VERSION` export used by the dashboard header |
| `README.md` | "Current version" line + any changelog section header |
| `agent/README.md` §9b | "Ollama fallback" section version marker |
| `ops/README.md` | Sizing/version note if referenced |
| `CHANGELOG.md` | New `## v0.2.<n>-alpha` entry |

The version string ships in the Continuum dashboard header + is echoed by
`/api/health/models` for cheap live-vs-source drift checks.

## 4. Source of truth

- **`src/`** — Vite SPA (dark theme canonical, vermilion `#d94f2c` accent).
  Base-path-agnostic: uses `import.meta.env.BASE_URL` for all internal links.
- **`agent/index.mjs`** — Express server entrypoint. Mounts `/api/chat`,
  `/api/health`, `/api/health/models`, and any future endpoints under a
  configurable prefix so torii-base can mount it at `/agent/`.
- **`agent/core/model-router.mjs`** — The provider-agnostic router
  (`createModelRouter({ routstr, ollama, cfg, log }).chat(args)`). Returns
  `{ok, content, model, tokens_in, tokens_out, sats_spent, duration_ms,
  provider}` with `provider ∈ routstr|ollama|both`. Strategies: `routstr_first`
  (default), `ollama_first`, `ollama_only`, `routstr_only`. Opens one shared
  turn budget and only falls through on retryable failures (see §2.11).
- **`agent/core/ollama.mjs`** — Ollama HTTP client (chat completions API).
  Single configured model; fail-fast on connection error.
- **`agent/core/routstr.mjs`** — Routstr client (Cashu-paid LLM calls). Resolves
  the requested model to reachable providers **cheapest-first** and fails over
  across them within the turn budget; reclaims change from the `X-Cashu` refund
  header.
- **`agent/core/routstr-discovery.mjs`** — Routstr Core v0.1.0 discovery
  (RIP-02/03): Nostr kind-38421 provider announcements merged with deterministic
  bootstrap endpoints, plus per-provider `/v1/models` catalog fetch and sats
  pricing.
- **`agent/lib/timeout-budget.mjs`** — CONT-TIMEOUT-1: one wall-clock budget per
  turn, sliced across sequential provider attempts (provider timeout clamped to
  the remaining budget; a fallback with <5s left is not started).
- **`agent/lib/provider-errors.mjs`** — structured error classification (5xx /
  HTML error page / timeout / empty stream / dry wallet) that drives both the
  Routstr provider ladder and the Routstr→Ollama fallback.
- **`agent/routes/chat.mjs`** — `/api/chat` endpoint; delegates to the router.
- **`agent/routes/health.mjs`** — `/api/health` (liveness) and
  `/api/health/models` (Routstr reachability + Ollama reachability + configured
  strategy). Read-only, no billed calls.
- **`config.example.yaml`** — canonical config shape. Includes the `ollama:`
  block (`enabled`, `base_url`, `model`, `timeout_ms`) added in v0.2.6-alpha.
- **`ops/ansible/`** — installer for a fresh Ubuntu VPS.
  - `roles/base/` — user, systemd unit, nginx site, HTTPS.
  - `roles/continuum/` — clones repo, builds `dist/`, wires agent as a systemd
    service.
  - `roles/ollama/` — installs Ollama and pulls the configured default model.
- **`ops/README.md`** — VPS sizing table (RAM/CPU/disk per Ollama model),
  install/upgrade/rollback runbook.

## 5. Build / test / check commands

```bash
# SPA (root)
npm install
npm run dev              # Vite dev server
npm run build            # → dist/
npm run preview          # serve built dist/

# Agent (agent/)
cd agent
npm install
npm run start            # node index.mjs (reads ../config.yaml)
npm test                 # unit tests for router + clients

# Ansible (ops/ansible/)
ansible-playbook -i inventory.example.ini site.yml --check   # dry-run
ansible-playbook -i inventory.example.ini site.yml           # apply

# Health probe (any environment)
curl -s http://localhost:3000/api/health/models | jq .
```

A change is "green" when **build + agent tests + `/api/health/models` OK** on a
local dev instance. Test the base-path build BOTH at `/` and at `/continuum/`
before publishing — the mounted case is the failure mode most likely to regress.

## 6. Debug / operator surface

- **`torii doctor`** (from torii-base) — checks Continuum reachability, agent
  health, Routstr reachability, Ollama reachability, and Cashu wallet presence.
  Run this first when anything looks off; it distinguishes "SPA down" from
  "agent down" from "provider unreachable".
- **`/api/health`** — cheap liveness (200 OK if the agent process is up).
- **`/api/health/models`** — returns `{routstr: {ok, latency_ms},
  ollama: {ok, latency_ms, model}, strategy, version}`. Safe to poll.
- **Dashboard header** — shows source `VERSION`, provider strategy, and
  (when wired) the last resolved `provider` from the most recent chat call.
- **Agent logs** — structured JSON to stdout; systemd captures them under
  `journalctl -u torii-continuum-agent`.

## 7. Deploy / publish

The user's standing rule: **"Publish to `continuum-torii.pplx.app` and bump the
version after every iteration."**

Preview + publish sequence (main agent only — subagents cannot call
`publish_website`):

```
pplx-tool deploy_website
  project_path=/home/user/workspace/torii-continuum/dist
  site_name="Torii Continuum"
  entry_point="index.html"

pplx-tool publish_website
  site_id="00acfee3-6cd6-477f-8d0f-36f84a6f6963"
  project_path=/home/user/workspace/torii-continuum
  dist_path=/home/user/workspace/torii-continuum/dist
```

- **Site ID (published):** `00acfee3-6cd6-477f-8d0f-36f84a6f6963`
- **Asset ID:** `92361a20-e20f-4647-b44b-9fbab826b52c`
- **URL:** https://continuum-torii.pplx.app
- **Visibility:** public

**Pre-publish checklist:**
1. Version bumped in ALL §3 markers.
2. `npm run build` clean, `dist/` regenerated.
3. Agent tests green.
4. Security review subagent (`security_subagent_prompt.md`) run — no BLOCK
   findings. Note: the pplx.app published sandbox has no LLM API / connector
   bridge, so any AI features must be routed through the operator's OWN
   provider endpoints (not the pplx credential proxy).
5. Commit + push to `main` with the `ChiefmonkeyArt` author.
6. `deploy_website` → `publish_website` (with the `site_id` above for updates).

**Self-hosting the whole stack** (Continuum + Plebeian + Quest under one
domain): use the `ops/ansible/` playbook or the torii-base installer
(see `TORII_BASE_HANDOFF.md`).

## 8. Active issues / open edges

- **Dashboard is not yet wired to `/api/health/models`.** The endpoint exists
  and returns real data; the UI currently shows a static "provider ready"
  badge. Next slice: subscribe the header + a small provider card to that
  endpoint (polling or SSE) so the operator sees the actual strategy +
  reachability without opening curl.
- **Cashu wallet health is a reachability probe, not a real balance check.**
  `torii doctor` currently checks that the Cashu mint URL responds; it does
  not query the wallet balance or verify the mint's public key. A future
  slice should fold in a signed wallet-info call.
- **Ollama model selection is single-model per config.** `config.yaml` picks
  ONE `ollama.model`. Multi-model routing (e.g. small model for classifier,
  large for chat) is not implemented — the router picks Ollama or Routstr, not
  Ollama-model-A vs Ollama-model-B.
- **No consent gate on `/api/chat` yet.** The agent will happily call Routstr
  (spending sats) on any authenticated request. Before wiring a UI that fires
  chats implicitly (e.g. on page load), add a per-session consent flag mirroring
  Quest's SEC-1 pattern.
- **VPS install has been tested via Ansible check-mode but not on a live
  cold-boot VPS end-to-end.** The playbook is docs-consistent with `ops/README.md`
  but a real first-run smoke on Ubuntu 24.04 is still pending.

## 9. Next-job format

When picking up work, state it as:

```
TASK:        <one line>
VERSION:     bump v0.2.<n> → v0.2.<n+1>-alpha
CONSTRAINTS: (default = all of §2; note any the task explicitly relaxes)
SCOPE:       files expected to change; split by concern
DONE WHEN:   build + agent tests green; /api/health/models OK; docs (§4) updated;
             version markers (§3) bumped
DEPLOY:      Publish to continuum-torii.pplx.app after landing green
             (user's standing rule — every iteration)
```

Keep changes incremental and reversible. Test the base-path build at BOTH `/`
and `/continuum/` before publishing.

## 10. Ecosystem context

Torii Continuum is one leaf of the Torii ecosystem:

- **Torii Quest** — browser arena shooter (Three.js + Rapier). See
  `HANDOFF.md`. Live: https://torii-quest.pplx.app
- **Torii Continuum** — sovereign agent + operator console. *This document.*
- **torii-base** — host layer that mounts Continuum + Plebeian + Quest on
  one domain via nginx. See `TORII_BASE_HANDOFF.md`.
- **Plebeian Market** — nostr-native marketplace (external upstream).

The design signature across all four: dark canonical, vermilion accent
`#d94f2c`, feudal/cyberpunk aesthetic. Character (not charter). Bitcoin
maximalist, joyfully optimistic.
