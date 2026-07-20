#!/usr/bin/env bash
#
# Hermetic tests for the automatic disk-retention sweep (OPS-RETENTION-1,
# v0.2.67-alpha). No root, no network, no real prod paths.
#
# The suite sources torii-disk-retention.sh (the CLI dispatcher is guarded, so
# sourcing is side-effect free) and drives the pure + FS functions against
# temp-dir fixtures, plus static assertions on the fail-closed guards. It covers,
# in particular, the security-review-critical cases:
#   - path traversal / symlink escape / protected-path refusal,
#   - hostile directory names (spaces, newlines, $(...), backticks) via NUL-safe
#     enumeration and quoted rm (never a glob or eval),
#   - the failed-deploy retention rule (a failed run is kept until a LATER
#     successful run supersedes it),
#   - fail-closed refusal when the live release / deploy service state is unsafe,
#   - deploy-log rotation that never touches system/audit logs.
#
# Run:  bash ops/test/torii-disk-retention.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
TOOL="${REPO_ROOT}/ops/torii-disk-retention.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$TOOL" ]] || { bad "missing tool: $TOOL"; exit 1; }

# ── 0. Parses + sources without side effects ─────────────────────────────────
bash -n "$TOOL" && ok "tool passes bash -n" || bad "tool failed bash -n"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Point every approved root at the sandbox BEFORE sourcing, and neutralise the
# protected list to a sandbox path so protected-vs-approved logic is exercisable.
export RET_DEPLOY_ROOT="$WORK/opt-deploy"
export RET_STAGING_PARENT="$WORK/root-staging"
export RET_LOG_DIR="$WORK/var-log"
export RET_CONF="$WORK/deploy.conf"
export RET_BACKUP_PARENT="$WORK/root-backups"
# app.staging fixture lives under a sandbox "home" whose sibling "app" is protected,
# mirroring /home/continuum/{app,app.staging} on the box.
export RET_APP_STAGING="$WORK/home/app.staging"
export RET_PROTECTED_PATHS_OVERRIDE="$WORK/protected $WORK/opt-torii $WORK/home/app"
mkdir -p "$RET_DEPLOY_ROOT" "$RET_STAGING_PARENT" "$RET_LOG_DIR" "$RET_BACKUP_PARENT" "$WORK/protected" "$WORK/opt-torii" "$WORK/home/app"

# shellcheck disable=SC1090
source "$TOOL"
ok "tool sources without running the sweep (dispatcher guarded)"

reset_accum() { RET_RECLAIMED_BYTES=0; RET_PRUNED_COUNT=0; }

# ── 1. ret_is_within ─────────────────────────────────────────────────────────
mkdir -p "$WORK/root-staging/child"
ret_is_within "$WORK/root-staging/child" "$WORK/root-staging" && ok "is_within: child inside root" || bad "is_within child failed"
if ret_is_within "$WORK/root-staging" "$WORK/root-staging"; then bad "is_within must reject root==path"; else ok "is_within: rejects equal path"; fi
if ret_is_within "$WORK" "$WORK/root-staging"; then bad "is_within must reject parent"; else ok "is_within: rejects parent"; fi
if ret_is_within "$WORK/root-staging/../opt-deploy/x" "$WORK/root-staging"; then bad "is_within must reject traversal-out"; else ok "is_within: rejects ../ escape"; fi

# ── 2. ret_is_protected ──────────────────────────────────────────────────────
mkdir -p "$WORK/protected/secret"
ret_is_protected "$WORK/protected" && ok "is_protected: exact protected path" || bad "is_protected exact failed"
ret_is_protected "$WORK/protected/secret" && ok "is_protected: nested under protected" || bad "is_protected nested failed"
if ret_is_protected "$WORK/root-staging/child"; then bad "is_protected must not flag approved dirs"; else ok "is_protected: approved dir not protected"; fi

# ── 3. ret_safe_target (the core deletion gate) ──────────────────────────────
mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-ok"
ret_safe_target "$RET_STAGING_PARENT/torii-final-cutover-ok" "$RET_STAGING_PARENT" >/dev/null \
  && ok "safe_target: accepts a legit depth-1 child" || bad "safe_target rejected a legit child"
# symlink entry (pointing anywhere) must be refused, never followed
ln -s /etc "$RET_STAGING_PARENT/torii-final-cutover-evil"
if ret_safe_target "$RET_STAGING_PARENT/torii-final-cutover-evil" "$RET_STAGING_PARENT" >/dev/null; then
  bad "safe_target must refuse a symlink entry"; else ok "safe_target: refuses symlink entry (no follow)"; fi
