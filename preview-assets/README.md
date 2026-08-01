# preview-assets

Interaction mockups for Continuum, kept in-repo so PRs land beside the
production code but never ship into the built app.

Each mockup lives under `onboarding-vX.Y.Z/` and is self-contained (its own
`VERSION`, assets, and vendored `three-libs/`). The version directory itself is
the shippable artifact and is copied directly.

Current preview: **v0.1.22-preview** (`onboarding-v0.1.22/`).

## Retention policy (added v0.1.22)

Only the **current** preview and the **previous** one are kept in the working
tree. `onboarding-v0.1.0` … `onboarding-v0.1.20` and the obsolete `releases/`
tarballs (superseded at v0.1.12, when the version directory became the
artifact) were removed at v0.1.22, taking `preview-assets/` from **378 MB to
13 MB**. Nothing is lost: every removed version is still reachable from its
annotated release tag, e.g.

    git show v0.2.100-alpha:preview-assets/onboarding-v0.1.21/VERSION
    git checkout v0.2.100-alpha -- preview-assets/onboarding-v0.1.21

When a new preview lands, delete the one that is now two behind in the same PR.

## Audience note (added v0.1.22)

This deck is deliberately **not** wired into the main Continuum login. Its
graphic-novel look suits Torii Quest players and gamers; the Continuum audience
— people building communities, websites and Bitcoin commerce — needs a plainer
onboarding. Treat this directory as a separate guided path, not as the future
production sign-in screen.

## Deploy a preview to chiefmonkey.art

**Live layout (verified on the box, 2026-08-01):** `/var/www/torii/onboarding-preview`
is a **symlink** to a timestamped directory under
`/var/www/torii/onboarding-preview-releases/`. Deploys stage a new release
directory and atomically flip the symlink; the previous target is kept for one
generation so a rollback is a single `ln -sfn`. Public URL:
<https://chiefmonkey.art/onboarding-preview/>.

Do not deploy by hand and do not rsync over the live path. Use the audited
operator script, which verifies the annotated tag and the shipped VERSION/CTA
before it mutates anything, preserves the layout type on swap, and probes the
live URL afterwards with automatic rollback on failure:

    sudo bash ops/torii-final-cutover.sh        # DRY_RUN=1 first

(Deploying to the VPS is a separate step handled by the user/main agent, not
performed as part of shipping a PR.)

## Not shipped in the built app

`vite.config.js` should exclude `preview-assets/` from the production build.
This folder is source-of-truth for design review only.
