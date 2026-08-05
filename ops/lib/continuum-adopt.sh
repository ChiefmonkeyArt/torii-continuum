#!/usr/bin/env bash
#
# Torii Continuum — standalone→Ansible adoption logic (shared, sourceable).
#
# WHY THIS EXISTS
# ---------------
# There are two ways the agent can already be installed on a box:
#
#   standalone  ops/install-agent.sh  → /opt/torii/continuum-agent
#                                        unit: torii-continuum-agent.service
#                                        AGENT_PORT=8787
#   ansible     roles/continuum       → /home/<user>/app/agent
#                                        unit: continuum-agent.service
#
# The agent's funded Routstr key and character ciphertexts are encrypted at rest
# with a key DERIVED FROM session_secret. If a deploy overwrites config.yaml with
# a fresh session_secret, or points the service at an empty new state dir, the
# funded key is orphaned — irrecoverably. That is the #1 thing this module exists
# to prevent.
#
# So the role must be able to:
#   1. detect which layout(s) already exist,
#   2. back up all encrypted/config state to a root-only path BEFORE any mutation
#      (fail closed — no backup, no mutation),
#   3. migrate a standalone install into the Ansible layout VERBATIM (config and
#      session_secret copied byte-for-byte, never regenerated), and
#   4. decide whether config.yaml may be (re)rendered at all — only on a genuinely
#      fresh install, or when the operator has explicitly opted into rotation.
#
# TRANSACTIONAL ORDERING (v0.2.42-alpha)
# --------------------------------------
# A prior adoption failed because it migrated live state INTO /home/<user>/app/agent
# and only THEN tried to `git clone` into /home/<user>/app — cloning into a
# directory already populated with runtime state. That left the box with the
# original standalone layout AND a partial, non-git /home/<user>/app holding a
# COPY of the state. To make adoption safe and re-runnable this module now also:
#
#   5. detects that partial-adoption state EXPLICITLY (agent dir has state but
#      app dir has no .git, standalone still present) — never mistaking it for a
#      valid existing-Ansible install;
#   6. builds every git checkout/npm/build step in a CLEAN staging/release dir
#      that never holds authoritative state, so a clone/build can be retried or
#      wiped without risking real state;
#   7. copies authoritative live state into the staged release only AFTER a
#      successful checkout+build, then atomically swaps the release into place,
#      quarantining (never deleting) any pre-existing app dir; and
#   8. can roll a failed promotion back to the quarantined directory.
#
# The standalone service is kept RUNNING through all preflight work (clone, npm,
# build, config decisions) and is stopped only immediately before the final
# state copy + atomic cutover, so port 8787 is freed for the shortest window.
#
# Every function here is one-way about secrets: session_secret / admin_npub values
# are NEVER printed. Drift detection reports only the words "same" or "differ".
#
# No side effects on source: sourcing this file only defines constants + functions.
# A CLI dispatcher at the bottom runs only when the file is executed directly, so
# the Ansible role can invoke it via ansible.builtin.script and the test suite can
# source it and call the functions in-process.

# ── Constants ─────────────────────────────────────────────────────────────────
readonly CONTINUUM_ANSIBLE_SERVICE="continuum-agent"
readonly CONTINUUM_STANDALONE_SERVICE="torii-continuum-agent"
# State artefacts that must be backed up / migrated. config.yaml carries the
# session_secret; the three dirs carry the encrypted key + wallet + drafts.
readonly CONTINUUM_STATE_ITEMS=(config.yaml memory ciphertexts pending)

