# CHANGELOG

## v0.1.15-preview - deterministic character↔deck sync (Chiefmonkey after soft reload)

v0.1.14 restored Step 2 on reload and made the GLB loader retry on error, but
Chiefmonkey still *intermittently* stayed absent after an ordinary Cmd+R soft
refresh (a hard Cmd+Shift+R always worked), even though Step 2 session restore
succeeded. A live browser diagnostic ruled out the assets: every file served
200, the GLB parsed with all 19 clips (incl. `Idle_03`), and the canvas existed
full-viewport at opacity 0. The remaining variable was **startup ordering**.

Root cause — a script/load-ordering race, not bad assets. `character.js` (an
ES module) and `deck.js` (a classic script) are injected together and execute
in a non-deterministic order relative to each other and to the async GLB load.
`deck.js` announces the desired step (including the restored Step 2) via an
`onboarding:step` CustomEvent. When that fired *before* the GLB finished
loading, the old `character.js` dropped it (its `actions` map was still empty)
and then, in `onLoaded`, hard-applied `applyStep(1)` — so the restored Step 2
and its `Idle_03` were silently reverted, and because the intended ready-state
was lost the stage could stay dark. Whether the event landed before or after
the load was pure timing, which is exactly why it reproduced only sometimes and
why a hard refresh (different fetch/preload timing) masked it.

Fix (client-only; no server, schema, validation-endpoint, or asset change):

- A tiny **pure, injectable sync state machine** in `onboarding-client.js`
  (`createCharacterSync` / `recordStep` / `resolveReadyStep` /
  `markCharacterFailed`), alongside the existing `nextLoadAttempt` /
  `selectAnimation` helpers, so the "which step to show once the model is
  ready" decision is order-independent and unit-testable with no DOM/WebGL.
- `character.js` now records every `onboarding:step` into that state. Before
  readiness the step is remembered, not dropped; on load, `onLoaded` calls
  `resolveReadyStep(sync, window.__toriiRestoredStep)` — honouring a step the
  deck already broadcast, else the restored session step (2..5) read *at ready
  time* so a late-evaluating `onboarding-client.js` is still picked up, else
  Step 1. The hard-coded `applyStep(1)` is gone. A step that arrives *after*
  readiness applies immediately. The two paths together are fully
  order-independent.
- **Explicit readiness + terminal-failure state/events**: on successful load
  `window.__toriiCharacterReady = true` and an `onboarding:model-loaded` event
  fire; on terminal give-up (retry already spent) `window.__toriiCharacterFailed
  = true` and `onboarding:model-error` fire and the sync is marked failed so no
  further step is ever applied. No artificial delay, and the UI is never hidden
  beyond the character canvas itself.

Everything else is byte-for-byte preserved: the single cache-busted retry and
`nextLoadAttempt` policy, the same-origin no-`crossorigin` preload hints
(v0.1.11), `restoreSession`/`isSessionValid` fail-closed logic, the NIP-07
primary / browser-client NIP-46 secondary flows, the "Sign with Plebeian
Signer" wording, the `localStorage['torii.session']` shape, and the three
auth-phase clips (`HandGesture_00` / `Idle_03` / `Confused_02`). New offline
regressions exercise both orderings (restore-before-load and load-before-
restore), ordinary reload / cache-hit (resolves to Step 1, no revert), and the
terminal failure branch (no step applied after give-up).

## v0.1.14-preview - restore Step 2 on reload + Chiefmonkey reappears after refresh

After a successful NIP-07 sign the deck advances to Step 2, but a plain page
refresh dropped the operator back to Step 1 and left Chiefmonkey invisible.
Two independent root causes, fixed together (client-only; no server, schema,
or validation-endpoint change):

1. **No session restore on load (Step 2 → Step 1 on refresh).**
   `onboarding-client.js` wrote `localStorage['torii.session']` on success but
   nothing ever read it back on load, and `deck.js` always hard-started at
   Step 1. Fix: `restoreSession()` reads and validates the stored session at
   module load and, when valid, sets `window.__toriiRestoredStep`; `deck.js`
   opens directly on that step. A `onboarding:advance` dispatch covers the
   reverse script-execution order, so restore is independent of the async
   module/classic load race. Validation is **fail closed** and adds no server
   surface: there is no dedicated session-validation endpoint, so
   `isSessionValid()` enforces every non-secret invariant the agent's own
   `verifySessionToken` (agent/core/auth.mjs) enforces — the exact
   `iat.exp.pubkey.sig` token shape, numeric timestamps, a not-yet-elapsed
   expiry, and that the pubkey baked into the token matches the stored
   identity. Invalid/expired/tampered sessions are removed and the operator
   restarts cleanly at Step 1. The HMAC secret is never needed or exposed in
   the browser.