# path traversal that escapes the approved root
if ret_safe_target "$RET_STAGING_PARENT/../opt-deploy" "$RET_STAGING_PARENT" >/dev/null; then
  bad "safe_target must refuse ../ escape"; else ok "safe_target: refuses ../ escape"; fi
# a candidate whose real parent is NOT exactly the root (depth 2)
mkdir -p "$RET_STAGING_PARENT/sub/deep"
if ret_safe_target "$RET_STAGING_PARENT/sub/deep" "$RET_STAGING_PARENT" >/dev/null; then
  bad "safe_target must refuse depth>1"; else ok "safe_target: refuses depth>1 child"; fi
# the approved root itself, and "/"
if ret_safe_target "$RET_STAGING_PARENT" "$RET_STAGING_PARENT" >/dev/null; then bad "safe_target must refuse root itself"; else ok "safe_target: refuses the root itself"; fi
# protected candidate even if it has a matching name
mkdir -p "$WORK/protected/torii-final-cutover-x"
if ret_safe_target "$WORK/protected/torii-final-cutover-x" "$WORK/protected" >/dev/null; then
  bad "safe_target must refuse a protected candidate"; else ok "safe_target: refuses protected candidate"; fi
# non-existent
if ret_safe_target "$RET_STAGING_PARENT/nope" "$RET_STAGING_PARENT" >/dev/null; then bad "safe_target must refuse missing"; else ok "safe_target: refuses missing path"; fi
rm -rf "$RET_STAGING_PARENT/torii-final-cutover-ok" "$RET_STAGING_PARENT/torii-final-cutover-evil" "$RET_STAGING_PARENT/sub"

# ── 4. Success/failed classification ─────────────────────────────────────────
mkdir -p "$WORK/run-ok" "$WORK/run-bad"
: > "$WORK/run-ok/cutover-summary.txt"
ret_run_is_success "$WORK/run-ok" && ok "classify: run with summary = success" || bad "classify success failed"
if ret_run_is_success "$WORK/run-bad"; then bad "classify: no-summary must be failed"; else ok "classify: run without summary = failed"; fi

# ── 5. Staging retention matrix incl. FAILED-DEPLOY retention rule ────────────
seed_staging() {
  rm -rf "$RET_STAGING_PARENT"; mkdir -p "$RET_STAGING_PARENT"
  # oldest → newest by sortable UTC name
  mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260101T000000Z"; : > "$RET_STAGING_PARENT/torii-final-cutover-20260101T000000Z/cutover-summary.txt"  # old success
  mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260102T000000Z"                                                                                     # failed, older than newest OK
  mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260103T000000Z"; : > "$RET_STAGING_PARENT/torii-final-cutover-20260103T000000Z/cutover-summary.txt"  # NEWEST success (rollback set)
  mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260104T000000Z"                                                                                     # failed, NEWER than newest OK
}
seed_staging
[[ "$(ret_newest_success_run "$RET_STAGING_PARENT")" == *"20260103T000000Z" ]] \
  && ok "newest_success_run picks the newest verified run" || bad "newest_success_run wrong"
reset_accum
ret_prune_superseded_staging "$RET_STAGING_PARENT" >/dev/null
[[ -d "$RET_STAGING_PARENT/torii-final-cutover-20260103T000000Z" ]] && ok "retains the newest verified rollback set" || bad "deleted the rollback set"
[[ -d "$RET_STAGING_PARENT/torii-final-cutover-20260104T000000Z" ]] && ok "retains un-superseded failed run (newer than newest verified)" || bad "deleted an un-superseded failed run"
[[ ! -d "$RET_STAGING_PARENT/torii-final-cutover-20260102T000000Z" ]] && ok "prunes a superseded failed run (older than newest verified)" || bad "kept a superseded failed run"
[[ ! -d "$RET_STAGING_PARENT/torii-final-cutover-20260101T000000Z" ]] && ok "prunes a superseded old success" || bad "kept a superseded old success"
[[ "$RET_PRUNED_COUNT" -eq 2 ]] && ok "reclaimed exactly the 2 superseded runs" || bad "wrong prune count (${RET_PRUNED_COUNT})"

