#!/usr/bin/env bash
#
# Torii Continuum — automatic disk-retention sweep (OPS-RETENTION-1, v0.2.67-alpha).
#
# WHY THIS EXISTS
# ---------------
# The deploy/cutover pipeline leaves regenerable artefacts behind that nothing
# prunes centrally:
#   - deployment source clones under /opt/deploy/torii-continuum-<tag>/ (the
#     unattended wrapper's checkouts), and
#   - cutover staging trees under /root/torii-final-cutover-<UTC>/ (each a full
#     clone + node_modules + backup + logs; a FAILED cutover leaves its whole
#     tree behind for inspection and it is never reaped).
# On a small VPS these accumulate until `npm ci` dies with ENOSPC (the live
# failure the cutover's own prune + preflight already partly addressed). This
# sweep is the single, auditable place that reclaims that space AFTER a
# successful deploy, while treating live state, encrypted state, projects,
# certificates, model weights and system audit logs as untouchable.
#
# RETENTION POLICY (fail-closed, idempotent)
# ------------------------------------------
#   1. Runs only after a verified-good deploy: the live agent must serve exactly
#      the version pinned in the deploy conf. If it does not (or cannot be
#      resolved), the sweep REFUSES to mutate anything (service state unsafe).
#   2. Source clones (/opt/deploy/torii-continuum-*): keep the LIVE release's
#      clone; delete every other (obsolete) clone.
#   3. Cutover staging (/root/torii-final-cutover-*): keep the single NEWEST
#      VERIFIED run (the one with a completed cutover-summary.txt — the rollback/
#      recovery set) plus every run NEWER than it (an un-superseded failed run's
#      diagnostics + rollback material are retained until a LATER successful run
#      supersedes them). Delete every run OLDER than the newest verified run.
#      If NO verified run exists at all, delete nothing (nothing has superseded
#      the failed material yet).
#   4. Deployment-specific logs under /var/log/torii-continuum are capped/rotated;
#      system + audit logs (journal, audit, auth, syslog) are never touched.
#
# SAFETY MODEL
# ------------
#   - APPROVED ROOTS: deletion may only happen strictly inside /opt/deploy, the
#     /root cutover-staging namespace, and /var/log/torii-continuum. Every
#     candidate is canonicalised (realpath) and re-checked: it must not be a
#     symlink, its parent must be exactly the approved root, and it must not fall
#     on or under any PROTECTED path. A candidate that fails any check is SKIPPED
#     (never deleted) and warned about — deletion fails closed per path.
#   - PROTECTED PATHS: config, encrypted state / memory / wallet / pending /
#     ciphertexts (all under the live app tree), /srv/continuum-projects,
#     certificates, the /home/continuum/app live tree, /opt/torii-suite/work,
#     Ollama models, CUDA libraries, and system/audit logs are refused outright.
#   - Enumeration is NUL-safe `find` (never a glob or eval), so hostile directory
#     names (spaces, newlines, `$(...)`, `../`) cannot break out.
#   - flock serialises concurrent runs; a second run reclaims nothing (idempotent).
#
# SOURCEABLE: sourcing this file only defines constants + functions (the test
# suite sources it and drives the pure functions in-process). The side-effecting
# sweep runs only when the file is executed directly.
#
# No secret is read, written, or logged. The deploy conf is parsed line-wise for
# the target tag only (never sourced), so a hostile conf cannot execute.

set -euo pipefail