2. **Chiefmonkey invisible after refresh (loader gave up on error).**
   v0.1.11 added a watchdog that retried the GLB once on an 8s *stall*, but a
   reload could make the preloaded same-origin fetch *error* outright — and
   the old `onErr` merely hid the canvas and cancelled the watchdog, so the
   retry never ran. Fix: both stall and error now route through the pure
   `nextLoadAttempt()` policy — first failure (either kind) gets one
   cache-busting retry, a second gives up rather than looping. The preload
   hints are untouched, so the v0.1.11 same-origin (no-`crossorigin`) fix that
   avoids the CORS cache mismatch is preserved.

Carries forward the v0.1.13 empty-JSON-header fix unchanged (the bodyless
`/api/auth/challenge` POST still sends no `Content-Type`). NIP-07 stays the
primary path, browser-client NIP-46 the secondary; the "Sign with Plebeian
Signer" wording, `localStorage['torii.session']` shape, and the three
auth-phase clips (`HandGesture_00` / `Idle_03` / `Confused_02`) are all
preserved. New offline regressions prove: a valid stored session restores
Step 2; an invalid/expired session fails closed to Step 1 and is cleared; and
the loader retries on both stall and error while the same-origin preloads
carry no `crossorigin`.

## v0.1.13-preview - fix "agent challenge failed (400)" on Sign with Plebeian Signer

Operator clicked "Sign with Plebeian Signer"; Chiefmonkey animated but no
signer prompt opened and the panel reported `agent challenge failed (400)`.

Root cause was in `onboarding-client.js`'s `postJson` helper, not the agent.
It always sent `Content-Type: application/json`, even for the **bodyless**
`POST /api/auth/challenge` call. The agent runs Fastify v5, whose JSON
content-type parser rejects an empty body carrying that header with
`400 FST_ERR_CTP_EMPTY_JSON_BODY` — so the very first step of the auth flow
failed before any signer was ever invoked (the NIP-07 window.nostr prompt
comes only *after* a challenge is fetched).

Fix (client-only, no server or validation change):

- `postJson` now sets `Content-Type: application/json` and serialises a body
  **only when a body is actually provided**. The challenge call goes out with
  no body and no content-type (→ 200); the verify call is unchanged and still
  sends the JSON event body.

No change to the agent, its schema, or its validation. NIP-07 stays the
primary path, browser-client NIP-46 the secondary; `localStorage['torii.session']`,
the "Sign with Plebeian Signer" wording, and the three auth-phase clips
(`HandGesture_00` / `Idle_03` / `Confused_02`) are all preserved. A new
offline regression test asserts the challenge POST carries no body and no
JSON content-type while the verify POST still does.

## v0.1.12-preview - onboarding step 1: live NIP-07/NIP-46 auth

Step 1 ("Prove you're the operator") now talks to the live same-origin
agent API instead of just advancing the deck on click.

New self-contained `onboarding-client.js` (ES module, no build step, no
third-party CDN):

- Primary path is **NIP-07** via `window.nostr` (Plebeian Signer). The
  button reads "Sign with Plebeian Signer". Flow: `POST /api/auth/challenge`
  -> build + sign the exact kind-22242 auth event the agent expects
  (`content == challenge`, `['challenge', challenge]` + `['relay', origin]`
  tags) -> `POST /api/auth/verify` -> store the session. Fails closed on
  malformed challenge/verify responses, expired challenges, pubkey mismatch,
  a signed challenge that doesn't match, or an absent token.
- Secondary path is **NIP-46** with the browser as the client (architecture
  per github.com/dsbaars/bunker46), revealed by "Use a different signer".
  The operator pastes a `bunker://` connection string; the browser parses it
  and asks the remote signer to sign the same 22242 event over the bunker's
  relay. There is **no server bunker-connect endpoint** and no key or
  connection secret is ever sent to the agent — only the final signed event
  reaches `/api/auth/verify`. It never silently falls back to NIP-07.
