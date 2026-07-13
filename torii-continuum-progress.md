# Torii Continuum — Progress log

Living release log for the `torii-continuum` repo. Newest first. One entry per release. Longer slice reports live alongside as `torii-continuum-v0.2.N-<slice>-report.md` when a release warrants deeper narration; this file is the fast scan.

Companion source-of-truth files (per the `Torii` Space instructions, one set per project):

- `torii-continuum-strategy.md` — vision, principles, decision rules, architecture direction.
- `torii-continuum-todo.md` — active task queue.
- `torii-continuum-progress.md` — this file, release log.
- `torii-continuum-handoff.md` — developer entry point / resume point.

## v0.2.32-alpha — ONBOARDING-STEP1-FIX: "agent challenge failed (400)" on Sign with Plebeian Signer

Onboarding preview bumped to **v0.1.13-preview** (`preview-assets/onboarding-v0.1.13/`).
Production bug: on the live onboarding preview (v0.1.12-preview / agent
v0.2.31-alpha) the operator clicked "Sign with Plebeian Signer"; Chiefmonkey
animated but no signer prompt opened and the panel reported exactly
`agent challenge failed (400)`.

**Root cause (client-only).** `onboarding-client.js`'s `postJson` helper
always set `Content-Type: application/json`, including on the **bodyless**
`POST /api/auth/challenge` call. The agent runs Fastify v5, whose JSON
content-type parser rejects an empty body carrying that header with
`400 FST_ERR_CTP_EMPTY_JSON_BODY`. So the very first step failed before any
signer was invoked — the NIP-07 `window.nostr` prompt only fires *after* a
challenge is fetched, which is why Chiefmonkey animated ("prompting") but no
extension prompt appeared. The agent route, schema, and validation were
correct; the mismatch was entirely in the client's request framing.

**Fix.** `postJson` now sets the JSON content-type and serialises a body only
when a body is actually provided. The challenge call goes out bodyless with no
content-type (→ 200); the verify call is unchanged. No server endpoint added,
no validation weakened, no new bunker-connect endpoint. NIP-07 stays primary,
browser-client NIP-46 secondary; `localStorage['torii.session']`, the exact
"Sign with Plebeian Signer" wording, and the three auth-phase clips
(`HandGesture_00` / `Idle_03` / `Confused_02`) are all preserved.

Tests: new offline vitest case asserts the challenge POST carries no body and
no JSON content-type while the verify POST still does; new agent
`fastify-v5-api` case pins the empty-body-400 vs bodyless-200 contract the fix
relies on. Verified root vitest, root build, agent `node --test`, agent
`npm audit --omit=dev`. Code + PR only — not deployed.

## v0.2.31-alpha — ONBOARDING-STEP1: live NIP-07/NIP-46 auth for the onboarding preview

Onboarding preview bumped to **v0.1.12-preview** (`preview-assets/onboarding-v0.1.12/`).
Step 1 ("Prove you're the operator") now performs a real login against the
same-origin agent API instead of advancing the deck on a bare click.

New self-contained `onboarding-client.js` (ES module, no build step, no
third-party CDN). Primary path is **NIP-07** via `window.nostr` (button:
"Sign with Plebeian Signer"): `POST /api/auth/challenge` → build + sign the
exact kind-22242 auth event the agent expects (`content == challenge`,
`['challenge', …]` + `['relay', origin]` tags, mirroring
`agent/core/auth.mjs`) → `POST /api/auth/verify` → persist the session to
exactly `localStorage['torii.session']`. Fails closed on malformed
challenge/verify responses, expired challenges, pubkey/challenge mismatch,
or an absent token. Secondary path is **NIP-46** with the browser as the
client (architecture per github.com/dsbaars/bunker46), revealed by "Use a
different signer": the operator pastes a `bunker://` string, the browser
parses it and asks the remote signer to sign the same event over the
bunker's relay. There is **no server bunker-connect endpoint**; no key or
connection secret ever reaches the agent, and it never silently falls back
to NIP-07. Session value shape: `{ token, expires_at, pubkey, method,
created_at }` — session token + public identity metadata only, no secrets.

