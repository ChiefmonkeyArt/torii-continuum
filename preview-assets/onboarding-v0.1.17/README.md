# torii-continuum onboarding preview

Version: **0.1.17-preview**

A five-panel graphic-novel style onboarding mockup for torii-continuum.
Chiefmonkey (a live Three.js-rendered character) greets the operator across
five narrative beats — Verify, Wallet, Routstr, Welcome, Recovery kit — with
painterly backdrop scenes cross-fading behind a frosted glass panel deck.

Live preview: https://chiefmonkey.art/onboarding-preview/

## Structure

- `index.html` - markup, step panels, importmap
- `shared.css` - design system + responsive (desktop/mobile) layout
- `deck.js` - panel deck navigation (step advance, step dots, skip)
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

## Known dev-time CDN reference

`index.html` still loads type faces (Cabinet Grotesk, Satoshi, JetBrains
Mono) from Fontshare (`api.fontshare.com`). This is flagged in-file and is
considered acceptable for this design-review mockup under the standing rule's
"dev-time CDN ... fine for local mockups" carve-out. Before this becomes the
shipped Continuum onboarding flow, these font families should be self-hosted
to remove the last third-party CDN dependency.

## Mobile support

As of v0.1.1-preview, the character canvas renders correctly on iOS
Safari/Brave (previously blank due to a blocked esm.sh CDN import), and the
camera framing has portrait-specific positions (`STEP_FRAMES_MOBILE` in
`character.js`) so Chiefmonkey stays visible above the mobile bottom sheet.

See `CHANGELOG.md` for full release history.
