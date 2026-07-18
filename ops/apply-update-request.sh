#!/usr/bin/env bash
#
# Torii Continuum — root-side update-request applier (VERSION-UPDATE-1, v0.2.69-alpha).
#
# WHY THIS EXISTS
# ---------------
# The agent runs UNPRIVILEGED (`continuum` user, systemd ProtectSystem=strict)
# and its ONLY writable path is its own memory/ dir. It therefore CANNOT edit the
# root-owned deploy pin (/etc/torii/continuum-deploy.conf). So the admin-gated
# POST /api/update route (see agent/core/updater.mjs) does the only thing it can:
# it writes a single, server-vetted "update request" JSON into the agent spool
# (<AGENT_ROOT>/memory/update-request.json).
#
# THIS SCRIPT is the root half of that privilege separation. It runs as
# ExecStartPre of the deploy service, INDEPENDENTLY re-validates the request, and
# — only if it passes — rewrites CONTINUUM_TARGET_TAG in the pin. The existing
# hardened deploy wrapper (deploy-unattended.sh) then converges as usual, so the
# request still flows through EVERY existing guard (strict grammar, allowlist,
# optional signed-tag gate, version health gate). This applier trusts nothing the
# agent wrote: it re-checks the grammar and the allowlist here too.
#
# FAIL-SAFE, not fail-blocking. This is a PRE step for the baseline pin deploy.
# A missing spool, a corrupt request, or an unauthorized tag must NEVER abort the
# deploy that would otherwise run from the existing pin — such requests are
# discarded (consumed) and the script exits 0. Only a valid, allowed, newer tag
# results in a pin rewrite. If the pin cannot be written, the request is LEFT in
# place for the next run and the script still exits 0 (the baseline deploy runs).
#
# It NEVER execs the requested code, never reads a secret, and only ever writes
# the single CONTINUUM_TARGET_TAG line of the pin (atomically, preserving the
# rest of the file byte-for-byte).
#
# SOURCEABLE: sourcing this file only defines constants + functions (the test
# suite sources it and calls the pure functions in-process). The side-effecting
# apply runs only when the file is executed directly.

set -euo pipefail

# ── Constants / defaults (overridable via environment for tests) ──────────────
: "${CONTINUUM_CONF:=/etc/torii/continuum-deploy.conf}"
# The agent's writable spool. Mirrors join(AGENT_ROOT,'memory','update-request.json')
# where AGENT_ROOT on the box is the deployed agent dir.
: "${CONTINUUM_UPDATE_REQUEST:=/opt/torii/continuum-agent/memory/update-request.json}"
# Optional allowlist file — the SAME policy the deploy wrapper enforces. Read
# from the pin if present so both halves agree without duplicating config.
: "${CONTINUUM_ALLOWLIST_FILE:=}"

# Strict release-tag grammar — a byte-for-byte mirror of deploy-unattended.sh's
# CONTINUUM_TAG_RE and agent updater UPDATE_TAG_RE. A validated tag contains no
# shell/YAML/quote metacharacter, so it is safe to write into the pin verbatim.
readonly CONTINUUM_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

upd_log() { printf '[apply-update-request] %s\n' "$*"; }

# req_validate_tag <tag> — 0 iff the tag matches the strict release grammar.
req_validate_tag() {
  local tag="${1:-}"
  [[ -n "$tag" ]] || return 1
  [[ "$tag" =~ $CONTINUUM_TAG_RE ]]
}

# json_string_field <json> <key> — extract a top-level JSON string value without
# assuming jq. Returns empty on absence. The value is then grammar-validated, so
# a loose extractor is safe: anything that isn't a valid tag is rejected anyway.
json_string_field() {
  local json="${1:-}" key="${2:?}"
  printf '%s' "$json" \
    | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
    | head -1
}

# req_tag_allowed <tag> <allowlist-file> — identical policy to the deploy
# wrapper's tag_allowed:
#   - no file configured        → allowed (allowlist is opt-in)
#   - file configured + present  → tag must appear as its own line
#   - file configured + missing  → DENY (fail-closed)
req_tag_allowed() {
  local tag="${1:-}" file="${2:-}"
  [[ -n "$file" ]] || return 0
  [[ -f "$file" ]] || return 1
  grep -qxF -- "$tag" "$file"
}