Chiefmonkey reacts via the existing animation channel: `HandGesture_00`
while prompting/signing, `Idle_03` on success, `Confused_02` on failure —
each with an ordered fallback to a clip that exists in the shipped GLB (the
GLB ships neither `HandGesture_00` nor `Confused_02`), so a missing clip
keeps the current animation rather than freezing.

Preserves the desktop-only gate and every prior perf fix (self-hosted
Three.js/Draco, WebP scenes, Draco wasm preload, `renderer.compile`,
same-origin preload cache behaviour). 28 offline vitest cases cover NIP-07
success/failure, storage shape/key, API response validation, animation
selection, NIP-46 browser-client behaviour + no-server-bunker-endpoint, and
no forbidden UI terminology ("Wallet" on the signer button, "VPS") or CDN
regressions. Verified: root vitest 28/28, root build, agent `node --test`,
ops regressions, `npm audit --omit=dev` (agent). **Code + draft PR only —
not deployed.**

## v0.2.30-alpha — AGENT-SEC-OPT-TORII-PERMS: least-privilege fix for the shared /opt/torii parent

Production regression fix, found after the v0.2.29 deploy to the SHC VPS. The
installer created the **shared** parent `/opt/torii` with an unconditional
`install -d -m 0750 -o continuum -g continuum /opt/torii`. `install -d` re-applies
mode+owner on every run, so this clamped the directory that torii's *other* apps
live under (torii-base launcher, quest tooling) to `0750 continuum:continuum` and
stripped its world-execute (`o+x`) bit. nginx (`www-data`) could then no longer
traverse `/opt/torii` to reach `/opt/torii/launcher/index.html`, so `/` fell
through to a default nginx **404** (Quest under `/var/www` was unaffected).

Fix (`ops/install-agent.sh`): create `/opt/torii` **only if absent**, `root:root`
`0755`, and **never re-own or re-mode an existing** shared parent. The agent's own
subdir `/opt/torii/continuum-agent` stays locked `0750 continuum:continuum` — nginx
never serves from it (the agent is loopback-proxied on `127.0.0.1:8787`), so no
confidentiality is lost. No behaviour change for the agent; the only delta is that
the shared parent keeps the permissions its other tenants need.

Tests: new hermetic + anti-drift `ops/test/installer-shared-parent.test.sh` (10
assertions) — proves the installer no longer chowns the shared parent to the
service user, guards its creation with an existence check (non-destructive
re-run), creates it `root:root 0755`, keeps `$INSTALL_DIR` locked `0750`
`$SERVICE_USER`, and functionally that an existing parent's mode (incl. an
operator-chosen `0751`) survives a re-run while a fresh parent comes up
world-traversable and the agent subdir stays `0750`. Full ops suite green:
`installer-preflight` 18/18, `installer-signal` 9/9, `nginx-install` 13/13,
`installer-shared-parent` 10/10; all `ops/*.sh` pass `bash -n`.

Operator out-of-band unblock before redeploy, if needed:
`sudo chown root:root /opt/torii && sudo chmod 0755 /opt/torii` (restores `o+x`,
leaves the agent subdir untouched). The previously-planned **onboarding** work
moves to **v0.2.31-alpha**. Code + draft PR only — not yet deployed.

## v0.2.29-alpha — AGENT-SEC-CASHU-LTS-RUNTIME: enforce the Node 22 money-path floor

Security-relevant follow-up to v0.2.28. Two independent reviews of PR #26 reached
the same conclusion: the cashu-ts v3-lts migration is correct, minimal, and
well-evidenced, with exactly one blocking change — the runtime contract must be
aligned with cashu-ts 3.7.1's `engines.node >=22.4.0` so the wallet is not
deployed onto an unsupported runtime by default. This slice makes Node 22 LTS a
**hard, enforced deployment prerequisite**. The dependency version is unchanged
(**3.7.1 stays pinned**); all v0.2.28 compatibility fixtures are preserved.

Changes:
- **Agent engine floor.** `agent/package.json` (and the agent lockfile root
  entry) `engines.node` `>=20.0.0 → >=22.4.0`. The **root** `package.json` is
  deliberately left engine-free — it is static vite/vitest frontend tooling with
  no agent runtime, so falsely requiring Node 22 there was avoided.
