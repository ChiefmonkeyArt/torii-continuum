# Continuum Onboarding Preview

Five-panel graphic-novel onboarding sequence for Torii Continuum.
Painterly backdrops + live Three.js Chiefmonkey render.

## Install (chiefmonkey.art)

Extract into your nginx docroot at `/continuum/onboarding-preview/`,
e.g. `/var/www/torii/continuum/onboarding-preview/`.

```bash
tar xzf torii-continuum-onboarding-preview-v0.1.0.tar.gz \
    -C /var/www/torii/continuum/
mv /var/www/torii/continuum/onboarding-v0.1.0 \
   /var/www/torii/continuum/onboarding-preview
```

Then browse to `https://chiefmonkey.art/continuum/onboarding-preview/`.

## Contents

- `index.html` — entry point
- `shared.css` — full design system
- `deck.js` — panel choreography
- `character.js` — Three.js GLB renderer
- `scenes/*.png` — five painterly backdrops
- `assets/chiefmonkey6.glb` — Chiefmonkey model (24 bones, 19 animations)
- `three-libs/draco/` — self-hosted Draco decoder (~756KB)

## Notes

Nothing here writes state, submits data, or contacts any backend.
It's a design mockup for interaction review only.

External runtime deps (dev only, for the preview build):
- `three@0.161.0` via esm.sh — production build should bundle Three
- Google/Fontshare fonts via CDN — production should self-host

Draco decoder IS self-hosted (`three-libs/draco/`) so no runtime CDN
fetches are needed for the character render.
