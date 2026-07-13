# Continuum — Session Handover

**Current version:** v0.2.29-alpha
**Currently deployed server version:** v0.2.26-alpha (v0.2.27, v0.2.28, and v0.2.29 are not yet deployed — redeploy is a separate operator step via `ops/install-agent.sh`, and now **requires a Node 22 LTS host** — see the runtime gate below). **v0.2.27-alpha remains the newest *shipped* code; v0.2.28-alpha (cashu v3-lts migration) and v0.2.29-alpha (Node 22 runtime gate) are code+PR only, not deployed.**

Paste this whole block at the start of a new Perplexity Computer session to resume work seamlessly.

**Active focus:** **v0.2.28-alpha shipped AGENT-SEC-CASHU-LTS: the money-path dependency migration flagged in v0.2.27.** `@cashu/cashu-ts` moved `2.5.3 → 3.7.1` (the maintained `v3-lts` "security-fixes-only" line; dist-tag `v3-lts` resolved to `3.7.1` at implementation time, latest was `4.7.0` — v4 deliberately not taken), pinned `^3.7.1`, lockfile regenerated with sha512 integrity and the deprecation notice cleared. Code adapted in `agent/core/wallet.mjs` only: class rename `CashuMint→Mint` / `CashuWallet→Wallet`; the boot warm-up `getMintInfo()` (async in v2, now a sync cached getter that throws pre-load in v3) replaced by `await wallet.loadMint()`; an idempotent `ensureLoaded()` guard added before `receive()`/`send()` to restore v2 lazy-load-on-demand (verified zero extra network once keysets are cached). Token/proof codec, `Token`/`Proof`/`SendResponse` shapes, and the `receive()→Proof[]` contract are unchanged between the versions (both default to token-v4 `cashuB`). Safety proof: a token encoded by the **real 2.5.3 library** decodes under 3.7.1 with all mint/unit/memo/id/amount/secret/C preserved AND **re-encodes byte-identically**; on-disk `memory/wallet/*.json` survives a JSON round-trip unchanged — no re-mint, conversion, deletion, or network mutation. New offline `agent/test/cashu-migration.test.js` (8 cases) pins every used Cashu boundary incl. malformed/truncated tokens failing closed without leaking secrets; agent `node --test` now **38/38**. `npm audit --omit=dev` and full audit both **0 vulnerabilities**; real `node index.mjs` boot on Node 20.20.1 clean with no new warnings and Fastify 5.10.0 intact; root build + ops regressions (13/13, 9/9) green; prod tree shrank 71→68 packages. **Runtime gate — RESOLVED in v0.2.29-alpha (AGENT-SEC-CASHU-LTS-RUNTIME):** cashu-ts 3.7.1 declares `engines.node >=22.4.0` across the whole v3-lts line. This is now treated as a **HARD deployment prerequisite for the money path, not an advisory** — an `EBADENGINE` warning during `npm ci` is not an acceptable production state for a wallet. v0.2.29 raised `agent/package.json` (+ agent lockfile) `engines.node` to `>=22.4.0` (root frontend `package.json` deliberately left engine-free — static vite/vitest, no agent runtime), rewrote the `ops/install-agent.sh` preflight to gate on a robust major.minor.patch check (`ops/lib/node-version.sh::node_version_ok`, rejecting 22.0.x–22.3.x, erroring with the floor and stopping before touching anything), added `ops/test/installer-preflight.test.sh` (18 host-independent boundary assertions), fixed the stale `wallet.mjs` comment, and made `ops/README` state Node 22 LTS is a hard prerequisite. Verified under a real **Node 22.11.0** runtime (sandbox default is Node 20.20.1): clean `npm ci` with no EBADENGINE, 0 vulns, agent 38/38, ops 18/9/13, root build + vitest green, and a `node index.mjs` boot → `/api/health` 200 (v0.2.29-alpha) with no warnings. **Deploy prerequisite:** upgrade the VPS to Node 22 LTS before re-running `ops/install-agent.sh`; it will refuse to run on Node 20. **NOT yet deployed** — v0.2.26 remains the live server; v0.2.27 remains the newest shipped code. Prior slice: **v0.2.27 shipped AGENT-SEC: production dependency remediation.** `npm audit --omit=dev` in `agent/` reported 5 HIGH advisories in the Fastify tree during the live v0.2.26 deploy — all rooted in `fast-uri` (path-traversal GHSA-q3j6-qgpj-74h6 + host-confusion GHSA-v39h-62p7-jpjc) plus a Fastify content-type body-validation-bypass (GHSA-jx2c-rxcm-jvmq, no v4 backport). Cleared by upgrading `fastify ^4.28.1 → ^5.10.0`, `@fastify/cors ^9 → ^11`, `@fastify/rate-limit ^9 → ^11` and regenerating the lockfile; `fast-uri` now resolves to patched 3.1.3/4.1.0. No app code change beyond dropping the explicit `disableRequestLogging: false` from the Fastify constructor — passing the top-level option at all (even the default `false`) trips Fastify v5's `FSTDEP023` deprecation (guard is `!== undefined`, verified in installed `fastify@5.10.0` source + under `--trace-deprecation`; warning says removed in `fastify@6`); the drop is a no-op that silences the warning, request logging still emits. `@cashu/cashu-ts` stays at 2.5.3 (**no published npm/GHSA advisory**, so it does not block this hotfix — but the deprecation points to the `v3-lts` "security-fixes-only" line, so a v3-lts/v4 migration is a **security-relevant money-path follow-up to prioritise**, deferred as a separate slice to avoid behaviour drift in money-handling code — not cosmetic). Post-fix `npm audit --omit=dev` = **0 vulnerabilities**. Added `agent/test/wallet.test.js` (offline wallet guard/failure paths + cashu-ts codec regression) and `agent/test/fastify-v5-api.test.js` (cors preflight + rate-limit route-config contract); agent `node --test` now 30/30, rate-limit smoke green, root build green, ops regression 13+9 green. **NOT yet deployed** — v0.2.26 remains the live server version until an operator re-runs `install-agent.sh`. Base-path awareness + Ollama fallback landed in v0.2.6. Docs hygiene sweep across v0.2.7 → v0.2.12. **v0.2.13 shipped CONT-HEALTH-1**: dashboard now has a live Provider card polling `/api/health/models` every 20s. **v0.2.14 shipped SUITE-VPS-READY-1 rate-limit slice** — the public auth surface is behind `@fastify/rate-limit@9` per-IP with 429 + `Retry-After`; the in-memory challenges Map is capped and LRU-by-expiry evicted with structured `[auth]` logs, all prefix-only. **v0.2.26 shipped SUITE-VPS-READY-2: agent deploy tooling + first-touch admin claim.** New `ops/` assets let an operator run the agent as a hardened standalone systemd service: `ops/systemd/torii-continuum-agent.service` (locked `continuum` user, `ProtectSystem=strict`, only `memory/` + `config.yaml` writable), `ops/nginx/torii-api.conf` (same-origin `/api/` proxy + edge `limit_req`), `ops/install-agent.sh` (idempotent strict-bash installer: locked user, `rsync` without clobbering state, `npm ci --omit=dev`, one-time config gen with a fresh `openssl` session_secret, config validation, nginx `-t`-before-reload wiring, bounded `/api/health` proof), and a refreshed `ops/README.md` runbook. `agent/core/auth.mjs` gained first-touch admin bootstrap: with an empty `admin_npub` the first valid NIP-07 verifier atomically claims admin (npub persisted to `config.yaml` 0600 via injected `persistAdminNpub` in `config.mjs`), race-safe and fail-closed; `/api/health` now reports `admin_claimed`. **The agent is NOT deployed by this work** — running `install-agent.sh` on a server is a separate operator step. Next code slice: **real Cashu wallet health probe (CONT-HEALTH-2)** — a signed wallet-info call so `torii doctor` verifies the mint's public key and reports actual balance, landing as a new Provider-card row + `/api/health/wallet` endpoint.

