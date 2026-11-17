# The Continuum logo: the wave through the torii

Date: 2026-11-17. Status: **Accepted** 2026-11-17 after the local review ("Accept, ship and deploy Continuum v0.2.213-alpha"). Request (owner, 2026-11-16/17: "these
shisa are really the logo for teams... I'd also like to work on another logo
for just continuum... with a Japanese theme"; chose concept 2, colourway 2C,
"with the dark top"; "apply that and the favicon where needed").
Target: Continuum `v0.2.213-alpha`. No Suite or Teams change.

## Context

- The sidebar brand tile shows a torii glyph (U+26E9) in an amber tile.
- Continuum shows a hand-drawn torii SVG (`toriiSvg()` in
  `src/views/landing.js`, about 185 lines) on the sign-in card and the About
  hero. The favicon is a separate torii SVG.
- The painted shisa pair is the Teams logo (Teams ADR 0014), so Continuum
  needs its own mark in the same painted style.
- Continuum is 連続体 (renzokutai), "a continuous body". An endless wave
  (seigaiha pattern) looping through the gate says the same thing.

## Decision

1. **The logo.** A painted torii with a dark purple top bar, orange-to-purple
   pillars and purple bases, with an endless seigaiha wave ribbon looping
   through it, purple at the back and tangerine at the front. It ships as one
   bundled `src/assets/continuum-logo.webp`, 440x278 (2x for a 220 px card),
   at most 40 KB, with transparency.
2. **Where it shows.** The sign-in card (220 px wide, 184 px on phones) and
   the About hero (300 px, 230 px on narrow screens), replacing the drawn torii.
   The sidebar brand tile shows the favicon image (34 px) instead of the
   torii glyph, reusing the same cached file. All three are decorative (`alt=""`, `aria-hidden`); the wordmark and
   headings carry the name.
3. **The favicon.** A flat version of the same shape (thick torii, dark top
   bar, one gradient ribbon, no scale pattern) so it reads at 16 px. It stays
   at `/favicon.svg` as one embedded 48 px PNG, at most 6.5 KB, no outside
   requests.
4. **Removed.** `toriiSvg()` and its CSS (`.landing-torii*`, `.login-mark`)
   have no other callers and are deleted.

## Consequences

- The JS bundle drops the SVG builder; the image loads once and is cached.
- The flat favicon simplifies the logo; at 16 px it reads as a coloured
  torii shape rather than showing the wave pattern.
- Teams keeps the shisa pair as its own logo and favicon.

## Tests

`src/continuum-logo.test.js`: both views import the logo and not
`toriiSvg`; the old SVG and CSS are gone; WebP header, alpha, 440x278 and
size cap; the sidebar uses the favicon image; favicon is one bundled 48 px PNG under the cap.