- **Installer preflight (fail-closed, robust semver).** `ops/install-agent.sh`
  now sources a new `ops/lib/node-version.sh` and gates on
  `node_version_ok "$node_ver"`, a **major.minor.patch** comparison (NOT
  major-only — `22.0.x`–`22.3.x` are correctly rejected even though `22 ≥ 22`).
  On a sub-floor or unparseable version it `die`s with the explicit supported
  floor and **stops before touching any user, service, or file** (the gate sits
  in preflight, ahead of user creation).
- **Regression coverage.** New `ops/test/installer-preflight.test.sh` (18
  assertions) is host-Node-independent — it exercises the pure helper with fixed
  strings: the four required boundaries (20.x reject, 22.3.x reject, 22.4.0
  accept, later-major accept) plus edges (patch/minor above floor, high patch on
  low minor rejected, old LTS rejected, `v`-prefix, prerelease suffix, bare major
  rejected, unparseable → rc 2), a side-effect-free source check, and anti-drift
  that the installer still sources the lib and gates before state changes.
- **Test-runner portability.** `agent` `npm test` `node --test test/` →
  `node --test`. Node 22's directory-argument discovery regressed the `test/`
  form (reported a single failing pseudo-subtest); no-arg auto-discovery reports
  the true **38/38** on both Node 20 and Node 22.
- **Docs.** `ops/README` Prerequisites now state Node **22 LTS is a hard
  prerequisite** (installer refuses older, stops before touching anything) and
  that an `EBADENGINE` warning is not an acceptable production state for a
  wallet; the "run Node 22 at next convenience" framing is gone. Handoff / this
  log / todo updated; the progress live-vs-shipped version wording corrected
  (v0.2.26 live, v0.2.27 newest shipped).
- **Cosmetic + evaluated.** Stale `wallet.mjs` comment `// mintUrl → CashuWallet`
  → `Wallet`. The `ensureLoaded()` in-flight dedup was evaluated and **left
  as-is** (documented non-blocking in-code): `loadMint()` is idempotent, boot
  warm-up primes each mint, and the only un-deduped case fires duplicate
  idempotent fetches — never a double-spend — so introducing memoized state in
  the money path right before a gated deploy was not justified.

Verified under a **real Node 22.11.0 runtime** (fetched as a non-global tarball;
the sandbox default is Node 20.20.1 — supported-boot is **not** claimed from Node
20): `npm ci --omit=dev` clean with **no EBADENGINE**; `npm audit` + `--omit=dev`
**0 vulnerabilities**; agent `node --test` **38/38**; ops `installer-preflight`
**18/18**, `installer-signal` **9/9**, `nginx-install` **13/13**; all `ops/*.sh`
pass `bash -n`; root `npm ci` + `vite build` green; `vitest` (no frontend specs)
exit 0; and a real `node index.mjs` boot → `/api/health` **200**, version
`0.2.29-alpha`, with **no deprecation/EBADENGINE/experimental warnings**.

**Deploy prerequisite:** the VPS must move to the Node 22 LTS line before
`ops/install-agent.sh` will run — it now refuses Node 20. **NOT yet deployed** —
v0.2.26-alpha remains the live server; v0.2.27-alpha the newest shipped code.
This slice is code + PR only.

## v0.2.28-alpha — AGENT-SEC-CASHU-LTS: maintained money-path dependency

Security-relevant money-path slice. Executes the follow-up flagged in v0.2.27:
migrate the deprecated `@cashu/cashu-ts@2.5.3` off the unmaintained line onto
the maintained **v3-lts "security-fixes-only" LTS**. Dist-tag evidence at
implementation time: `npm view @cashu/cashu-ts dist-tags` → `v3-lts: 3.7.1`
(latest is `4.7.0`; we deliberately do **not** jump to v4). Pinned per repo
convention as `"@cashu/cashu-ts": "^3.7.1"` (caret, matching the other agent
deps); lockfile regenerated with registry integrity (sha512) — the 2.5.3
`deprecated` notice is gone from the tree.