---

## Standing operating rules (project-wide, across all Torii repos)

1. Each Torii app lives in a fully separate GitHub repo (`torii-quest`, `torii-continuum`, `torii-de`, `torii-base`, `torii-suite`); files carry ONLY that repo's project name — Continuum files say "continuum", Quest files say "quest", DE files say "de". Never cross-name.
2. Bump the version on EVERY change without exception — including doc-only changes, comment tweaks, filename renames, and typo fixes. There is no "too small to bump" change.
3. Push everything to GitHub immediately via a PR that lands on `main`. No local-only work.
4. Never publish device names, hostnames, or local machine identifiers to GitHub (commits, PR titles, PR bodies, code, docs). Use generic terms like "your local machine".

---

## Project

- **Name:** Continuum — a local-first project engine + marketplace shell for Torii Quest and related nostr-shaped work.
- **Repo:** `ChiefmonkeyArt/torii-continuum` on the Perplexity git proxy.
- **Local workspace path:** `/home/user/workspace/torii-continuum`
- **Live URL:** https://continuum-torii.pplx.app
- **Publish site_id:** `00acfee3-6cd6-477f-8d0f-36f84a6f6963`  ← ALWAYS pass this on publish updates
- **Publish app_slug:** `continuum-torii`
- **App asset_id (Perplexity preview):** `c82245ab-ac3c-4283-847b-f0e604adde1d`
- **Visibility settings URL:** https://www.perplexity.ai/computer/a/c82245ab-ac3c-4283-847b-f0e604adde1d?open-publish=true
- **Old (legacy) URL still up separately:** https://continuum.pplx.app — read-only oversight surface from earlier build, unrelated to this app's publish chain.

