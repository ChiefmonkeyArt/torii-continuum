# preview-assets

Interaction mockups for Continuum, kept in-repo so PRs land beside the
production code but never ship into the built app.

Each mockup lives under `onboarding-vX.Y.Z/`. Releases publish the
matching tarball under `releases/`.

## Deploy a preview to chiefmonkey.art

    scp releases/torii-continuum-onboarding-preview-v0.1.0.tar.gz \
        root@chiefmonkey.art:/tmp/
    ssh root@chiefmonkey.art
    tar xzf /tmp/torii-continuum-onboarding-preview-v0.1.0.tar.gz \
        -C /var/www/torii/continuum/
    mv /var/www/torii/continuum/onboarding-v0.1.0 \
       /var/www/torii/continuum/onboarding-preview

Then browse https://chiefmonkey.art/continuum/onboarding-preview/

## Not shipped in the built app

`vite.config.js` should exclude `preview-assets/` from the production
build. This folder is source-of-truth for design review only.
