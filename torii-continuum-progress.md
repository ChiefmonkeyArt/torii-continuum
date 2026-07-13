# Torii Continuum — Progress log

Living release log for the `torii-continuum` repo. Newest first. One entry per release. Longer slice reports live alongside as `torii-continuum-v0.2.N-<slice>-report.md` when a release warrants deeper narration; this file is the fast scan.

Companion source-of-truth files (per the `Torii` Space instructions, one set per project):

- `torii-continuum-strategy.md` — vision, principles, decision rules, architecture direction.
- `torii-continuum-todo.md` — active task queue.
- `torii-continuum-progress.md` — this file, release log.
- `torii-continuum-handoff.md` — developer entry point / resume point.

## v0.2.26-alpha — SUITE-VPS-READY-2: agent deploy tooling + first-touch admin claim

Second slice of the suite VPS-install prep. Ships the tooling to run the
agent as a hardened standalone service and removes the last manual step in
bootstrapping an operator, so a fresh box is claimable by its owner on first
sign-in. **The agent is NOT deployed by this PR** — this lands the tooling;
actually running `install-agent.sh` on a server is a separate, operator-run
step.

New ops assets:
- `ops/systemd/torii-continuum-agent.service` — runs the agent as a locked,
  non-login `continuum` system user from `/opt/torii/continuum-agent` under
  `NODE_ENV=production`. Hardened: `NoNewPrivileges`, `ProtectSystem=strict`
  (whole FS read-only to the service except `memory/` + the single
  `config.yaml` file), `PrivateTmp`/`PrivateDevices`, kernel/proc/clock
  protections, `MemoryDenyWriteExecute`, `@system-service` syscall filter,
  empty capability set, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`.
  Safe restart with a `StartLimitBurst` cap so a bad config fails the unit
  instead of crash-looping.
- `ops/nginx/torii-api.conf` — server-scoped same-origin `location /api/`
  reverse proxy to `127.0.0.1:8787`, with edge `limit_req` (30 r/s, burst 60)
  as a second rate-limit layer above the in-process Fastify limiter. The
  `limit_req_zone` (http context) is documented + shipped separately to
  `/etc/nginx/conf.d/`. Correct client-IP passthrough (`X-Real-IP`) for the
  agent's bucket key.
- `ops/install-agent.sh` — idempotent, strict-mode installer: root check +
  dependency preflight, locked system user, `rsync --delete` of code that
  never clobbers `memory/`/`pending/`/`ciphertexts/`/`config.yaml`,
  `npm ci --omit=dev`, one-time `config.yaml` generation with a fresh
  `openssl rand -hex 32` `session_secret` (0600, never echoed), config
  validation before restart, systemd + nginx wiring (`nginx -t` before any
  reload, refuses to redeclare an existing zone), and a bounded
  `/api/health` liveness proof.
- `ops/README.md` — refreshed with an authoritative standalone-install
  runbook (prereqs, install/upgrade, config, nginx contexts, first-touch
  claim, service management, security model, rollback/uninstall,
  troubleshooting).

First-touch admin bootstrap (`agent/core/auth.mjs`, `agent/core/config.mjs`,
`agent/index.mjs`):
- If `admin_npub` is empty, the agent boots **unclaimed**. The first caller
  to pass a valid NIP-07 challenge/verify atomically claims admin: their
  npub is persisted to `config.yaml` (canonical `npub1…`, 0600) and every
  later non-matching caller is rejected. Configured-admin behaviour is
  unchanged.
- Race-safe (in-flight promise guard → exactly one of two concurrent first
  verifies wins, no double-persist) and **fails closed**: if the config
  write throws, no session token is issued and the box stays claimable.
- Persistence is injected (`deps.persistAdmin`) so `createAuth` stays a pure
  unit under test; `persistAdminNpub()` lives in `config.mjs`, does an
  in-place `0600` rewrite that preserves comments/other keys, re-parses the
  result as a YAML sanity check, and refuses a malformed npub (injection
  guard).
- Logging stays prefix-only — never full pubkeys/challenges/IPs, never the
  session secret. `/api/health` now reports `admin_claimed`.

Tests: 13 agent unit tests via `node --test` — first-touch success + single
persist, restart honours persisted admin (no re-persist), second/different
caller rejected, configured-admin matching/stranger/never-persist, bad
signature no claim, wrong-kind no claim, concurrent race one-winner,
persistence-failure fail-closed, no-persister fail-closed, plus four
`persistAdminNpub` temp-tree tests (replace empty/set/insert/refuse
malformed). Installer passes `bash -n`; `nginx -t`/`systemd-analyze` are
environment-gated (tools absent in CI) and validated by the installer at
deploy time.

## v0.2.25-alpha - onboarding preview v0.1.11-preview (fix reload stall)

Operator reported browser refresh left Chiefmonkey invisible.
Root cause: `<link rel=preload as=fetch crossorigin>` for same-origin
assets uses CORS credentials mode but GLTFLoader/DRACOLoader fetch
without CORS. On reload the cached preload could not be matched
to the actual request and stalled.

Fixes:
- Dropped `crossorigin` from same-origin preload hints (glb, wasm).
  Added `type` attributes for accurate matching.
- Removed modulepreload for GLTFLoader/DRACOLoader (bare `three`
  specifier probes before the importmap resolves, printing a
  harmless but noisy error).
- Added 8s load watchdog with cache-bust retry so a stalled load
  never leaves the user with an empty stage.

Local: first 1.29s, reload 1 270ms, reload 2 113ms, reload 3 60ms.

VERSION 0.1.11-preview. sha256 5b956052c915f45bdd8486bc721f92cb3e1dacac7663c51e5419ddfcedfee54b.

## v0.2.24-alpha - onboarding preview v0.1.10-preview (Draco wasm + shader precompile)

Operator reported Chiefmonkey still lagged ~10s after v0.1.9. Two more
culprits fixed:
1. Draco was configured `type: 'js'` - the slow pure-JS decoder.
   Switched to `wasm` and added `draco.preload()` so the wasm module
   is instantiated before the GLB arrives.
2. First render triggered synchronous shader compilation. Added
   `renderer.compile(scene, camera)` before the opacity fade so the
   pipelines are warm.
Fade shortened 900ms -> 400ms.

Local render 1.85s -> 1.31s. Bigger gain expected on slow networks
because wasm decode is 3-10x faster than JS decode.

VERSION 0.1.10-preview. sha256 db0f7cab6d3d73d74c256e9599853a126d25802229c343f1ae48e818ff2b6654.

## v0.2.23-alpha - onboarding preview v0.1.9-preview (fast load)

Operator reported the scene painted in 3 chunks and Chiefmonkey took
30s to appear. Two root causes fixed:

1. Scene PNGs 3MB x 5 = 14.5MB, progressive-decoded. Converted to WebP
   q82 -> 1.3MB total (91% smaller).
2. Character load was fully serial: three.module.js (1.3MB) -> GLTFLoader
   -> DRACOLoader -> draco_decoder.wasm -> chiefmonkey6.glb. Added
   `<link rel=preload>` (as=fetch) for glb + wasm and `modulepreload`
   for three.module + loaders + character.js so everything fetches in
   parallel with HTML parse.
3. Fontshare stylesheet moved to media="print" onload=media="all" swap
   so it doesn't block first paint.

Tarball dropped from 15MB to 2.7MB. Local render measures ~1.9s
(canvas opacity >0.5, i.e. character visible).

VERSION 0.1.9-preview. sha256 744ef4003e76f2df5cd763601eebec80601659d21249e16754b7b5c103df3305.

## v0.2.22-alpha - onboarding preview v0.1.8-preview (recenter character)

Operator felt Chiefmonkey was too far left after v0.1.7. Nudged
CHAR_X_DESKTOP from -0.9 to -0.5 so he lands in the left third with
breathing room to both sides.

VERSION 0.1.8-preview. sha256 bb36aa7928b176b859519ef6623305e714626df0cba4984e411a2367ec6e69d2.

## v0.2.21-alpha - onboarding preview v0.1.7-preview (canvas full viewport)

Operator flagged that Chiefmonkey's hand vanished off the right side of
the character during the step-1 stretch pose. Root cause: `#character`
canvas was `width: 50vw`, so any pose extending past 720px on a 1440px
viewport got clipped at the canvas boundary - looking like a hand
disappearing "behind the panel".

