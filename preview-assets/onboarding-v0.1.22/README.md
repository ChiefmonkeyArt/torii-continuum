# torii-continuum onboarding preview

Version: **0.1.22-preview**

A five-panel graphic-novel style onboarding mockup for torii-continuum.
Chiefmonkey (a live Three.js-rendered character) greets the operator across
five narrative beats — Verify, Wallet, Routstr, Welcome, Recovery kit — with
painterly backdrop scenes cross-fading behind a frosted glass panel deck.

Live preview: https://chiefmonkey.art/onboarding-preview/

## Structure

- `index.html` - markup, step panels, importmap. Step 1's primary control reads
  **"Sign in with browser extension"** (the NIP-07 signer path — Plebeian Signer,
  nos2x, Alby); the ghost button opens the NIP-46 **remote signer** alternative.
- `shared.css` - design system + responsive (desktop/mobile) layout. Numbered
  step dots read at a glance: the **current** step is enlarged with a brighter
  `--amber-bright` ring + glow; **completed** steps are **bronze-filled**
  (`--bronze`, dark numerals at AA contrast); upcoming steps stay dim. Keyboard
  focus shows an explicit `:focus-visible` amber ring, and no new motion is
  introduced (reduced-motion safe).
- `deck.js` - panel deck navigation (step advance, step dots, skip). Toggles
  `.active` on the current dot and `.done` on completed dots.
- `onboarding-client.js` - live client for steps 1–3 (v0.1.16). Self-contained,
  no build step: NIP-07 (`window.nostr`, Plebeian Signer) primary + NIP-46
  browser-client (bunker) secondary against the same-origin agent API, and
  the `torii.session` localStorage writer. Exports pure, injectable helpers
  so the whole flow is unit-testable offline — including session restore on
  reload (`isSessionValid`/`restoreSession`, fail closed), the character
  loader retry policy (`nextLoadAttempt`), and the character↔deck step-sync
  state machine (`createCharacterSync`/`recordStep`/`resolveReadyStep`/
  `markCharacterFailed`). v0.1.16 adds the Step 2 wallet + Step 3 Routstr
  helpers — shape validation (`validateNwcUriShape`, `validateRoutstrKeyShape`,
  `validateTopupAmount`), the authenticated same-origin calls (`connectWallet`,
  `walletStatus`, `disconnectWallet`, `connectRoutstrKey`, `quoteRoutstrTopup`,
  `payRoutstrInvoice`, `recoverRoutstrInvoice`, `routstrStatus`,
  `disconnectRoutstr`) and the DOM wiring
  (`wireReveal`, `capMatrixHtml`, `initStep2`, `initStep3`). Secrets (the NWC
  URI, the `sk-…` key) are sent only over the authenticated link, never written
  to storage/URL/logs, and the input is cleared on every connect outcome;
  `payRoutstrInvoice` refuses to pay unless `confirm === true`.
- `character.js` - Three.js scene, camera framing per step, mobile portrait
  reframing, GLB model + animation loading with a stall/error retry, step-1
  auth-phase clips. v0.1.15: applies the deck's resolved/restored step on
  model-ready (order-independent) and emits explicit `onboarding:model-loaded`
  / `onboarding:model-error` readiness events. v0.1.17: a dedicated,
  forbidden-safe animation state machine — each step plays one dedicated clip
  resolved from `STEP_CLIPS`/`selectStepClip` (no locomotion/knock-down), and a
  raycast hit-test on the model plays a random one-shot from a curated click
  pool (`CLICK_POOL`/`pickClickReaction`), returning to the step clip on finish.
  Respects `prefers-reduced-motion`, guards against click-spam, and never
  steals a click aimed at a UI control.
- `assets/chiefmonkey-onboarding.glb` - the character model, crushed for
  production by `tools/optimize-glb.mjs` (Draco mesh compression + WebP
  textures + resample; ~74.75% smaller than source, ~2.35MB). Ships with a
  `.manifest.json` recording sizes, %reduction, a deterministic SHA-256, and
  the retained/dropped clip inventory.
- `tools/optimize-glb.mjs` - reproducible local GLB optimizer. Drops forbidden
  locomotion/knock-down clips using the SAME `isForbiddenClip` predicate the
  runtime uses (single source of truth), then dedup/weld/resample + WebP + Draco.
  Deterministic: re-running on the same source yields byte-identical output.
- `scenes/*.png` - five painterly backdrop scenes
- `three-libs/` - self-hosted Three.js runtime + Draco decoder (see below)

## Self-hosted dependencies

Per the standing rule ("No Cloudflare, no third-party CDN, no KYC, no PaaS
lock-in"), all runtime JS dependencies are vendored locally under
`three-libs/`:

- `three-libs/three/three.module.js` - Three.js 0.161.0 core (ESM build)
- `three-libs/three/addons/loaders/GLTFLoader.js`
- `three-libs/three/addons/loaders/DRACOLoader.js`
- `three-libs/three/addons/utils/BufferGeometryUtils.js` - transitive
  dependency of GLTFLoader.js
- `three-libs/draco/` - Draco WASM decoder (already self-hosted prior to
  v0.1.1-preview)

These were vendored from the jsDelivr npm mirror
(https://cdn.jsdelivr.net/npm/three@0.161.0/...) at v0.1.1-preview time and
are served locally in production — jsDelivr itself is dev-time tooling only,
not a runtime dependency.

## Fonts (self-hosted, zero third-party requests)

Since **v0.1.22** the type faces are self-hosted: `fonts/*.woff2` declared in
`fonts.css`, which `index.html` and `inspect/index.html` load locally. The old
`api.fontshare.com` stylesheet was the deck's only third-party request; it is
gone, so the preview now matches the production rule that Continuum makes zero
external requests. Cabinet Grotesk and Satoshi are licensed for self-hosting
under the ITF Free Font Licence (free for personal and commercial use, offline
kit explicitly supported).

Only `woff2` is shipped — every browser that can run this deck (WebGL2 + ES
modules) supports it, so the CDN's `woff`/`ttf` fallbacks were dead weight.
Total font payload: **114 KB** across five faces.

Note: the Fontshare CDN never actually served **JetBrains Mono** (it is not an
ITF family), so `--font-mono` has always fallen through to the system monospace
stack. Rendering is therefore unchanged by this switch, and nothing is
self-hosted for the mono role. If a real mono face is wanted later it is a
deliberate, separately-weighed addition.

## Mobile support

As of v0.1.1-preview, the character canvas renders correctly on iOS
Safari/Brave (previously blank due to a blocked esm.sh CDN import), and the
camera framing has portrait-specific positions (`STEP_FRAMES_MOBILE` in
`character.js`) so Chiefmonkey stays visible above the mobile bottom sheet.

See `CHANGELOG.md` for full release history.
