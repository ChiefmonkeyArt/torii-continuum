# Torii Continuum — Progress log

Living release log for the `torii-continuum` repo. Newest first. One entry per release. Longer slice reports live alongside as `torii-continuum-v0.2.N-<slice>-report.md` when a release warrants deeper narration; this file is the fast scan.

Companion source-of-truth files (per the `Torii` Space instructions, one set per project):

- `torii-continuum-strategy.md` — vision, principles, decision rules, architecture direction.
- `torii-continuum-todo.md` — active task queue.
- `torii-continuum-progress.md` — this file, release log.
- `torii-continuum-handoff.md` — developer entry point / resume point.

## v0.2.14-alpha — SUITE-VPS-READY-1 (Continuum PR slice): rate-limit auth surface + bounded challenges Map + structured [auth] logs

First code slice of the suite v0.6.0-alpha VPS-install prep. Hardens the two public endpoints that a scanner will hit first — `/api/auth/challenge` and `/api/auth/verify` — without touching the admin surface. Also swaps the previously-unbounded in-memory challenges Map for a hard-capped, LRU-by-expiry structure so a challenge flood can no longer OOM the agent.

- `agent/package.json` — added `@fastify/rate-limit: ^9.1.0` (v9 major matches the pinned `fastify@^4.28.1`). No other deps touched. Version 0.2.13-alpha → 0.2.14-alpha. Root `package.json` bumped in lockstep.
- `agent/core/auth.mjs` — rewritten around a bounded `Map` with a resolved `MAX_CHALLENGES` (default 1000, source `cfg.rate_limit.max_challenges`). New signature is `createAuth(cfg, deps)` where `deps.log` is Fastify's pino instance; falls back to a console shim if omitted so tests can drive it without a full app. Overshoot eviction sweeps the oldest N entries by `expiresAt` and emits a single `auth.challenge.evicted` warning line. Expired-challenge and admin-not-matched paths now emit `auth.verify.fail` with a stable `reason` enum (`expired|notfound|badsig|notadmin|malformed_event|wrong_kind`). Success path emits `auth.verify.success`. All log objects carry `ip_prefix` (12 chars), `pubkey_prefix`/`challenge_prefix` (8 chars) only — never the full value. Adds `_challenges`, `_maxChallenges`, `_adminHex` on the returned object as read-only test hooks.
- `agent/index.mjs` — registers `@fastify/rate-limit` with `global: false` (routes opt in) and a `keyGenerator` that pins the bucket to `req.ip`. Two route-scoped configs: `/api/auth/challenge` at `auth_challenge_per_min` (default 10) and `/api/auth/verify` at `auth_verify_per_min` (default 20). Both use a custom `errorResponseBuilder` that (a) emits `auth.ratelimited` with route + ip_prefix + max + remaining_ms and (b) returns `{ ok:false, reason:"rate_limited", retry_after_sec }` alongside the standard `Retry-After` header. `cfg.rate_limit.enabled: false` skips the plugin registration and the per-route configs become inert (dev only). The old ad-hoc `[auth]` log-string warnings on the routes are gone — the structured events live inside `auth.mjs` now, single source of truth.
- `agent/core/config.mjs` — optional-defaults block now populates `cfg.rate_limit` when absent (`enabled: true`, `auth_challenge_per_min: 10`, `auth_verify_per_min: 20`, `max_challenges: 1000`). Existing v0.5.0-alpha installs pick up the defaults without editing `config.yaml`.
- `agent/config.example.yaml` — new `rate_limit:` block with commented defaults, log-taxonomy reference, and the dev-only disable path.
- `agent/README.md` §10 — stamp bumped to v0.2.14-alpha, `POST /api/auth/challenge|verify` rows now note the rate limit, response shape + `Retry-After` shown, structured log taxonomy documented, and the tune/disable snippet included.
- `agent/scripts/smoke-rate-limit.mjs` — new. Boots a Fastify instance in-process against `auth.mjs` and drives 5 test scenarios: (T1) `/challenge` ×10 all 200, #11 = 429 with `Retry-After`, `auth.ratelimited` logs emitted; (T2) `/verify` ×20 no 429, #21 = 429; (T3) 10 issues against a `max_challenges: 5` cap leaves the Map at 5 and emits `auth.challenge.evicted` logs; (T4) `rate_limit.enabled: false` accepts 15/15; (T5) `auth.challenge.issued` and `auth.verify.fail` structured lines present with no full pubkey/challenge in the log body. All 5 pass.
- Follow-up (separate suite PR, tracked in `torii-suite-v0.6-plan.md` items G–P): systemd unit, nginx `/mp` fragment, arena-ws install stage, MP smoke, `nginx configtest` guardrail, Ubuntu 26 INFO note.