# ── layout_detect <app_dir> <agent_dir> <standalone_dir> ────────────────────────
#   Prints exactly one of:
#     mode=existing-ansible   app_dir IS a git checkout (.git) AND agent has config
#     mode=partial-adoption   agent dir has state but app_dir has NO .git — a
#                             half-migrated tree from a failed adoption. NEVER
#                             treated as a valid existing-Ansible install.
#     mode=adopt-standalone   no Ansible-side state, but standalone state exists
#     mode=fresh              nothing anywhere
#   Precedence matters:
#     * a real git-backed Ansible install wins (never re-adopt over it);
#     * a NON-git app dir carrying state is a partial adoption to be recovered,
#       not an install to build on top of (that was the v0.2.41 failure mode).
layout_detect() {
  local app_dir="$1" agent_dir="$2" standalone_dir="$3"
  local agent_has_state=false standalone_has_state=false
  { [ -f "${agent_dir}/config.yaml" ] || [ -d "${agent_dir}/memory" ]; } && agent_has_state=true
  { [ -f "${standalone_dir}/config.yaml" ] || [ -d "${standalone_dir}/memory" ]; } && standalone_has_state=true

  if [ -d "${app_dir}/.git" ] && [ -f "${agent_dir}/config.yaml" ]; then
    echo "mode=existing-ansible"
  elif [ "$agent_has_state" = true ] && [ ! -d "${app_dir}/.git" ]; then
    echo "mode=partial-adoption"
  elif [ "$standalone_has_state" = true ]; then
    echo "mode=adopt-standalone"
  else
    echo "mode=fresh"
  fi
}

# ── authoritative_state_dir <mode> <agent_dir> <standalone_dir> ─────────────────
#   Prints the directory whose config.yaml + encrypted state is AUTHORITATIVE
#   (the live, funded one) for a given mode — the single source that must be
#   copied verbatim into a freshly built release. Prints empty for fresh.
#     existing-ansible -> the agent dir (the running Ansible install)
#     adopt-standalone -> the standalone dir
#     partial-adoption -> the standalone dir if it still carries state (it is the
#                         untouched, still-running original), else the partial
#                         agent-dir copy as a last resort.
authoritative_state_dir() {
  local mode="$1" agent_dir="$2" standalone_dir="$3"
  case "$mode" in
    existing-ansible) echo "$agent_dir" ;;
    adopt-standalone) echo "$standalone_dir" ;;
    partial-adoption)
      if [ -f "${standalone_dir}/config.yaml" ] || [ -d "${standalone_dir}/memory" ]; then
        echo "$standalone_dir"
      else
        echo "$agent_dir"
      fi ;;
    *) echo "" ;;
  esac
}

# ── backup_state <backup_dir> <src_dir> [<src_dir> ...] ─────────────────────────
#   Creates <backup_dir> as 0700 and copies every existing CONTINUUM_STATE_ITEM
#   from each source dir into a per-source labelled subdir. FAIL CLOSED: if the
#   backup dir cannot be created, or a present item cannot be copied, or the
#   post-copy verification fails, returns non-zero WITHOUT having printed any
#   secret. The caller (role) treats a non-zero return as "abort before mutating".
#   Never prints file contents — only paths and item names.
backup_state() {
  local backup_dir="$1"; shift
  [ -n "$backup_dir" ] || { echo "backup_state: no backup dir given" >&2; return 2; }

  mkdir -p "$backup_dir" 2>/dev/null || { echo "backup_state: cannot create $backup_dir" >&2; return 1; }
  chmod 0700 "$backup_dir" 2>/dev/null || { echo "backup_state: cannot chmod 0700 $backup_dir" >&2; return 1; }

  local src label dest item copied=0
  for src in "$@"; do
    [ -d "$src" ] || continue
    # Label each source by a filesystem-safe form of its path so two source
    # layouts never collide inside the backup.
    label="$(echo "$src" | sed -e 's#^/##' -e 's#/#_#g')"
    dest="${backup_dir}/${label}"
    mkdir -p "$dest" 2>/dev/null || { echo "backup_state: cannot create $dest" >&2; return 1; }
    for item in "${CONTINUUM_STATE_ITEMS[@]}"; do
      if [ -e "${src}/${item}" ]; then
        cp -a "${src}/${item}" "${dest}/" 2>/dev/null \
          || { echo "backup_state: FAILED to copy ${item} from ${src}" >&2; return 1; }
        # Verify the artefact actually landed.
        [ -e "${dest}/${item}" ] \
          || { echo "backup_state: verification FAILED for ${item} from ${src}" >&2; return 1; }
        copied=$((copied+1))
        echo "backup_state: saved ${item} <- ${src}"
      fi
    done
  done
  echo "backup_state: ok items=${copied} dir=${backup_dir}"
  return 0
}