API migration (v2.5.3 → v3.7.1), inventoried against the official bundled
`lib/types/index.d.ts` + compiled `lib/cashu-ts.es.js`, adapting code only where
required:
- **Class rename (breaking):** `CashuMint` → `Mint`, `CashuWallet` → `Wallet`.
  `agent/core/wallet.mjs` import + `new Wallet(new Mint(url))` updated. `Wallet`
  still accepts a `Mint` instance (also a bare URL string).
- **`getMintInfo()` (breaking):** was `Promise<MintInfo>` (async network fetch)
  in 2.5.3; in 3.7.1 it is a **synchronous cached getter** that throws if the
  wallet has not been loaded. The boot warm-up (`await wallet.getMintInfo()`)
  is replaced by `await wallet.loadMint()`, which performs the network fetch of
  mint info + keysets + keys.
- **Lazy-load semantics:** v3 `receive()`/`send()` require `loadMint()` first
  (v2 auto-loaded). Added an idempotent `ensureLoaded()` guard before each
  money-path op — verified in source that `loadMint()` skips both network
  fetches once cached (`keyChain.init`: `if (keysets>0 && !forceRefresh) return`),
  so this restores v2's lazy load-on-demand at **zero** extra traffic once warm.
- **Unchanged (no code change):** token codec `getEncodedToken`/`getDecodedToken`
  (both default to token-v4/`cashuB` in 2.5.3 **and** 3.7.1); the `Token`
  `{ mint, proofs, unit?, memo? }` and `Proof` `{ id, amount, secret, C, ... }`
  shapes; `SendResponse` `{ keep, send }`; the `receive() → Proof[]` return.

Serialized-state compatibility (the load-bearing safety proof): a token encoded
by the **real 2.5.3 library** decodes under 3.7.1 preserving mint/unit/memo and
every proof `id`/`amount`/`secret`/`C`, and 3.7.1 **re-encodes it to the
byte-identical wire string**. On-disk `memory/wallet/*.json` (`{ mint, proofs,
updated_at }` plain JSON) survives a JSON round-trip unchanged. No re-mint, no
conversion, no network mutation, no deletion of existing state.

Tests added (offline, deterministic, no live mint / no network / no secrets
logged) — `agent/test/cashu-migration.test.js`, 8 cases: v2-era `cashuB` token
decodes under v3-lts; every critical proof field preserved; mint/unit/memo
survive; **byte-identical re-encode** of the frozen 2.5.3 fixture; encode→decode
amount preservation; proof/pending memory JSON shape unchanged; malformed and
truncated tokens fail closed **without echoing secret material**. Existing
`agent/test/wallet.test.js` guard/codec suite still green under v3.

Verification: `npm audit --omit=dev` and full `npm audit` → **0 vulnerabilities**
(0 critical / 0 high / 0 moderate / 0 low), unchanged from v0.2.27; agent
`node --test` **38/38** (was 30 + 8 new); `scripts/smoke-rate-limit.mjs` all
pass; a real `node index.mjs` boot under Node 20.20.1 comes up clean with
**no new deprecation/warning** (`/api/health` 200, Fastify 5.10.0 intact); root
`vitest` (no frontend suites) + `vite build` green; ops `nginx-install` 13/13
and `installer-signal` 9/9; all `ops/*.sh` pass `bash -n`. Production dep tree
**shrank 71 → 68** transitive packages (the cashu package itself is larger on
disk); `@fastify/*` + `fastify@5.10.0` untouched.

Runtime gate carried into handoff and **resolved in v0.2.29-alpha**: cashu-ts
3.7.1 declares `engines.node >=22.4.0` across the whole v3-lts line. For a money
path this is treated as a **hard deployment prerequisite, not an advisory** — an
`EBADENGINE` warning during `npm ci` is not an acceptable production state for a
wallet. v0.2.29 raises the agent `engines.node` floor and the installer preflight
to Node 22 LTS (see the v0.2.29 entry above). The used API surface happens to run
on Node 20.20.1, but "works today" is not "supported"; the version choice
(3.7.1) stands, only the runtime is now gated.

**NOT yet deployed** — v0.2.26-alpha remains the **live/deployed** server version
and v0.2.27-alpha the newest **shipped** code until an operator re-runs
`ops/install-agent.sh` (which now requires a Node 22 LTS host). This slice is
code + PR only.

