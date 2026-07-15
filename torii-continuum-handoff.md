# Continuum — Session Handover

**Current version:** v0.2.40-alpha (onboarding preview v0.1.20-preview — unchanged; this slice is ops-only)
**Currently deployed server version:** v0.2.29-alpha (deployed to the SHC VPS on a Node 22.23.1 host). **v0.2.30-alpha through v0.2.40-alpha are code+PR only — not yet deployed.**

Paste this whole block at the start of a new Perplexity Computer session to resume work seamlessly.

**Active focus:** **v0.2.40-alpha ships OPS-HARDENING: safe standalone→Ansible adoption, no config clobber, fail-closed backups** (ops-only; **no app/agent code changed**, onboarding preview stays **v0.1.20-preview**). Fixes the dangerous deployment mismatch that blocked the live v0.2.39-alpha rollout: the continuum Ansible role cloned to `/home/continuum/app` and **re-rendered `config.yaml`/`session_secret` unconditionally on every run**, while the live standalone box uses `/opt/torii/continuum-agent` + unit `torii-continuum-agent.service` on port 8787 — so running the old role over that box would have overwritten the session_secret (orphaning the funded Routstr key, encrypted at rest under a key derived from it) and/or double-bound 8787. **Fix:** the risky detect/backup/migrate/config-decision logic is factored into a sourceable, unit-tested lib `ops/lib/continuum-adopt.sh`, and `roles/continuum/tasks/main.yml` is now a thin guarded orchestrator that (1) **detects** layout (`fresh`/`adopt-standalone`/`existing-ansible`; an existing Ansible layout always wins); (2) takes a **fail-closed** timestamped **root-only 0700 backup** of `config.yaml`+`memory/`+`ciphertexts/`+`pending/` from both layouts under `/root/continuum-backup-<UTC>/` before any mutation (no backup ⇒ abort); (3) on adopt **stops+disables** the standalone unit (frees 8787) and **migrates config+state verbatim** — `session_secret` copied byte-for-byte, never regenerated, migration idempotent; (4) **never clobbers** an existing config on routine deploy — renders from vault ONLY on a fresh install or explicit `-e continuum_allow_config_rotation=true` (off by default), and on a preserve runs a one-way drift check that prints only `same`/`differ` (never a value) and surfaces a safe "rotation pending" notice; (5) wraps the service+nginx cutover in a `block`/`rescue` that on failure prints the backup path + exact recovery command. `git force:true` resets only tracked files, and all agent state is gitignored, so a re-checkout/build can't delete encrypted state. New `roles/continuum/defaults/main.yml` holds the safe tunables (`continuum_standalone_dir`, `continuum_standalone_service`, `continuum_backup_root`, `continuum_allow_config_rotation: false`); secret-touching tasks carry `no_log: true`. Pinned by `ops/test/continuum-adopt.test.sh` (**44** hermetic assertions: detection precedence, fail-closed backup, verbatim+idempotent migration, config-action matrix, no-secret drift, permissions, anti-drift greps). New "Adopting a standalone install with Ansible" runbook in `ops/README.md`. **Operator handles NO secrets** at any point; deploy is the normal `ansible-playbook … --tags continuum`. Tests this slice: adopt suite **44/44**; unchanged app/agent suites not re-run beyond the required build/audit. Code + PR only — **not merged, tagged, or deployed.** Prior slice: **v0.2.39-alpha ships ONBOARDING-GATING + APP-MOUNT: real claimed-state Step-3 gating, dup-pay race closed, completion lands on the actual app dashboard** (onboarding preview → **v0.1.20-preview**, `preview-assets/onboarding-v0.1.20/`). Two live defects on the v0.1.19/v0.2.38 stack plus the app-mount follow-through. **User-funded Routstr key, all encrypted agent memory, and prior payment state preserved — no invoice created/paid/re-submitted, no `memory/**` touched.** **(A) Claimed-state gating (root cause):** a verified funded key still rendered both setup cards, key-entry/reveal, *Verify & connect* and *Request an invoice* — a CSS cascade defect, not logic: author `display` rules (`.btn-primary{inline-flex}`, `.wallet-choices/.routstr-paths{flex}`, `.choice-card{grid}`) outrank the UA `[hidden]{display:none}`, so `el.hidden=true` visually no-op'd. Fix: canonical `[hidden]{display:none !important}` in `shared.css`; the status-only resume path funnels through `renderSuccessAdvance` via a single `showClaimed` helper (replaces `showConnected`); the panel carries `data-claimed="1"` as single source of truth, leaving one green summary + exactly one standalone Continue. **Dup-pay race closed:** `data-claimed` checked as the first line of quote/key-connect/pay-confirm handlers (pay button also permanently disabled once claimed) — a second invoice/payment is structurally impossible in claimed state. **(B) App mount:** `CONTINUUM_HOME` `/continuum/` → `/continuum/#/dashboard` (+ curtain anchor) so completion opens the multi-view Amber SPA dashboard, not the marketing root; open-redirect guard preserved. **Session handoff:** `adoptOnboardingSession()` (in `src/data/agent.js`, called once in `main.js` before `initStore()`) fails closed if the SPA already has a live session, else adopts the `localStorage['torii.session']` envelope token into `continuum.session.v1` only if `tokenLooksLive` (shape + unexpired), so a freshly onboarded user is not bounced to sales/login; `deriveSameOriginBase` makes `agentUrl()` fall back to same-origin `/continuum` under the mount (no CDN/third-party origin). **No separate torii-suite PR required** — the `/continuum/` alias + subpath refresh + `/continuum/api/*` proxy + SPA build + agent install + nginx fragment + launcher registration are all in this repo's `ops/ansible`; the root launcher is never overwritten. **Safe idempotent deploy (operator step, NOT run here, from `ops/ansible/`):** `ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags continuum`. **(C) Wording:** residual VPS/daemon/box copy in `routstr.js`/`landing.js`/`auth.js` scrubbed to "your Torii, your gateway". Tests: root vitest **762/762** (new `src/data/agent.test.js` 11 cases; preview v0.1.20 **153**), agent `node --test` **104/104**, `npm run build` clean, `npm audit --omit=dev` **0 vulns** (root + agent). Honest limitation: no jsdom/live agent here, so no live funded-agent click-through — gating proven by the CSS `!important` cascade guarantee + source/behaviour guards. Code + PR only — **not merged, tagged, or deployed.** Prior slice: **v0.2.38-alpha ships ONBOARDING-FINISH: verified-state cleanup, correct balance units, inline key reveal, deterministic final curtain** (onboarding preview → **v0.1.19-preview**, `preview-assets/onboarding-v0.1.19/`). A focused live UX/completion pass from three screenshots; no character/animation/CDN/provider-pinning behaviour changed and no payment/NWC semantics changed beyond balance *display* and safe key *retrieval*; the funded key + prior state are preserved. **(A) Balance units (root cause):** Routstr denominates balances in MILLISATS but `extractBalanceSats` surfaced the raw `balance` verbatim, so a 10,000-sat key showed "10000000 sats"; the provider adapter now divides msat fields to whole sats (explicit `*_sats` trusted), a marker-guarded `displayBalanceSats` migration divides legacy stored envelopes (no `balance_units`) by 1000 on read while new envelopes carry `balance_units:'sat'`, and all balances render via `formatSats` (e.g. `10,000 sats`). **(B) Step 3 verified state:** once claimed/encrypted/verified, `collapseStep3Setup` hides both path cards, both forms, the invoice card, the progress bar and all three setup CTAs, leaving one green summary + a SINGLE Continue button outside it, no countdown/auto-advance (supersedes the v0.1.18 countdown), advance idempotent. **(C) Step 5 recovery kit:** removed the unbranded "Reveal full Routstr key (one-time)" button + its `window.confirm` flow (never revealed the key); the ROUTSTR KEY row now has branded inline eye + copy controls that fetch the key over the existing admin-authenticated no-store `export-key` endpoint, hold it in memory only (never localStorage/sessionStorage/URL/logs), and re-mask on toggle/step-leave/tab-hide/session-loss/timeout (`shouldMaskReveal`/`REVEAL_TIMEOUT_MS`); the Download click is itself the explicit confirmation and embeds the full key in the saved file while still excluding the NWC secret. **(D) Final curtain:** the old curtain only `console.log`'d a commented redirect and spun forever; `initCurtain` now navigates deterministically to the resolved same-origin `/continuum/` home (a `window.__toriiContinuumHome` override accepted only same-origin — open-redirect guard), reveals a real "Open Continuum now" fallback link on a bounded timer, honours `prefers-reduced-motion`, and drops the spinner shortly after the nav attempt so it can never hang. Tests: agent `node --test` **104/104**, root vitest **269/269** (preview v0.1.19 **145**), `npm run build` clean, `npm audit --omit=dev` **0 vulns** (root + agent). Code + PR only — not deployed. Prior slice: **v0.2.37-alpha ships ONBOARDING-PAY-RECOVERY: paid-but-unclaimed Routstr recovery + payment progress state machine + working recovery kit** (onboarding preview → **v0.1.18-preview**, `preview-assets/onboarding-v0.1.18/`). Fixes a live incident where an operator connected NWC and paid 10,000 sats to fund a Routstr session, but the UI said "payment confirmed" without surfacing the `sk-` key, never auto-advanced, and the Recovery Kit "download" was a no-op that just stepped the deck. **No new invoice created or paid during diagnosis or fix.** Delivered a safe SSH recovery runbook first (inspect `memory/secrets/*.enc` by metadata only — never decrypt; reuse the operator's existing browser session token against the loopback admin API; claim the already-paid key with the **idempotent** `POST /api/onboarding/routstr/recover` sending `{}` — the agent re-submits the stored bolt11 and never re-pays; redacted status/verify; one-time no-store `export-key` only if a manual copy is required). Root fact: **payment-confirmed does NOT imply the key is stored** — the claim is a separate post-settlement step; recovery states are paid+claimed / paid+unclaimed (the live case) / unpaid-or-expired. **Agent (v0.2.37-alpha):** new admin-gated endpoints `GET /api/onboarding/recovery/state` (redacted resume snapshot; `claimable` true only when a pending invoice is stored with no key), `GET /api/onboarding/recovery-kit` (`Cache-Control: no-store`, secret-free by default), `POST /api/onboarding/routstr/export-key` (one-time full-key reveal; `confirm===true` required else 400, 409 when no key, `no-store`, rate-limited, persists `export_count`/`last_exported_at` audit, logs warn never the key). **Preview (v0.1.18):** pure `ONBOARD_PHASES`/`PHASE_META` state machine driving an accessible (role=status, aria-live) progress + scanning bar + elapsed timer across connect→quote→pay→claim→verify; **SUCCESS only when the agent reports `key_stored===true`** (`classifyPayResult`/`classifyRecoverResult` map bare paid/recoverable → retryable `PAID_UNCLAIMED`, never success); duplicate-payment prevention (Confirm button permanently disabled after first click); success renders the redacted key then auto-advances after a short countdown with an immediate Continue-now; refresh-resume reads `recovery/state` on load and finishes a `claimable` claim via empty-body `recover` (no re-payment); real Recovery Kit download via Blob (`buildRecoveryKit`) whose default excludes the NWC secret + full key and carries redacted previews + restoration instructions, with the full key included only via an explicit confirmed one-time `export-key` reveal; Step 5 markup no longer prints static secret-adjacent values. Preserved: character/animation behaviour, self-hosted Three.js (no CDN), provider pinning, redaction, rate limits, no autonomous spend, no nsec on server. Tests: agent `node --test` **102/102**, root vitest **453/453** (preview v0.1.18 **124**), `npm run build` clean, `npm audit --omit=dev` **0 vulns** (root + agent). Code + PR only — not deployed. Prior slice: **v0.2.36-alpha ships ONBOARDING-ASSET: new Chiefmonkey GLB + forbidden-safe animation state machine** (onboarding preview → **v0.1.17-preview**, `preview-assets/onboarding-v0.1.17/`). A substantial asset + animation upgrade of the design-review onboarding mockup (NOT the production app). A fresh Chiefmonkey source GLB replaces the old `chiefmonkey6.glb` and is crushed for production by a new reproducible local optimizer `tools/optimize-glb.mjs` (gltf-transform 4.4.1 + draco3dgltf 1.5.7 + sharp 0.35.3, build-time only, no third-party runtime CDN): `dedup → weld → resample → textureCompress(webp,q82,≤1024²) → prune → draco(edgebreaker)`, dropping every forbidden locomotion/knock-down clip with the runtime's own `isForbiddenClip` predicate (single source of truth). Source 9,298,852 B (SHA `87b0048c…c37dd`) is kept OUT of git (build artifact only, see `tools/SOURCE.md`); the committed optimized `assets/chiefmonkey-onboarding.glb` is 2,347,780 B — **74.75% smaller** (target ≥60%), SHA `0253d5e1…e2fcb` — with a `.manifest.json` recording sizes/%reduction/deterministic SHA + retained/dropped clip inventory (13 retained, 5 forbidden dropped: `Clapping_Run`/`Knock_Down`/`Running`/`Stylish_Walk_inplace`/`Walking`; mesh/skin(24 joints)/material/texture preserved nonzero, clip names survive Draco). `character.js` now runs a dedicated forbidden-safe state machine — each of the 5 deck steps plays one dedicated clip from `STEP_CLIPS`/`selectStepClip` (1 Talk_with_Hands_Open, 2 Agree_Gesture, 3 mage_soell_cast_3, 4 Gentlemans_Bow, 5 Idle_10; dormant step-6 Victory_Cheer curtain), applied deterministically on entering/restoring via the v0.1.15 `resolveReadyStep` path (order-independent) — and a raycast hit-test (`Raycaster.intersectObject`, NDC from canvas rect) plays a random one-shot from a curated `CLICK_POOL` (`pickClickReaction`, no immediate repeat) then crossfades back to the current step clip on the mixer `finished` event, ignoring UI-control clicks / respecting `prefers-reduced-motion` / ignoring click-spam. Step-1/2/3 prompt/success/failure `onboarding:anim` overrides are transient and always return to the current step clip (no race can permanently overwrite step state). Deterministic offline tests parse the optimized GLB JSON chunk (counts nonzero, referenced clip names survive), assert no forbidden pattern is selectable, verify the committed asset matches manifest SHA + size budget (≤3 MB, ≥60%), and cover every step mapping / restore ordering / status→current-step return / click hit-no-hit + UI-guard + no-immediate-repeat + spam guard + crossfade return / reduced motion / final load-error. Verified target-file + full root vitest green and `npm run build` clean. Code + draft PR only — preview snapshot only, not deployed. Prior slices (onboarding preview arc): **v0.2.35-alpha / v0.1.16-preview** (PR #32) reworked Step 2 (wallet-agnostic NWC connect via NIP-47 `get_info` capability matrix, funding gated on `pay_invoice`) and Step 3 (Routstr existing-`sk-…`-key OR fund-a-new-session: quote → explicit confirm → NWC pay → claim minted key, with a RECOVERABLE poll-timeout carrying the bolt11 via `/lightning/recover`); secrets stored encrypted at rest (AES-256-GCM), admin-gated + rate-limited, pay refuses unless `confirm===true` AND `pay_invoice` advertised. **v0.2.34-alpha / v0.1.15-preview** (PR #31) added the deterministic character↔deck step-sync state machine (`createCharacterSync`/`recordStep`/`resolveReadyStep`/`markCharacterFailed`) that fixed the intermittent invisible-Chiefmonkey-after-soft-reload race by remembering steps before model readiness instead of dropping them then hard-applying Step 1. **v0.2.33-alpha / v0.1.14-preview** (PR #30) fixed refresh dropping Step 2 → Step 1 (`restoreSession`/`isSessionValid` fail-closed, `window.__toriiRestoredStep`) and Chiefmonkey invisible on reload (route both GLB stall AND error through `nextLoadAttempt`). Prior slice: **v0.2.32-alpha ships ONBOARDING-STEP1-FIX: "agent challenge failed (400)" on Sign with Plebeian Signer** (onboarding preview → **v0.1.13-preview**, `preview-assets/onboarding-v0.1.13/`). Client-only fix: `onboarding-client.js`'s `postJson` was sending `Content-Type: application/json` on the **bodyless** `POST /api/auth/challenge`, and Fastify v5 rejects an empty body carrying that header with `400 FST_ERR_CTP_EMPTY_JSON_BODY` — failing step 1 before the NIP-07 prompt (which only fires after a challenge is fetched), so Chiefmonkey animated but no signer opened. Fix: `postJson` only sets the JSON content-type + serialises a body when a body is actually present; the challenge call now goes out bodyless (→ 200), verify unchanged. No server endpoint added, no validation weakened, no bunker-connect endpoint; NIP-07 primary + browser-client NIP-46 secondary, `localStorage['torii.session']`, exact signer wording, and the three clips (`HandGesture_00`/`Idle_03`/`Confused_02`) all preserved. New offline vitest case (challenge POST has no body/no JSON content-type; verify still does) + new agent `fastify-v5-api` case pinning the empty-body-400 vs bodyless-200 contract. Prior slice: **v0.2.31-alpha shipped ONBOARDING-STEP1: live NIP-07/NIP-46 auth for onboarding step 1** (onboarding preview → **v0.1.12-preview**, `preview-assets/onboarding-v0.1.12/`). New self-contained `onboarding-client.js` (ES module, no build step, no third-party CDN) wires step 1 to the same-origin agent API. NIP-07 primary via `window.nostr` (button "Sign with Plebeian Signer"): `POST /api/auth/challenge` → sign the exact kind-22242 auth event `agent/core/auth.mjs` expects (`content == challenge`, `['challenge', …]` + `['relay', origin]` tags) → `POST /api/auth/verify` → persist to exactly `localStorage['torii.session']` as `{ token, expires_at, pubkey, method, created_at }` (token + public identity only, no secrets). Fails closed on malformed responses, expired challenges, pubkey/challenge mismatch, or absent token. NIP-46 secondary with the browser as the client (bunker46 architecture, "Use a different signer"): parses a pasted `bunker://` string and asks the remote signer to sign the same event over its relay — **no server bunker-connect endpoint**, no key/secret sent to the agent, no silent fallback. Chiefmonkey phases via the existing event channel: `HandGesture_00` prompting/signing, `Idle_03` success, `Confused_02` failure, each with an ordered fallback to an existing GLB clip (the GLB ships neither `HandGesture_00` nor `Confused_02`, so the fallback runs and never freezes). Desktop-only gate + all prior perf fixes preserved. 28 offline vitest cases; verified root vitest 28/28, root build, agent `node --test`, ops regressions, agent `npm audit --omit=dev`. Code + draft PR only. Prior slice: **v0.2.30-alpha shipped AGENT-SEC-OPT-TORII-PERMS: least-privilege fix for the shared `/opt/torii` parent.** The v0.2.29 deploy surfaced a production regression — `ops/install-agent.sh` created the shared parent with an unconditional `install -d -m 0750 -o continuum -g continuum /opt/torii`, and because `install -d` re-applies mode+owner on every run it clamped the parent that torii's *other* apps live under (torii-base launcher, quest tooling) to `0750 continuum:continuum`, stripping its world-execute bit. nginx (`www-data`) could then no longer traverse `/opt/torii` to reach `/opt/torii/launcher/index.html`, so `/` fell through to a default nginx 404 (Quest under `/var/www` stayed readable). Fix: create `/opt/torii` **only if absent**, `root:root 0755`, and **never re-own/re-mode an existing shared parent**; the agent's own subdir `/opt/torii/continuum-agent` stays locked `0750 continuum:continuum` (nginx never serves from it — the agent is loopback-proxied on 8787). New hermetic + anti-drift regression `ops/test/installer-shared-parent.test.sh` (10 assertions) pins that the installer no longer chowns the shared parent to the service user, guards creation with an existence check, and keeps `$INSTALL_DIR` locked. The previously-planned **onboarding** work moves to **v0.2.31-alpha**. Operator out-of-band unblock if needed before redeploy: `sudo chown root:root /opt/torii && sudo chmod 0755 /opt/torii` (restores o+x, leaves the agent subdir untouched). Prior slice: **v0.2.28-alpha shipped AGENT-SEC-CASHU-LTS: the money-path dependency migration flagged in v0.2.27.** `@cashu/cashu-ts` moved `2.5.3 → 3.7.1` (the maintained `v3-lts` "security-fixes-only" line; dist-tag `v3-lts` resolved to `3.7.1` at implementation time, latest was `4.7.0` — v4 deliberately not taken), pinned `^3.7.1`, lockfile regenerated with sha512 integrity and the deprecation notice cleared. Code adapted in `agent/core/wallet.mjs` only: class rename `CashuMint→Mint` / `CashuWallet→Wallet`; the boot warm-up `getMintInfo()` (async in v2, now a sync cached getter that throws pre-load in v3) replaced by `await wallet.loadMint()`; an idempotent `ensureLoaded()` guard added before `receive()`/`send()` to restore v2 lazy-load-on-demand (verified zero extra network once keysets are cached). Token/proof codec, `Token`/`Proof`/`SendResponse` shapes, and the `receive()→Proof[]` contract are unchanged between the versions (both default to token-v4 `cashuB`). Safety proof: a token encoded by the **real 2.5.3 library** decodes under 3.7.1 with all mint/unit/memo/id/amount/secret/C preserved AND **re-encodes byte-identically**; on-disk `memory/wallet/*.json` survives a JSON round-trip unchanged — no re-mint, conversion, deletion, or network mutation. New offline `agent/test/cashu-migration.test.js` (8 cases) pins every used Cashu boundary incl. malformed/truncated tokens failing closed without leaking secrets; agent `node --test` now **38/38**. `npm audit --omit=dev` and full audit both **0 vulnerabilities**; real `node index.mjs` boot on Node 20.20.1 clean with no new warnings and Fastify 5.10.0 intact; root build + ops regressions (13/13, 9/9) green; prod tree shrank 71→68 packages. **Runtime gate — RESOLVED in v0.2.29-alpha (AGENT-SEC-CASHU-LTS-RUNTIME):** cashu-ts 3.7.1 declares `engines.node >=22.4.0` across the whole v3-lts line. This is now treated as a **HARD deployment prerequisite for the money path, not an advisory** — an `EBADENGINE` warning during `npm ci` is not an acceptable production state for a wallet. v0.2.29 raised `agent/package.json` (+ agent lockfile) `engines.node` to `>=22.4.0` (root frontend `package.json` deliberately left engine-free — static vite/vitest, no agent runtime), rewrote the `ops/install-agent.sh` preflight to gate on a robust major.minor.patch check (`ops/lib/node-version.sh::node_version_ok`, rejecting 22.0.x–22.3.x, erroring with the floor and stopping before touching anything), added `ops/test/installer-preflight.test.sh` (18 host-independent boundary assertions), fixed the stale `wallet.mjs` comment, and made `ops/README` state Node 22 LTS is a hard prerequisite. Verified under a real **Node 22.11.0** runtime (sandbox default is Node 20.20.1): clean `npm ci` with no EBADENGINE, 0 vulns, agent 38/38, ops 18/9/13, root build + vitest green, and a `node index.mjs` boot → `/api/health` 200 (v0.2.29-alpha) with no warnings. **Deploy prerequisite:** upgrade the VPS to Node 22 LTS before re-running `ops/install-agent.sh`; it will refuse to run on Node 20. **NOT yet deployed** — v0.2.26 remains the live server; v0.2.27 remains the newest shipped code. Prior slice: **v0.2.27 shipped AGENT-SEC: production dependency remediation.** `npm audit --omit=dev` in `agent/` reported 5 HIGH advisories in the Fastify tree during the live v0.2.26 deploy — all rooted in `fast-uri` (path-traversal GHSA-q3j6-qgpj-74h6 + host-confusion GHSA-v39h-62p7-jpjc) plus a Fastify content-type body-validation-bypass (GHSA-jx2c-rxcm-jvmq, no v4 backport). Cleared by upgrading `fastify ^4.28.1 → ^5.10.0`, `@fastify/cors ^9 → ^11`, `@fastify/rate-limit ^9 → ^11` and regenerating the lockfile; `fast-uri` now resolves to patched 3.1.3/4.1.0. No app code change beyond dropping the explicit `disableRequestLogging: false` from the Fastify constructor — passing the top-level option at all (even the default `false`) trips Fastify v5's `FSTDEP023` deprecation (guard is `!== undefined`, verified in installed `fastify@5.10.0` source + under `--trace-deprecation`; warning says removed in `fastify@6`); the drop is a no-op that silences the warning, request logging still emits. `@cashu/cashu-ts` stays at 2.5.3 (**no published npm/GHSA advisory**, so it does not block this hotfix — but the deprecation points to the `v3-lts` "security-fixes-only" line, so a v3-lts/v4 migration is a **security-relevant money-path follow-up to prioritise**, deferred as a separate slice to avoid behaviour drift in money-handling code — not cosmetic). Post-fix `npm audit --omit=dev` = **0 vulnerabilities**. Added `agent/test/wallet.test.js` (offline wallet guard/failure paths + cashu-ts codec regression) and `agent/test/fastify-v5-api.test.js` (cors preflight + rate-limit route-config contract); agent `node --test` now 30/30, rate-limit smoke green, root build green, ops regression 13+9 green. **NOT yet deployed** — v0.2.26 remains the live server version until an operator re-runs `install-agent.sh`. Base-path awareness + Ollama fallback landed in v0.2.6. Docs hygiene sweep across v0.2.7 → v0.2.12. **v0.2.13 shipped CONT-HEALTH-1**: dashboard now has a live Provider card polling `/api/health/models` every 20s. **v0.2.14 shipped SUITE-VPS-READY-1 rate-limit slice** — the public auth surface is behind `@fastify/rate-limit@9` per-IP with 429 + `Retry-After`; the in-memory challenges Map is capped and LRU-by-expiry evicted with structured `[auth]` logs, all prefix-only. **v0.2.26 shipped SUITE-VPS-READY-2: agent deploy tooling + first-touch admin claim.** New `ops/` assets let an operator run the agent as a hardened standalone systemd service: `ops/systemd/torii-continuum-agent.service` (locked `continuum` user, `ProtectSystem=strict`, only `memory/` + `config.yaml` writable), `ops/nginx/torii-api.conf` (same-origin `/api/` proxy + edge `limit_req`), `ops/install-agent.sh` (idempotent strict-bash installer: locked user, `rsync` without clobbering state, `npm ci --omit=dev`, one-time config gen with a fresh `openssl` session_secret, config validation, nginx `-t`-before-reload wiring, bounded `/api/health` proof), and a refreshed `ops/README.md` runbook. `agent/core/auth.mjs` gained first-touch admin bootstrap: with an empty `admin_npub` the first valid NIP-07 verifier atomically claims admin (npub persisted to `config.yaml` 0600 via injected `persistAdminNpub` in `config.mjs`), race-safe and fail-closed; `/api/health` now reports `admin_claimed`. **The agent is NOT deployed by this work** — running `install-agent.sh` on a server is a separate operator step. Next code slice: **real Cashu wallet health probe (CONT-HEALTH-2)** — a signed wallet-info call so `torii doctor` verifies the mint's public key and reports actual balance, landing as a new Provider-card row + `/api/health/wallet` endpoint.

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
