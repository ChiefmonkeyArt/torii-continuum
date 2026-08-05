#!/usr/bin/env bash
#
# Torii Continuum — unattended deploy wrapper (OPS-CUTOVER-3, v0.2.61-alpha).
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
# OPS-CUTOVER-3 (v0.2.61-alpha) — ROLE-VAR RESOLUTION FIX
# ------------------------------------------------------
# A live v0.2.59-alpha unattended run failed at the FIRST role task with
# `continuum_user is undefined`. Root cause: manual installs copy
# group_vars/all.yml.example → group_vars/all.yml (gitignored) to supply the
# role's structural identity vars, but this server-side pull never created that
# file — it only wrote a two-key group_vars/all.yml (torii_domain +
# continuum_version), so continuum_user / continuum_repo / continuum_agent_host /
# continuum_agent_port / continuum_mount_path / continuum_vite_agent_url were all
# undefined on a pristine tagged checkout.
#
# Two-part fix:
#   1. The role now ships those structural, non-secret vars as role defaults
#      (ops/ansible/roles/continuum/defaults/main.yml), so a pristine checkout
#      converges with NO group_vars/all.yml at all.
#   2. This wrapper NO LONGER writes a gitignored group_vars/all.yml. The only
#      truly per-host, non-secret values (torii_domain, continuum_version, and
#      continuum_repo for provenance) are passed EXPLICITLY and deterministically
#      via a validated `-e @extra-vars.json` file — the highest-precedence,
#      unambiguous Ansible input. All three inputs are strictly validated before
#      being written, so the JSON cannot be injected into.
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
#   CONTINUUM_DEPLOY_MODE=artifact              # artifact (default, fast) | source-build
#   CONTINUUM_ALLOW_SOURCE_FALLBACK=0           # 1 = fall back to source-build on artifact failure
#
# OPS-ARTIFACT-1 (v0.2.103-alpha) — RELEASE-ARTIFACT FAST PATH
# --------------------------------------------------------------
# Historically this wrapper only cloned the small ops/ansible tooling checkout
# and delegated the SLOW work (SPA build, two npm ci passes) to the Ansible
# role, which repeated that work on every single upgrade. Now, in the default
# 'artifact' mode, this wrapper ALSO downloads the CI-built release tarball
# (dist/ + agent source + agent's already-installed production node_modules)
# from the GitHub Release for the target tag, verifies its checksum against
# the co-published .sha256 sidecar, and hands the verified local path to the
# role via the extra-vars file. The role then just extracts it — no clone, no
# npm, no build, on the VPS. FAIL CLOSED: a missing asset or checksum mismatch
# aborts before Ansible ever runs, unless CONTINUUM_ALLOW_SOURCE_FALLBACK=1.

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
: "${CONTINUUM_DEPLOY_MODE:=artifact}"
: "${CONTINUUM_ALLOW_SOURCE_FALLBACK:=0}"
: "${CONTINUUM_ARTIFACT_CACHE:=/opt/deploy/artifacts}"
: "${CONTINUUM_GITHUB_API:=https://api.github.com}"

# Directory this script lives in, so the co-located verify library resolves
# correctly regardless of the caller's cwd (systemd unit, manual invocation,
# or test harness sourcing this file from a different directory).
CONTINUUM_WRAPPER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly CONTINUUM_WRAPPER_DIR
readonly CONTINUUM_ARTIFACT_VERIFY_LIB="${CONTINUUM_WRAPPER_DIR}/lib/artifact-verify.sh"

# Strict release-tag grammar: a v-prefixed semver with an optional pre-release
# suffix of [0-9A-Za-z.-]. This is the FIRST line of defence — it rejects
# branches, commit SHAs, and every shell/YAML metacharacter, so a validated tag
# is safe to interpolate into git args and group_vars YAML.
readonly CONTINUUM_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# Strict DNS-name grammar for the domain, and a strict https(.git) grammar for
# the repo URL. OPS-CUTOVER-3: these two values plus the tag are the only inputs
# interpolated into the -e extra-vars JSON handed to Ansible, so each is pinned
# to an alphabet that contains no quote, brace, backslash, or shell/JSON
# metacharacter. A validated value is therefore safe to embed verbatim.
readonly CONTINUUM_DOMAIN_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
readonly CONTINUUM_REPO_RE='^https://[A-Za-z0-9._~/-]+\.git$'