# ── Constants / defaults (overridable via environment for tests) ──────────────
: "${RET_CONF:=/etc/torii/continuum-deploy.conf}"
: "${RET_HEALTH_URL:=http://127.0.0.1:8787/api/health}"
: "${RET_DEPLOY_ROOT:=/opt/deploy}"
: "${RET_STAGING_PARENT:=/root}"
: "${RET_LOG_DIR:=/var/log/torii-continuum}"
: "${RET_LOCKFILE:=/run/torii-continuum-retention.lock}"
# Pre-mutation state backups the deploy role writes as
# <parent>/continuum-backup-<UTC>/ (one per deploy run, root-only 0700). Never
# pruned centrally before v0.2.75-alpha, so they accumulated one-per-deploy.
: "${RET_BACKUP_PARENT:=/root}"
# The deploy role's staging/release dir (built then renamed into the live app on a
# successful cutover). On success it is normally gone (renamed to the app tree);
# this is the belt-and-suspenders sweep of any failed-clone residue.
: "${RET_APP_STAGING:=/home/continuum/app.staging}"
# Keep policy (configurable via the deploy role vars, see defaults/main.yml):
#   sources  — how many /opt/deploy/torii-continuum-* clones to keep. The current
#              PINNED clone is ALWAYS kept on top of this; the default 1 means the
#              pinned clone ONLY (a non-current tag can be re-cloned on rollback).
#   backups  — how many newest /root/continuum-backup-* dirs to keep, by mtime.
: "${RET_SOURCE_KEEP:=1}"
: "${RET_BACKUP_KEEP:=3}"
# The floor the deploy/cutover preflight enforces (2 GiB fail-before-mutation
# gate). Retained here only for reporting parity; this sweep frees space, it does
# not require it.
: "${RET_MIN_FREE_MB:=2048}"
# Filesystem-usage warning threshold (percent). At or above this the sweep emits
# a WARNING for the affected mount.
: "${RET_WARN_PCT:=80}"
# Deploy-log rotation policy: keep the newest N rotated files, and truncate any
# single live log larger than this many bytes.
: "${RET_LOG_KEEP:=10}"
: "${RET_LOG_MAX_BYTES:=10485760}"   # 10 MiB

# Names the sweep will act on, at depth 1 under their approved root only.
readonly RET_STAGING_GLOB='torii-final-cutover-*'
readonly RET_SOURCE_GLOB='torii-continuum-*'
readonly RET_BACKUP_GLOB='continuum-backup-*'
# A cutover run is VERIFIED (successful) iff this completed-summary marker exists.
readonly RET_SUCCESS_MARKER='cutover-summary.txt'

# Strict release-tag grammar (mirrors deploy-unattended.sh): a validated tag is
# safe to interpolate into paths and never a branch/SHA/metacharacter.
readonly RET_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

# Paths that must NEVER be deleted or descended into for deletion. A candidate
# whose canonical path equals or is nested under any of these is refused. Kept
# broad on purpose: protecting a parent (e.g. the whole live app tree) protects
# every secret/state child under it (memory, wallet, pending, ciphertexts).
# Overridable in tests via RET_PROTECTED_PATHS_OVERRIDE.
if [[ -n "${RET_PROTECTED_PATHS_OVERRIDE:-}" ]]; then
  # shellcheck disable=SC2206
  RET_PROTECTED_PATHS=(${RET_PROTECTED_PATHS_OVERRIDE})
else
  RET_PROTECTED_PATHS=(
    /etc/torii                       # deploy conf + allowlist (read-only to us)
    /home/continuum/app              # live app tree: code, config.yaml, agent/
    /home/continuum/.config          # user config / keys
    /home/continuum/.local           # user state
    /srv/continuum-projects          # authored project data
    /opt/torii                       # torii-base launcher/registry/env
    /opt/torii-suite/work            # suite working tree
    /etc/letsencrypt                 # certificates
    /etc/ssl                         # certificates
    /usr/share/ollama                # Ollama models
    /var/lib/ollama                  # Ollama models
    /root/.ollama                    # Ollama models (root)
    /opt/ollama                      # Ollama models
    /usr/local/cuda                  # CUDA libraries
    /var/log/journal                 # systemd journal (audit)
    /var/log/audit                   # auditd (audit)
  )
fi

# Sweep-run accumulators.
RET_RECLAIMED_BYTES=0
RET_PRUNED_COUNT=0

ret_log()  { printf '[disk-retention] %s\n' "$*"; }
ret_warn() { printf '[disk-retention] WARN: %s\n' "$*" >&2; }
ret_die()  { printf '[disk-retention] FATAL: %s\n' "$*" >&2; exit 1; }

# ret_canon <path> — canonical absolute path with all symlinks resolved. Uses
# realpath -m so a (would-be) non-existent path still canonicalises lexically for
# comparison; callers that require existence check it separately.
ret_canon() {
  realpath -m -- "${1:?}" 2>/dev/null
}

# ret_is_within <path> <root> — 0 iff canonical <path> is strictly inside
# canonical <root> (never equal to it). Both are canonicalised first.
ret_is_within() {
  local p r
  p="$(ret_canon "${1:?}")" || return 1
  r="$(ret_canon "${2:?}")" || return 1
  [[ -n "$p" && -n "$r" ]] || return 1
  [[ "$p" != "$r" ]] || return 1
  [[ "$p/" == "$r/"* ]]
}

