# CHANGELOG

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
