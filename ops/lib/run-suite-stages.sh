#!/usr/bin/env bash
# Run named Torii Suite stage installers on the VPS from the selected Suite tag.
# Called by .github/workflows/suite-stages-vps.yml over its host-key-pinned SSH,
# as root. Stages are an allowlist; with enable=1 the matching INSTALL_* flags
# are persisted to the operator .env first (so later bootstraps keep them).
# Output is masked by the caller (public logs). Never prints .env values.
set -euo pipefail
die() { printf 'suite stages: %s\n' "$*" >&2; exit 1; }
[[ $# == 3 ]] || die "usage: <suite tag> <stage,stage,...> <enable 0|1>"
tag="$1" stages="$2" enable="$3"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid release tag"
[[ "$enable" == 0 || "$enable" == 1 ]] || die "enable must be 0 or 1"
[[ "$stages" =~ ^[a-z_]+(,[a-z_]+)*$ ]] || die "invalid stage list"
checkout=/opt/torii-suite/checkout
env_file="$checkout/.env"
[[ -f "$env_file" && ! -L "$env_file" ]] || die "no operator .env"
head="$(git -C "$checkout" rev-parse HEAD)"
want="$(git -C "$checkout" rev-parse --verify "refs/tags/$tag^{commit}")" || die "tag not fetched; select it first"
[[ "$head" == "$want" ]] || die "Suite checkout is not at $tag"
[[ "$(cat "$checkout/VERSION")" == "$tag" ]] || die "VERSION disagrees with $tag"

declare -A INSTALLER=(
  [fips]=install-fips.sh
  [teams]=install-teams.sh
  [continuum_host]=install-continuum-host.sh
  [teams_app]=install-teams-app.sh
  [auctions]=install-auctions.sh
)
declare -A FLAG=([teams]=INSTALL_TEAMS [continuum_host]=INSTALL_CONTINUUM_HOST [teams_app]=INSTALL_TEAMS_APP [auctions]=INSTALL_AUCTIONS)
IFS=, read -r -a list <<< "$stages"
for s in "${list[@]}"; do [[ -n "${INSTALLER[$s]:-}" ]] || die "unknown stage: $s"; done

set_env() { # KEY VALUE: replace or append, keeping owner and mode
  local k="$1" v="$2"
  if grep -q "^${k}=" "$env_file"; then sed -i "s|^${k}=.*|${k}=${v}|" "$env_file"
  else printf '%s=%s\n' "$k" "$v" >> "$env_file"; fi
}
if [[ "$enable" == 1 ]]; then
  for s in "${list[@]}"; do
    [[ -n "${FLAG[$s]:-}" ]] || continue
    set_env "${FLAG[$s]}" 1; echo "set ${FLAG[$s]}=1 in .env"
  done
fi

set -a; source "$env_file"; set +a
export SUITE_WORK_DIR="${SUITE_WORK_DIR:-/opt/torii-suite/work}" APPS_ROOT="${APPS_ROOT:-/apps}"
export TORII_RELAY_HOST="${TORII_RELAY_HOST-relay.${TORII_DOMAIN}}"
export TORII_TEAMS_HOST="${TORII_TEAMS_HOST-teams.${TORII_DOMAIN}}"
# Same derivation as bootstrap.sh (Suite v0.9.31).
if [[ "${INSTALL_CONTINUUM_HOST:-0}" == 1 ]]; then
  export CONTINUUM_HOST="${CONTINUUM_HOST:-continuum.${TORII_DOMAIN}}"
else
  export CONTINUUM_HOST=""
fi
for s in "${list[@]}"; do
  echo "== stage ${s} (${INSTALLER[$s]}) from Suite ${tag}"
  bash "$checkout/installers/${INSTALLER[$s]}"
done
echo "== done: ${stages}"