# ret_is_protected <path> — 0 iff canonical <path> equals or is nested under any
# protected path. Fail-safe: an un-canonicalisable path is treated as protected.
ret_is_protected() {
  local p q
  p="$(ret_canon "${1:?}")" || return 0
  [[ -n "$p" ]] || return 0
  local prot
  for prot in "${RET_PROTECTED_PATHS[@]}"; do
    q="$(ret_canon "$prot")" || continue
    [[ -n "$q" ]] || continue
    [[ "$p" == "$q" || "$p/" == "$q/"* ]] && return 0
  done
  return 1
}

# ret_safe_target <candidate> <approved-root> — echo the canonical candidate and
# return 0 ONLY when deleting it is provably safe:
#   - the candidate is not itself a symlink (we never follow one out of the root),
#   - it exists and canonicalises,
#   - its canonical parent is EXACTLY the canonical approved root (depth 1, no
#     traversal, no symlinked re-parenting),
#   - it is not on/under any protected path,
#   - it is not the approved root itself nor "/".
# Any failure returns non-zero and prints nothing — the caller must skip it.
ret_safe_target() {
  local cand="${1:?}" root="${2:?}" real realparent realroot
  [[ -e "$cand" ]] || return 1
  [[ -L "$cand" ]] && return 1                     # never act on a symlink entry
  real="$(realpath -e -- "$cand" 2>/dev/null)" || return 1
  realroot="$(realpath -e -- "$root" 2>/dev/null)" || return 1
  [[ "$real" == "/" || "$real" == "$realroot" ]] && return 1
  realparent="$(dirname -- "$real")"
  [[ "$realparent" == "$realroot" ]] || return 1  # exactly one level under root
  ret_is_protected "$real" && return 1
  printf '%s\n' "$real"
}

# ret_dir_bytes <path> — apparent size in bytes (0 if missing/unreadable).
ret_dir_bytes() {
  local p="${1:?}" n=0
  [[ -e "$p" ]] || { printf '0'; return 0; }
  n="$(du -sb -- "$p" 2>/dev/null | awk '{print $1}')"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s' "$n"
}

# ret_reclaim <candidate> <approved-root> <label> — safety-re-check then delete,
# accounting bytes reclaimed. Unsafe candidates are skipped (never deleted).
ret_reclaim() {
  local cand="${1:?}" root="${2:?}" label="${3:-target}" real bytes
  if ! real="$(ret_safe_target "$cand" "$root")"; then
    ret_warn "refusing to delete unsafe ${label}: ${cand} (symlink/escape/protected)"
    return 0
  fi
  bytes="$(ret_dir_bytes "$real")"
  rm -rf -- "$real" || { ret_warn "could not delete ${label}: ${real}"; return 0; }
  RET_RECLAIMED_BYTES=$(( RET_RECLAIMED_BYTES + bytes ))
  RET_PRUNED_COUNT=$(( RET_PRUNED_COUNT + 1 ))
  ret_log "reclaimed ${label}: ${real} ($(ret_human "$bytes"))"
}

# ret_human <bytes> — human-readable size.
ret_human() {
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN{
    split("B KiB MiB GiB TiB",u," "); i=1; x=b+0;
    while (x>=1024 && i<5){x/=1024;i++}
    if (i==1) printf "%d %s", x, u[i]; else printf "%.2f %s", x, u[i]
  }'
}

# ret_fs_percent <path> — integer used-percent of the filesystem holding <path>.
ret_fs_percent() {
  local p="${1:?}" probe="$1"
  while [[ ! -e "$probe" && "$probe" != "/" ]]; do probe="$(dirname -- "$probe")"; done
  df -P -- "$probe" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}'
}

# ret_fs_free_mb <path> — available MiB on the filesystem holding <path>.
ret_fs_free_mb() {
  local p="${1:?}" probe="$1"
  while [[ ! -e "$probe" && "$probe" != "/" ]]; do probe="$(dirname -- "$probe")"; done
  df -Pm -- "$probe" 2>/dev/null | awk 'NR==2 {print $4}'
}

# ret_run_is_success <run-dir> — 0 iff the run completed (summary marker present).
ret_run_is_success() {
  [[ -f "${1:?}/${RET_SUCCESS_MARKER}" ]]
}