- Session is written to exactly `localStorage['torii.session']` as JSON:
  `{ token, expires_at, pubkey, method, created_at }` — session token +
  public identity metadata only, no secrets.

Chiefmonkey reacts to the auth phase via the existing animation channel:
`HandGesture_00` while prompting/signing, `Idle_03` on success,
`Confused_02` on failure — each with an ordered fallback to a clip that
exists in the shipped GLB, so a missing clip keeps the current animation
rather than freezing.

Preserves the desktop-only gate and every prior performance fix (self-hosted
Three.js/Draco, WebP scenes, Draco wasm preload, renderer compile,
same-origin preload cache behaviour). Terminology unchanged: "Your Torii,
your gateway"; never "Wallet" on the signer button; never "VPS" in the UI.

## v0.1.11-preview - fix reload stall + preload cache

Operator reported first-load worked fast, but browser refresh left
Chiefmonkey invisible while the scene rendered. Root cause was a
preload cache mismatch: `<link rel=preload as=fetch crossorigin>` for
same-origin assets uses CORS credentials mode, but GLTFLoader and
DRACOLoader fetch without CORS. On reload the cached preload could
not be matched to the actual request and either double-fetched or
stalled.

Fixes:
- Removed `crossorigin` from same-origin preload hints (glb, wasm).
  Added `type` attributes for accurate MIME matching.
- Removed modulepreload for GLTFLoader.js and DRACOLoader.js. Those
  import `three` by bare specifier and the raw modulepreload probe
  ran before the importmap could resolve it, throwing a harmless but
  noisy console error.
- Added a load watchdog: if the GLB stalls >8s, retry once with a
  cache-buster query so the user never sees an empty stage.

Local render times: first 1.29s, reload 1 270ms, reload 2 113ms,
reload 3 60ms.

## v0.1.10-preview - Draco wasm decoder + shader precompile

Operator reported Chiefmonkey still lagged ~10s after scene paint even
after v0.1.9's preload work. Two remaining culprits:

1. Draco was using `type: 'js'` - the pure-JS decoder, 3-10x slower than
   the wasm decoder for skinned meshes. The wasm binary was already
   shipped and preloaded, just not used.
2. First frame after model add triggered synchronous WebGL shader
   compilation for skinning (visible as tab freeze).

Fixes:
- `draco.setDecoderConfig({ type: 'wasm' })` and `draco.preload()` so
  the wasm decoder is instantiated before the GLB arraybuffer arrives.
- `<link rel=preload as=script>` for draco_wasm_wrapper.js added.
- `renderer.compile(scene, camera)` before opacity flip - shaders
  compile during the fade window, not the first animation frame.
- Fade transition 900ms -> 400ms so the character is visible sooner
  after decode.

Local render 1.85s -> 1.31s. On slow networks the improvement is larger
because wasm decode scales with mesh size while JS decode does the
whole thing on the main thread.

## v0.1.9-preview - fast load: WebP scenes + parallel preload

Operator reported the scene painted in 3 chunks and the character
appeared 30s later. Two root causes:

1. Scene PNGs were 3MB each x 5 = 14.5MB total, painted progressively.
2. Character load was serial: three.module.js (1.3MB) -> GLTFLoader ->
   DRACOLoader -> draco_decoder.wasm (188KB) -> chiefmonkey6.glb (1.2MB)
   -> decode. Every step waited for the previous.

Fixes:
- Scenes converted PNG -> WebP q82. 14.5MB -> 1.3MB total (91% smaller).
  Visually indistinguishable at page scale.
- `<link rel="preload">` for scene 1 (fetchpriority=high), the GLB,
  and the Draco wasm - all fetch in parallel with the HTML parse
  instead of after the JS import chain.
- `<link rel="modulepreload">` for three.module.js, GLTFLoader,
  DRACOLoader, and character.js - browser starts fetching modules
  before the deferred body script runs.
- Fontshare stylesheet loads with media="print" onload swap so it
  fetches without blocking first paint. Falls back cleanly via
  <noscript>.
- PNG originals moved out of the shipped tree (kept in workspace
  scenes-orig-backup-continuum for source).

Local end-to-end render measured at ~1.9s (was likely 5-10x that).

## v0.1.8-preview - character re-centered (CHAR_X_DESKTOP -0.9 -> -0.5)