# ── migrate_state <standalone_dir> <ansible_agent_dir> [owner] ──────────────────
#   Copies config.yaml + state dirs from the standalone layout into the Ansible
#   layout, PRESERVING the existing config byte-for-byte (session_secret is never
#   regenerated). Applies 0700 to state dirs and 0600 to config.yaml. chowns to
#   <owner>:<owner> only when running as root (uid 0); skipped otherwise so the
#   test suite works unprivileged. Never overwrites an artefact that already
#   exists at the destination (idempotent: a second run is a no-op for present
#   items). Never prints file contents.
migrate_state() {
  local src="$1" dst="$2" owner="${3:-}"
  [ -d "$src" ] || { echo "migrate_state: source $src missing" >&2; return 1; }
  mkdir -p "$dst" 2>/dev/null || { echo "migrate_state: cannot create $dst" >&2; return 1; }

  local item
  for item in "${CONTINUUM_STATE_ITEMS[@]}"; do
    if [ -e "${src}/${item}" ] && [ ! -e "${dst}/${item}" ]; then
      cp -a "${src}/${item}" "${dst}/" 2>/dev/null \
        || { echo "migrate_state: FAILED to copy ${item}" >&2; return 1; }
      echo "migrate_state: copied ${item}"
    fi
  done

  # Lock modes. Dirs 0700, config 0600.
  [ -e "${dst}/config.yaml" ] && chmod 0600 "${dst}/config.yaml" 2>/dev/null || true
  for item in memory ciphertexts pending; do
    [ -d "${dst}/${item}" ] && chmod 0700 "${dst}/${item}" 2>/dev/null || true
  done

  if [ "$(id -u)" = "0" ] && [ -n "$owner" ]; then
    chown -R "${owner}:${owner}" "$dst" 2>/dev/null \
      || { echo "migrate_state: chown to $owner failed" >&2; return 1; }
    echo "migrate_state: chowned $dst -> $owner"
  else
    echo "migrate_state: chown skipped (uid=$(id -u) owner='${owner}')"
  fi
  echo "migrate_state: ok"
  return 0
}

# ── config_action <mode> [allow_rotation] ───────────────────────────────────────
#   Decides what the role may do with config.yaml. Prints exactly one word:
#     render     fresh install — safe to render config.yaml from the template
#     preserve   config exists — leave it untouched (the safe default)
#     rotate     config exists AND operator explicitly set allow_rotation=true
#   For adopt-standalone the migrated config is authoritative, so we preserve.
config_action() {
  local mode="$1" allow="${2:-false}"
  case "$mode" in
    fresh) echo "render" ;;
    existing-ansible|adopt-standalone|partial-adoption)
      if [ "$allow" = "true" ]; then echo "rotate"; else echo "preserve"; fi
      ;;
    *) echo "preserve" ;;
  esac
}

# ── stage_reset <release_dir> ───────────────────────────────────────────────────
#   Guarantees a CLEAN, empty staging/release dir for the git checkout + build.
#   The release dir NEVER holds authoritative state (state is only copied in AFTER
#   the build, immediately before cutover), so wiping it on every run is safe and
#   makes a retried adoption idempotent. Refuses obviously dangerous targets.
stage_reset() {
  local rel="$1"
  [ -n "$rel" ] || { echo "stage_reset: no release dir given" >&2; return 2; }
  case "$rel" in
    /|""|/home|/root|/opt|/opt/torii) echo "stage_reset: refusing unsafe target '$rel'" >&2; return 2 ;;
  esac
  rm -rf -- "$rel" 2>/dev/null || { echo "stage_reset: cannot clear $rel" >&2; return 1; }
  mkdir -p "$rel" 2>/dev/null || { echo "stage_reset: cannot create $rel" >&2; return 1; }
  echo "stage_reset: ok $rel"
  return 0
}