# ret_newest_success_run <parent> — echo the newest cutover staging run that has
# a completed summary marker, or nothing. Newest-first by the sortable UTC
# timestamp in the dir name; NUL-safe enumeration.
ret_newest_success_run() {
  local parent="${1:?}" d
  while IFS= read -r -d '' d; do
    if ret_run_is_success "$d"; then printf '%s\n' "$d"; return 0; fi
  done < <(find "$parent" -maxdepth 1 -type d -name "$RET_STAGING_GLOB" -print0 2>/dev/null | sort -zr)
  return 0
}

# ret_prune_superseded_staging <parent> — delete every cutover staging run OLDER
# than the newest verified run; keep the newest verified run and everything newer
# (un-superseded failed diagnostics). If no verified run exists, delete nothing.
ret_prune_superseded_staging() {
  local parent="${1:?}"
  [[ -d "$parent" ]] || return 0
  local newest_ok; newest_ok="$(ret_newest_success_run "$parent")"
  if [[ -z "$newest_ok" ]]; then
    ret_log "no verified cutover run present under ${parent}; retaining all staging (nothing to supersede failed material yet)"
    return 0
  fi
  ret_log "newest verified rollback set: ${newest_ok}"
  local d
  # Newest-first; anything sorting AFTER newest_ok (i.e. lexically smaller) is
  # older and superseded. We compare on the sortable timestamped name.
  while IFS= read -r -d '' d; do
    if [[ "$d" == "$newest_ok" ]]; then continue; fi
    if [[ "$(basename -- "$d")" > "$(basename -- "$newest_ok")" ]]; then
      # Newer than the newest verified run → un-superseded; retain.
      ret_run_is_success "$d" \
        && ret_log "retaining newer verified run: ${d}" \
        || ret_log "retaining un-superseded failed run (diagnostics + rollback): ${d}"
      continue
    fi
    # Older than the newest verified run → superseded; reclaim the whole tree.
    ret_reclaim "$d" "$parent" "superseded cutover staging"
  done < <(find "$parent" -maxdepth 1 -type d -name "$RET_STAGING_GLOB" -print0 2>/dev/null | sort -zr)
}

# ret_prune_source_clones <deploy-root> <live-tag> [keep] — ALWAYS keep the live
# (pinned) release's source clone; additionally keep the newest (keep-1) OTHER
# clones by mtime, deleting every remaining torii-continuum-* clone. keep defaults
# to RET_SOURCE_KEEP (1 → the pinned clone ONLY; a non-current tag can be
# re-cloned on rollback). The pinned clone is never counted against the budget and
# never deleted, whatever its mtime.
ret_prune_source_clones() {
  local root="${1:?}" live_tag="${2:?}" keep="${3:-$RET_SOURCE_KEEP}"
  [[ -d "$root" ]] || return 0
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=1
  local keep_name="torii-continuum-${live_tag}" d base
  # Extra non-pin clones to retain on top of the pin (never negative).
  local extra=$(( keep > 0 ? keep - 1 : 0 ))
  local kept_extra=0
  # Newest-first by mtime so the extras we retain are the most recent non-pin ones.
  while IFS= read -r -d '' d; do
    base="$(basename -- "$d")"
    if [[ "$base" == "$keep_name" ]]; then
      ret_log "retaining pinned source clone: ${d}"
      continue
    fi
    if (( kept_extra < extra )); then
      kept_extra=$(( kept_extra + 1 ))
      ret_log "retaining recent source clone (${kept_extra}/${extra}): ${d}"
      continue
    fi
    ret_reclaim "$d" "$root" "obsolete source clone"
  done < <(find "$root" -maxdepth 1 -type d -name "$RET_SOURCE_GLOB" -printf '%T@\t%p\0' 2>/dev/null | sort -zrn | cut -zf2-)
}

