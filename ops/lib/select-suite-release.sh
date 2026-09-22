#!/usr/bin/env bash
# Select an explicitly requested, merged Suite release on the existing VPS.
# Called by the deployment workflow over its host-key-pinned SSH connection.
# No secret/config reads, forced checkout, tag rewrites, or arbitrary commands.
set -euo pipefail
die() { printf 'suite release selection: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die "one release tag is required"
tag="$1"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid release tag"
checkout=/opt/torii-suite/checkout
remote="$(git -C "$checkout" remote get-url origin)"
[[ "$remote" == https://github.com/ChiefmonkeyArt/torii-suite ||
   "$remote" == https://github.com/ChiefmonkeyArt/torii-suite.git ]] || die "unexpected Suite origin"
[[ -z "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]] ||
  die "tracked local edits present; refusing to overwrite them"
# No leading '+' on either refspec: non-fast-forward main or a moved tag fails.
git -C "$checkout" fetch --no-tags origin \
  refs/heads/main:refs/remotes/origin/main "refs/tags/$tag:refs/tags/$tag"
commit="$(git -C "$checkout" rev-parse --verify "refs/tags/$tag^{commit}")"
git -C "$checkout" merge-base --is-ancestor "$commit" refs/remotes/origin/main ||
  die "release is not merged into Suite main"
version="$(git -C "$checkout" show "$commit:VERSION")"
[[ "$version" == "$tag" ]] || die "release tag and VERSION disagree"
# .env is ignored operator state, not touched by checkout; untracked collisions
# are rejected by git itself. Never use --force, reset, clean, or a wildcard ref.
git -C "$checkout" checkout --detach "$commit"
printf 'Selected Suite %s at %s\n' "$tag" "$commit"