# ── promote_release <release_dir> <app_dir> <quarantine_dir> ────────────────────
#   Atomically swaps a freshly built staging release into the live app path. If
#   app_dir already exists (a valid Ansible install OR a partial non-git tree) it
#   is MOVED to quarantine_dir first — NEVER deleted, so its state survives for
#   backup/inspection. Both moves are renames (atomic when on one filesystem).
#   Idempotent: if the release dir is already gone but app_dir is a promoted git
#   checkout, it is a no-op success (a re-run after a completed promotion).
promote_release() {
  local rel="$1" app="$2" quar="$3"
  [ -n "$rel" ] && [ -n "$app" ] && [ -n "$quar" ] \
    || { echo "promote_release: missing args" >&2; return 2; }
  if [ ! -d "$rel" ]; then
    if [ -d "${app}/.git" ]; then echo "promote_release: already promoted (no staging present)"; return 0; fi
    echo "promote_release: staging $rel missing and $app is not a promoted checkout" >&2
    return 1
  fi
  if [ -e "$app" ]; then
    [ -e "$quar" ] && { echo "promote_release: quarantine $quar already exists" >&2; return 1; }
    mv -- "$app" "$quar" 2>/dev/null \
      || { echo "promote_release: cannot quarantine $app -> $quar" >&2; return 1; }
    echo "promote_release: quarantined $app -> $quar"
  fi
  mv -- "$rel" "$app" 2>/dev/null \
    || { echo "promote_release: cannot move $rel -> $app" >&2; return 1; }
  echo "promote_release: promoted $rel -> $app"
  return 0
}

# ── rollback_release <app_dir> <quarantine_dir> [failed_dir] ────────────────────
#   Undo a promotion: move the just-promoted (failed) app aside to failed_dir
#   (or, if none given, leave it in place and refuse to clobber), then restore the
#   quarantined original back to app_dir. Used by the role's rescue path so a
#   failed cutover of an EXISTING install returns to its previous tree. Never
#   deletes state.
rollback_release() {
  local app="$1" quar="$2" failed="${3:-}"
  [ -n "$app" ] && [ -n "$quar" ] || { echo "rollback_release: missing args" >&2; return 2; }
  [ -d "$quar" ] || { echo "rollback_release: no quarantine at $quar (nothing to restore)" >&2; return 1; }
  if [ -e "$app" ]; then
    [ -n "$failed" ] || { echo "rollback_release: $app present and no failed_dir given" >&2; return 1; }
    [ -e "$failed" ] && { echo "rollback_release: failed_dir $failed already exists" >&2; return 1; }
    mv -- "$app" "$failed" 2>/dev/null \
      || { echo "rollback_release: cannot move failed $app -> $failed" >&2; return 1; }
    echo "rollback_release: moved failed release $app -> $failed"
  fi
  mv -- "$quar" "$app" 2>/dev/null \
    || { echo "rollback_release: cannot restore $quar -> $app" >&2; return 1; }
  echo "rollback_release: restored $app from $quar"
  return 0
}

# ── session_secret_of <config.yaml> ─────────────────────────────────────────────
#   INTERNAL. Extracts the session_secret value from a config file. Its output is
#   fed only into config_drift's one-way digest — it is NEVER surfaced to a caller
#   or log. Returns empty string if absent/unreadable.
session_secret_of() {
  local cfg="$1"
  [ -r "$cfg" ] || { echo ""; return 0; }
  sed -n -E 's/^[[:space:]]*session_secret:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' "$cfg" | head -n1
}