# ret_prune_backups <backup-parent> [keep] — keep the newest <keep> pre-mutation
# state backups (<parent>/continuum-backup-*) by mtime; delete every older one.
# keep defaults to RET_BACKUP_KEEP (3). Each backup is a rollback set, so we keep
# a small window rather than only the current one. Deletion goes through the same
# safety re-check (ret_safe_target) as every other reclaim — anchored to depth-1
# children of the approved parent, never a symlink, never a protected path.
ret_prune_backups() {
  local parent="${1:?}" keep="${2:-$RET_BACKUP_KEEP}"
  [[ -d "$parent" ]] || return 0
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=3
  local d kept=0
  # Newest-first by mtime.
  while IFS= read -r -d '' d; do
    kept=$(( kept + 1 ))
    if (( kept <= keep )); then
      ret_log "retaining recent state backup (${kept}/${keep}): ${d}"
      continue
    fi
    ret_reclaim "$d" "$parent" "old state backup"
  done < <(find "$parent" -maxdepth 1 -type d -name "$RET_BACKUP_GLOB" -printf '%T@\t%p\0' 2>/dev/null | sort -zrn | cut -zf2-)
}

# ret_prune_app_staging <staging-path> — remove the deploy role's staging/release
# dir if any residue remains after a successful cutover (normally it was renamed
# into the live app tree). STRICT anchoring: the basename must be exactly
# 'app.staging' (never 'app'), the entry must not be a symlink, and it must pass
# the protected-path refusal — so this can never touch /home/continuum/app (live)
# or any protected tree even if misconfigured.
ret_prune_app_staging() {
  local staging="${1:?}"
  [[ -e "$staging" ]] || { ret_log "no staging residue at ${staging}; nothing to clear"; return 0; }
  [[ -L "$staging" ]] && { ret_warn "refusing to remove a symlinked staging path: ${staging}"; return 0; }
  if [[ "$(basename -- "$staging")" != "app.staging" ]]; then
    ret_warn "refusing to remove a staging path whose name is not exactly 'app.staging': ${staging}"
    return 0
  fi
  local real; real="$(ret_canon "$staging")" || { ret_warn "cannot resolve staging path ${staging}"; return 0; }
  if ret_is_protected "$real"; then
    ret_warn "refusing to remove a protected staging path: ${real}"
    return 0
  fi
  local parent; parent="$(dirname -- "$real")"
  ret_reclaim "$real" "$parent" "failed-clone staging residue"
}

# ret_rotate_logs <dir> — cap deployment-specific logs. Refuses any dir that is
# not the approved log dir or that resolves onto/under a protected path, so a
# misconfiguration can never rotate/weaken system or audit logs. Keeps the newest
# RET_LOG_KEEP rotated (*.gz / *.N) files and truncates any live *.log over
# RET_LOG_MAX_BYTES. Best-effort and idempotent.
ret_rotate_logs() {
  local dir="${1:?}" real approved
  approved="$(ret_canon "$RET_LOG_DIR")"
  real="$(ret_canon "$dir")" || { ret_warn "cannot resolve log dir ${dir}"; return 0; }
  if [[ "$real" != "$approved" ]]; then
    ret_warn "refusing to rotate logs outside the approved dir (${real} != ${approved})"
    return 0
  fi
  if ret_is_protected "$real"; then
    ret_warn "refusing to rotate a protected/system log path: ${real}"
    return 0
  fi
  [[ -d "$real" ]] || { ret_log "no deploy-log dir at ${real}; skipping rotation"; return 0; }

  # Truncate oversized live logs in place (preserves inode/permissions; never
  # deletes the audit trail, only bounds this deploy log's growth).
  local f sz
  while IFS= read -r -d '' f; do
    sz="$(stat -c '%s' -- "$f" 2>/dev/null || echo 0)"
    if [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > RET_LOG_MAX_BYTES )); then
      : > "$f" && ret_log "truncated oversized deploy log: ${f} (was $(ret_human "$sz"))"
    fi
  done < <(find "$real" -maxdepth 1 -type f -name '*.log' -print0 2>/dev/null)

  # Keep only the newest RET_LOG_KEEP rotated artefacts.
  local -a rotated=()
  while IFS= read -r -d '' f; do rotated+=("$f"); done < <(
    find "$real" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.log.[0-9]*' \) \
      -printf '%T@\t%p\0' 2>/dev/null | sort -zrn | cut -zf2-
  )
  local i=0
  for f in "${rotated[@]}"; do
    i=$(( i + 1 ))
    (( i > RET_LOG_KEEP )) || continue
    [[ -f "$f" && ! -L "$f" ]] || continue
    ret_is_protected "$f" && continue
    local bytes; bytes="$(ret_dir_bytes "$f")"
    rm -f -- "$f" && { RET_RECLAIMED_BYTES=$(( RET_RECLAIMED_BYTES + bytes )); ret_log "rotated out old deploy log: ${f}"; }
  done
}

