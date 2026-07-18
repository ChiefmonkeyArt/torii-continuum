#!/usr/bin/env bash
#
# Torii final VPS cutover — in-repo operator script (OPS-RETENTION-1, v0.2.67-alpha).
#
# Root-owned, fail-closed cutover for chiefmonkey.art. Fetched from ONE immutable
# annotated release tag and invoked with a short command from a verified clone:
#
#     sudo bash ops/torii-final-cutover.sh
#
# It:
#   - verifies exact annotated release tags + version markers before mutating live state
#       torii-base            v0.1.4
#       torii-continuum       v0.2.67-alpha  (this script's own release tag)
#       onboarding preview    v0.1.21-preview
#   - backs up the current Torii base state to a root-only timestamped directory
#   - redeploys torii-base via its sanctioned bootstrap (TORII_DOMAIN + SKIP_CERTBOT=1)
#   - bootstraps + triggers the Continuum OPS-DEPLOY-2 unattended pull, pins the tag,
#     and health/version-gates the live agent
#   - resolves the onboarding-preview live layout FAIL-CLOSED, deploys the preview
#     atomically, keeps exactly one rollback path, and verifies HTTP 200 + the
#     onboarding sign-in CTA (robust intent match, not a frozen phrase)
#   - reports service/timer/disk state and describes rollback
#
# ── v0.2.65-alpha CTA-detection hardening (OPS-CUTOVER-6) ──────────────────────
#   ROBUST ONBOARDING CTA MATCH. The preview probes previously required an exact
#   substring ("Sign in with browser extension"). The live button label is wrapped
#   in an icon <svg>/<span>, and the CTA wording can drift across preview
#   revisions, so the exact match false-failed a valid, live onboarding page after
#   deployment. Detection now normalises the fetched HTML (tags -> spaces,
#   whitespace collapsed, lowercased) and matches the sign-in *intent* via
#   PREVIEW_CTA_REGEX (text_has_cta/url_has_cta/wait_url_has_cta), so a reworded or
#   markup-wrapped-but-valid CTA passes while a blank/error page still fails closed.
#
# ── Why this file replaces the pasted-heredoc delivery ────────────────────────
# The previous delivery pasted a script body straight into an interactive VPS
# shell. A paste can truncate mid-line, and an interactive shell executes what it
# has received so far — a partial, dangerous run. Two structural defenses fix that:
#
#   1. ANTI-PARTIAL-DELIVERY BRACE GROUP. The entire executable body lives inside
#      a single `{ ... }` group whose closing brace is the last line. bash parses
#      to the matching brace before running anything; a truncated copy is missing
#      the brace, so bash reports a syntax error and NOTHING executes.
#   2. NO `exec sudo -- bash "$0"`. When pasted/sourced, `$0` is the interactive
#      shell (e.g. `-bash`), so that idiom re-execs the wrong thing. This script
#      instead REQUIRES root and refuses to be sourced; the documented invocation
#      is `sudo bash ops/torii-final-cutover.sh` from a verified clone.
#
# ── v0.2.63-alpha disk-safety hardening (OPS-CUTOVER-5) ───────────────────────
#   1. PREFLIGHT FREE-SPACE GATE. preflight_free_space() runs FIRST in main —
#      before any clone or mutation — and dies if any filesystem we clone into,
#      back up onto, or npm-install under has less than PREFLIGHT_MIN_FREE_MB
#      free. This makes a space-starved host fail closed up front instead of
#      half-applying the cutover and dying mid-`npm ci` (the live ENOSPC failure).
#   2. BACKUP EXCLUDES. The rollback tar now excludes regenerable cache/build
#      artifacts (node_modules, .git, .cache, .npm, dist, .vite) via
#      BACKUP_EXCLUDES, so the backup can't itself exhaust the disk. Scoped to
#      regenerable artifacts ONLY — config/state (env, registry.json,
#      root_app.conf) is still captured byte-for-byte.
#
# ── v0.2.62-alpha hotfix (OPS-CUTOVER-4) ──────────────────────────────────────
#   Prune stale /root/torii-final-cutover-* staging dirs after a successful
#   cutover (prune_old_staging_dirs, KEEP_STAGING_DIRS=1) so repeated runs cannot
#   accumulate and exhaust the disk. Runs LAST in main; a failed run leaves its
#   newest staging dir for inspection.
#
# ── v0.2.61-alpha hotfix (OPS-CUTOVER-3), from a live v0.2.59-alpha run ────────
#   1. UNATTENDED ROLE-VAR FIX. The Continuum unattended converge failed at the
#      first role task with `continuum_user is undefined`: the server-side pull
#      never created the hand-copied group_vars/all.yml that manual installs rely
#      on. The role now ships those structural identity vars as defaults, and the
#      wrapper passes per-host values via a validated -e extra-vars file instead
#      of a gitignored group_vars/all.yml.
#   2. NO RETRY STORM. The recurring deploy timer is installed but NOT enabled by
#      the bootstrap here; the cutover runs the first converge manually, health-
#      gates it, and enables the timer ONLY after a fully successful cutover, so a
#      failed converge can never be retried every 5 min against a bad config.
#
# ── v0.2.59-alpha hotfix (OPS-CUTOVER-2), from a live v0.2.58-alpha run ────────
#   1. PUBLIC-MODE FIX. The root-only umask 077 (correct for backups/state) also
#      applied to the git checkout of the public source, and torii-base installs
#      its webroot with mode-preserving `cp -a`, so /opt/torii/launcher landed as
#      0600/0700 and nginx returned HTTP 403. Sources are now checked out under a
#      public umask (022), the bootstrap runs under 022, and the launcher webroot
#      is force-set to 0755/0644 after install — scoped so secrets/config are
#      never widened.
#   2. ROLLBACK FIX. `die(){ exit 1; }` does NOT trigger the ERR trap, so the
#      HTTP 403 failure exited WITHOUT rolling back. A robust EXIT trap now runs a
#      reentrant rollback on every non-zero exit (die/exit included).
#
# Privacy/security: public HTTPS clones only; no secrets read/written/printed; no
# broad sudoers; existing config/state preserved byte-for-byte by the hardened role.
#
# This script is prepared and statically checked in-repo. It is NOT run as part of
# packaging and this repo does not deploy on your behalf.