Fix:
- `#character` canvas widened to 100vw
- `CHAR_X_DESKTOP = -0.9` in character.js keeps him in the left third
- `.panel { z-index: 5 }` so a swinging arm is correctly occluded by UI,
  not by an invisible canvas edge
- `resize()` re-anchors the base x on orientation flips

VERSION 0.1.7-preview. sha256 bdf01ae2021648f2350f378fb03ca9cf12648fa784e7b5feb86c480e8dac7a9e.

## v0.2.20-alpha - onboarding preview v0.1.6-preview (main page opaque fix)

v0.1.5 patched only `/inspect/inspector.js`. Operator confirmed the main
`/onboarding-preview/` page still showed the broken character - that page
uses `character.js`, which had the same missing opaque-material patch.

Same 4-line fix now applied there:
- `material.transparent = false`
- `material.depthWrite = true`
- `material.alphaTest = 0`
- `mesh.frustumCulled = false`

VERSION 0.1.6-preview. sha256 09457399e0ea040390ebc9c73a877a50f0b856674ff10f933bdcb501b5a1f93a.

## v0.2.19-alpha - onboarding preview v0.1.5-preview (opaque materials fix)

Root cause found for the 19/19 flagged clips. Chiefmonkey6.glb ships with
`alphaMode:BLEND` on the skinned meshes. Torii Quest patches this on load
(`src/napNpc.js` v0.2.111): sets `transparent=false`, `depthWrite=true`,
`alphaTest=0` and `frustumCulled=false`. Without those overrides, the
transparent pipeline draws faces out of order and the mesh appears to
disintegrate - which is exactly what the operator saw on every clip.