# 5b. Idempotency — a second sweep reclaims nothing.
reset_accum
ret_prune_superseded_staging "$RET_STAGING_PARENT" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 ]] && ok "staging prune is idempotent (2nd run reclaims 0)" || bad "staging prune not idempotent"

# 5c. NO verified run anywhere → delete NOTHING (nothing has superseded failures).
rm -rf "$RET_STAGING_PARENT"; mkdir -p "$RET_STAGING_PARENT"
mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260201T000000Z" "$RET_STAGING_PARENT/torii-final-cutover-20260202T000000Z"
reset_accum
ret_prune_superseded_staging "$RET_STAGING_PARENT" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 && -d "$RET_STAGING_PARENT/torii-final-cutover-20260201T000000Z" ]] \
  && ok "no verified run → retains all failed staging (fail-safe)" || bad "pruned failed staging with no verified run"

# ── 6. Hostile directory names (NUL-safe enumeration, quoted rm, no eval) ─────
rm -rf "$RET_STAGING_PARENT"; mkdir -p "$RET_STAGING_PARENT"
mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260301T000000Z"; : > "$RET_STAGING_PARENT/torii-final-cutover-20260301T000000Z/cutover-summary.txt"  # newest verified
# a superseded run with a hostile name containing a command substitution + space
evil_name='torii-final-cutover-20260228T000000Z $(touch '"$WORK"'/PWNED) `id`'
mkdir -p "$RET_STAGING_PARENT/$evil_name"
reset_accum
ret_prune_superseded_staging "$RET_STAGING_PARENT" >/dev/null
[[ ! -e "$WORK/PWNED" ]] && ok "hostile dir name is NOT executed (no command substitution)" || bad "hostile dir name executed a command!"
[[ ! -d "$RET_STAGING_PARENT/$evil_name" ]] && ok "hostile-named superseded run pruned safely (quoted rm)" || bad "hostile-named run not pruned"

# ── 7. Source-clone pruning keeps the live release only ──────────────────────
rm -rf "$RET_DEPLOY_ROOT"; mkdir -p "$RET_DEPLOY_ROOT"
for t in v0.2.63-alpha v0.2.64-alpha v0.2.65-alpha v0.2.67-alpha; do mkdir -p "$RET_DEPLOY_ROOT/torii-continuum-${t}"; done
reset_accum
ret_prune_source_clones "$RET_DEPLOY_ROOT" "v0.2.67-alpha" >/dev/null
[[ -d "$RET_DEPLOY_ROOT/torii-continuum-v0.2.67-alpha" ]] && ok "source prune keeps the live release clone" || bad "deleted the LIVE source clone"
remaining="$(find "$RET_DEPLOY_ROOT" -maxdepth 1 -type d -name 'torii-continuum-*' | wc -l | tr -d ' ')"
[[ "$remaining" -eq 1 ]] && ok "source prune removes all obsolete clones (remaining=${remaining})" || bad "source prune left too many (${remaining})"
# a symlinked clone pointing at a protected path must never be followed/deleted
ln -s "$WORK/protected" "$RET_DEPLOY_ROOT/torii-continuum-v0.0.1-evil"
reset_accum
ret_prune_source_clones "$RET_DEPLOY_ROOT" "v0.2.67-alpha" >/dev/null 2>&1
[[ -d "$WORK/protected" ]] && ok "source prune never follows a symlink into a protected path" || bad "followed symlink and deleted protected target!"
rm -f "$RET_DEPLOY_ROOT/torii-continuum-v0.0.1-evil"

# 7b. Configurable source keep-count: pin is ALWAYS kept; keep=2 retains the pin
#     plus the single newest OTHER clone; older non-pin clones are pruned.
rm -rf "$RET_DEPLOY_ROOT"; mkdir -p "$RET_DEPLOY_ROOT"
for t in v0.2.70-alpha v0.2.71-alpha v0.2.72-alpha v0.2.75-alpha; do
  mkdir -p "$RET_DEPLOY_ROOT/torii-continuum-${t}"; sleep 0.01
