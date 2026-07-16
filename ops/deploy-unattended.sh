#!/usr/bin/env bash
#
# Torii Continuum — unattended deploy wrapper (OPS-DEPLOY-2, v0.2.50-alpha).
#
# WHY THIS EXISTS
# ---------------
# Local-device automation cannot make outbound SSH, and interactive VPS SSH
# prompts for a password, so a PUSH deploy is not viable. This wrapper is the
# SERVER-SIDE PULL half: a small, auditable, root-owned orchestrator that a
# systemd timer (or a narrowly-sudo'd deploy principal) invokes on the box. It
# does NOT reimplement the deploy — it validates a target tag and then delegates
# to the already-hardened Ansible `continuum` role, which owns state backup, the
# atomic staging→swap cutover, the version-asserting health gate, rescue
# rollback, quarantine cleanup, and secret hygiene.
#
# The unattended path is VAULT-FREE and preserves config.yaml / session_secret /
# the funded Routstr key byte-for-byte (the role detects `existing-ansible` and
# never rotates secrets). No secret is read, written, or logged here.
#
# FAIL-CLOSED. Every guard that cannot be satisfied aborts before any mutation.
#
# SOURCEABLE: sourcing this file only defines constants + functions (the test
# suite sources it and calls the pure functions in-process). The side-effecting
# deploy runs only when the file is executed directly.
#
# Config is read from /etc/torii/continuum-deploy.conf (root-owned, 0600):
#   CONTINUUM_TARGET_TAG=v0.2.50-alpha        # required (or pass as $1)
#   CONTINUUM_DOMAIN=example.com               # required
#   CONTINUUM_REPO=https://github.com/ChiefmonkeyArt/torii-continuum.git
#   CONTINUUM_REQUIRE_SIGNED_TAGS=0            # 1 = require `git tag -v` (recommended)
#   CONTINUUM_ALLOWLIST_FILE=/etc/torii/continuum-deploy.allow  # optional
#   CONTINUUM_HEALTH_URL=http://127.0.0.1:8787/api/health
#   CONTINUUM_DEPLOY_ROOT=/opt/deploy
#   CONTINUUM_KEEP_RELEASES=3
#   CONTINUUM_GNUPGHOME=/etc/torii/deploy-gnupg   # keyring for signed-tag checks

set -euo pipefail

# ── Constants / defaults (overridable via the config file or environment) ─────
: "${CONTINUUM_CONF:=/etc/torii/continuum-deploy.conf}"
: "${CONTINUUM_REPO:=https://github.com/ChiefmonkeyArt/torii-continuum.git}"
: "${CONTINUUM_REQUIRE_SIGNED_TAGS:=0}"
: "${CONTINUUM_ALLOWLIST_FILE:=}"
: "${CONTINUUM_HEALTH_URL:=http://127.0.0.1:8787/api/health}"
: "${CONTINUUM_DEPLOY_ROOT:=/opt/deploy}"
: "${CONTINUUM_KEEP_RELEASES:=3}"
: "${CONTINUUM_GNUPGHOME:=}"
: "${CONTINUUM_LOCKFILE:=/run/torii-continuum-deploy.lock}"

# Strict release-tag grammar: a v-prefixed semver with an optional pre-release
# suffix of [0-9A-Za-z.-]. This is the FIRST line of defence — it rejects
# branches, commit SHAs, and every shell/YAML metacharacter, so a validated tag
# is safe to interpolate into git args and group_vars YAML.
readonly CONTINUUM_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

dep_log() { printf '[deploy-unattended] %s\n' "$*"; }
dep_die() { printf '[deploy-unattended] FATAL: %s\n' "$*" >&2; exit 1; }

# validate_tag <tag> — 0 iff the tag matches the strict release grammar.
validate_tag() {
  local tag="${1:-}"
  [[ -n "$tag" ]] || return 1
  [[ "$tag" =~ $CONTINUUM_TAG_RE ]]
}

# version_matches <target-tag> <live-version> — 0 iff live == target with a
# single leading "v" stripped from the target. Mirrors the role's health gate.
version_matches() {
  local want="${1#v}" live="${2:-}"
  [[ -n "$live" && "$live" == "$want" ]]
}