The v0.1.4 inspector didn't have this patch. v0.1.5 adopts the exact same
block from `napNpc.js`. Character now renders opaque and intact across all
clips.

Onboarding preview `VERSION` bumped to `0.1.5-preview`. Tarball at
`preview-assets/releases/torii-continuum-onboarding-preview-v0.1.5.tar.gz`
(sha256 `b3e3a084ef6630bab5199acfec0bb8d688b789eb9309a9388ef30cba84e6ce12`).

QA: Playwright at 1440x900, Hit_Reaction_to_Waist clip - character renders
whole, no arm shredding, no floating cuffs, tail visible, hands connect to
wrists.

Next: operator re-audits the 19 clips against the corrected renderer to see
which (if any) clips still have real animation issues vs. the material bug.

## v0.2.18-alpha - onboarding preview v0.1.4-preview (clip inspector)

New `/inspect/` diagnostic page for auditing all 19 GLB animation clips one by
one. First step of fixing the glitching + limb-through-body issues observed on
Chiefmonkey during onboarding. Rather than guess, we look.

Inspector delta:

- New page at `/onboarding-preview/inspect/` with an ordered list of every clip
  discovered in `chiefmonkey6.glb` (uses `gltf.animations` directly, no
  hard-coded names to drift)
- Neutral scene: grid floor at y=0, 3-light setup (ambient + key + fill), pink
  cone marker on +Z axis so orientation is unambiguous
- Camera: distance / height / orbit yaw sliders, plus mouse-drag orbit and
  wheel zoom (sliders update on drag, drag updates on sliders)
- Playback speed 0.1x to 2.0x (`AnimationAction.setEffectiveTimeScale`)
- Per-clip verdict: Keep / Flag, icon shown next to clip name, persisted in
  `localStorage['continuum.clipVerdicts.v1']`