done
# Make the PINNED clone the OLDEST by mtime to prove the pin is kept regardless of age.
touch -d '2000-01-01' "$RET_DEPLOY_ROOT/torii-continuum-v0.2.71-alpha"
reset_accum
ret_prune_source_clones "$RET_DEPLOY_ROOT" "v0.2.71-alpha" 2 >/dev/null
[[ -d "$RET_DEPLOY_ROOT/torii-continuum-v0.2.71-alpha" ]] && ok "source keep=2 always retains the pinned clone (even when oldest)" || bad "pruned the pinned clone!"
[[ -d "$RET_DEPLOY_ROOT/torii-continuum-v0.2.75-alpha" ]] && ok "source keep=2 retains the newest non-pin clone" || bad "pruned the newest non-pin clone under keep=2"
kept_srcs="$(find "$RET_DEPLOY_ROOT" -maxdepth 1 -type d -name 'torii-continuum-*' | wc -l | tr -d ' ')"
[[ "$kept_srcs" -eq 2 ]] && ok "source keep=2 leaves exactly pin + 1 newest (kept=${kept_srcs})" || bad "source keep=2 kept wrong count (${kept_srcs})"

# 7c. Default keep (RET_SOURCE_KEEP=1) → pin ONLY.
rm -rf "$RET_DEPLOY_ROOT"; mkdir -p "$RET_DEPLOY_ROOT"
for t in v0.2.73-alpha v0.2.74-alpha v0.2.75-alpha; do mkdir -p "$RET_DEPLOY_ROOT/torii-continuum-${t}"; done
reset_accum
ret_prune_source_clones "$RET_DEPLOY_ROOT" "v0.2.75-alpha" >/dev/null   # keep defaults to RET_SOURCE_KEEP=1
[[ "$(find "$RET_DEPLOY_ROOT" -maxdepth 1 -type d -name 'torii-continuum-*' | wc -l | tr -d ' ')" -eq 1 \
   && -d "$RET_DEPLOY_ROOT/torii-continuum-v0.2.75-alpha" ]] \
  && ok "default source keep prunes to the pinned clone only" || bad "default source keep did not reduce to pin-only"

# ── 7d. Backup retention: keep the newest N by mtime, prune older ─────────────
seed_backups() {
  rm -rf "$RET_BACKUP_PARENT"; mkdir -p "$RET_BACKUP_PARENT"
  # Create 5 backups oldest→newest; set explicit mtimes so ordering is deterministic.
  local i
  for i in 1 2 3 4 5; do
    mkdir -p "$RET_BACKUP_PARENT/continuum-backup-2026010${i}T000000Z"
    touch -d "2026-01-0${i} 00:00:00" "$RET_BACKUP_PARENT/continuum-backup-2026010${i}T000000Z"
  done
}
seed_backups
reset_accum
ret_prune_backups "$RET_BACKUP_PARENT" 3 >/dev/null
kept_bk="$(find "$RET_BACKUP_PARENT" -maxdepth 1 -type d -name 'continuum-backup-*' | wc -l | tr -d ' ')"
[[ "$kept_bk" -eq 3 ]] && ok "backup prune keeps exactly the newest 3 (kept=${kept_bk})" || bad "backup prune kept wrong count (${kept_bk})"
[[ -d "$RET_BACKUP_PARENT/continuum-backup-20260105T000000Z" && -d "$RET_BACKUP_PARENT/continuum-backup-20260103T000000Z" ]] \
  && ok "backup prune keeps the newest backups by mtime" || bad "backup prune removed a newest backup"
[[ ! -d "$RET_BACKUP_PARENT/continuum-backup-20260101T000000Z" && ! -d "$RET_BACKUP_PARENT/continuum-backup-20260102T000000Z" ]] \
  && ok "backup prune removes the oldest backups" || bad "backup prune kept an oldest backup"
[[ "$RET_PRUNED_COUNT" -eq 2 ]] && ok "backup prune reclaimed exactly the 2 oldest" || bad "backup prune count wrong (${RET_PRUNED_COUNT})"
# Idempotent second pass reclaims nothing.
reset_accum
ret_prune_backups "$RET_BACKUP_PARENT" 3 >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 ]] && ok "backup prune is idempotent (2nd run reclaims 0)" || bad "backup prune not idempotent"
# Fewer backups than the keep budget → keep all.
seed_backups; rm -rf "$RET_BACKUP_PARENT/continuum-backup-20260101T000000Z" "$RET_BACKUP_PARENT/continuum-backup-20260102T000000Z"
reset_accum
ret_prune_backups "$RET_BACKUP_PARENT" 3 >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 && "$(find "$RET_BACKUP_PARENT" -maxdepth 1 -type d -name 'continuum-backup-*' | wc -l | tr -d ' ')" -eq 3 ]] \
  && ok "backup prune keeps all when at/under the budget" || bad "backup prune deleted within the budget"