# ── config_drift <existing_config> <candidate_config> ───────────────────────────
#   Compares the session_secret of two configs WITHOUT revealing either. Prints:
#     same    both session_secrets are byte-identical
#     differ  they differ (routine deploy must then PRESERVE + warn, not rotate)
#   Uses a hash so no value ever reaches stdout/stderr. If either secret is empty
#   (unreadable) we conservatively report "differ" so the caller errs toward
#   preserving rather than silently rotating.
config_drift() {
  local a b ha hb
  a="$(session_secret_of "$1")"
  b="$(session_secret_of "$2")"
  if [ -z "$a" ] || [ -z "$b" ]; then echo "differ"; return 0; fi
  ha="$(printf '%s' "$a" | sha256sum | awk '{print $1}')"
  hb="$(printf '%s' "$b" | sha256sum | awk '{print $1}')"
  if [ "$ha" = "$hb" ]; then echo "same"; else echo "differ"; fi
}

# ── deploy_webroot <src_dist> <webroot> <stage> <backup> ────────────────────────
#   Publishes the built static SPA to a PUBLIC webroot that nginx (www-data) can
#   traverse, WITHOUT exposing the private app/agent source or encrypted state.
#   nginx cannot descend into /home/<user> (0750 home + the unit's ProtectHome),
#   so aliasing the SPA out of the private app dir returns HTTP 500 — this copies
#   ONLY the static bundle out to a world-traversable location.
#
#   Transactional: the bundle is copied into a clean <stage> dir (perms normalised
#   to dirs 0755 / files 0644, owned root:root when running as root), then the live
#   <webroot> — if present — is MOVED to <backup> (never deleted) and <stage> is
#   atomically renamed into place. Refuses obviously dangerous targets. Idempotent
#   enough to re-run: each run stages fresh and keeps the prior tree as backup.
deploy_webroot() {
  local src="$1" webroot="$2" stage="$3" backup="$4"
  [ -n "$src" ] && [ -n "$webroot" ] && [ -n "$stage" ] && [ -n "$backup" ] \
    || { echo "deploy_webroot: missing args" >&2; return 2; }
  [ -d "$src" ] || { echo "deploy_webroot: source dist $src missing" >&2; return 1; }
  local t
  for t in "$webroot" "$stage"; do
    case "$t" in
      /|""|/var|/var/www|/home|/root|/opt|/opt/torii|/usr|/etc)
        echo "deploy_webroot: refusing unsafe target '$t'" >&2; return 2 ;;
    esac
  done

  rm -rf -- "$stage" 2>/dev/null || { echo "deploy_webroot: cannot clear stage $stage" >&2; return 1; }
  mkdir -p "$stage" 2>/dev/null || { echo "deploy_webroot: cannot create stage $stage" >&2; return 1; }
  # Copy CONTENTS of the dist dir (not the dir itself) into the stage.
  cp -a "${src}/." "${stage}/" 2>/dev/null \
    || { echo "deploy_webroot: cannot copy $src -> $stage" >&2; return 1; }

  find "$stage" -type d -exec chmod 0755 {} + 2>/dev/null \
    || { echo "deploy_webroot: cannot chmod dirs" >&2; return 1; }
  find "$stage" -type f -exec chmod 0644 {} + 2>/dev/null \
    || { echo "deploy_webroot: cannot chmod files" >&2; return 1; }

  if [ "$(id -u)" = "0" ]; then
    chown -R root:root "$stage" 2>/dev/null \
      || { echo "deploy_webroot: chown root:root failed" >&2; return 1; }
    echo "deploy_webroot: chowned $stage -> root:root"
  else
    echo "deploy_webroot: chown skipped (uid=$(id -u))"
  fi

  if [ -e "$webroot" ]; then
    [ -e "$backup" ] && { echo "deploy_webroot: backup $backup already exists" >&2; return 1; }
    mv -- "$webroot" "$backup" 2>/dev/null \
      || { echo "deploy_webroot: cannot back up $webroot -> $backup" >&2; return 1; }
    echo "deploy_webroot: backed up $webroot -> $backup"
  fi
  mv -- "$stage" "$webroot" 2>/dev/null \
    || { echo "deploy_webroot: cannot promote $stage -> $webroot" >&2; return 1; }
  echo "deploy_webroot: ok $webroot"
  return 0
}