## Stack

- **Frontend:** Vite (dev + build), Vitest (tests). Vanilla JS SPA + hash router. Static bundle. LocalStorage for theme + nostr-shaped events + session token.
- **Agent (`agent/`, v0.2.0-alpha+):** Node 20 + Fastify (`fastify@^5.10.0` since v0.2.27), `nostr-tools@^2.7.2` for NIP-07 verify, `@cashu/cashu-ts@^3.7.1` (v3-lts, since v0.2.28) for the Cashu wallet, `yaml@^2.5.1` for config. Runs as a systemd service on the operator's VPS. Frontend points at it via `VITE_AGENT_URL` (build-time) or `window.__CONTINUUM_AGENT_URL__` (runtime). Demo build on pplx.app intentionally omits this so it stays offline/mock.
- Auth: NIP-07 challenge (kind 22242) verified server-side, session token is `iat.exp.pk.hmacSig` HMAC-SHA256, 24h TTL.

## Design system (matches https://continuum.pplx.app aesthetic)

- **Palette (dark, HSL space-separated so alpha ops work):**
  - `--background: 30 12% 8%`
  - `--foreground: 40 16% 93%`
  - `--card: 32 10% 12%` / `--card-border: 32 10% 20%`
  - `--primary: 38 92% 58%` (amber)
  - `--muted-foreground: 38 8% 62%`
  - `--sidebar: 30 12% 10%` / `--sidebar-accent: 32 10% 18%`
- **Palette (light):**
  - `--background: 40 33% 97%`
  - `--foreground: 36 14% 13%`
  - `--primary: 36 92% 46%` (deeper amber)
- **Fonts (loaded in `index.html`):**
  - Display: Cabinet Grotesk (Fontshare)
  - Body: Satoshi (Fontshare)
  - Mono: JetBrains Mono (Google Fonts)
- **Radius:** `0.75rem`
- **Theme toggle:** sun/moon SVG in sidebar; respects `prefers-color-scheme`.

## File map

