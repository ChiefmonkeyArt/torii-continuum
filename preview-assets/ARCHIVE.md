# Preview archive index (FE-01)

The historical onboarding previews and their release tarballs have been
removed from the **working tree** to keep checkouts lean, but remain fully
recoverable from Git history. This file records what was archived, its exact
scope, and how to restore it.

## What is archived

| Group | Versions | Approx. size |
|---|---|---|
| Historical snapshots | `onboarding-v0.1.0` – `onboarding-v0.1.20` | ~206 MB |
| Release tarballs + checksums | `releases/torii-continuum-onboarding-preview-v0.1.{0,1,3..11}.tar.gz` (+ `.sha256.txt`) | ~175 MB |

485 files / **381,496,875 bytes** total. Per-file SHA-256 and byte size are in
[`archive-manifest.tsv`](./archive-manifest.tsv).

## What is preserved (NOT archived)

- `onboarding-v0.1.21/` — the **current** preview (`0.1.21-preview`), hard-referenced
  by `ops/torii-final-cutover.sh` (`PREVIEW_DIR_NAME="onboarding-v0.1.21"`). Untouched.
- `README.md` and this index.

## Why

`preview-assets/` had grown to ~388 MB of design-review snapshots that never ship
into the built app (`vite.config.js` copies only `public/`; the release artifact
excludes previews). Removing the historical copies from the working tree is a
fail-safe cleanup — it does not reclaim existing Git history or already-published
release storage.

## Recovery

Everything here is preserved in Git history. Restore any version at its last
pre-archival commit, then verify against `archive-manifest.tsv`:

```sh
# e.g. restore the v0.1.12 snapshot at the last commit that carried it
git show a8ecdc6:preview-assets/onboarding-v0.1.12/index.html > /tmp/v012.html

# verify a restored file matches the recorded hash
sha256sum /tmp/v012.html   # compare to archive-manifest.tsv, row `onboarding-v0.1.12/index.html`
```

The recorded commit is the point these files were last present in the tree; the
Git object store retains them indefinitely.