# ── rollback_webroot <webroot> <backup> ─────────────────────────────────────────
#   Undo a webroot promotion: discard the just-promoted tree and restore the prior
#   webroot from its backup. Used by the role's rescue path when a cutover fails
#   after the static swap. Requires the backup to exist (that is the state to
#   restore); refuses otherwise so it never invents an empty webroot.
rollback_webroot() {
  local webroot="$1" backup="$2"
  [ -n "$webroot" ] && [ -n "$backup" ] || { echo "rollback_webroot: missing args" >&2; return 2; }
  [ -d "$backup" ] || { echo "rollback_webroot: no backup at $backup (nothing to restore)" >&2; return 1; }
  case "$webroot" in
    /|""|/var|/var/www|/home|/root|/opt|/opt/torii|/usr|/etc)
      echo "rollback_webroot: refusing unsafe target '$webroot'" >&2; return 2 ;;
  esac
  rm -rf -- "$webroot" 2>/dev/null || { echo "rollback_webroot: cannot remove $webroot" >&2; return 1; }
  mv -- "$backup" "$webroot" 2>/dev/null \
    || { echo "rollback_webroot: cannot restore $backup -> $webroot" >&2; return 1; }
  echo "rollback_webroot: restored $webroot from $backup"
  return 0
}

# ── normalize_root_app <requested> ──────────────────────────────────────────────
#   Maps a group_vars root-app selector to the value the installed Torii CLI
#   actually accepts for `torii set-root`. The launcher that owns "/" is NOT a
#   registered app, so the CLI represents it as the sentinel `none`. Passing a
#   name like `launcher` makes the API return 404 {error: app_not_installed,
#   name: launcher} and the deploy rolls back. So legacy/empty/null selectors and
#   the common launcher synonyms all normalize to `none`; an explicit registered
#   app name (continuum, quest, plebeian, …) passes through UNCHANGED and is only
#   ever set when an operator deliberately configures it.
#   Prints exactly one token on stdout.
normalize_root_app() {
  local v="${1:-}"
  v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$v" in
    ""|none|null|"~"|launcher|torii|torii-base|base|root|home|homepage|default)
      echo "none" ;;
    *) echo "$v" ;;
  esac
}

# ── set_root_safe <torii_bin> <requested> [env_file] ─────────────────────────────
#   Idempotently points the Torii launcher root at the NORMALIZED selector.
#   - normalizes <requested> (launcher/empty/null → none) so a default install
#     never 404s the way `torii set-root launcher` did live;
#   - if <env_file> is given and exists, sources it first (the admin token the CLI
#     needs lives at /opt/torii/env) — the token value is never printed;
#   - skips the call when the current root already equals the target (queried via
#     `torii get-root`; if that subcommand is unavailable the query is treated as
#     unknown and set-root runs, which is idempotent for `none`);
#   - warns (stderr only) when the effective target is `continuum`, because making
#     Continuum own "/" takes the Torii Suite launcher off the root — discouraged.
#   Returns 0 on success/skip so a default install never trips the role's rescue
#   rollback. Never prints secrets.
set_root_safe() {
  local bin="$1" requested="${2:-}" env_file="${3:-}"
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    . "$env_file"
  fi
  local effective; effective="$(normalize_root_app "$requested")"
  if [ "$effective" = "continuum" ]; then
    echo "WARNING: pointing the Torii root at Continuum — the Torii Suite launcher will no longer own '/'. This is discouraged; the safe default is 'none' (launcher at root)." >&2
  fi
  local current=""
  current="$("$bin" get-root 2>/dev/null || true)"
  current="$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [ -n "$current" ] && [ "$current" = "$effective" ]; then
    echo "root-app already '$effective'; skipping set-root"
    return 0
  fi
  "$bin" set-root "$effective"
}

