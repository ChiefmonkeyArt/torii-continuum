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

# ── layout_detect <ansible_agent_dir> <standalone_dir> ──────────────────────────
#   Prints exactly one of:
#     mode=existing-ansible   the Ansible layout already has a config.yaml
#     mode=adopt-standalone   no Ansible config, but standalone state exists
#     mode=fresh              neither layout has state
#   Precedence matters: an existing Ansible install always wins (we must never
#   re-adopt on top of an already-migrated tree and clobber it).
layout_detect() {
  local ansible_dir="$1" standalone_dir="$2"
  if [ -f "${ansible_dir}/config.yaml" ]; then
    echo "mode=existing-ansible"
  elif [ -f "${standalone_dir}/config.yaml" ] || [ -d "${standalone_dir}/memory" ]; then
    echo "mode=adopt-standalone"
  else
    echo "mode=fresh"
  fi
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
    existing-ansible|adopt-standalone)
      if [ "$allow" = "true" ]; then echo "rotate"; else echo "preserve"; fi
      ;;
    *) echo "preserve" ;;
  esac
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

# ── CLI dispatcher (only when executed, not when sourced) ───────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  cmd="${1:-}"; shift || true
  case "$cmd" in
    detect)        layout_detect "$@" ;;
    backup)        backup_state "$@" ;;
    migrate)       migrate_state "$@" ;;
    config-action) config_action "$@" ;;
    config-drift)  config_drift "$@" ;;
    *)
      echo "usage: continuum-adopt.sh {detect|backup|migrate|config-action|config-drift} ..." >&2
      exit 2 ;;
  esac
fi
