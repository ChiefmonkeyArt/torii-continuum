# torii-continuum onboarding preview

Version: **0.1.1-preview**

A five-panel graphic-novel style onboarding mockup for torii-continuum.
Chiefmonkey (a live Three.js-rendered character) greets the operator across
five narrative beats — Verify, Wallet, Routstr, Welcome, Recovery kit — with
painterly backdrop scenes cross-fading behind a frosted glass panel deck.

Live preview: https://chiefmonkey.art/onboarding-preview/

## Structure

- `index.html` - markup, step panels, importmap
- `shared.css` - design system + responsive (desktop/mobile) layout
- `deck.js` - panel deck navigation (step advance, step dots, skip)
- `character.js` - Three.js scene, camera framing per step, mobile portrait
  reframing, GLB model + animation loading
- `assets/chiefmonkey6.glb` - the character model (Draco-compressed)
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
