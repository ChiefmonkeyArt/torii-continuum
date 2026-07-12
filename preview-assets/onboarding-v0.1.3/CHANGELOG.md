# CHANGELOG

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