## v0.2.27-alpha — AGENT-SEC: production dependency remediation

Security-only slice. During the live v0.2.26-alpha deploy, `npm ci --omit=dev`
in `agent/` surfaced **5 HIGH** production advisories in the Fastify dependency
tree (and the informational `@cashu/cashu-ts@2.5.3` deprecation notice).

Root cause: the whole cluster traces to `fast-uri` and Fastify itself —
- `fast-uri` path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6, CWE-22, CVSS 7.5)
- `fast-uri` host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc, CWE-436, CVSS 7.5)
- `@fastify/ajv-compiler`, `fast-json-stringify`, `@fastify/fast-json-stringify-compiler` all HIGH transitively via the vulnerable `fast-uri`
- `fastify` HIGH on its own account: Content-Type tab-char body-validation bypass (GHSA-jx2c-rxcm-jvmq, CWE-436, CVSS 7.5), **no v4 backport** — fixed only in `fastify@>=5.7.2`.

Because the Fastify advisory has no v4 fix, an override on `fast-uri` alone
could not reach zero HIGH; the safe complete remediation was the Fastify v5
line. Changes:
- `agent/package.json`: `fastify ^4.28.1 → ^5.10.0`, `@fastify/cors ^9.0.1 → ^11.0.0`, `@fastify/rate-limit ^9.1.0 → ^11.0.0`; lockfile regenerated (`fast-uri` now 3.1.3 / nested 4.1.0, both patched).
- `agent/index.mjs`: removed the explicit `disableRequestLogging: false`. Passing this top-level option **at all** — even the default `false` — trips Fastify v5's `FSTDEP023` deprecation warning: the constructor guard is `if (options.disableRequestLogging !== undefined)`, not a truthiness check (verified against installed `fastify@5.10.0` `lib/warnings.js` + `fastify.js`, and reproduced live under `node --trace-deprecation`). The warning text states the top-level option "will be removed in `fastify@6`". The value only restated the default, so dropping it is a pure no-op that silences the boot warning — request logging still emits `incoming request` / `request completed`. No other app code change — the v4→v5 migration was API-transparent for this daemon (trustProxy allow-list, CORS options, rate-limit `global:false` + per-route `config.rateLimit` + `errorResponseBuilder(req, ctx.ttl)` all unchanged in the v11 plugins).
- `@cashu/cashu-ts` **held at 2.5.3**: it carries **no published npm/GHSA advisory** (absent from `npm audit`), so it does not block this HIGH-clearing hotfix. It is **not** merely a spec/maintenance deprecation, though: the registry notice steers users to `@cashu/cashu-ts@v3-lts`, described upstream as the "security-fixes-only LTS" line — implying maintained fixes that 2.5.3 will not receive. A v3-lts (3.7.1) or v4 (4.7.0) migration touches proof/token handling in the wallet money path, so it is deferred to its own slice rather than folded into a security hotfix — but it is tracked as a **security-relevant** money-path follow-up to prioritise, not cosmetic cleanup.

Tests added (offline, no live mint / no network / no secrets logged):
- `agent/test/wallet.test.js` — wallet guard + failure paths (sub-sat send, insufficient balance, malformed token, non-whitelisted mint) and a `getEncodedToken`/`getDecodedToken` `{ mint, proofs }` round-trip regression against the new lockfile.
- `agent/test/fastify-v5-api.test.js` — CORS preflight (204 + echoed origin + credentials) and the rate-limit route-config contract (429 at N+1 + `Retry-After` + numeric `context.ttl`) under fastify 5 / plugins 11.

Verification: `npm audit --omit=dev` → **0 vulnerabilities** (from 5 HIGH);
agent `node --test` 30/30; `scripts/smoke-rate-limit.mjs` all pass; root
`vitest` (no frontend suites) + `vite build` green; ops regression
`nginx-install` 13/13 and `installer-signal` 9/9; all `ops/*.sh` pass
`bash -n`.

**Not deployed by this slice.** v0.2.26-alpha remains the currently deployed
server version; picking up v0.2.27 on the VPS is a separate operator step
(re-run `ops/install-agent.sh`, which runs `npm ci --omit=dev` against the new
lockfile).

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