dep_log() { printf '[deploy-unattended] %s\n' "$*"; }
dep_die() { printf '[deploy-unattended] FATAL: %s\n' "$*" >&2; exit 1; }

# validate_tag <tag> — 0 iff the tag matches the strict release grammar.
validate_tag() {
  local tag="${1:-}"
  [[ -n "$tag" ]] || return 1
  [[ "$tag" =~ $CONTINUUM_TAG_RE ]]
}

# validate_domain <domain> — 0 iff the domain matches the strict DNS grammar.
validate_domain() {
  local d="${1:-}"
  [[ -n "$d" ]] || return 1
  [[ "$d" =~ $CONTINUUM_DOMAIN_RE ]]
}

# validate_repo <url> — 0 iff the repo URL is a plain https://…​.git with no
# metacharacters. Refuses ssh://, git://, file://, and any embedded shell/JSON
# special so it is safe to interpolate.
validate_repo() {
  local u="${1:-}"
  [[ -n "$u" ]] || return 1
  [[ "$u" =~ $CONTINUUM_REPO_RE ]]
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

# write_localhost_inventory <dir> — render the vault-free, localhost, SSH-less
# inventory the `existing-ansible` redeploy runs against.
#
# OPS-CUTOVER-3: this deliberately does NOT write group_vars/all.yml. The role's
# structural identity vars are now self-sufficient defaults, and the per-host
# values are supplied via write_extra_vars() below (an -e file, which outranks
# both defaults and any group_vars). Writing a gitignored group_vars/all.yml here
# was the fragile, incomplete path that caused the `continuum_user is undefined`
# failure, so it is gone.
write_localhost_inventory() {
  local dir="${1:?}"
  cat > "$dir/inventory.yml" <<YAML
all:
  children:
    torii:
      hosts:
        localhost:
          ansible_connection: local
YAML
}

# write_extra_vars <path> <domain> <version-tag> <repo> [artifact-path] [deploy-mode] [allow-fallback] —
# emit the deterministic, non-secret extra-vars JSON passed to ansible-playbook
# as `-e @<path>`. Only the per-host values live here; every structural var
# comes from role defaults. All string inputs are strictly pre-validated
# (validate_domain/validate_tag/validate_repo) before this is called, so
# verbatim interpolation is injection-safe. continuum_version carries the
# leading "v" exactly as the tag; the role strips it where a bare semver is
# needed. No secret is ever written here. artifact-path is either an absolute
# filesystem path with no shell/JSON metacharacters (produced by this same
# script, never user input) or empty.
write_extra_vars() {
  local path="${1:?}" domain="${2:?}" tag="${3:?}" repo="${4:?}"
  local artifact_path="${5:-}" deploy_mode="${6:-artifact}" allow_fallback="${7:-false}"
  cat > "$path" <<JSON
{
  "torii_domain": "${domain}",
  "continuum_version": "${tag}",
  "continuum_repo": "${repo}",
  "continuum_artifact_path": "${artifact_path}",
  "continuum_deploy_mode": "${deploy_mode}",
  "continuum_deploy_allow_source_fallback": ${allow_fallback}
}
JSON
}

# ── Release-artifact download (OPS-ARTIFACT-1) ───────────────────────────────

# artifact_repo_slug <https-git-url> — "Owner/Repo" from a validated
# https://github.com/Owner/Repo.git URL, for building the Releases API path.
# Returns empty (caller must treat as "cannot resolve") for any non-GitHub
# host — the fast path is GitHub-Releases-specific; other hosts fall back to
# source-build automatically since no artifact can be located for them.
artifact_repo_slug() {
  local url="${1:?}"
  [[ "$url" =~ ^https://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)\.git$ ]] || { printf ''; return 0; }
  printf '%s' "${BASH_REMATCH[1]}"
}

# download_release_artifact <repo-url> <tag> <cache-dir> — downloads the three
# published release assets (tarball, .sha256, .manifest.json) for <tag> into
# <cache-dir>, verifies checksum + manifest immediately, and prints the local
# tarball path on stdout on success. Returns non-zero (prints nothing) on ANY
# failure: unresolvable repo host, missing release, missing asset, network
# error, checksum mismatch, or manifest/tag mismatch — the caller decides
# whether that is fatal or a trigger for the source-build fallback. Never
# retries indefinitely; a single attempt per asset, fail closed.
download_release_artifact() {
  local repo_url="${1:?}" tag="${2:?}" cache_dir="${3:?}"
  local slug; slug="$(artifact_repo_slug "$repo_url")"
  if [[ -z "$slug" ]]; then
    dep_log "artifact download: repo '${repo_url}' is not a plain https://github.com/OWNER/REPO.git URL; cannot resolve a Releases API path." >&2
    return 1
  fi
  command -v curl >/dev/null || { dep_log "artifact download: curl not found." >&2; return 1; }

  mkdir -p "$cache_dir"
  local tarball="${cache_dir}/torii-continuum-${tag}.tar.gz"
  local sumfile="${tarball}.sha256"
  local manifest="${cache_dir}/torii-continuum-${tag}.manifest.json"

  # Reuse a cached artifact only if it already passes verification (handles
  # re-runs/retries without re-downloading; never trusts a cache hit blindly).
  if [[ -f "$tarball" && -f "$sumfile" && -f "$manifest" ]]; then
    # shellcheck disable=SC1090
    if ( source "$CONTINUUM_ARTIFACT_VERIFY_LIB" 2>/dev/null && \
         artifact_verify_checksum "$tarball" "$sumfile" && \
         artifact_verify_manifest "$manifest" "$tag" ) >/dev/null 2>&1; then
      dep_log "artifact download: reusing already-verified cached artifact for ${tag}." >&2
      printf '%s' "$tarball"
      return 0
    fi
    dep_log "artifact download: cached artifact for ${tag} failed verification; re-downloading." >&2
    rm -f -- "$tarball" "$sumfile" "$manifest"
  fi

  local api="${CONTINUUM_GITHUB_API}/repos/${slug}/releases/tags/${tag}"
  dep_log "artifact download: querying release metadata (${api})" >&2
  local release_json
  release_json="$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github+json' -- "$api" 2>/dev/null || true)"
  if [[ -z "$release_json" ]]; then
    dep_log "artifact download: no GitHub Release found for ${tag} (or API unreachable)." >&2
    return 1
  fi

  local asset
  for asset in "torii-continuum-${tag}.tar.gz" "torii-continuum-${tag}.tar.gz.sha256" "torii-continuum-${tag}.manifest.json"; do
    local dl_url
    dl_url="$(printf '%s' "$release_json" | sed -n "s/.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\\([^\"]*${asset}\\)\".*/\\1/p" | head -1)"
    if [[ -z "$dl_url" ]]; then
      dep_log "artifact download: release ${tag} has no '${asset}' asset." >&2
      return 1
    fi
    local dest="${cache_dir}/${asset}"
    dep_log "artifact download: fetching ${asset}" >&2
    if ! curl -fsSL --max-time 120 -o "${dest}.part" -- "$dl_url" 2>/dev/null; then
      dep_log "artifact download: failed to fetch ${asset} from ${dl_url}." >&2
      rm -f -- "${dest}.part"
      return 1
    fi
    mv -f -- "${dest}.part" "$dest"
  done

  # shellcheck disable=SC1090
  source "$CONTINUUM_ARTIFACT_VERIFY_LIB"
  if ! artifact_verify_checksum "$tarball" "$sumfile"; then
    dep_log "artifact download: checksum verification FAILED for ${tag}." >&2
    return 1
  fi
  if ! artifact_verify_manifest "$manifest" "$tag"; then
    dep_log "artifact download: manifest verification FAILED for ${tag}." >&2
    return 1
  fi
  dep_log "artifact download: verified OK for ${tag} (${tarball})." >&2
  printf '%s' "$tarball"
  return 0
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
  validate_domain "$domain" \
    || dep_die "domain '${domain}' is not a valid DNS name (refused before it reaches Ansible)."
  validate_repo "$CONTINUUM_REPO" \
    || dep_die "repo '${CONTINUUM_REPO}' is not a plain https://…​.git URL (refused by policy)."
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
  write_localhost_inventory "$ans"

  # ── Release-artifact fast path (default) ────────────────────────────────
  # Download + verify the CI-built tarball BEFORE Ansible ever runs, so a
  # missing/tampered artifact is caught here (with a clear log line) rather
  # than deep inside the role. The role independently re-verifies the same
  # artifact (defence in depth) before ever extracting it into staging.
  local artifact_path="" deploy_mode="$CONTINUUM_DEPLOY_MODE" allow_fallback="false"
  [[ "$CONTINUUM_ALLOW_SOURCE_FALLBACK" == "1" ]] && allow_fallback="true"

  if [[ "$deploy_mode" == "artifact" ]]; then
    dep_log "artifact mode: attempting release-artifact fast path for ${tag}."
    if artifact_path="$(download_release_artifact "$CONTINUUM_REPO" "$tag" "$CONTINUUM_ARTIFACT_CACHE")"; then
      dep_log "artifact mode: using verified artifact ${artifact_path}."
    else
      artifact_path=""
      if [[ "$allow_fallback" == "true" ]]; then
        dep_log "WARN artifact download/verification failed for ${tag}; falling back to source-build (CONTINUUM_ALLOW_SOURCE_FALLBACK=1)."
        deploy_mode="source-build"
      else
        dep_die "artifact download/verification failed for ${tag} and CONTINUUM_ALLOW_SOURCE_FALLBACK is not set; refusing to silently fall back to a slow source build. Publish the release-artifact workflow for this tag, or set CONTINUUM_ALLOW_SOURCE_FALLBACK=1 to allow the slow path."
      fi
    fi
  else
    dep_log "deploy mode is '${deploy_mode}' (explicit source-build); skipping artifact download."
  fi

  write_extra_vars "${ans}/continuum-deploy.extra.json" "$domain" "$tag" "$CONTINUUM_REPO" \
    "$artifact_path" "$deploy_mode" "$allow_fallback"

  # Delegate to the hardened role. It performs: fail-closed state backup,
  # staging build, atomic swap, restart-before-readiness, version-asserting
  # health gate, and rescue rollback on failure. Vault-free → no secret touched.
  # Per-host values arrive via the deterministic -e extra-vars file (highest
  # precedence); structural identity vars come from role defaults.
  dep_log "running existing-ansible redeploy (--tags continuum) for ${tag}"
  ( cd "$ans" && ansible-playbook -i inventory.yml -e "@continuum-deploy.extra.json" site.yml --tags continuum )

  # Independent post-verify on top of the role's own gate (belt-and-suspenders).
  local now; now="$(live_version "$CONTINUUM_HEALTH_URL")"
  version_matches "$tag" "$now" \
    || dep_die "post-deploy health check: live version '${now}' != target '${tag}'."
  dep_log "post-deploy health OK: live=${now}."

  prune_releases "$CONTINUUM_DEPLOY_ROOT" "$CONTINUUM_KEEP_RELEASES" "$tag"

  # Best-effort disk-retention sweep (OPS-RETENTION-1): AFTER this verified-good
  # deploy, reclaim obsolete deployment source clones and superseded cutover
  # staging trees, cap deploy logs, and report FS usage. Run as an ISOLATED
  # process (from the just-checked-out tag's copy) so a fail-closed refusal or
  # any retention error can never fail a deploy that already succeeded — cleanup
  # must not break deploys.
  local retention="${src}/ops/torii-disk-retention.sh"
  if [[ -f "$retention" ]]; then
    dep_log "running disk-retention sweep (${retention})"
    bash "$retention" || dep_log "WARN retention sweep exited non-zero (deploy already succeeded; ignoring)."
  else
    dep_log "no disk-retention script in checkout; skipping sweep."
  fi
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