Operator felt Chiefmonkey sat too far left at -0.9 world units on the
onboarding first page. Nudged to -0.5 so he lands in the left third
with breathing room to both sides while still leaving the panel clear.

## v0.1.7-preview - character canvas widened to 100vw, no more edge clipping

Chiefmonkey's canvas was `width: 50vw` on desktop, so wide-armed poses
(Idle_03 stretch, walk swings) got clipped at the 720px canvas boundary
- looking like a hand "disappearing behind" something invisible.

Fix:
- `#character` canvas now spans 100vw x 100vh
- Chiefmonkey repositioned in 3D via `CHAR_X_DESKTOP = -0.9` world units
  so he stays framed in the left third instead of centered
- `.panel` gets `z-index: 5` so hands can no longer occlude UI - if a
  gesture swings into panel space, the panel correctly sits on top
- Mobile keeps character at x=0 (already used a 100vw canvas + bottom sheet)
- `resize()` re-anchors the base x on portrait <-> landscape swaps

## v0.1.6-preview - main onboarding gets same opaque fix

The v0.1.5 opaque-material patch only landed in `/inspect/`. The main
onboarding at `/onboarding-preview/` still used the broken `character.js`
loader. Same 4-line fix applied there.

## v0.1.5-preview - clip inspector opaque-material fix

Reason 100% of clips looked shredded: the inspector wasn't patching the GLB
materials the same way torii-quest does. Chiefmonkey6's GLB ships with
`alphaMode:BLEND` on the skinned meshes; without an opaque override the
transparent pipeline draws faces out of order and the model appears to
disintegrate.

Now matches torii-quest `src/napNpc.js` v0.2.111 fix:

- `material.transparent = false`
- `material.depthWrite = true`
- `material.alphaTest = 0`
- `mesh.frustumCulled = false`

## v0.1.4-preview - clip inspector

Added `/inspect/` diagnostic page for auditing all 19 GLB animation clips.

- New page at `/onboarding-preview/inspect/` with dropdown of all clips
- Neutral grid floor + 3-light setup for even inspection
- Camera controls: distance, height, orbit yaw (sliders + mouse drag + wheel zoom)
- Playback speed 0.1x to 2.0x
- Keep / Flag verdict per clip, persisted to localStorage
- "Copy report to clipboard" exports markdown audit
- Desktop-only (shares the mobile gate from v0.1.3)
- Reuses parent Three.js from `../three-libs/`

## v0.1.3-preview — desktop-only gate

Continuum onboarding is a desktop-only flow (self-hosted Torii setup + a
desktop-only game). Rather than fight iOS WebGL quirks for a use case that
does not exist, small screens and coarse pointers are now blocked at the
door with a friendly notice.

- Added desktop-only splash shown when `matchMedia('(max-width: 899px)')` or
  `matchMedia('(pointer: coarse)')` matches
- Splash sets `data-desktop-only="blocked"` on `<html>` before any scripts
  load, so Three.js, GLTFLoader, DRACOLoader, and the character GLB are
  never fetched on mobile — respects data allowance and battery
- Reverted the v0.1.2 in-browser diagnostic overlay in `character.js` back
  to the clean v0.1.1 baseline (no `#char-diag`, no `window.error` handler)
- Self-hosted Three.js retained from v0.1.1 (privacy standing rule)
- `VERSION` bumped 0.1.1-preview → 0.1.3-preview
  (0.1.2 was diagnostic-only, never deployed)

## v0.1.1-preview — self-hosted Three.js + mobile framing attempt
- Vendored Three.js core + GLTFLoader + DRACOLoader under `three-libs/three/`
- Portrait-aware `STEP_FRAMES_MOBILE` + `orientationchange` handler
- Bolder current step dot (amber ring + soft glow)
- Root cause: even with self-hosted Three.js, GLB render still failed on
  iOS Brave. Discovery in v0.1.3: mobile is not a target use case for
  onboarding, so we gate it out instead of debugging further.

## v0.1.0-preview — first deploy
- Painterly cross-fade backdrops
- Chiefmonkey GLB per-step framing (desktop only, undiscovered)
- Frosted glass panels, amber accent, 5-step deck + curtain
- Self-hosted via nginx atomic-release-dir + symlink at
  `/var/www/torii/onboarding-preview`