- Copy report button dumps markdown to clipboard: KEEP / FLAG / Not audited
- Desktop-only (reuses the v0.1.3 mobile gate)
- Reuses parent `three-libs/` via `..` importmap paths - no dependency
  duplication

Onboarding preview `VERSION` bumped to `0.1.4-preview`. Repo tarball at
`preview-assets/releases/torii-continuum-onboarding-preview-v0.1.4.tar.gz`
(sha256 `9d221744a21986d510f17a7df01354170b8fbcd167b47ac186ca4ba077116b30`,
~15 MB).

QA:

- Playwright at 1440x900: page loads, all 19 clips enumerated correctly
  (Crouch_Walk..., FunnyDancing_02, Hit_Reaction_to_Waist, Idle_03,
  Jump_Over_Obstacle_1/2, Knock_Down, Run_and_Shoot, Running_Reload_inplace,
  Running, Shot_and_Blown_Back, Standard_Forward_Charge_inplace,
  Stylish_Walk_inplace, Walk_Backward_inplace, Walk_Left_with_Gun_inplace,
  Walk_Turn_Left/Right, Walking, idle_to_push_up).
- Character renders full-body at default distance/height, +Z marker visible,
  Keep click updates flag icon to ok green, Flag click updates to red.
- Copy report generates a well-formed KEEP/FLAG/Not-audited markdown block.

Next: user audits the 19 clips, then we apply Three.js-side workarounds
(bone masking, clip range cropping, weight cleanup) for the flagged ones.

## v0.2.17-alpha - onboarding preview v0.1.3-preview (desktop-only gate)

Continuum onboarding is a desktop-only flow (Torii VPS setup + a desktop-only game
launch). Rather than fight iOS WebGL quirks for a use case that does not exist,
small screens and coarse-pointer devices are now blocked at the door with a
friendly notice pointing them at a laptop.

Onboarding preview delta:

- Added desktop-only gate: `matchMedia('(max-width: 899px)')` or
  `matchMedia('(pointer: coarse)')` sets `data-desktop-only="blocked"` on
  `<html>` before any scripts load. Three.js, GLTFLoader, DRACOLoader, and the
  Chiefmonkey GLB are never fetched on mobile - respects data allowance,
  battery, and iOS WebGL cost.
- Splash copy: "Continuum onboarding is desktop-only. Setting up your Torii and
  stepping into the world both need a keyboard and a bigger screen. Open this
  link on a laptop or desktop to begin."
- Reverted the v0.1.2 in-browser diagnostic overlay experiment; character.js
  is back to the clean v0.1.1 baseline.
- Self-hosted Three.js retained from v0.1.1 (privacy standing rule).
- Onboarding preview `VERSION` bumped to `0.1.3-preview` (0.1.2 was diagnostic
  only, never deployed).
- Repo tarball at `preview-assets/releases/torii-continuum-onboarding-preview-v0.1.3.tar.gz`
  (sha256 `29fe758120308cdc7d32ca6487e1a97152e4f90667a518e6ba9e5e9e73306872`).

VPS deploy from tarball -> new dated release dir under
`/var/www/torii/onboarding-preview-releases/` -> atomic symlink flip on
`/var/www/torii/onboarding-preview`. Registry `version` bumped to
`0.1.3-preview`. No nginx reload needed (fragment points at the symlink).

QA:

- Playwright at 390x844 mobile viewport: gate splash renders, ZERO requests
  to `three-libs/*`, `character.js`, `deck.js`, or the GLB. Confirmed via
  request interceptor.
- Playwright at 1440x900 desktop viewport: full onboarding still renders,
  panel-current at step 1, painterly backdrop + frosted panel + amber CTA
  all intact.

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
deploy to your gateway host under `/var/www/torii/continuum/onboarding-preview/`.

Design review only - not built into the production app. Real
integration lands in v0.9.0-alpha.