# A backup with a hostile name must be pruned safely, not executed. The name is
# slash-free (so it is a single depth-1 dir we can age via mtime) and embeds a
# command substitution + backticks that must NEVER run.
seed_backups
evil_bk='continuum-backup-20251231T000000Z $(touch BK_PWNED) `id`'
mkdir -p "$RET_BACKUP_PARENT/$evil_bk"; touch -d '2025-12-31 00:00:00' "$RET_BACKUP_PARENT/$evil_bk"
reset_accum
ret_prune_backups "$RET_BACKUP_PARENT" 3 >/dev/null
[[ ! -e "$WORK/BK_PWNED" && ! -e "$RET_BACKUP_PARENT/BK_PWNED" && ! -e ./BK_PWNED ]] \
  && ok "hostile backup name is NOT executed (no command substitution)" || bad "hostile backup name executed a command!"
[[ ! -d "$RET_BACKUP_PARENT/$evil_bk" ]] && ok "hostile-named old backup pruned safely (quoted rm)" || bad "hostile-named backup not pruned"

# ── 7e. app.staging residue removal (strict, never the live app tree) ─────────
mkdir -p "$RET_APP_STAGING/junk"
reset_accum
ret_prune_app_staging "$RET_APP_STAGING" >/dev/null
[[ ! -e "$RET_APP_STAGING" ]] && ok "app.staging residue is removed after success" || bad "app.staging residue not removed"
[[ -d "$WORK/home/app" ]] && ok "app.staging removal never touches the sibling live app tree" || bad "removed the live app tree!"
# Missing staging → clean no-op.
reset_accum
ret_prune_app_staging "$RET_APP_STAGING" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 ]] && ok "app.staging removal is a no-op when absent" || bad "app.staging no-op deleted something"
# Refuses a path whose basename is not exactly 'app.staging' (e.g. the live app).
if out="$(ret_prune_app_staging "$WORK/home/app" 2>&1)"; then :; fi
[[ -d "$WORK/home/app" ]] && printf '%s' "$out" | grep -qi 'refusing' \
  && ok "app.staging removal refuses a non-'app.staging' path (protects live app)" || bad "did not refuse a non-app.staging path"
# Refuses a symlinked staging entry (never follows it out).
ln -s "$WORK/protected" "$WORK/home/app.staging"
out="$(ret_prune_app_staging "$WORK/home/app.staging" 2>&1 || true)"
[[ -d "$WORK/protected" ]] && printf '%s' "$out" | grep -qi 'refusing' \
  && ok "app.staging removal refuses a symlink (no follow into protected)" || bad "followed a symlinked staging path"
rm -f "$WORK/home/app.staging"

# ── 7f. app.quarantine-* pruning (age > RET_QUARANTINE_AGE_DAYS, keep floor) ───
# The cutover role moves the previous live app aside as app.quarantine-<UTC>/.
# Retain the newest RET_QUARANTINE_KEEP unconditionally; prune the rest only once
# they age past RET_QUARANTINE_AGE_DAYS. Uses %T@ mtime (touch -d 'N days ago').
QPARENT="$WORK/qhome"
seed_quarantines_aged() {   # args: ages-in-days; one unique app.quarantine-* dir per arg
  rm -rf "$QPARENT"; mkdir -p "$QPARENT"
  local a i=0 d
  for a in "$@"; do
    i=$(( i + 1 ))
    d="$QPARENT/app.quarantine-i${i}-age${a}d"
    mkdir -p "$d"
    touch -d "${a} days ago" "$d"
  done
}
qcount() { find "$QPARENT" -maxdepth 1 -type d -name 'app.quarantine-*' | wc -l | tr -d ' '; }

# (a) The 5.5 GiB bug: nine dirs aged 1..9 days, defaults (age 3 / keep 3) →
#     keep the three newest (aged 1,2,3), prune the six older-than-3-days.
seed_quarantines_aged 1 2 3 4 5 6 7 8 9
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null
[[ "$(qcount)" -eq 3 ]] && ok "quarantine prune keeps exactly the newest 3 (kept=$(qcount))" || bad "quarantine prune kept wrong count ($(qcount))"
[[ "$RET_PRUNED_COUNT" -eq 6 ]] && ok "quarantine prune reclaims the 6 older-than-3-days" || bad "quarantine prune count wrong (${RET_PRUNED_COUNT})"
[[ -d "$QPARENT/app.quarantine-i1-age1d" && -d "$QPARENT/app.quarantine-i2-age2d" && -d "$QPARENT/app.quarantine-i3-age3d" ]] \
  && ok "quarantine prune keeps the three newest by mtime" || bad "quarantine prune removed a newest dir"