- `index.html` — Fontshare + Google Fonts preconnect + stylesheets, `theme-color="#1a1613"`.
- `src/main.js` — bootstrap.
- `src/shell.js` — sidebar, theme toggle, footer note ("Local-first…").
- `src/router.js` — hash router.
- `src/views/projects.js` — Projects list.
- `src/views/projectHome.js` — single project page (milestones + todos).
- `src/views/marketplace.js` — bounty rows, "ours" highlighting.
- `src/views/dashboard.js` — oversight cards + by-project progress.
- `src/views/routstr.js` — Routstr AI model picker + Cashu wallet mock.
- `src/data/{schema,store,seed}.js` — mock nostr-shaped event store.
- `src/styles/theme.css` — HSL tokens, both themes.
- `src/styles/layout.css` — sidebar + page-header (amber eyebrow + display title).
- `src/styles/pages.css` — cards, milestones, todos, marketplace rows.
- `src/styles/chat.css` — bottom chat dock (mock).

## Build + deploy commands

```bash
# Local dev
cd /home/user/workspace/torii-continuum
npm ci
npm run dev            # vite dev server
npm test               # vitest

# Production build
npm run build          # outputs to /home/user/workspace/torii-continuum/dist

# Preview deploy (thread-attached app card)
pplx-tool deploy_website <<'JSON'
{
  "project_path": "/home/user/workspace/torii-continuum/dist",
  "site_name": "Continuum",
  "entry_point": "index.html",
  "should_validate": true
}
JSON
# api_credentials=["pplx-tool:deploy_website"]

# Publish update to live URL (ALWAYS pass site_id — no subdomain picker)
pplx-tool publish_website <<'JSON'
{
  "project_path": "/home/user/workspace/torii-continuum",
  "dist_path": "/home/user/workspace/torii-continuum/dist",
  "app_name": "Continuum",
  "site_id": "00acfee3-6cd6-477f-8d0f-36f84a6f6963"
}
JSON
# api_credentials=["pplx-tool:publish_website"]

# Commit + push
cd /home/user/workspace/torii-continuum && \
  git add -A && \
  git -c user.email=chiefmonkey@hodlr.rocks -c user.name="Chiefmonkey" \
    commit -m "…" && \
  git push origin main
# api_credentials=["github"]
```

## Publishing rules to remember

- **Preview vs publish:** `deploy_website` is the thread-attached preview (safe, unlimited). `publish_website` updates the live `continuum-torii.pplx.app` URL — do it only when the user asks.
- **Always pass `site_id`** on updates. Without it, the tool shows a subdomain picker and can create a duplicate site.
- **Order matters:** `deploy_website` must be called first with the same `dist_path` before `publish_website` in the same session.
- **Security review required before every publish:** run a subagent with `/home/user/workspace/skills/website-building/website-publishing/security_subagent_prompt.md` and pass BLOCK findings back to the user.
- **Published-site limits:** no `api_credentials`, no LLM APIs, no external tool connectors at runtime. This app is static-only so unaffected.
- **Do not use `publish_website` to unpublish.** If user asks to unpublish, direct them to the app card's Unpublish button.

## Git state (as of handover)