# tag_allowed <tag> <allowlist-file> — policy for the optional allowlist.
#   - no file configured        → allowed (allowlist is opt-in)
#   - file configured + present  → tag must appear as its own line
#   - file configured + missing  → DENY (fail-closed: a broken allowlist path
#     must never silently widen what may deploy)
tag_allowed() {
  local tag="${1:-}" file="${2:-}"
  [[ -n "$file" ]] || return 0
  [[ -f "$file" ]] || return 1
  grep -qxF -- "$tag" "$file"
}

# live_version <health-url> — best-effort live agent version, empty on any
# failure. Never fails the caller; the caller decides what an empty means.
live_version() {
  local url="${1:-$CONTINUUM_HEALTH_URL}" body=''
  body="$(curl -fsS --max-time 5 -- "$url" 2>/dev/null || true)"
  [[ -n "$body" ]] || { printf ''; return 0; }
  # Extract the "version" field without assuming jq is installed.
  printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# verify_signed_tag <repo-dir> <tag> — 0 iff `git tag -v` validates the tag's
# GPG signature against the configured keyring. Fail-closed if git/gpg cannot run.
verify_signed_tag() {
  local repo="${1:?}" tag="${2:?}"
  local -a env=()
  [[ -n "$CONTINUUM_GNUPGHOME" ]] && env=(env "GNUPGHOME=$CONTINUUM_GNUPGHOME")
  "${env[@]}" git -C "$repo" tag -v -- "$tag" >/dev/null 2>&1
}

# load_conf — source the root-owned config file if present. It must be a plain
# KEY=value file; it is sourced, so it must be root-owned and 0600 (the wrapper
# and bootstrap enforce this).
load_conf() {
  local conf="${1:-$CONTINUUM_CONF}"
  if [[ -f "$conf" ]]; then
    # shellcheck disable=SC1090
    source "$conf"
  fi
}

# write_localhost_inventory <dir> <domain> <tag> — render the vault-free,
# localhost, SSH-less inventory + non-secret vars the `existing-ansible`
# redeploy needs. The tag is already regex-validated, so quoting it is belt.
write_localhost_inventory() {
  local dir="${1:?}" domain="${2:?}" tag="${3:?}"
  cat > "$dir/inventory.yml" <<YAML
all:
  children:
    torii:
      hosts:
        localhost:
          ansible_connection: local
YAML
  mkdir -p "$dir/group_vars"
  cat > "$dir/group_vars/all.yml" <<YAML
torii_domain: "${domain}"
continuum_version: "${tag}"
YAML
}

# prune_releases <deploy-root> <keep> <live-tag> — keep the newest <keep>
# torii-continuum-* release dirs; NEVER remove the currently-live one. Best
# effort: a prune failure is logged, not fatal (cleanup must not break deploys).
prune_releases() {
  local root="${1:?}" keep="${2:?}" live_tag="${3:-}"
  [[ -d "$root" ]] || return 0
  local -a dirs=()
  local d
  # Newest-first by mtime.
  while IFS= read -r d; do dirs+=("$d"); done < <(
    find "$root" -maxdepth 1 -type d -name 'torii-continuum-*' -printf '%T@\t%p\n' \
      2>/dev/null | sort -rn | cut -f2-
  )
  local kept=0
  for d in "${dirs[@]}"; do
    if [[ -n "$live_tag" && "$d" == *"/torii-continuum-${live_tag}" ]]; then
      continue  # never prune the live release
    fi
    kept=$((kept + 1))
    if (( kept > keep )); then
      rm -rf -- "$d" && dep_log "pruned old release ${d}" || dep_log "WARN could not prune ${d}"
    fi
  done
}

# run_deploy [tag] — the full side-effecting deploy. Fail-closed at every guard.
run_deploy() {
  load_conf

  local tag="${1:-${CONTINUUM_TARGET_TAG:-}}"
  local domain="${CONTINUUM_DOMAIN:-}"

  [[ "$(id -u)" -eq 0 ]] || dep_die "must run as root (installs code + runs the role)."
  [[ -n "$tag" ]]        || dep_die "no target tag: set CONTINUUM_TARGET_TAG in ${CONTINUUM_CONF} or pass it as an argument."
  [[ -n "$domain" ]]     || dep_die "no domain: set CONTINUUM_DOMAIN in ${CONTINUUM_CONF}."

  validate_tag "$tag" \
    || dep_die "target '${tag}' is not a valid v<semver> release tag (branches/SHAs are refused by policy)."
  tag_allowed "$tag" "$CONTINUUM_ALLOWLIST_FILE" \
    || dep_die "target '${tag}' is not in the allowlist ${CONTINUUM_ALLOWLIST_FILE}."

  # Idempotent no-op: if the live agent already serves this version, do nothing.
  local live; live="$(live_version "$CONTINUUM_HEALTH_URL")"
  if version_matches "$tag" "$live"; then
    dep_log "already at ${tag} (live=${live}); nothing to do."
    return 0
  fi
  dep_log "target=${tag} live=${live:-<none>}; proceeding."

  command -v git >/dev/null            || dep_die "git not found."
  command -v ansible-playbook >/dev/null || dep_die "ansible-playbook not found."

  local src="${CONTINUUM_DEPLOY_ROOT}/torii-continuum-${tag}"
  mkdir -p "$CONTINUUM_DEPLOY_ROOT"

  # Fresh, version-specific checkout. A pre-existing dir for this tag is reused
  # only if it is a clean git tree at the tag; otherwise it is replaced so a
  # half-clone can never be deployed.
  if [[ -d "$src/.git" ]]; then
    dep_log "reusing existing checkout ${src}"
    git -C "$src" fetch --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}" >/dev/null 2>&1 || true
    git -C "$src" checkout -q "tags/${tag}" -- 2>/dev/null || dep_die "cannot checkout tag ${tag} in ${src}."
  else
    rm -rf -- "$src"
    dep_log "cloning ${tag} into ${src}"
    git clone --depth 1 --branch "$tag" -- "$CONTINUUM_REPO" "$src" >/dev/null 2>&1 \
      || dep_die "git clone of tag ${tag} failed."
  fi

  # Optional supply-chain gate: require a valid signed tag.
  if [[ "$CONTINUUM_REQUIRE_SIGNED_TAGS" == "1" ]]; then
    verify_signed_tag "$src" "$tag" \
      || dep_die "signed-tag verification failed for ${tag} (CONTINUUM_REQUIRE_SIGNED_TAGS=1)."
    dep_log "signed-tag verification OK for ${tag}."
  else
    dep_log "WARN signed-tag verification is OFF (set CONTINUUM_REQUIRE_SIGNED_TAGS=1 once a signing key is configured)."
  fi

  local ans="${src}/ops/ansible"
  [[ -f "${ans}/site.yml" ]] || dep_die "checkout is missing ops/ansible/site.yml."
  write_localhost_inventory "$ans" "$domain" "$tag"

  # Delegate to the hardened role. It performs: fail-closed state backup,
  # staging build, atomic swap, restart-before-readiness, version-asserting
  # health gate, and rescue rollback on failure. Vault-free → no secret touched.
  dep_log "running existing-ansible redeploy (--tags continuum) for ${tag}"
  ( cd "$ans" && ansible-playbook -i inventory.yml site.yml --tags continuum )

  # Independent post-verify on top of the role's own gate (belt-and-suspenders).
  local now; now="$(live_version "$CONTINUUM_HEALTH_URL")"
  version_matches "$tag" "$now" \
    || dep_die "post-deploy health check: live version '${now}' != target '${tag}'."
  dep_log "post-deploy health OK: live=${now}."

  prune_releases "$CONTINUUM_DEPLOY_ROOT" "$CONTINUUM_KEEP_RELEASES" "$tag"
  dep_log "deploy of ${tag} complete."
}

# ── CLI dispatcher (runs only when executed directly, not when sourced) ───────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # Serialize concurrent triggers (timer + manual) with an flock on a fd.
  exec 9>"$CONTINUUM_LOCKFILE" 2>/dev/null || true
  if command -v flock >/dev/null && [[ -e "$CONTINUUM_LOCKFILE" ]]; then
    flock -n 9 || dep_die "another deploy is already running (lock ${CONTINUUM_LOCKFILE})."
  fi
  run_deploy "${1:-}"
fi