[[ ! -d "$QPARENT/app.quarantine-i4-age4d" && ! -d "$QPARENT/app.quarantine-i9-age9d" ]] \
  && ok "quarantine prune removes the aged (>3d) dirs (5.5 GiB bug fixed)" || bad "quarantine prune kept an aged dir"
# Idempotent: a second pass reclaims nothing.
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 ]] && ok "quarantine prune is idempotent (2nd run reclaims 0)" || bad "quarantine prune not idempotent"

# (b) All quarantines younger than the age threshold → keep everything.
seed_quarantines_aged 0 1 1 2 2   # five dirs, all < 3 days old
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 && "$(qcount)" -eq 5 ]] \
  && ok "quarantine prune keeps all when every dir is younger than the age threshold" || bad "quarantine prune dropped a young dir"

# (c) Keep-newest-N floor: only 2 quarantines, BOTH aged 30 days → keep both
#     (never drop below the floor even when all violate the age threshold).
seed_quarantines_aged 30 30
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null
[[ "$RET_PRUNED_COUNT" -eq 0 && "$(qcount)" -eq 2 ]] \
  && ok "quarantine prune keep-newest-N floor retains both aged dirs (never below floor)" || bad "quarantine prune dropped below the keep floor"

# (d) %T@ mtime: a single aged dir BEYOND the floor (touch -d '4 days ago')
#     qualifies as prunable; the floor keeps the three newest.
seed_quarantines_aged 1 2 3
mkdir -p "$QPARENT/app.quarantine-prunable"; touch -d '4 days ago' "$QPARENT/app.quarantine-prunable"
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null
[[ ! -d "$QPARENT/app.quarantine-prunable" && "$RET_PRUNED_COUNT" -eq 1 ]] \
  && ok "quarantine prune drops a 4-days-ago dir beyond the floor (%T@ mtime)" || bad "quarantine prune did not drop the 4-day dir"

# (e) Refuses to touch the live app tree even via a symlinked app.quarantine-evil
#     pointing at it (safety re-check + protected-path list catch it).
seed_quarantines_aged 10 20 30 40   # aged enough that non-symlinks would prune
ln -s "$WORK/home/app" "$QPARENT/app.quarantine-evil"   # points at a PROTECTED path
touch -d '40 days ago' "$WORK/home/app" 2>/dev/null || true
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null 2>&1
[[ -d "$WORK/home/app" ]] && ok "quarantine prune never follows a symlink into the protected live app tree" || bad "followed symlink and deleted the live app tree!"
[[ -L "$QPARENT/app.quarantine-evil" ]] && ok "quarantine prune leaves the symlink entry itself untouched (not enumerated)" || bad "quarantine prune deleted/followed the symlink entry"
rm -f "$QPARENT/app.quarantine-evil"

# (f) Refuses when a candidate is itself a symlink out of the parent (no follow).
seed_quarantines_aged 15
ln -s "$WORK/protected" "$QPARENT/app.quarantine-link"
reset_accum
ret_prune_app_quarantines "$QPARENT" >/dev/null 2>&1
[[ -d "$WORK/protected" ]] && ok "quarantine prune never follows a symlink candidate out of the parent" || bad "followed a symlink candidate and deleted its target"
[[ -L "$QPARENT/app.quarantine-link" ]] && ok "quarantine prune leaves a symlink candidate in place" || bad "quarantine prune removed a symlink candidate"
rm -f "$QPARENT/app.quarantine-link"