- Branch: `main`
- Remote: `https://git-agent-proxy.perplexity.ai/ChiefmonkeyArt/torii-continuum.git`
- Recent commits (top of `main`):
  - v0.2.13-alpha released — CONT-HEALTH-1 dashboard provider card (#9)
  - `<pending>` release: v0.2.14-alpha — SUITE-VPS-READY-1 rate-limit slice (rate-limit auth surface + bounded challenges Map + structured [auth] logs)
  - `043ad7c` release: v0.2.12-alpha — finish Space-scoped file naming migration (#8)
  - `8ceb3cd` release: v0.2.11-alpha — refresh torii-continuum-handoff.md (#7)
  - `13f1769` release: v0.2.10-alpha — scrub local-machine class mentions from docs (#6)
  - `e0c7259` release: v0.2.9-alpha — rename HANDOVER.md → torii-continuum-handoff.md (#5)
  - `74e3812` release: v0.2.8-alpha — cross-name audit: clean up stale Quest references (#4)
  - `40f5b27` release: v0.2.7-alpha — mirror standing operating rules into HANDOVER.md (#3)
  - `f185e67` CONT-INSTALLER-1 + CONT-AGENT-1b: base-path awareness + Ollama fallback (v0.2.6-alpha)
  - `dc4124d` panic key: make 30097 explicitly optional (v0.2.5-alpha)
  - `907c05e` CONT-CHARACTER-1: sealed character + memory infrastructure (v0.2.4-alpha)
  - `94e5269` feat: v0.2.3-alpha — ornate Myōjin torii SVG
  - `d830ec5` chore: v0.2.2-alpha — new H1 'The Gateway Project.'
  - `51482e2` chore: v0.2.1-alpha — dark default + security hardening
  - `cb7d4eb` feat: v0.2.0-alpha — CONT-AGENT-1 invariants + landing (mashed)

## Related projects (for cross-linking)

- `ChiefmonkeyArt/torii-quest` — the Three.js/Rapier arena shooter. Live at `torii-quest.pplx.app`. Separate repo, separate publish chain, separate release cadence.
- `torii-quest`'s dashboard source module (renamed to `toriiQuestDashboardData.js` in Quest v0.2.351) — the legacy source of the bronze/amber aesthetic that was ported here.

## Space context

- Perplexity Space: **Torii** (canonical URL `https://www.perplexity.ai/spaces/torii-8qN21IWsQ7.yuEGH9oNihw`).
- Space instructions: source-of-truth files are Space-scoped, one set per project. For Continuum work, use:
  - `torii-continuum-strategy.md` — strategy
  - `torii-continuum-todo.md` — active task list
  - `torii-continuum-progress.md` — progress log
  - `torii-continuum-handoff.md` — this file
- Never load a Quest / DE / Base todo or strategy file for Continuum work — cross-naming is a standing-rule violation (rule #1).
- Optimize for efficiency, security, file size, and speed on every change.

## Next likely tasks

Code slices (in rough priority order):

- ~~**Dashboard header → `/api/health/models`.**~~ **DONE v0.2.13-alpha** — Provider card renders under the KPI strip on `#/dashboard`, polls every 20s, three states per provider (`Enabled` / `Reachable`+`Unreachable` / `Disabled`), self-cleans on hashchange, honest about the fact that Routstr has no reachability probe yet.
- **Real Cashu wallet health probe.** Today `torii doctor` only pings the mint URL. Fold in a signed wallet-info call so it verifies the mint's public key and can report actual balance. Ship as a new row in the same Provider card + a new `/api/health/wallet` endpoint (admin-gated, mirrors the shape of `/api/health/models`).
- **Consent gate on `/api/chat`.** The agent will currently spend sats on any authenticated request. Add a per-session consent flag mirroring Quest's SEC-1 pattern before wiring any UI that fires chats implicitly (e.g. on page load).
- **Multi-model Ollama routing.** Router currently picks Ollama vs Routstr but not Ollama-model-A vs Ollama-model-B. Config shape needs a small model list.
- **Live cold-boot smoke of the Ansible playbook** on a fresh Ubuntu 24.04 VPS. Check-mode has been run; end-to-end has not.
- **IndexedDB persistence** for the frontend store (currently in-memory + localStorage seed).
- **Real nostr relay publish** for NIP-07 events (currently mocked).

Housekeeping / infra:

- Consider mirroring the torii-suite Playwright `?mock=1` walkthrough as a GitHub Action for Continuum so doc-only regressions can't sneak past the version-bump rule.
- User's stated intent: self-host eventually via `ops/ansible`; use `continuum-torii.pplx.app` until then.

## User preferences (confirmed)

- Loves the bronze/amber aesthetic of `continuum.pplx.app` — this app must match it.
- Wants both light AND dark themes.
- Local-first + nostr from day one.
- Optimize for efficiency, security, file size, and speed.
- Terminology: never say "scrape/crawl"; prefer "collect/gather/read".
- Uses ZorinOS + Comet on their primary local machine; a secondary local machine is available in `<devices>` for browser tasks.

## Resume checklist for the new session

1. Confirm the URL is still live: `curl -sI https://continuum-torii.pplx.app | head -1`
2. Pull latest: `cd /home/user/workspace/torii-continuum && git pull origin main`
3. Read this file first, then check `src/data/store.js` and `src/router.js` for structure.
4. For any publish, use `site_id: "00acfee3-6cd6-477f-8d0f-36f84a6f6963"`.