# ── artifact_verify_cli <artifact-path> <expected-tag> ───────────────────────
#   Thin wrapper the Ansible role's `script` module invokes to verify a
#   pre-staged release artifact before it is ever extracted into the staging
#   dir. Delegates the actual gates to artifact-verify.sh (checksum + manifest
#   + tag + required-contents + no-secrets), which lives alongside this file.
#   Expects <artifact-path>.sha256 and <artifact-path-without-.tar.gz>.manifest.json
#   next to the tarball (the layout ops/deploy-unattended.sh downloads and the
#   CI release workflow publishes). Fails closed (non-zero, message on stdout
#   so `register: ...stdout` in the playbook can surface it) on any missing
#   file, checksum mismatch, or tag/version mismatch. Extraction happens
#   separately (ansible.builtin.unarchive) only after this returns 0.
artifact_verify_cli() {
  local artifact="${1:?usage: artifact-verify <artifact-tarball-path> <expected-tag>}"
  local tag="${2:?usage: artifact-verify <artifact-tarball-path> <expected-tag>}"

  if [ -z "$artifact" ] || [ "$artifact" = "" ]; then
    echo "artifact_verify_cli: no artifact path configured (continuum_artifact_path is empty)"
    return 1
  fi
  if [ ! -f "$artifact" ]; then
    echo "artifact_verify_cli: artifact not found at ${artifact}"
    return 1
  fi

  local lib_dir; lib_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)"
  local verifier="${lib_dir}/artifact-verify.sh"
  if [ ! -f "$verifier" ]; then
    echo "artifact_verify_cli: verifier library missing at ${verifier}"
    return 1
  fi
  # shellcheck disable=SC1090
  . "$verifier"

  local sumfile="${artifact}.sha256"
  local manifest; manifest="$(dirname -- "$artifact")/$(basename -- "$artifact" .tar.gz).manifest.json"
  local extract_dir; extract_dir="$(mktemp -d)"
  # Best-effort cleanup of the scratch extraction used only to validate
  # contents/no-secrets; the real extraction into staging happens afterwards
  # via ansible.builtin.unarchive, independent of this scratch copy.
  trap 'rm -rf -- "$extract_dir"' RETURN 2>/dev/null || true

  if ! tar -xzf "$artifact" -C "$extract_dir" 2>&1; then
    echo "artifact_verify_cli: failed to extract ${artifact} for validation"
    rm -rf -- "$extract_dir"
    return 1
  fi
  local extracted_root
  extracted_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  if [ -z "$extracted_root" ]; then
    echo "artifact_verify_cli: extracted tarball has no top-level directory"
    rm -rf -- "$extract_dir"
    return 1
  fi

  if artifact_verify_all "$artifact" "$sumfile" "$manifest" "$tag" "$extracted_root"; then
    echo "ok: artifact verified for ${tag}"
    rm -rf -- "$extract_dir"
    return 0
  else
    echo "artifact verification FAILED for ${tag} (see stderr for the specific gate)"
    rm -rf -- "$extract_dir"
    return 1
  fi
}

# ── CLI dispatcher (only when executed, not when sourced) ───────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  cmd="${1:-}"; shift || true
  case "$cmd" in
    detect)          layout_detect "$@" ;;
    authoritative)   authoritative_state_dir "$@" ;;
    backup)          backup_state "$@" ;;
    migrate)         migrate_state "$@" ;;
    stage-reset)     stage_reset "$@" ;;
    promote)         promote_release "$@" ;;
    rollback)        rollback_release "$@" ;;
    config-action)   config_action "$@" ;;
    config-drift)    config_drift "$@" ;;
    normalize-root)  normalize_root_app "$@" ;;
    set-root-safe)   set_root_safe "$@" ;;
    deploy-webroot)  deploy_webroot "$@" ;;
    rollback-webroot) rollback_webroot "$@" ;;
    artifact-verify) artifact_verify_cli "$@" ;;
    *)
      echo "usage: continuum-adopt.sh {detect|authoritative|backup|migrate|stage-reset|promote|rollback|config-action|config-drift|normalize-root|set-root-safe|deploy-webroot|rollback-webroot|artifact-verify} ..." >&2
      exit 2 ;;
  esac
fi