# ── 8. Deploy-log rotation (never touches system/audit logs) ─────────────────
rm -rf "$RET_LOG_DIR"; mkdir -p "$RET_LOG_DIR"
# oversized live log gets truncated in place (inode preserved)
head -c 200000 /dev/zero > "$RET_LOG_DIR/deploy.log" 2>/dev/null || printf '%0.sX' $(seq 1 200000) > "$RET_LOG_DIR/deploy.log"
RET_LOG_MAX_BYTES=1000
ino_before="$(stat -c '%i' "$RET_LOG_DIR/deploy.log")"
ret_rotate_logs "$RET_LOG_DIR" >/dev/null
sz_after="$(stat -c '%s' "$RET_LOG_DIR/deploy.log")"
ino_after="$(stat -c '%i' "$RET_LOG_DIR/deploy.log")"
[[ "$sz_after" -eq 0 && "$ino_before" == "$ino_after" ]] && ok "rotation truncates an oversized log in place (audit-safe, inode kept)" || bad "oversized log not truncated in place"
# keep only newest N rotated artefacts
for i in 1 2 3 4 5; do : > "$RET_LOG_DIR/deploy.log.${i}"; sleep 0.01; done
RET_LOG_KEEP=2
ret_rotate_logs "$RET_LOG_DIR" >/dev/null
kept="$(find "$RET_LOG_DIR" -maxdepth 1 -type f -name 'deploy.log.[0-9]*' | wc -l | tr -d ' ')"
[[ "$kept" -eq 2 ]] && ok "rotation keeps only the newest N rotated logs (kept=${kept})" || bad "rotation kept wrong count (${kept})"
# refuses to rotate a dir that is not the approved log dir
out="$(ret_rotate_logs "$WORK/opt-torii" 2>&1 || true)"
printf '%s' "$out" | grep -qi 'refusing' && ok "rotation refuses a non-approved log dir" || bad "rotation did not refuse a non-approved dir"

# ── 9. Reporting: reclaimed bytes + fs percent parse + 80% warning ───────────
reset_accum
mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260401T000000Z"; : > "$RET_STAGING_PARENT/torii-final-cutover-20260401T000000Z/cutover-summary.txt"
mkdir -p "$RET_STAGING_PARENT/torii-final-cutover-20260331T000000Z"; head -c 4096 /dev/zero > "$RET_STAGING_PARENT/torii-final-cutover-20260331T000000Z/blob" 2>/dev/null || true
ret_prune_superseded_staging "$RET_STAGING_PARENT" >/dev/null
[[ "$RET_RECLAIMED_BYTES" -gt 0 ]] && ok "reports non-zero reclaimed bytes after pruning content" || bad "reclaimed-bytes accounting is zero"
[[ "$(ret_human 1048576)" == "1.00 MiB" ]] && ok "ret_human formats MiB" || bad "ret_human formatting wrong ($(ret_human 1048576))"
pct="$(ret_fs_percent "$WORK")"; [[ "$pct" =~ ^[0-9]+$ ]] && ok "fs_percent returns an integer (${pct}%)" || bad "fs_percent not an integer"
# 80% warning: stub the FS percent high and confirm a WARN is emitted.
ret_fs_percent() { printf '95'; }
ret_fs_free_mb() { printf '10000'; }
warn_out="$(ret_report 2>&1)"
printf '%s' "$warn_out" | grep -qi 'full' && ok "report warns at/above the 80% threshold" || bad "no 80% capacity warning emitted"
unset -f ret_fs_percent ret_fs_free_mb

# ── 10. Fail-closed gates (pin/health/service-state) + no-conf-exec ───────────
# valid + matching → resolves
printf 'CONTINUUM_TARGET_TAG="v0.2.67-alpha"\nCONTINUUM_DOMAIN=chiefmonkey.art\n' > "$RET_CONF"
ret_live_version() { printf '0.2.67-alpha'; }
[[ "$(ret_resolve_live_tag)" == "v0.2.67-alpha" ]] && ok "resolve_live_tag returns the verified tag on match" || bad "resolve_live_tag failed on a valid match"
# mismatch → refuse (die)
ret_live_version() { printf '0.2.65-alpha'; }
if ( ret_resolve_live_tag ) >/dev/null 2>&1; then bad "resolve_live_tag must refuse on version mismatch"; else ok "resolve_live_tag refuses on version mismatch (unsafe state)"; fi
# empty live (agent down) → refuse
ret_live_version() { printf ''; }
if ( ret_resolve_live_tag ) >/dev/null 2>&1; then bad "resolve_live_tag must refuse when agent is unreachable"; else ok "resolve_live_tag refuses when live version is empty"; fi
# missing pin → refuse
rm -f "$RET_CONF"; ret_live_version() { printf '0.2.67-alpha'; }
if ( ret_resolve_live_tag ) >/dev/null 2>&1; then bad "resolve_live_tag must refuse with no pin"; else ok "resolve_live_tag refuses when pin is unresolved"; fi
# pin parsing is LINE-WISE — a hostile conf value must NOT be executed
printf 'CONTINUUM_TARGET_TAG="v0.2.67-alpha"\nEVIL=$(touch %s/CONF_PWNED)\n' "$WORK" > "$RET_CONF"
got="$(ret_pin_tag)"
[[ "$got" == "v0.2.67-alpha" && ! -e "$WORK/CONF_PWNED" ]] && ok "pin_tag parses line-wise and never executes the conf" || bad "conf was sourced/executed (or pin misparsed)"
# invalid tag in pin → empty (fail-closed upstream)
printf 'CONTINUUM_TARGET_TAG=not-a-tag\n' > "$RET_CONF"
[[ -z "$(ret_pin_tag)" ]] && ok "pin_tag rejects an invalid tag grammar" || bad "pin_tag accepted an invalid tag"