{
set -euo pipefail
umask 077

# ── Guard 1: refuse sourcing ─────────────────────────────────────────────────
# Sourcing would run in the caller's shell with the caller's $0 — exactly the
# broken-paste footgun. Refuse it explicitly.
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  printf '[cutover] FATAL: do not source this script; run: sudo bash ops/torii-final-cutover.sh\n' >&2
  return 1 2>/dev/null || exit 1
fi

# ── Guard 2: require root, do NOT re-exec through sudo ────────────────────────
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '[cutover] FATAL: must run as root. Run: sudo bash ops/torii-final-cutover.sh\n' >&2
  exit 1
fi

readonly DOMAIN="chiefmonkey.art"
readonly BASE_REPO="https://github.com/ChiefmonkeyArt/torii-base.git"
readonly BASE_TAG="v0.1.4"
readonly BASE_VERSION="0.1.4"
readonly CONTINUUM_REPO="https://github.com/ChiefmonkeyArt/torii-continuum.git"
readonly CONTINUUM_TAG="v0.2.67-alpha"
readonly CONTINUUM_VERSION="0.2.67-alpha"
readonly PREVIEW_DIR_NAME="onboarding-v0.1.21"
readonly PREVIEW_VERSION="0.1.21-preview"
# Canonical CTA label — kept for logs/reports only, NOT for matching.
readonly PREVIEW_CTA="Sign in with browser extension"
# Robust CTA matcher. Detection matches the sign-in *intent* ("sign in … with|using
# … extension") after the HTML is normalised (tags stripped, whitespace collapsed,
# lowercased), so a valid-but-reworded CTA ("Sign in with a browser extension",
# "Sign in using a Nostr extension") or a label split across an icon <svg>/<span>
# still passes, while a blank/error page (missing the tokens) still fails closed.
# This replaces the old frozen exact-substring check, which false-failed a live,
# valid onboarding page whose button markup wraps the label.
readonly PREVIEW_CTA_REGEX='sign[ -]?in (with|using)( [a-z0-9]+)* extension'
readonly ROOT_URL="https://${DOMAIN}/"
readonly LAUNCHER_ASSET_URL="https://${DOMAIN}/assets/launcher.css"
readonly CONTINUUM_PUBLIC_URL="https://${DOMAIN}/continuum/"
readonly PREVIEW_ROOT_URL="https://${DOMAIN}/onboarding-preview/"
readonly PREVIEW_CONTINUUM_URL="https://${DOMAIN}/continuum/onboarding-preview/"
readonly PREVIEW_ROOT_PATH="/var/www/torii/onboarding-preview"
readonly PREVIEW_CONTINUUM_PATH="/var/www/torii/continuum/onboarding-preview"
readonly SIDECAR_HEALTH_URL="http://127.0.0.1:8780/torii/healthz"
readonly CONTINUUM_HEALTH_URL="http://127.0.0.1:8787/api/health"
readonly TORII_REGISTRY="/opt/torii/registry.json"
readonly TORII_ROOT_APP_CONF="/opt/torii/root_app.conf"
# Public launcher webroot that nginx serves at `/` and `/assets/`. Static-only
# (index.html + assets); it holds no secrets, so it must be world-readable. Scoped
# strictly here so mode enforcement never touches /opt/torii/env, registry.json,
# or root_app.conf (secrets/config live at the /opt/torii top level, not under it).
readonly LAUNCHER_WEBROOT="/opt/torii/launcher"
readonly PUBLIC_DIR_MODE="0755"
readonly PUBLIC_FILE_MODE="0644"
readonly CONTINUUM_CONF="/etc/torii/continuum-deploy.conf"
readonly TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly RUN_ROOT="/root/torii-final-cutover-${TIMESTAMP}"
# How many timestamped /root/torii-final-cutover-* staging dirs to keep after a
# SUCCESSFUL cutover (the newest N, which always includes this run's RUN_ROOT).
# Each run leaves a ~629M dir (clone + node_modules); they were never pruned, so
# repeated attempts accumulated 2.5G+ and the unattended deploy hit ENOSPC at
# `npm ci` on a 15G host. See prune_old_staging_dirs().
readonly KEEP_STAGING_DIRS=1
# Preflight free-space floor (MiB) required on every filesystem we clone into,
# back up onto, or npm-install under, checked BEFORE any mutation. The live
# ENOSPC-at-`npm ci` failure (a 15G host with accumulated staging dirs) proves a
# space-starved run must fail closed up front rather than half-apply a cutover
# and then die mid-install. Each staging run needs ~629M (clone + node_modules)
# plus the base backup tar and preview stage; 2048 MiB is a conservative floor.
readonly PREFLIGHT_MIN_FREE_MB=2048
# Non-fatal capacity warning threshold (percent used). A host that still clears
# the 2 GiB floor but is >= this full gets a WARN nudging the operator to run the
# disk-retention sweep (ops/torii-disk-retention.sh). Never blocks the cutover.
readonly PREFLIGHT_WARN_PCT=80
# Filesystems that must have headroom before we touch anything: the staging root
# (/root), the app/npm target (/home), the base install (/opt), and the webroot
# (/var/www). Deduped by mountpoint at check time so multiple paths on one FS are
# only counted once.
readonly PREFLIGHT_PATHS=(/root /home /opt /var/www)
readonly SRC_ROOT="${RUN_ROOT}/src"
readonly BACKUP_ROOT="${RUN_ROOT}/backup"
readonly LOG_ROOT="${RUN_ROOT}/logs"
readonly STATE_ROOT="${RUN_ROOT}/state"
readonly SUMMARY_FILE="${RUN_ROOT}/cutover-summary.txt"
readonly NGINX_HITS_FILE="${STATE_ROOT}/preview-nginx-hits.txt"
readonly BASE_BACKUP_TAR="${BACKUP_ROOT}/torii-base-backup.tar"
readonly BASE_ABSENT_LIST="${BACKUP_ROOT}/torii-base-absent.txt"
readonly CONTINUUM_CONF_BACKUP="${BACKUP_ROOT}/continuum-deploy.conf.before"
# Cache / build-artifact globs excluded from the rollback backup tar. These are
# regenerable (npm/pip caches, build output, VCS metadata) and can dominate the
# archive size, so backing them up wastes the very disk this cutover is trying to
# protect. Scoped to regenerable artifacts ONLY — never config/state: the tar
# still captures /opt/torii/env, registry.json and root_app.conf byte-for-byte.
readonly BACKUP_EXCLUDES=(
  '--exclude=*/node_modules'
  '--exclude=*/.git'
  '--exclude=*/.cache'
  '--exclude=*/.npm'
  '--exclude=*/dist'
  '--exclude=*/.vite'
)

BASE_MUTATED=0
CONTINUUM_PIN_CHANGED=0
PREVIEW_SWAPPED=0
ROLLBACK_ACTIVE=0
PREVIEW_LAYOUT=""
PREVIEW_PUBLIC_URL=""
PREVIEW_LIVE_PATH=""
PREVIEW_PREV_PATH=""
PREVIEW_STAGE_PATH=""
PREVIEW_RELEASE_PARENT=""
PREVIEW_OWNER="0"
PREVIEW_GROUP="0"
PREVIEW_DIR_MODE="0755"
PREVIEW_FILE_MODE="0644"
PREVIEW_ROOT_PUBLIC_OK=0
PREVIEW_CONT_PUBLIC_OK=0
PREVIEW_ROOT_CFG_HIT=0
PREVIEW_CONT_CFG_HIT=0
PREVIEW_ROOT_FS_OK=0
PREVIEW_CONT_FS_OK=0
PRE_ROOT_APP=""
PRE_APP_NAMES=""
PRE_CONTINUUM_TARGET_TAG=""
BASE_SRC="${SRC_ROOT}/torii-base-${BASE_TAG}"
CONTINUUM_SRC="${SRC_ROOT}/torii-continuum-${CONTINUUM_TAG}"

log() {
  printf '[cutover] %s\n' "$*"
}

die() {
  printf '[cutover] FATAL: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command missing: $1"
}

# Preflight: refuse to start unless every filesystem we will clone into, back up
# onto, or npm-install under has at least PREFLIGHT_MIN_FREE_MB free. Runs FIRST
# in main — before verify_release_sources clones anything and before any live
# mutation — so a space-starved host fails closed up front instead of half-
# applying the cutover and dying mid-`npm ci` (the live ENOSPC failure). Paths
# are deduped by mountpoint so co-located targets are only counted once.
preflight_free_space() {
  require_cmd df
  local -A seen_mounts=()
  local path mount avail_mb
  for path in "${PREFLIGHT_PATHS[@]}"; do
    # Resolve to an existing ancestor so df has something to report on even if a
    # leaf (e.g. /var/www) does not exist yet on a fresh host.
    local probe="$path"
    while [[ ! -e "$probe" && "$probe" != "/" ]]; do
      probe="$(dirname -- "$probe")"
    done
    mount="$(df -P -- "$probe" | awk 'NR==2 {print $6}')"
    [[ -n "$mount" ]] || continue
    [[ -n "${seen_mounts[$mount]:-}" ]] && continue
    seen_mounts[$mount]=1
    avail_mb="$(df -Pm -- "$probe" | awk 'NR==2 {print $4}')"
    [[ "$avail_mb" =~ ^[0-9]+$ ]] || die "could not read free space for ${path} (mount ${mount})"
    if (( avail_mb < PREFLIGHT_MIN_FREE_MB )); then
      die "insufficient free space on ${mount} (${avail_mb} MiB free, need ${PREFLIGHT_MIN_FREE_MB} MiB) — free space before cutover"
    fi
    # Non-fatal capacity warning: at/above PREFLIGHT_WARN_PCT the host is getting
    # tight even though it still clears the hard 2 GiB floor above. This is an
    # early signal to run the disk-retention sweep; it never blocks the cutover.
    local used_pct
    used_pct="$(df -P -- "$probe" | awk 'NR==2 {gsub("%","",$5); print $5}')"
    if [[ "$used_pct" =~ ^[0-9]+$ ]] && (( used_pct >= PREFLIGHT_WARN_PCT )); then
      log "WARN filesystem ${mount} is ${used_pct}% full (>= ${PREFLIGHT_WARN_PCT}%); free space soon (see ops/torii-disk-retention.sh)"
    fi
    log "Preflight free space OK on ${mount}: ${avail_mb} MiB (>= ${PREFLIGHT_MIN_FREE_MB} MiB, ${used_pct:-?}% used)"
  done
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  [[ "$actual" == "$expected" ]] || die "${label}: expected '${expected}', got '${actual}'"
}

append_summary() {
  printf '%s\n' "$*" >> "$SUMMARY_FILE"
}

json_field() {
  local field="$1"
  python3 -c 'import json, sys
field = sys.argv[1]
data = json.load(sys.stdin)
value = data.get(field)
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
' "$field"
}

json_field_from_file() {
  local file="$1" field="$2"
  python3 - "$file" "$field" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
field = sys.argv[2]
if not path.exists():
    print("")
    raise SystemExit(0)
data = json.loads(path.read_text())
value = data.get(field)
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

registry_app_names() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit(0)
data = json.loads(path.read_text())
apps = data.get("apps") or []
names = []
for item in apps:
    if isinstance(item, dict) and isinstance(item.get("name"), str):
        names.append(item["name"])
print(",".join(sorted(dict.fromkeys(names))))
PY
}

http_code() {
  local url="$1"
  curl -L -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true
}

url_contains() {
  local url="$1" needle="$2"
  local body
  body="$(curl -L -fsS --max-time 20 "$url")" || return 1
  grep -Fq -- "$needle" <<<"$body"
}

wait_url_contains() {
  local url="$1" needle="$2" tries="$3" delay="$4"
  local i
  for ((i=1; i<=tries; i++)); do
    if url_contains "$url" "$needle"; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

# Normalise HTML/text for CTA detection: tags -> spaces, collapse whitespace,
# lowercase. Makes CTA matching tolerant of the icon <svg>/<span> markup the
# button label is wrapped in, plus incidental whitespace/case differences.
normalize_cta_text() {
  sed -e 's/<[^>]*>/ /g' | tr '\n\r\t' '   ' | tr -s ' ' | tr '[:upper:]' '[:lower:]'
}

# Pure, network-free CTA test over a blob of HTML/text. Robustly matches the
# onboarding sign-in CTA intent via PREVIEW_CTA_REGEX after normalisation, so
# reworded-but-valid CTAs pass and blank/error pages fail closed.
text_has_cta() {
  local text="$1" norm
  norm="$(printf '%s' "$text" | normalize_cta_text)"
  grep -Eq "$PREVIEW_CTA_REGEX" <<<"$norm"
}

# Fetch a URL and robustly test it for the onboarding CTA (fail-closed on any
# curl error). Replaces the old exact-substring url_contains for CTA checks.
url_has_cta() {
  local url="$1" body
  body="$(curl -L -fsS --max-time 20 "$url")" || return 1
  text_has_cta "$body"
}

wait_url_has_cta() {
  local url="$1" tries="$2" delay="$3"
  local i
  for ((i=1; i<=tries; i++)); do
    if url_has_cta "$url"; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

wait_json_version() {
  local url="$1" expected="$2" tries="$3" delay="$4"
  local i body version
  for ((i=1; i<=tries; i++)); do
    body="$(curl -fsS --max-time 10 "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      version="$(printf '%s' "$body" | json_field version 2>/dev/null || true)"
      if [[ "$version" == "$expected" ]]; then
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

# Clone exactly one annotated tag over a shallow fetch and refuse anything that
# is not an annotated tag object (a lightweight tag or a moved branch fails here).
#
# The checkout runs under a PUBLIC umask (022), not the root-only 077 used for
# backups/state. torii-base's bootstrap installs its public webroot with `cp -a`
# (mode-preserving), so a working tree checked out under 077 would arrive in
# /opt/torii/launcher as 0600 files / 0700 dirs and nginx would answer HTTP 403.
# These are public source repos with no secrets, and the tree sits under the
# root-only RUN_ROOT, so a world-readable working copy is safe.
clone_annotated_tag() {
  local repo="$1" tag="$2" dest="$3"
  rm -rf -- "$dest"
  mkdir -p "$dest"
  local prev_umask; prev_umask="$(umask)"
  umask 022
  git -C "$dest" init -q
  git -C "$dest" remote add origin "$repo"
  git -C "$dest" fetch -q --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
  if [[ "$(git -C "$dest" cat-file -t "refs/tags/${tag}")" != "tag" ]]; then
    umask "$prev_umask"
    die "${repo} ${tag} is not an annotated tag"
  fi
  git -C "$dest" checkout -q "tags/${tag}"
  umask "$prev_umask"
}

record_absent() {
  local path="$1"
  printf '%s\n' "$path" >> "$BASE_ABSENT_LIST"
}

backup_torii_base_state() {
  mkdir -p "$BACKUP_ROOT"
  : > "$BASE_ABSENT_LIST"
  local -a existing=()
  local item
  for item in \
    /opt/torii \
    /etc/nginx/sites-available/torii.conf \
    /etc/nginx/sites-enabled/torii.conf \
    /etc/nginx/sites-enabled/default \
    /etc/systemd/system/torii-base-sidecar.service \
    /usr/local/bin/torii \
    /etc/sudoers.d/torii-nginx
  do
    if [[ -e "$item" || -L "$item" ]]; then
      existing+=("$item")
    else
      record_absent "$item"
    fi
  done
  if ((${#existing[@]} > 0)); then
    tar -cpf "$BASE_BACKUP_TAR" --numeric-owner --xattrs --acls "${BACKUP_EXCLUDES[@]}" "${existing[@]}"
  else
    : > "$BASE_BACKUP_TAR"
  fi
  if [[ -f "$CONTINUUM_CONF" ]]; then
    cp -a -- "$CONTINUUM_CONF" "$CONTINUUM_CONF_BACKUP"
  fi
}

restore_torii_base_backup() {
  log "Restoring torii-base backup"
  if [[ -s "$BASE_BACKUP_TAR" ]]; then
    tar -xpf "$BASE_BACKUP_TAR" -C /
  fi
  if [[ -f "$BASE_ABSENT_LIST" ]]; then
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      rm -rf -- "$path"
    done < "$BASE_ABSENT_LIST"
  fi
  systemctl daemon-reload || true
  if [[ -f /etc/systemd/system/torii-base-sidecar.service ]]; then
    systemctl restart torii-base-sidecar.service || true
  fi
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || true
    else
      log "WARN nginx -t failed after torii-base restore"
    fi
  fi
}

restore_continuum_pin() {
  if [[ -f "$CONTINUUM_CONF_BACKUP" ]]; then
    cp -a -- "$CONTINUUM_CONF_BACKUP" "$CONTINUUM_CONF"
  elif [[ -n "$PRE_CONTINUUM_TARGET_TAG" && -f "$CONTINUUM_CONF" ]]; then
    set_conf_value "$CONTINUUM_CONF" CONTINUUM_TARGET_TAG "$PRE_CONTINUUM_TARGET_TAG"
  fi
}

restore_preview() {
  [[ -n "$PREVIEW_LIVE_PATH" ]] || return 0
  log "Restoring onboarding preview rollback path"
  case "$PREVIEW_LAYOUT" in
    root-symlink)
      if [[ -L "$PREVIEW_PREV_PATH" ]]; then
        rm -f -- "$PREVIEW_LIVE_PATH"
        mv -T -- "$PREVIEW_PREV_PATH" "$PREVIEW_LIVE_PATH" || return 1
      else
        return 1
      fi
      ;;
    continuum-dir)
      if [[ -d "$PREVIEW_PREV_PATH" ]]; then
        rm -rf -- "$PREVIEW_LIVE_PATH"
        mv -- "$PREVIEW_PREV_PATH" "$PREVIEW_LIVE_PATH" || return 1
      else
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

# Roll back every mutation that was actually performed, in reverse order. Made
# reentrant with a guard so it runs exactly once no matter which path triggers it
# (ERR trap, EXIT trap, or an explicit die/exit). `set +e` keeps a failing
# restore step from aborting the remaining restores. This function never exits —
# it always returns to its caller (on_exit), which owns the final exit code.
rollback() {
  local rc="$1"
  (( ROLLBACK_ACTIVE == 1 )) && return 0
  ROLLBACK_ACTIVE=1
  trap - ERR
  set +e
  if (( BASE_MUTATED == 0 && CONTINUUM_PIN_CHANGED == 0 && PREVIEW_SWAPPED == 0 )); then
    log "Failed before any live mutation (exit ${rc}); nothing to roll back"
    return 0
  fi
  log "Failure detected (exit ${rc}); rolling back live mutations"
  if (( PREVIEW_SWAPPED == 1 )); then
    if ! restore_preview; then
      log "WARN preview rollback failed; inspect ${PREVIEW_PREV_PATH}"
    fi
  fi
  if (( CONTINUUM_PIN_CHANGED == 1 )); then
    if ! restore_continuum_pin; then
      log "WARN continuum pin restore failed; inspect ${CONTINUUM_CONF}"
    fi
  fi
  if (( BASE_MUTATED == 1 )); then
    if ! restore_torii_base_backup; then
      log "WARN torii-base rollback failed; inspect ${BACKUP_ROOT}"
    fi
  fi
  log "Check journals with: journalctl -u torii-base-sidecar.service -u torii-continuum-deploy.service -u continuum-agent.service -n 200 --no-pager"
  return 0
}

# ERR trap: annotate the failing line, then exit; the EXIT trap performs the
# rollback. A bare failing command triggers this under set -e.
on_err() {
  local rc="$1" line="$2"
  printf '[cutover] ERROR at line %s (exit %s)\n' "$line" "$rc" >&2
  exit "$rc"
}

# EXIT trap: the single, robust rollback chokepoint. It fires for EVERY exit path
# — an explicit `die`/`exit` (which do NOT trigger ERR), a `cmd || die`
# short-circuit, a set -e abort, or normal completion — so no post-mutation
# failure can slip past rollback the way the old `die(){ exit 1; }` path did in
# the live run (HTTP 403 → die → exit with no rollback).
on_exit() {
  local rc=$?
  trap - EXIT ERR
  if (( rc != 0 )); then
    rollback "$rc"
  fi
  exit "$rc"
}
trap 'on_err $? $LINENO' ERR
trap on_exit EXIT

set_conf_value() {
  local file="$1" key="$2" value="$3"
  python3 - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines()
out = []
replaced = False
prefix = key + "="
for line in lines:
    if line.startswith(prefix):
        out.append(f"{key}={value}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
}

current_conf_value() {
  local file="$1" key="$2"
  python3 - "$file" "$key" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
prefix = key + "="
if not path.exists():
    print("")
    raise SystemExit(0)
for line in path.read_text().splitlines():
    if line.startswith(prefix):
        print(line[len(prefix):])
        break
else:
    print("")
PY
}

preview_config_hit() {
  local regex="$1"
  local dir
  for dir in /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d /opt/torii/nginx-fragments; do
    [[ -d "$dir" ]] || continue
    if grep -RqsE -- "$regex" "$dir"; then
      return 0
    fi
  done
  return 1
}

collect_preview_nginx_hits() {
  mkdir -p "$STATE_ROOT"
  : > "$NGINX_HITS_FILE"
  local dir
  for dir in /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d /opt/torii/nginx-fragments; do
    [[ -d "$dir" ]] || continue
    grep -RInE -- 'onboarding-preview|continuum/onboarding-preview|/var/www/torii/onboarding-preview|/var/www/torii/continuum/onboarding-preview' "$dir" >> "$NGINX_HITS_FILE" 2>/dev/null || true
  done
}

preview_root_target() {
  readlink -f -- "$PREVIEW_ROOT_PATH"
}

stat_owner_group() {
  local path="$1"
  stat -c '%u:%g' -- "$path"
}

# Force a public static tree to safe, world-readable modes: traversable dirs and
# readable files. Strictly scoped to the given root — it never widens anything
# outside it, so it is safe to run near (but never on) secret/config paths.
set_public_tree_modes() {
  local root="$1" dir_mode="$2" file_mode="$3"
  [[ -d "$root" ]] || die "cannot set modes: ${root} is not a directory"
  find "$root" -type d -exec chmod "$dir_mode" {} +
  find "$root" -type f -exec chmod "$file_mode" {} +
}

# Defence-in-depth after the sanctioned bootstrap: force the public launcher
# webroot to 0755 dirs / 0644 files so nginx can serve it even if a future
# bootstrap regresses a mode. Scoped to LAUNCHER_WEBROOT only; /opt/torii/env,
# registry.json and root_app.conf live above it and are never touched.
enforce_public_static_modes() {
  [[ -d "$LAUNCHER_WEBROOT" ]] || die "launcher webroot missing after bootstrap: ${LAUNCHER_WEBROOT}"
  set_public_tree_modes "$LAUNCHER_WEBROOT" "$PUBLIC_DIR_MODE" "$PUBLIC_FILE_MODE"
}

prepare_preview_permissions() {
  local stage="$1"
  # The stage dir is created via `mktemp -d` under the root-only umask (077), so
  # it starts at 0700; this normalises it (and the copied payload) back to public
  # modes before the atomic swap, closing the same 403 hazard for the preview.
  set_public_tree_modes "$stage" "$PREVIEW_DIR_MODE" "$PREVIEW_FILE_MODE"
  chown -R -- "$PREVIEW_OWNER:$PREVIEW_GROUP" "$stage"
}

# Decide which of the two documented preview layouts is actually live, and refuse
# to act unless exactly one is unambiguously serving the expected CTA. Ambiguity
# or absence is fatal — never guess with live state.
resolve_preview_layout() {
  collect_preview_nginx_hits
  PREVIEW_ROOT_PUBLIC_OK=0
  PREVIEW_CONT_PUBLIC_OK=0
  PREVIEW_ROOT_CFG_HIT=0
  PREVIEW_CONT_CFG_HIT=0
  PREVIEW_ROOT_FS_OK=0
  PREVIEW_CONT_FS_OK=0

  if url_has_cta "$PREVIEW_ROOT_URL"; then PREVIEW_ROOT_PUBLIC_OK=1; fi
  if url_has_cta "$PREVIEW_CONTINUUM_URL"; then PREVIEW_CONT_PUBLIC_OK=1; fi
  if preview_config_hit '(^|[^A-Za-z0-9_./-])/onboarding-preview/?([[:space:];{]|$)|/var/www/torii/onboarding-preview'; then PREVIEW_ROOT_CFG_HIT=1; fi
  if preview_config_hit '/continuum/onboarding-preview|/var/www/torii/continuum/onboarding-preview'; then PREVIEW_CONT_CFG_HIT=1; fi
  if [[ -L "$PREVIEW_ROOT_PATH" ]]; then PREVIEW_ROOT_FS_OK=1; fi
  if [[ -d "$PREVIEW_CONTINUUM_PATH" && ! -L "$PREVIEW_CONTINUUM_PATH" ]]; then PREVIEW_CONT_FS_OK=1; fi

  if (( PREVIEW_ROOT_PUBLIC_OK == 1 && PREVIEW_CONT_PUBLIC_OK == 1 )); then
    die "preview URL detection is ambiguous: both public URLs serve the expected CTA"
  fi
  if (( PREVIEW_ROOT_PUBLIC_OK == 0 && PREVIEW_CONT_PUBLIC_OK == 0 )); then
    die "preview URL detection failed: neither public URL serves the expected CTA"
  fi

  if (( PREVIEW_ROOT_PUBLIC_OK == 1 )); then
    (( PREVIEW_ROOT_FS_OK == 1 )) || die "root preview URL is live but ${PREVIEW_ROOT_PATH} is not the expected symlink layout"
    if (( PREVIEW_CONT_PUBLIC_OK == 1 || (PREVIEW_CONT_CFG_HIT == 1 && PREVIEW_CONT_FS_OK == 1) )); then
      die "preview layout is ambiguous: root URL is live but continuum path also looks active"
    fi
    PREVIEW_LAYOUT="root-symlink"
    PREVIEW_PUBLIC_URL="$PREVIEW_ROOT_URL"
    PREVIEW_LIVE_PATH="$PREVIEW_ROOT_PATH"
    PREVIEW_PREV_PATH="${PREVIEW_ROOT_PATH}.prev"
    local live_target
    live_target="$(preview_root_target)"
    PREVIEW_RELEASE_PARENT="$(dirname -- "$live_target")"
    IFS=: read -r PREVIEW_OWNER PREVIEW_GROUP <<<"$(stat_owner_group "$live_target")"
    PREVIEW_DIR_MODE="$(stat -c '%a' -- "$live_target")"
  else
    (( PREVIEW_CONT_FS_OK == 1 )) || die "continuum preview URL is live but ${PREVIEW_CONTINUUM_PATH} is not the expected directory layout"
    if (( PREVIEW_ROOT_PUBLIC_OK == 1 || (PREVIEW_ROOT_CFG_HIT == 1 && PREVIEW_ROOT_FS_OK == 1) )); then
      die "preview layout is ambiguous: continuum URL is live but root path also looks active"
    fi
    PREVIEW_LAYOUT="continuum-dir"
    PREVIEW_PUBLIC_URL="$PREVIEW_CONTINUUM_URL"
    PREVIEW_LIVE_PATH="$PREVIEW_CONTINUUM_PATH"
    PREVIEW_PREV_PATH="${PREVIEW_CONTINUUM_PATH}.prev"
    PREVIEW_RELEASE_PARENT="$(dirname -- "$PREVIEW_CONTINUUM_PATH")"
    IFS=: read -r PREVIEW_OWNER PREVIEW_GROUP <<<"$(stat_owner_group "$PREVIEW_CONTINUUM_PATH")"
    PREVIEW_DIR_MODE="$(stat -c '%a' -- "$PREVIEW_CONTINUUM_PATH")"
  fi

  PREVIEW_FILE_MODE="0644"
}

copy_preview_payload() {
  local src="$1" stage="$2"
  cp -a -- "$src/." "$stage/"
  prepare_preview_permissions "$stage"
}

swap_preview_root_symlink() {
  local src="$1"
  local stage_release new_link
  stage_release="$(mktemp -d --tmpdir="$PREVIEW_RELEASE_PARENT" ".onboarding-preview-${TIMESTAMP}.XXXXXX")"
  PREVIEW_STAGE_PATH="$stage_release"
  copy_preview_payload "$src" "$stage_release"
  new_link="${PREVIEW_LIVE_PATH}.next"
  rm -f -- "$new_link"
  ln -s -- "$stage_release" "$new_link"
  rm -rf -- "$PREVIEW_PREV_PATH"
  mv -T -- "$PREVIEW_LIVE_PATH" "$PREVIEW_PREV_PATH"
  if ! mv -T -- "$new_link" "$PREVIEW_LIVE_PATH"; then
    rm -f -- "$new_link"
    mv -T -- "$PREVIEW_PREV_PATH" "$PREVIEW_LIVE_PATH" || true
    die "failed to promote new onboarding preview symlink"
  fi
  PREVIEW_SWAPPED=1
}

swap_preview_continuum_dir() {
  local src="$1"
  local stage
  stage="$(mktemp -d --tmpdir="$PREVIEW_RELEASE_PARENT" ".onboarding-preview-${TIMESTAMP}.XXXXXX")"
  PREVIEW_STAGE_PATH="$stage"
  copy_preview_payload "$src" "$stage"
  rm -rf -- "$PREVIEW_PREV_PATH"
  mv -- "$PREVIEW_LIVE_PATH" "$PREVIEW_PREV_PATH"
  if ! mv -- "$stage" "$PREVIEW_LIVE_PATH"; then
    mv -- "$PREVIEW_PREV_PATH" "$PREVIEW_LIVE_PATH" || true
    die "failed to promote new onboarding preview directory"
  fi
  PREVIEW_SWAPPED=1
}

capture_pre_state() {
  PRE_ROOT_APP="$(json_field_from_file "$TORII_REGISTRY" root_app)"
  PRE_APP_NAMES="$(registry_app_names "$TORII_REGISTRY")"
  PRE_CONTINUUM_TARGET_TAG="$(current_conf_value "$CONTINUUM_CONF" CONTINUUM_TARGET_TAG)"
}

verify_release_sources() {
  require_cmd git
  require_cmd curl
  require_cmd python3
  require_cmd systemctl
  require_cmd nginx
  require_cmd tar
  require_cmd mktemp
  require_cmd grep
  require_cmd sed
  require_cmd find
  require_cmd cp
  require_cmd mv
  require_cmd chown
  require_cmd chmod
  require_cmd ansible-playbook

  mkdir -p "$SRC_ROOT" "$BACKUP_ROOT" "$LOG_ROOT" "$STATE_ROOT"

  clone_annotated_tag "$BASE_REPO" "$BASE_TAG" "$BASE_SRC"
  clone_annotated_tag "$CONTINUUM_REPO" "$CONTINUUM_TAG" "$CONTINUUM_SRC"

  bash -n "$BASE_SRC/bootstrap.sh"
  bash -n "$CONTINUUM_SRC/ops/deploy-bootstrap.sh"
  bash -n "$CONTINUUM_SRC/ops/deploy-unattended.sh"

  assert_eq "$BASE_VERSION" "$(tr -d '\n' < "$BASE_SRC/VERSION")" "torii-base VERSION"
  assert_eq "$BASE_VERSION" "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$BASE_SRC/sidecar/package.json")" "torii-base sidecar package version"
  grep -Fq "const VERSION = '${BASE_VERSION}';" "$BASE_SRC/sidecar/index.mjs" || die "torii-base sidecar index version marker missing"
  grep -Fq 'Continuum amber' "$BASE_SRC/launcher/assets/launcher.css" || die "torii-base launcher amber marker missing"

  assert_eq "$CONTINUUM_VERSION" "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$CONTINUUM_SRC/package.json")" "torii-continuum root package version"
  assert_eq "$CONTINUUM_VERSION" "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$CONTINUUM_SRC/agent/package.json")" "torii-continuum agent package version"
  [[ -f "$CONTINUUM_SRC/ops/systemd/torii-continuum-deploy.service" ]] || die "continuum deploy service missing"
  [[ -f "$CONTINUUM_SRC/ops/deploy-bootstrap.sh" ]] || die "continuum deploy bootstrap missing"

  assert_eq "$PREVIEW_VERSION" "$(tr -d '\n' < "$CONTINUUM_SRC/preview-assets/${PREVIEW_DIR_NAME}/VERSION")" "onboarding preview VERSION"
  text_has_cta "$(cat "$CONTINUUM_SRC/preview-assets/${PREVIEW_DIR_NAME}/index.html")" || die "onboarding preview CTA marker missing"
}

deploy_torii_base() {
  log "Backing up torii-base state"
  backup_torii_base_state
  capture_pre_state
  BASE_MUTATED=1
  log "Deploying torii-base ${BASE_TAG} via sanctioned bootstrap"
  # Run the bootstrap under a PUBLIC umask (022) in a subshell so any file it
  # creates directly defaults to world-readable modes. The subshell isolates the
  # umask change; the script's root-only 077 default is restored on return.
  (
    umask 022
    DEBIAN_FRONTEND=noninteractive \
    APT_LISTCHANGES_FRONTEND=none \
    NEEDRESTART_MODE=a \
    TORII_DOMAIN="$DOMAIN" \
    SKIP_CERTBOT=1 \
    bash "$BASE_SRC/bootstrap.sh"
  )
  log "Enforcing public modes on ${LAUNCHER_WEBROOT} (0755 dirs / 0644 files)"
  enforce_public_static_modes
}

validate_torii_base() {
  log "Validating torii-base"
  wait_json_version "$SIDECAR_HEALTH_URL" "$BASE_VERSION" 20 2 || die "torii-base sidecar health did not report ${BASE_VERSION}"
  local post_root_app post_app_names launcher_code
  post_root_app="$(json_field_from_file "$TORII_REGISTRY" root_app)"
  post_app_names="$(registry_app_names "$TORII_REGISTRY")"
  [[ "$post_root_app" == "$PRE_ROOT_APP" ]] || die "root_app changed across torii-base deployment"
  [[ "$post_app_names" == "$PRE_APP_NAMES" ]] || die "registry app names changed across torii-base deployment"
  nginx -t >/dev/null
  launcher_code="$(http_code "$ROOT_URL")"
  [[ "$launcher_code" == "200" ]] || die "public launcher probe failed with HTTP ${launcher_code}"
  url_contains "$LAUNCHER_ASSET_URL" 'Continuum amber' || die "public launcher amber asset marker missing"
}

bootstrap_and_deploy_continuum() {
  log "Bootstrapping Continuum unattended deploy"
  # OPS-CUTOVER-3: install the timer but DO NOT enable it here. Enabling the
  # recurring timer before a first successful converge means a broken deploy
  # (e.g. the v0.2.59-alpha `continuum_user is undefined` failure) would be
  # retried every 5 min — a retry storm against a known-bad config. We run the
  # first converge MANUALLY below, health-gate it, and only enable_deploy_timer()
  # at the very end of a fully successful cutover. A failure anywhere leaves the
  # timer disabled, so rollback cannot resurrect a retry loop.
  bash "$CONTINUUM_SRC/ops/deploy-bootstrap.sh" --no-enable-timer
  [[ -f "$CONTINUUM_CONF" ]] || die "continuum deploy config missing after bootstrap"
  cp -a -- "$CONTINUUM_CONF" "$CONTINUUM_CONF_BACKUP"
  CONTINUUM_PIN_CHANGED=1
  set_conf_value "$CONTINUUM_CONF" CONTINUUM_TARGET_TAG "$CONTINUUM_TAG"
  set_conf_value "$CONTINUUM_CONF" CONTINUUM_DOMAIN "$DOMAIN"
  set_conf_value "$CONTINUUM_CONF" CONTINUUM_REPO "$CONTINUUM_REPO"
  chown root:root "$CONTINUUM_CONF"
  chmod 0600 "$CONTINUUM_CONF"
  systemctl daemon-reload
  log "Triggering first manual converge via torii-continuum-deploy.service"
  systemctl start torii-continuum-deploy.service
  systemctl --no-pager --full status torii-continuum-deploy.service > "${LOG_ROOT}/torii-continuum-deploy.service.status.txt" 2>&1 || true
  wait_json_version "$CONTINUUM_HEALTH_URL" "$CONTINUUM_VERSION" 30 2 || die "continuum health did not report ${CONTINUUM_VERSION}"
}

# enable_deploy_timer — turn on the recurring unattended timer, but ONLY after a
# fully successful cutover (last step of main). Reached only past every health
# gate, so the timer never activates against a config that has not already
# converged once. If the cutover fails earlier, this never runs and the timer
# stays installed-but-disabled (no retry storm).
enable_deploy_timer() {
  log "Enabling torii-continuum-deploy.timer after successful first converge"
  systemctl enable --now torii-continuum-deploy.timer
}

deploy_preview() {
  resolve_preview_layout
  log "Deploying onboarding preview ${PREVIEW_VERSION} to ${PREVIEW_LAYOUT}"
  case "$PREVIEW_LAYOUT" in
    root-symlink)
      swap_preview_root_symlink "$CONTINUUM_SRC/preview-assets/${PREVIEW_DIR_NAME}"
      ;;
    continuum-dir)
      swap_preview_continuum_dir "$CONTINUUM_SRC/preview-assets/${PREVIEW_DIR_NAME}"
      ;;
    *)
      die "unknown preview layout: ${PREVIEW_LAYOUT}"
      ;;
  esac
  wait_url_has_cta "$PREVIEW_PUBLIC_URL" 20 2 || die "public preview URL failed post-deploy CTA check"
}

write_report() {
  local sidecar_json continuum_json launcher_code continuum_code preview_code
  sidecar_json="$(curl -fsS "$SIDECAR_HEALTH_URL")"
  continuum_json="$(curl -fsS "$CONTINUUM_HEALTH_URL")"
  launcher_code="$(http_code "$ROOT_URL")"
  continuum_code="$(http_code "$CONTINUUM_PUBLIC_URL")"
  preview_code="$(http_code "$PREVIEW_PUBLIC_URL")"

  : > "$SUMMARY_FILE"
  append_summary "Torii final cutover completed at ${TIMESTAMP}"
  append_summary "Backup root: ${BACKUP_ROOT}"
  append_summary "Preview rollback path: ${PREVIEW_PREV_PATH}"
  append_summary "Preview layout: ${PREVIEW_LAYOUT}"
  append_summary "Preview public URL: ${PREVIEW_PUBLIC_URL}"
  append_summary ""
  append_summary "Services"
  append_summary "  torii-base-sidecar.service: $(systemctl is-active torii-base-sidecar.service) / $(systemctl is-enabled torii-base-sidecar.service)"
  append_summary "  continuum-agent.service: $(systemctl is-active continuum-agent.service) / $(systemctl is-enabled continuum-agent.service)"
  append_summary "  torii-continuum-deploy.service result: $(systemctl show -p Result --value torii-continuum-deploy.service)"
  append_summary "  torii-continuum-deploy.timer: $(systemctl is-active torii-continuum-deploy.timer) / $(systemctl is-enabled torii-continuum-deploy.timer)"
  append_summary ""
  append_summary "Versions"
  append_summary "  torii-base sidecar: $(printf '%s' "$sidecar_json" | json_field version)"
  append_summary "  torii-continuum agent: $(printf '%s' "$continuum_json" | json_field version)"
  append_summary "  onboarding preview: $(tr -d '\n' < "${PREVIEW_LIVE_PATH}/VERSION")"
  append_summary ""
  append_summary "Public probes"
  append_summary "  ${ROOT_URL} -> HTTP ${launcher_code}"
  append_summary "  ${CONTINUUM_PUBLIC_URL} -> HTTP ${continuum_code}"
  append_summary "  ${PREVIEW_PUBLIC_URL} -> HTTP ${preview_code}"
  append_summary ""
  append_summary "Timer"
  systemctl list-timers --all torii-continuum-deploy.timer --no-pager >> "$SUMMARY_FILE" 2>/dev/null || true
  append_summary ""
  append_summary "Disk"
  df -h / /var/www /opt /home >> "$SUMMARY_FILE"

  cat "$SUMMARY_FILE"
}

cleanup_success() {
  rm -rf -- "$SRC_ROOT"
}

# prune_old_staging_dirs — after a SUCCESSFUL cutover, keep only the newest N
# /root/torii-final-cutover-* staging dirs and explicitly remove the older ones,
# so repeated runs cannot accumulate (each is ~629M) and exhaust the disk (the
# ENOSPC-at-`npm ci` failure this addresses). Placed LAST in main so a FAILED
# cutover never reaches here and its newest staging dir survives for inspection.
#
# Safety:
#   - Enumeration is explicit and NUL-safe via `find` (a bare
#     `rm /root/torii-final-cutover-*` glob does NOT reliably expand in every
#     shell and could delete nothing — or the wrong thing).
#   - Scoped to /root at depth 1, name torii-final-cutover-*, dirs only — it can
#     never reach /home/continuum/app, the live webroot /var/www/torii/continuum,
#     or anything outside this staging namespace.
#   - RUN_ROOT (the just-created dir) is skipped unconditionally, so even a
#     misconfigured keep count can never remove the current run.
prune_old_staging_dirs() {
  local keep="$KEEP_STAGING_DIRS"
  local -a dirs=()
  local d
  # Newest-first: the timestamped names (YYYYMMDDTHHMMSSZ) sort lexically by age.
  while IFS= read -r -d '' d; do
    dirs+=("$d")
  done < <(find /root -maxdepth 1 -type d -name 'torii-final-cutover-*' -print0 | sort -zr)

  local rank=0
  for d in "${dirs[@]}"; do
    if [[ "$d" == "$RUN_ROOT" ]]; then
      log "Keeping current staging dir: ${d}"
      continue
    fi
    rank=$((rank + 1))
    if (( rank < keep )); then
      log "Keeping recent staging dir: ${d}"
      continue
    fi
    log "Pruning stale staging dir: ${d}"
    rm -rf -- "$d"
  done
}

main() {
  log "Starting final VPS cutover for ${DOMAIN}"
  log "Run directory (root-only): ${RUN_ROOT}"
  preflight_free_space
  verify_release_sources
  deploy_torii_base
  validate_torii_base
  bootstrap_and_deploy_continuum
  deploy_preview
  write_report
  enable_deploy_timer
  cleanup_success
  trap - ERR
  # LAST step: only a fully successful cutover reaches here, so a failed run
  # always leaves its newest staging dir behind for inspection.
  prune_old_staging_dirs
  log "Cutover complete. Backup: ${BACKUP_ROOT}  Preview rollback: ${PREVIEW_PREV_PATH}"
}

main "$@"
}
# === torii-final-cutover.sh: end of guarded body (anti-partial-delivery brace) ===
