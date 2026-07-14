# Chiefmonkey onboarding asset — source provenance

The production asset `../assets/chiefmonkey-onboarding.glb` is a build artifact
produced from an **uncompressed source GLB that is deliberately kept OUT of git**
(it is ~9.3 MB and is not needed at runtime). Only the optimized asset and its
manifest are committed.

## Source

- Source file: `chiefmonkey-onboarding.glb` (raw, uncompressed export)
- Source SHA-256: `87b0048c81115a7e3a728e9fc3b8a0bd4fc11bfae4499d99102be542009c37dd`
- Source size: 9,298,852 bytes

## Reproducing the optimized asset

From this `tools/` directory, with the source GLB available locally:

```sh
npm install            # installs the pinned optimizer deps (see package.json)
node optimize-glb.mjs /path/to/chiefmonkey-onboarding.glb
```

This writes `../assets/chiefmonkey-onboarding.glb` and its `.manifest.json`.
The pipeline is deterministic: given the same source bytes it produces
byte-identical output, so the committed asset's SHA-256 must match the manifest:

- Optimized SHA-256: `0253d5e11c389d00144229085d6569306a4a68613395b35736f4d2793e9e2fcb`
- Optimized size: 2,347,780 bytes (74.75% smaller than source)

The test suite re-verifies this SHA + size budget against the committed asset,
so a non-reproducible or bloated rebuild fails CI.

## Pipeline (see `optimize-glb.mjs`)

`dedup → weld → resample → textureCompress(webp, q82, ≤1024²) → dedup → prune →
draco(edgebreaker)`, plus dropping every forbidden locomotion / knock-down clip
using the runtime's own `isForbiddenClip` predicate (imported from
`../onboarding-client.js` — single source of truth). No third-party runtime CDN
is introduced: Draco decodes via the vendored wasm decoder under
`../three-libs/draco/`, and WebP is decoded by the browser natively.