# ── 11. Static fail-closed / safety guards ───────────────────────────────────
grep -qF 'set -euo pipefail' "$TOOL" && ok "tool uses set -euo pipefail" || bad "tool missing strict mode"
grep -qF 'must run as root' "$TOOL" && ok "dispatcher refuses non-root" || bad "no non-root refusal"
grep -qF 'flock -n 9' "$TOOL" && ok "dispatcher serialises with flock (concurrency-safe)" || bad "no flock guard"
grep -qF 'print0' "$TOOL" && ok "enumeration is NUL-safe (find -print0)" || bad "enumeration not NUL-safe"
# No unguarded glob-rm of the staging/deploy namespaces.
if grep -qE 'rm -rf[^"]*/(opt/deploy|root)/torii-(continuum|final)-\*' "$TOOL"; then bad "tool uses a bare glob rm (unsafe)"; else ok "tool never uses a bare glob rm"; fi
# Every rm passes through the safety re-check (ret_safe_target) or the scoped log rotate.
grep -qF 'ret_safe_target' "$TOOL" && ok "deletions gate through ret_safe_target" || bad "deletions bypass ret_safe_target"
# The dispatcher only runs when executed, not sourced.
grep -qF '"${BASH_SOURCE[0]}" == "${0}"' "$TOOL" && ok "sweep runs only when executed (sourceable)" || bad "no sourceable guard"
# Protected-path list names the required untouchables.
for prot in '/home/continuum/app' '/srv/continuum-projects' 'letsencrypt' 'ollama' 'cuda' '/var/log/journal' '/var/log/audit' '/opt/torii-suite/work'; do
  grep -qF "$prot" "$TOOL" && ok "protected list includes ${prot}" || bad "protected list MISSING ${prot}"
done
# Never sources the conf (would execute hostile values).
if grep -qE '^[[:space:]]*(source|\.)[[:space:]]+.*RET_CONF' "$TOOL"; then bad "tool sources the conf (unsafe)"; else ok "tool never sources the conf"; fi
# v0.2.75-alpha additions are present and anchored to their exact globs.
grep -qF 'continuum-backup-*' "$TOOL" && ok "tool anchors backup prune to continuum-backup-*" || bad "backup glob not anchored"
grep -qF 'ret_prune_backups' "$TOOL" && ok "tool defines ret_prune_backups (backup retention)" || bad "missing ret_prune_backups"
grep -qF 'ret_prune_app_staging' "$TOOL" && ok "tool defines ret_prune_app_staging (residue removal)" || bad "missing ret_prune_app_staging"
# app.staging removal is name-anchored so it can never hit the live 'app' tree.
grep -qF "!= \"app.staging\"" "$TOOL" && ok "app.staging removal is strictly name-anchored" || bad "app.staging removal not name-anchored"
# v0.2.85-alpha additions: app.quarantine-* pruning, anchored + wired + belt-and-suspenders.
grep -qF 'ret_prune_app_quarantines' "$TOOL" && ok "tool defines ret_prune_app_quarantines (quarantine retention)" || bad "missing ret_prune_app_quarantines"
grep -qF 'app.quarantine-*' "$TOOL" && ok "tool anchors quarantine prune to app.quarantine-*" || bad "quarantine glob not anchored"
grep -qE 'ret_prune_app_quarantines "\$RET_QUARANTINE_PARENT"' "$TOOL" && ok "quarantine prune is wired into the sweep" || bad "quarantine prune not wired into retention_sweep"
grep -qE 'app\|app\.staging\|\.config\|\.local\|memory\|\.ssh' "$TOOL" && ok "quarantine prune hard-refuses protected basenames (belt + suspenders)" || bad "quarantine prune missing protected-basename refusal"

printf '\n[torii-disk-retention.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