# ret_live_version [url] — best-effort live agent version, empty on any failure.
# Factored out so tests can stub it. Never fails the caller.
ret_live_version() {
  local url="${1:-$RET_HEALTH_URL}" body=''
  body="$(curl -fsS --max-time 5 -- "$url" 2>/dev/null || true)"
  [[ -n "$body" ]] || { printf ''; return 0; }
  printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# ret_pin_tag [conf] — the pinned target tag, parsed LINE-WISE (never sourced) so
# a hostile conf cannot execute. Empty if unset/absent/invalid.
ret_pin_tag() {
  local conf="${1:-$RET_CONF}" raw=''
  [[ -f "$conf" ]] || { printf ''; return 0; }
  raw="$(sed -n 's/^[[:space:]]*CONTINUUM_TARGET_TAG=//p' "$conf" | tail -1)"
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  [[ "$raw" =~ $RET_TAG_RE ]] || { printf ''; return 0; }
  printf '%s' "$raw"
}

# ret_resolve_live_tag — the verified live release tag, or a fatal refusal. This
# is the "after a successful deploy only" + "deploy service state safe" gate:
# the pinned tag must be present AND the live agent must serve exactly it.
ret_resolve_live_tag() {
  local pin live
  pin="$(ret_pin_tag)"
  [[ -n "$pin" ]] || ret_die "cannot resolve the pinned release tag from ${RET_CONF} (active paths unresolved — refusing cleanup)."
  live="$(ret_live_version)"
  [[ -n "$live" ]] || ret_die "live agent version unavailable at ${RET_HEALTH_URL} (deploy service state unsafe — refusing cleanup)."
  [[ "${pin#v}" == "$live" ]] || ret_die "live version '${live}' != pinned '${pin}' (deploy not converged / unsafe — refusing cleanup)."
  printf '%s' "$pin"
}

# ret_report — reclaimed total + current filesystem usage for each approved root,
# with an 80% warning per mount.
ret_report() {
  ret_log "reclaimed ${RET_PRUNED_COUNT} item(s), $(ret_human "$RET_RECLAIMED_BYTES") total"
  local p pct free
  for p in "$RET_DEPLOY_ROOT" "$RET_STAGING_PARENT" "$RET_BACKUP_PARENT" "$RET_LOG_DIR"; do
    pct="$(ret_fs_percent "$p")"; free="$(ret_fs_free_mb "$p")"
    [[ -n "$pct" ]] || continue
    ret_log "filesystem for ${p}: ${pct}% used, ${free:-?} MiB free"
    if [[ "$pct" =~ ^[0-9]+$ ]] && (( pct >= RET_WARN_PCT )); then
      ret_warn "filesystem for ${p} is ${pct}% full (>= ${RET_WARN_PCT}% threshold)"
    fi
    if [[ "$free" =~ ^[0-9]+$ ]] && (( free < RET_MIN_FREE_MB )); then
      ret_warn "filesystem for ${p} has ${free} MiB free (< ${RET_MIN_FREE_MB} MiB deploy floor)"
    fi
  done
}

# retention_sweep — the full side-effecting sweep. Fail-closed at every gate.
retention_sweep() {
  local live_tag
  live_tag="$(ret_resolve_live_tag)"          # dies if deploy state is unsafe
  ret_log "verified live release: ${live_tag}; beginning retention sweep."

  ret_prune_source_clones "$RET_DEPLOY_ROOT" "$live_tag"
  ret_prune_superseded_staging "$RET_STAGING_PARENT"
  ret_prune_backups "$RET_BACKUP_PARENT"
  ret_prune_app_staging "$RET_APP_STAGING"
  ret_rotate_logs "$RET_LOG_DIR"
  ret_report
  ret_log "retention sweep complete."
}

# ── CLI dispatcher (runs only when executed directly, not when sourced) ───────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  [[ "$(id -u)" -eq 0 ]] || ret_die "must run as root (prunes root-owned deploy/staging trees)."
  exec 9>"$RET_LOCKFILE" 2>/dev/null || true
  if command -v flock >/dev/null && [[ -e "$RET_LOCKFILE" ]]; then
    flock -n 9 || ret_die "another retention sweep is already running (lock ${RET_LOCKFILE})."
  fi
  retention_sweep
fi