# current_pin_tag <conf> — the CONTINUUM_TARGET_TAG currently set in the pin
# (empty if unset/absent). Read WITHOUT sourcing (the pin is root-owned but we
# only need one line, and never want to execute it).
current_pin_tag() {
  local conf="${1:-$CONTINUUM_CONF}"
  [[ -f "$conf" ]] || { printf ''; return 0; }
  sed -n 's/^[[:space:]]*CONTINUUM_TARGET_TAG=\(.*\)$/\1/p' "$conf" | head -1
}

# rewrite_pin_tag <conf> <tag> — atomically set CONTINUUM_TARGET_TAG=<tag>,
# preserving every other line byte-for-byte. If the key is absent it is appended.
# Writes via a temp file + mv (same dir) so a reader never sees a half-write, and
# preserves root:root 0600. Returns non-zero if the rewrite could not complete.
rewrite_pin_tag() {
  local conf="${1:?}" tag="${2:?}"
  req_validate_tag "$tag" || return 1
  [[ -f "$conf" ]] || return 1
  local tmp; tmp="$(mktemp "${conf}.XXXXXX")" || return 1
  # Preserve perms/owner of the original on the temp before swapping.
  chmod 0600 "$tmp" 2>/dev/null || true
  if grep -q '^[[:space:]]*CONTINUUM_TARGET_TAG=' "$conf"; then
    # Replace the existing line. Tag is grammar-validated → no sed-metacharacter.
    sed "s|^[[:space:]]*CONTINUUM_TARGET_TAG=.*$|CONTINUUM_TARGET_TAG=${tag}|" "$conf" > "$tmp" || { rm -f "$tmp"; return 1; }
  else
    { cat "$conf"; printf 'CONTINUUM_TARGET_TAG=%s\n' "$tag"; } > "$tmp" || { rm -f "$tmp"; return 1; }
  fi
  chown root:root "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$conf" || { rm -f "$tmp"; return 1; }
}

# consume_request <path> — remove the spool so a request is applied at most once.
consume_request() {
  local path="${1:?}"
  rm -f -- "$path" 2>/dev/null || true
}

# apply_request [request-path] [conf] — the full side-effecting apply. ALWAYS
# returns 0 for expected cases (missing/corrupt/unauthorized request), so it can
# never block the baseline pin deploy it is a PRE step for.
apply_request() {
  local path="${1:-$CONTINUUM_UPDATE_REQUEST}"
  local conf="${2:-$CONTINUUM_CONF}"

  [[ -f "$path" ]] || { return 0; }  # nothing queued → nothing to do

  local raw; raw="$(cat -- "$path" 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    upd_log "empty update request; discarding."
    consume_request "$path"; return 0
  fi

  local tag; tag="$(json_string_field "$raw" tag)"
  if ! req_validate_tag "$tag"; then
    upd_log "update request has no valid tag (got '${tag}'); discarding."
    consume_request "$path"; return 0
  fi

  # Independent allowlist re-check (belt-and-suspenders with the agent + wrapper).
  # Resolve the allowlist file from the pin if not set in the environment.
  local allow="$CONTINUUM_ALLOWLIST_FILE"
  if [[ -z "$allow" && -f "$conf" ]]; then
    allow="$(sed -n 's/^[[:space:]]*CONTINUUM_ALLOWLIST_FILE=\(.*\)$/\1/p' "$conf" | head -1)"
  fi
  if ! req_tag_allowed "$tag" "$allow"; then
    upd_log "requested tag ${tag} is not allowlisted; discarding."
    consume_request "$path"; return 0
  fi

  local cur; cur="$(current_pin_tag "$conf")"
  if [[ "$cur" == "$tag" ]]; then
    upd_log "pin already targets ${tag}; consuming request (no rewrite needed)."
    consume_request "$path"; return 0
  fi

  if rewrite_pin_tag "$conf" "$tag"; then
    upd_log "pin updated: CONTINUUM_TARGET_TAG ${cur:-<unset>} -> ${tag}."
    consume_request "$path"
  else
    # Leave the request in place so the next run retries; do NOT block the deploy.
    upd_log "WARN could not rewrite pin ${conf} for ${tag}; leaving request for retry."
  fi
  return 0
}

# ── CLI dispatcher (runs only when executed directly, not when sourced) ───────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # As an ExecStartPre we may run before the pin exists on a fresh box; that is a
  # no-op, not an error. Never abort the deploy from here.
  apply_request "${1:-$CONTINUUM_UPDATE_REQUEST}" "${2:-$CONTINUUM_CONF}" || true
fi
