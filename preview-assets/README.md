# preview-assets

Interaction mockups for Continuum, kept in-repo so PRs land beside the
production code but never ship into the built app.

Each mockup lives under `onboarding-vX.Y.Z/`. Releases publish the
matching tarball under `releases/`.

Current preview: **v0.1.1-preview** (`onboarding-v0.1.1/`). Previous:
v0.1.0-preview (`onboarding-v0.1.0/`), kept for reference.

## Deploy a preview to chiefmonkey.art

    scp releases/torii-continuum-onboarding-preview-v0.1.1.tar.gz \
        root@chiefmonkey.art:/tmp/
    ssh root@chiefmonkey.art
    tar xzf /tmp/torii-continuum-onboarding-preview-v0.1.1.tar.gz \
        -C /var/www/torii/continuum/
    mv /var/www/torii/continuum/torii-continuum-onboarding-preview-v0.1.1 \
       /var/www/torii/continuum/onboarding-preview

Then browse https://chiefmonkey.art/continuum/onboarding-preview/

(Deploying to the VPS is a separate step handled by the user/main agent,
not performed as part of shipping this PR.)

## Not shipped in the built app

`vite.config.js` should exclude `preview-assets/` from the production
build. This folder is source-of-truth for design review only.
