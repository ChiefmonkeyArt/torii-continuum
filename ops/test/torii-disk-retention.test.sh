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
export RET_PROTECTED_PATHS_OVERRIDE="$WORK/protected $WORK/opt-torii"
mkdir -p "$RET_DEPLOY_ROOT" "$RET_STAGING_PARENT" "$RET_LOG_DIR" "$WORK/protected" "$WORK/opt-torii"

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

printf '\n[torii-disk-retention.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
