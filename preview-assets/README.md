# preview-assets

Interaction mockups for Continuum, kept in-repo so PRs land beside the
production code but never ship into the built app.

Each mockup lives under `onboarding-vX.Y.Z/` and is self-contained (its own
`VERSION`, assets, and vendored `three-libs/`). Early releases (≤ v0.1.11) also
published a matching tarball under `releases/`; since v0.1.12 the version
directory itself is the shippable artifact and is copied directly.

Current preview: **v0.1.21-preview** (`onboarding-v0.1.21/`). Earlier
versions (`onboarding-v0.1.0/` … `onboarding-v0.1.20/`) are kept for reference.

## Deploy a preview to chiefmonkey.art

The version directory is the artifact — copy it and flip the
`onboarding-preview` name onto it:

    rsync -a --delete onboarding-v0.1.21/ \
        root@chiefmonkey.art:/var/www/torii/continuum/onboarding-preview.next/
    ssh root@chiefmonkey.art \
        'mv /var/www/torii/continuum/onboarding-preview{,.prev} 2>/dev/null; \
         mv /var/www/torii/continuum/onboarding-preview{.next,}'

Then browse https://chiefmonkey.art/continuum/onboarding-preview/

(Deploying to the VPS is a separate step handled by the user/main agent,
not performed as part of shipping this PR.)

## Not shipped in the built app

`vite.config.js` should exclude `preview-assets/` from the production
build. This folder is source-of-truth for design review only.