Security posture: pubkeys, challenges, and IPs are never logged in full; only prefixes reach the journal. The rate-limit plugin's default in-memory store is local-only (no Redis, no cross-node leakage). Under v0.6.0-alpha's single-VPS install this is the right shape; if we ever go multi-agent we'd add a Redis store or a shared-nothing sharding strategy.

## v0.2.13-alpha — CONT-HEALTH-1: dashboard provider reachability card

First real feature slice after the v0.2.7 → v0.2.12 docs sweep. Wires the previously-inert "provider ready" area of the dashboard to the live `/api/health/models` endpoint.

- `src/views/dashboard.js` — new `ProviderCard()` renders under the KPI strip. Polls `/api/health/models` every 20s while `#/dashboard` is mounted; a self-removing `hashchange` listener + `isConnected` guards on every tick guarantee no timer leaks after navigation. Client-side round-trip latency (`performance.now()` bracket) is shown alongside the strategy and agent version so slow responses are visible.
- Three states per provider: `Enabled` (Routstr — no server-side reachability probe yet, so we show enablement honestly rather than fake a green light), `Reachable`/`Unreachable` (Ollama — endpoint probes actual reachability), `Disabled` (not enabled in config). Uses the existing `.pill.ok`/`.pill.danger`/`.pill` classes from `theme.css`.
- Two graceful-degradation states: `VITE_AGENT_URL` empty (demo build) shows an explainer instead of hammering a URL that doesn't exist; logged-out user sees a sign-in prompt because the endpoint is admin-gated.
- `src/data/agent.js` — added `healthModels()` client (single-line wrapper over the shared `req()` helper; inherits offline / 401 / network-fail envelopes).
- `src/styles/pages.css` — six new rules for the card layout, all scoped to `.provider-card*` and `.provider-row` so nothing else can regress. Uses the same token palette (`--border`, `--muted-foreground`, `--font-mono`, `--foreground`) already in use across the app.

Bonus fixes on the way through (all three killed stale `0.2.6-alpha` markers):
- `agent/index.mjs` — both `/api/health` and `/api/health/models` were reporting a hardcoded `0.2.6-alpha` version string that had been stale since v0.2.6. Replaced with a boot-time read of `agent/package.json`. Now every release surfaces the correct version through the health endpoints without another manual bump.
- `src/views/landing.js` + `vite.config.js` — the landing-page eyebrow said `Torii Continuum · v0.2.6-alpha`. Now baked in at build time via a Vite `define` (`__APP_VERSION__` read from `package.json`), so the eyebrow always matches the shipped release.
- `ops/README.md` — the example `/api/health` response payload also carried the stale hardcoded version. Reworded to describe the field generically (`<agent-version>`) so no future release is ever wrong here.

Doc-plus-tiny-feature. `npm run build` clean. No third-party dependencies added. Bundle grew from 57.63 kB to 60.01 kB (+2.4 kB ≈ the new ProviderCard + CSS).

## v0.2.12-alpha — finish Space-scoped file naming migration

Rename the last two docs to match the Space convention.

- `strategy.md` → `torii-continuum-strategy.md`.
- `continuum-todo.md` → `torii-continuum-todo.md`.
- New: `torii-continuum-progress.md` (this file).
- Updated in-file cross-references in strategy, todo, handoff, and any code that mentioned the old paths.

The v0.2.9 rename covered `HANDOVER.md → torii-continuum-handoff.md`. This slice finishes the migration so all four Space-scoped source-of-truth files are named consistently.

Doc-only change. `npm run build` clean, unchanged bundle.

## v0.2.11-alpha — refresh `torii-continuum-handoff.md`

Handoff drifted through v0.2.7 → v0.2.10 without a substantive edit. Refreshed:

- Version header v0.2.9 → v0.2.11 + new "Active focus" paragraph.
- "Recent commits" block rewritten to cover the v0.2.1 → v0.2.10 arc.
- "Space context" section rewritten to reference the four Space-scoped source-of-truth files instead of Quest artifacts (`NOSTR_ARENA_MASTER_TODO.md`, `Strategy-&-Next-Steps.md`) that had leaked in — a standing-rule-#1 (never cross-name) violation hiding in the onboarding doc.
- "Next likely tasks" rewritten to reflect the post-agent / post-base-path / post-Ollama-fallback backlog rather than the v0.1.0-era items.
- Fixed a stale `v0.2.9-alpha` marker at `agent/README.md §10`.

Doc-only. Build clean, 57.63 kB main chunk unchanged.

## v0.2.10-alpha — scrub local-machine class mentions from docs

Docs contained references to specific local machine classes. Standing rule #4 forbids publishing device names, hostnames, or local machine identifiers to GitHub. Removed.

## v0.2.9-alpha — rename `HANDOVER.md` → `torii-continuum-handoff.md`

Matched the Space convention for source-of-truth files (`torii-continuum-{strategy,todo,progress,handoff}.md`).

## v0.2.8-alpha — cross-name audit

Cleaned up stale Torii Quest references that had leaked into Continuum docs during the pre-split period. Standing rule #1: each Torii app lives in a fully separate repo; files carry ONLY that repo's project name.

## v0.2.7-alpha — mirror standing operating rules into handoff

Codified the four standing rules (separate repos, bump every change, PR to main, no personal identifiers) plus the privacy-before-efficiency-before-80/20 priority hierarchy directly into the handoff so a resuming session sees them without having to reload memory.

## v0.2.6-alpha — CONT-INSTALLER-1 + CONT-AGENT-1b

- Base-path awareness in `vite.config.js` (`base: "./"`) so Continuum works both standalone at `continuum-torii.pplx.app` and mounted at `/continuum` by torii-base.
- Ollama fallback ladder in `agent/core/model-router.mjs` — strategies `routstr-first` (default), `ollama-first`, `ollama-only`, `routstr-only`. `provider` field on every return.

## v0.2.5-alpha — panic key: make kind 30097 explicitly optional

The panic-key event kind is optional and the client must not require it.

## v0.2.4-alpha — CONT-CHARACTER-1

Sealed character + memory infrastructure.

## v0.2.3-alpha — ornate Myōjin torii SVG

Custom SVG logo replacing the placeholder.

## v0.2.2-alpha — new H1 "The Gateway Project."

Landing page copy update.

## v0.2.1-alpha — dark default + security hardening

Made dark the canonical theme (never ship a light-default build). Session cookie `__Host-` prefix requirement documented.

## v0.2.0-alpha — CONT-AGENT-1 invariants + landing

First agent scaffold: `agent/` Fastify daemon, NIP-07 challenge/verify, HMAC-signed session tokens, Cashu wallet on VPS (`@cashu/cashu-ts` v2), Routstr chat client, first `chat` skill. Frontend integrations: landing page at `#/`, sidebar Login button, chat dock routes through `/api/chat` when signed in.

See `torii-continuum-v0.2.0-cont-agent-1-report.md` for the full slice narration.

## v0.1.0 (pre-split)

- Split planning: Continuum owns its own strategy and todo files (separate from Quest).
- Amber/gold torii favicon on warm bronze tile.
- Bronze/amber aesthetic to match continuum.pplx.app.
- Continuum app builder MVP.

---

## v0.2.15-alpha - Onboarding preview v0.1.0 landed

Five-panel graphic-novel onboarding sequence added under
`preview-assets/onboarding-v0.1.0/`. Painterly backdrops, live
Three.js Chiefmonkey render with per-step camera framing and
animation cross-fade, frosted-glass bottom-sheet on mobile.

Self-hosted Draco decoder at `three-libs/draco/` (756 KB) so the
character render has zero third-party runtime CDN dependency.

Tarball + sha256 attached under `preview-assets/releases/` for scp
deploy to chiefmonkey.art:/var/www/torii/continuum/onboarding-preview/.

Design review only - not built into the production app. Real
integration lands in v0.9.0-alpha.
