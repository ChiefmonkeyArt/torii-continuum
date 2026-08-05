#!/usr/bin/env bash
#
# Hermetic tests for the in-repo cutover operator script (OPS-RETENTION-1, v0.2.67-alpha).
#
# No real deploy, no network, no root. Concerns:
#   1. Anti-partial-delivery — the whole body is a single brace group, so a
#      truncated copy (the exact hazard that motivated this script: a heredoc
#      paste that cut off mid-function) fails `bash -n` and runs NOTHING.
#   2. Safe invocation guards — refuses to be sourced, requires root, and never
#      uses the broken `exec sudo -- bash "$0"` re-exec.
#   3. Static release/security invariants — pinned annotated tags + versions,
#      fail-closed preview layout detection, no secrets, no broad sudoers.
#   4. v0.2.59-alpha hotfix (OPS-CUTOVER-2): public static modes are forced to
#      0755/0644 under an initial umask 077 (the live HTTP-403 bug), and EVERY
#      fatal path after mutation — including explicit `die`/`exit`, which do NOT
#      fire the ERR trap — reaches rollback via a single EXIT-trap chokepoint.
#      Includes functional replays (mode enforcement; backup→mutate→restore +
#      absent-path cleanup; die→rollback wiring) plus static asserts.
#
# Run:  bash ops/test/torii-final-cutover.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
CUTOVER="${REPO_ROOT}/ops/torii-final-cutover.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$CUTOVER" ]] || { bad "missing file: $CUTOVER"; exit 1; }

# ── 0. Parses cleanly ────────────────────────────────────────────────────────
bash -n "$CUTOVER" && ok "cutover passes bash -n" || bad "cutover failed bash -n"

# ── 1. Anti-partial-delivery brace group ─────────────────────────────────────
# The first executable (non-comment, non-blank) line must open the brace group.
#
# NOTE: these `grep "$CUTOVER" | head/tail` pipelines read the *whole*
# ~1000-line file upstream of a short-circuiting head/tail. Under
# `set -o pipefail` a fast-exiting head/tail can SIGPIPE the still-writing
# grep before it reaches EOF, which some CI runners' pipe-buffer/scheduler
# timing turns into a real (non-flaky-in-intent) pipefail failure though
# nothing is actually wrong. Scope pipefail off for just these two greps;
# tail/head themselves still enforce correctness via the `==`/`grep -qF`
# checks below.
set +o pipefail
first_exec="$(grep -nvE '^[[:space:]]*(#|$)' "$CUTOVER" | head -1 | cut -d: -f2-)"
set -o pipefail
[[ "$first_exec" == '{' ]] && ok "executable body opens with a '{' brace group" \
  || bad "body does not start with a brace group (got: '${first_exec}')"

# The last non-blank line must be the sentinel comment, and the line above the
# sentinel must close the group.
set +o pipefail
last_nonblank="$(grep -nvE '^[[:space:]]*$' "$CUTOVER" | tail -1 | cut -d: -f2-)"
set -o pipefail
printf '%s' "$last_nonblank" | grep -qF 'end of guarded body' \
  && ok "file ends with the anti-truncation sentinel comment" \
  || bad "missing trailing sentinel comment (got: '${last_nonblank}')"
set +o pipefail
close_line="$(grep -nvE '^[[:space:]]*$' "$CUTOVER" | tail -2 | head -1 | cut -d: -f2-)"
set -o pipefail
[[ "$close_line" == '}' ]] && ok "guarded body is closed by a '}' on the penultimate line" \
  || bad "closing brace not where expected (got: '${close_line}')"

# main runs INSIDE the group (last statement before the closing brace).
grep -qE '^main "\$@"$' "$CUTOVER" && ok "invokes main \"\$@\" once" || bad "no single main \"\$@\" invocation"

# Truncate the file at several depths; every truncation must break `bash -n`
# (proving a partial paste would refuse to execute). A file that still parses
# after losing its tail would be a silent partial-run hazard.
total="$(wc -l < "$CUTOVER")"
trunc_ok=1
for cut in 2 25 120 400; do
  frag="$(mktemp)"
  head -n "$(( total - cut ))" "$CUTOVER" > "$frag"
  if bash -n "$frag" 2>/dev/null; then trunc_ok=0; fi
  rm -f "$frag"
done
[[ "$trunc_ok" -eq 1 ]] && ok "any truncated copy fails bash -n (partial paste never runs)" \
  || bad "a truncated copy still parsed — partial-delivery hazard"

# ── 2. Safe invocation guards ────────────────────────────────────────────────
# The broken re-exec idiom must be gone from executable code. Comments may
# legitimately DESCRIBE it as the anti-pattern this script avoids, so strip them.
code_only="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code_only" | grep -qE 'exec[[:space:]]+sudo'; then
  bad "still uses 'exec sudo' re-exec (broken when pasted/sourced)"
else
  ok "no 'exec sudo -- bash \"\$0\"' re-exec in code"
fi

# Refuses sourcing (BASH_SOURCE vs $0 guard present).
grep -qF 'BASH_SOURCE[0]' "$CUTOVER" && grep -qiF 'do not source' "$CUTOVER" \
  && ok "refuses to be sourced" || bad "no source-refusal guard"

# Requires root with the documented invocation, no auto-escalation.
grep -qF 'must run as root' "$CUTOVER" \
  && grep -qF 'sudo bash ops/torii-final-cutover.sh' "$CUTOVER" \
  && ok "requires root and documents 'sudo bash ops/torii-final-cutover.sh'" \
  || bad "root requirement / documented invocation missing"

grep -qF 'set -euo pipefail' "$CUTOVER" && ok "uses set -euo pipefail" || bad "missing strict mode"
grep -qF 'umask 077' "$CUTOVER" && ok "sets a restrictive umask (077)" || bad "no restrictive umask"

# Behavioural: as a non-root user it must refuse BEFORE doing anything.
if [[ "$(id -u)" -ne 0 ]]; then
  set +e
  out="$(bash "$CUTOVER" 2>&1)"; rc=$?
  set -e
  [[ "$rc" -ne 0 ]] && printf '%s' "$out" | grep -qF 'must run as root' \
    && ok "non-root run refuses with a clear message (exit ${rc})" \
    || bad "non-root run did not fail closed (exit ${rc})"
else
  ok "skip non-root behavioural check (running as root)"
fi

# Behavioural: sourcing must refuse and must NOT start the cutover.
src_out="$(bash -c "source '$CUTOVER'" 2>&1 || true)"
printf '%s' "$src_out" | grep -qiF 'do not source' \
  && ! printf '%s' "$src_out" | grep -qF 'Starting final VPS cutover' \
  && ok "sourcing refuses and never enters main()" || bad "sourcing was not refused safely"

# ── 3. Pinned annotated tags + version markers ───────────────────────────────
grep -qF 'BASE_TAG="v0.1.4"' "$CUTOVER"                 && ok "pins torii-base v0.1.4"             || bad "torii-base tag not pinned"
grep -qF 'BASE_VERSION="0.1.4"' "$CUTOVER"              && ok "pins torii-base VERSION 0.1.4"      || bad "torii-base version not pinned"
grep -qF 'CONTINUUM_TAG="v0.2.67-alpha"' "$CUTOVER"     && ok "pins its own Continuum tag v0.2.67-alpha" || bad "continuum tag not pinned to v0.2.67-alpha"
grep -qF 'CONTINUUM_VERSION="0.2.67-alpha"' "$CUTOVER"  && ok "pins Continuum version 0.2.67-alpha" || bad "continuum version not pinned"
grep -qF 'PREVIEW_VERSION="0.1.21-preview"' "$CUTOVER"  && ok "pins onboarding preview 0.1.21-preview" || bad "preview version not pinned"
grep -qF 'PREVIEW_CTA="Sign in with browser extension"' "$CUTOVER" && ok "keeps the canonical CTA label" || bad "canonical CTA label missing"

# Annotated-tag verification: only an annotated tag object (cat-file -t == tag)
# is accepted — a lightweight tag or a moved branch is rejected.
grep -qF 'cat-file -t' "$CUTOVER" && grep -qF 'is not an annotated tag' "$CUTOVER" \
  && ok "verifies each source is an ANNOTATED tag" || bad "no annotated-tag verification"

# Version markers are asserted against the cloned sources before mutation.
grep -qF "const VERSION = '\${BASE_VERSION}';" "$CUTOVER" && ok "asserts torii-base sidecar index version marker" || bad "sidecar index marker not checked"
grep -qF 'Continuum amber' "$CUTOVER" && ok "asserts torii-base launcher amber marker" || bad "launcher amber marker not checked"

# The mixed-case sidecar-health typo from the source draft must not reappear.
if grep -qF 'SIDEcar_HEALTH_URL' "$CUTOVER"; then
  bad "mixed-case SIDEcar_HEALTH_URL typo present"
else
  grep -qF 'SIDECAR_HEALTH_URL' "$CUTOVER" && ok "sidecar health var is consistently cased" || bad "sidecar health var missing"
fi

# ── 4. Fail-closed preview layout + atomic swap + one rollback ────────────────
grep -qF 'preview URL detection is ambiguous' "$CUTOVER" && ok "preview detection dies on ambiguity" || bad "no ambiguity guard"
grep -qF 'preview URL detection failed' "$CUTOVER" && ok "preview detection dies when neither URL serves" || bad "no absence guard"
grep -qF '.prev' "$CUTOVER" && ok "keeps exactly one rollback (.prev)" || bad "no .prev rollback path"
grep -qF '.next' "$CUTOVER" && grep -qF 'mv -T' "$CUTOVER" && ok "promotes preview atomically (stage .next -> mv -T)" || bad "preview swap not atomic"

# ── 5. Health/version gates + state preservation ─────────────────────────────
grep -qF 'wait_json_version "$CONTINUUM_HEALTH_URL" "$CONTINUUM_VERSION"' "$CUTOVER" \
  && ok "health/version-gates the Continuum agent" || bad "no continuum health gate"
grep -qF 'wait_json_version "$SIDECAR_HEALTH_URL" "$BASE_VERSION"' "$CUTOVER" \
  && ok "health/version-gates the torii-base sidecar" || bad "no sidecar health gate"
grep -qF 'root_app changed across torii-base deployment' "$CUTOVER" \
  && ok "asserts registry root_app is preserved" || bad "no root_app preservation check"

# ── 6. Backups + rollback wiring ─────────────────────────────────────────────
grep -qF 'trap ' "$CUTOVER" && grep -qF 'ERR' "$CUTOVER" && ok "installs an ERR trap for rollback" || bad "no ERR trap"
grep -qF 'tar -cpf' "$CUTOVER" && ok "backs up torii-base state to a tar before mutation" || bad "no pre-mutation backup"
grep -qF 'continuum-deploy.conf.before' "$CUTOVER" && ok "backs up the Continuum pin file before editing" || bad "no pin-file backup"

# ── 7. No secrets, no broad sudoers ──────────────────────────────────────────
# Strip comments; the script legitimately DESCRIBES itself as secret-free.
code="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code" | grep -qiE 'session_secret|admin_npub|ask-vault|vault-password|PRIVATE KEY'; then
  bad "handles secrets in code"
else
  ok "no secret handling in code"
fi
# Granting passwordless sudo or editing sudoers is forbidden. Backing up an
# existing torii-base sudoers file for rollback is allowed, so flag only real
# grants (NOPASSWD / visudo) and writes INTO sudoers.d, not read/backup refs.
if printf '%s' "$code" | grep -qiE 'NOPASSWD|visudo'; then
  bad "grants passwordless sudo (NOPASSWD/visudo)"
elif printf '%s' "$code" | grep -qE '(install|tee|cp|>|>>)[^|]*sudoers\.d'; then
  bad "writes into /etc/sudoers.d"
else
  ok "never installs sudoers rules or passwordless sudo"
fi

# ── 8. Privacy: no device/host identifiers, public HTTPS only ────────────────
if printf '%s' "$code" | grep -qE 'git@|ssh://|git\+ssh'; then
  bad "uses an SSH git remote (should be public HTTPS)"
else
  grep -qF 'https://github.com/ChiefmonkeyArt/torii-continuum.git' "$CUTOVER" \
    && ok "clones over public HTTPS only" || bad "continuum HTTPS repo not referenced"
fi

# ── 9. Hotfix static asserts (OPS-CUTOVER-2, v0.2.59-alpha) ───────────────────
# 9a. The git checkout runs under a PUBLIC umask (022), not the root-only 077,
#     so the working tree torii-base copies with `cp -a` is world-readable.
awk '/^clone_annotated_tag\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'umask 022' \
  && ok "clone_annotated_tag checks out sources under umask 022" \
  || bad "clone_annotated_tag does not force umask 022 for the checkout"
# It must restore the previous umask (no leak of 022 into root-only state).
awk '/^clone_annotated_tag\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'umask "$prev_umask"' \
  && ok "clone_annotated_tag restores the prior (root-only) umask" \
  || bad "clone_annotated_tag leaks umask 022"

# 9b. The sanctioned torii-base bootstrap runs under umask 022 in a subshell so
#     any file it creates directly defaults to world-readable modes.
awk '/^deploy_torii_base\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'umask 022' \
  && ok "deploy_torii_base runs bootstrap under umask 022" \
  || bad "bootstrap not run under umask 022"
awk '/^deploy_torii_base\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'enforce_public_static_modes' \
  && ok "deploy_torii_base enforces public modes after bootstrap" \
  || bad "no post-bootstrap public-mode enforcement"

# 9c. Public-mode enforcement is scoped to the launcher webroot ONLY and forces
#     0755 dirs / 0644 files — exactly the manual recovery that fixed the 403.
grep -qF 'LAUNCHER_WEBROOT="/opt/torii/launcher"' "$CUTOVER" \
  && ok "launcher webroot pinned to /opt/torii/launcher" || bad "launcher webroot not pinned"
grep -qF 'PUBLIC_DIR_MODE="0755"' "$CUTOVER" && grep -qF 'PUBLIC_FILE_MODE="0644"' "$CUTOVER" \
  && ok "public static modes pinned to 0755 dirs / 0644 files" || bad "public static modes not pinned"
awk '/^enforce_public_static_modes\(\) \{/,/^\}/' "$CUTOVER" | grep -qF '$LAUNCHER_WEBROOT' \
  && ok "enforce_public_static_modes targets the launcher webroot" \
  || bad "enforce_public_static_modes does not target the launcher webroot"
awk '/^set_public_tree_modes\(\) \{/,/^\}/' "$CUTOVER" | grep -qE 'find .* -type d -exec chmod' \
  && awk '/^set_public_tree_modes\(\) \{/,/^\}/' "$CUTOVER" | grep -qE 'find .* -type f -exec chmod' \
  && ok "set_public_tree_modes chmods dirs and files separately" \
  || bad "set_public_tree_modes does not chmod dirs+files"

# 9d. Mode widening must NOT reach secrets/config. /opt/torii/env, registry.json
#     and root_app.conf sit ABOVE the launcher webroot and are never chmodded.
code_nc="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code_nc" | grep -qE 'chmod[^\n]*/opt/torii/env|chmod[^\n]*registry\.json|chmod[^\n]*root_app\.conf'; then
  bad "chmod touches a secret/config path (env/registry/root_app)"
else
  ok "no chmod on /opt/torii/env, registry.json or root_app.conf"
fi

# 9e. The preview stage (mktemp under 077 → 0700) is normalised to public modes
#     via the same shared helper before the atomic swap.
awk '/^prepare_preview_permissions\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'set_public_tree_modes' \
  && ok "preview stage normalised via the shared public-mode helper" \
  || bad "preview stage does not reuse the public-mode helper"

# 9f. Rollback wiring: a single EXIT-trap chokepoint drives rollback so explicit
#     die/exit paths (which do NOT fire ERR) still roll back; recursion-guarded.
grep -qF 'trap on_exit EXIT' "$CUTOVER" && ok "installs an EXIT-trap rollback chokepoint" \
  || bad "no EXIT-trap rollback chokepoint"
awk '/^on_exit\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'rollback' \
  && ok "on_exit invokes rollback on non-zero exit" || bad "on_exit does not call rollback"
awk '/^rollback\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'ROLLBACK_ACTIVE == 1' \
  && ok "rollback is recursion-guarded (runs exactly once)" || bad "rollback has no recursion guard"
# rollback must not exit() — it returns to on_exit which owns the exit code. Match
# only a statement-position `exit` (the word also appears inside log strings).
if awk '/^rollback\(\) \{/,/^\}/' "$CUTOVER" | sed 's/#.*$//' | grep -qE '^[[:space:]]*exit([[:space:]]|$)'; then
  bad "rollback calls exit (must return to on_exit)"
else
  ok "rollback never exits (returns to the EXIT-trap owner)"
fi
# A pre-mutation failure must be a no-op rollback (all mutation flags still 0).
awk '/^rollback\(\) \{/,/^\}/' "$CUTOVER" \
  | grep -qF 'BASE_MUTATED == 0 && CONTINUUM_PIN_CHANGED == 0 && PREVIEW_SWAPPED == 0' \
  && ok "rollback is a no-op before any live mutation" || bad "no pre-mutation no-op guard in rollback"

# ── 10. Hotfix functional replays (sandboxed; no root/network) ────────────────
# 10a. Under an initial umask 077, files/dirs are created 0600/0700 (reproducing
#      the live 403), then the exact enforcement the script runs (find -exec
#      chmod) must yield 0755 dirs / 0644 files.
mode_sandbox="$(mktemp -d)"
(
  umask 077
  mkdir -p "$mode_sandbox/launcher/assets"
  printf '<!doctype html>' > "$mode_sandbox/launcher/index.html"
  printf 'body{}'          > "$mode_sandbox/launcher/assets/app.css"
)
pre_file="$(stat -c '%a' "$mode_sandbox/launcher/index.html")"
pre_dir="$(stat -c '%a' "$mode_sandbox/launcher/assets")"
[[ "$pre_file" == "600" && "$pre_dir" == "700" ]] \
  && ok "umask 077 reproduces the 403 modes (0600 files / 0700 dirs)" \
  || bad "sandbox did not reproduce 0600/0700 under umask 077 (file=$pre_file dir=$pre_dir)"
# Replay the enforcement verbatim.
find "$mode_sandbox/launcher" -type d -exec chmod 0755 {} +
find "$mode_sandbox/launcher" -type f -exec chmod 0644 {} +
post_idx="$(stat -c '%a' "$mode_sandbox/launcher/index.html")"
post_css="$(stat -c '%a' "$mode_sandbox/launcher/assets/app.css")"
post_root="$(stat -c '%a' "$mode_sandbox/launcher")"
post_assets="$(stat -c '%a' "$mode_sandbox/launcher/assets")"
[[ "$post_root" == "755" && "$post_assets" == "755" ]] \
  && ok "enforcement sets launcher dirs to 0755" \
  || bad "launcher dirs not 0755 after enforcement (root=$post_root assets=$post_assets)"
[[ "$post_idx" == "644" && "$post_css" == "644" ]] \
  && ok "enforcement sets launcher files to 0644" \
  || bad "launcher files not 0644 after enforcement (index=$post_idx css=$post_css)"
rm -rf "$mode_sandbox"

# 10b. Backup → mutate → restore: a tar of pre-state is captured, a live mutation
#      overwrites it AND creates a path that did not exist (recorded as absent),
#      then restore returns the original content and removes the absent path —
#      exactly what a post-mutation public-probe failure triggers.
rb_sandbox="$(mktemp -d)"
mkdir -p "$rb_sandbox/opt/torii/launcher"
printf 'ORIGINAL' > "$rb_sandbox/opt/torii/launcher/index.html"
absent_marker="$rb_sandbox/opt/torii/continuum"   # does not exist pre-mutation
backup_tar="$rb_sandbox/base.tar"
absent_list="$rb_sandbox/absent.list"
: > "$absent_list"
# Snapshot: launcher exists (back it up), continuum absent (record it).
tar -cpf "$backup_tar" -C "$rb_sandbox" opt/torii/launcher
printf '%s\n' "$absent_marker" > "$absent_list"
# Mutate: clobber the backed-up file and create the previously-absent path.
printf 'BROKEN'  > "$rb_sandbox/opt/torii/launcher/index.html"
mkdir -p "$absent_marker"; printf 'NEW' > "$absent_marker/index.html"
# Restore (mirrors restore_torii_base_backup): extract tar, remove absent paths.
tar -xpf "$backup_tar" -C "$rb_sandbox"
while IFS= read -r p; do [[ -n "$p" ]] && rm -rf -- "$p"; done < "$absent_list"
restored="$(cat "$rb_sandbox/opt/torii/launcher/index.html")"
[[ "$restored" == "ORIGINAL" ]] \
  && ok "rollback restores the pre-mutation base backup" \
  || bad "base backup not restored (got '$restored')"
[[ ! -e "$absent_marker" ]] \
  && ok "rollback removes paths absent before mutation (clean slate)" \
  || bad "absent path not cleaned on rollback"
rm -rf "$rb_sandbox"

# 10c. die→rollback wiring: a harness mirroring the real trap chain proves that
#      an explicit `die` AFTER a mutation flag is set still reaches rollback via
#      the EXIT trap (the exact failure mode of the live run: 403 → die → the old
#      code exited with NO rollback). Also proves the recursion guard and that a
#      failure BEFORE any mutation is a no-op.
harness() {
  local set_flag="$1"   # 1 = simulate a post-mutation failure
  bash -c '
    set -euo pipefail
    MUTATED=0; ROLLBACK_ACTIVE=0
    rollback() {
      (( ROLLBACK_ACTIVE == 1 )) && return 0
      ROLLBACK_ACTIVE=1; trap - ERR; set +e
      if (( MUTATED == 0 )); then echo "NOOP"; return 0; fi
      echo "ROLLED_BACK"; return 0
    }
    on_exit() { local rc=$?; trap - EXIT ERR; (( rc != 0 )) && rollback "$rc"; exit "$rc"; }
    die() { echo "FATAL: $*" >&2; exit 1; }
    trap on_exit EXIT
    MUTATED='"$set_flag"'
    die "simulated public probe failed with HTTP 403"
  '
}
set +e
out_post="$(harness 1 2>/dev/null)"; rc_post=$?
out_pre="$(harness 0 2>/dev/null)";  rc_pre=$?
set -e
[[ "$rc_post" -ne 0 && "$out_post" == "ROLLED_BACK" ]] \
  && ok "die after mutation triggers rollback via the EXIT trap (exit ${rc_post})" \
  || bad "die after mutation did NOT roll back (rc=$rc_post out='$out_post')"
[[ "$rc_pre" -ne 0 && "$out_pre" == "NOOP" ]] \
  && ok "die before mutation is a no-op rollback (exit ${rc_pre})" \
  || bad "pre-mutation die was not a no-op (rc=$rc_pre out='$out_pre')"

# 10d. Recursion guard holds even if rollback is re-entered (ERR during rollback
#      must not re-run the restores).
guard_out="$(bash -c '
  ROLLBACK_ACTIVE=0; runs=0
  rollback(){ (( ROLLBACK_ACTIVE == 1 )) && return 0; ROLLBACK_ACTIVE=1; runs=$((runs+1)); rollback; echo "$runs"; }
  rollback
' 2>/dev/null)"
[[ "$guard_out" == "1" ]] \
  && ok "rollback recursion guard runs the body exactly once" \
  || bad "rollback recursion guard failed (runs='$guard_out')"

# ── 11. OPS-CUTOVER-3: timer only after a successful converge (no retry storm) ─
# 11a. The bootstrap is invoked with --no-enable-timer, so the recurring timer is
#      installed but NOT enabled until the manual first converge has health-gated.
awk '/^bootstrap_and_deploy_continuum\(\) \{/,/^\}/' "$CUTOVER" | grep -qE 'deploy-bootstrap\.sh"? --no-enable-timer' \
  && ok "bootstrap runs with --no-enable-timer (no premature timer)" \
  || bad "bootstrap does not pass --no-enable-timer"
# 11b. A dedicated enable_deploy_timer step enables the timer, and it is called in
#      main ONLY after write_report (i.e. past every health gate).
grep -qF 'enable_deploy_timer() {' "$CUTOVER" && ok "defines enable_deploy_timer step" || bad "no enable_deploy_timer step"
awk '/^enable_deploy_timer\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'systemctl enable --now torii-continuum-deploy.timer' \
  && ok "enable_deploy_timer enables the recurring timer" || bad "enable_deploy_timer does not enable the timer"
# main() ordering: enable_deploy_timer must come AFTER write_report and the
# converge, and the ONLY enable of the timer must be in enable_deploy_timer (the
# bootstrap path is --no-enable-timer). Verify main calls it last-ish.
main_body="$(awk '/^main\(\) \{/,/^\}/' "$CUTOVER")"
printf '%s' "$main_body" | grep -qF 'enable_deploy_timer' \
  && ok "main invokes enable_deploy_timer" || bad "main never enables the timer"
# The enable must not appear before bootstrap_and_deploy_continuum in main.
order_ok=1
line_boot="$(printf '%s\n' "$main_body" | grep -n 'bootstrap_and_deploy_continuum' | head -1 | cut -d: -f1)"
line_enable="$(printf '%s\n' "$main_body" | grep -n 'enable_deploy_timer' | head -1 | cut -d: -f1)"
line_report="$(printf '%s\n' "$main_body" | grep -n 'write_report' | head -1 | cut -d: -f1)"
[[ -n "$line_boot" && -n "$line_enable" && -n "$line_report" && "$line_enable" -gt "$line_boot" && "$line_enable" -gt "$line_report" ]] \
  && ok "main enables the timer only after converge + write_report" \
  || bad "main enables the timer too early (boot=$line_boot report=$line_report enable=$line_enable)"
# 11c. The ONLY `systemctl enable ... torii-continuum-deploy.timer` in the whole
#      script lives in enable_deploy_timer (belt: no stray early enable).
enable_hits="$(sed 's/#.*$//' "$CUTOVER" | grep -cF 'systemctl enable --now torii-continuum-deploy.timer')"
[[ "$enable_hits" -eq 1 ]] \
  && ok "exactly one timer-enable call in the script (in enable_deploy_timer)" \
  || bad "unexpected number of timer-enable calls ($enable_hits)"

# ── 12. Prune stale staging dirs after a successful cutover (ENOSPC fix) ──────
# Each run leaves a ~629M /root/torii-final-cutover-<ts>Z dir (clone + node_modules);
# they were never pruned, so repeats accumulated 2.5G+ and the unattended deploy
# hit ENOSPC at `npm ci`. A prune step now keeps only the newest N after success.
grep -qF 'prune_old_staging_dirs() {' "$CUTOVER" && ok "defines prune_old_staging_dirs step" || bad "no prune_old_staging_dirs step"
grep -qF 'readonly KEEP_STAGING_DIRS=1' "$CUTOVER" && ok "keeps exactly the newest 1 staging dir" || bad "KEEP_STAGING_DIRS not pinned to 1"
# 12a. Enumeration must be explicit find-based, NOT a bare glob (which does not
#      reliably expand in every shell and could match nothing or the wrong path).
awk '/^prune_old_staging_dirs\(\) \{/,/^\}/' "$CUTOVER" \
  | grep -qE "find /root -maxdepth 1 -type d -name 'torii-final-cutover-\*' -print0" \
  && ok "prune enumerates staging dirs via NUL-safe find (no bare glob)" \
  || bad "prune does not use explicit find enumeration"
if awk '/^prune_old_staging_dirs\(\) \{/,/^\}/' "$CUTOVER" | sed 's/#.*$//' | grep -qE 'rm[^\n]*/root/torii-final-cutover-\*'; then
  bad "prune uses a bare rm glob (unreliable expansion)"
else
  ok "prune never uses a bare rm glob"
fi
# 12b. The just-created RUN_ROOT is skipped unconditionally.
awk '/^prune_old_staging_dirs\(\) \{/,/^\}/' "$CUTOVER" | grep -qF '"$d" == "$RUN_ROOT"' \
  && ok "prune never removes the current RUN_ROOT" || bad "prune does not guard RUN_ROOT"
# 12c. Prune must not target the app dir or the live webroot.
if awk '/^prune_old_staging_dirs\(\) \{/,/^\}/' "$CUTOVER" | grep -qE '/home/continuum/app|/var/www/torii/continuum'; then
  bad "prune references the app dir or live webroot"
else
  ok "prune never touches /home/continuum/app or /var/www/torii/continuum"
fi
# 12d. Ordering: prune runs LAST in main (after enable_deploy_timer + cleanup),
#      so a FAILED cutover leaves the newest staging dir for inspection.
prune_main_body="$(awk '/^main\(\) \{/,/^\}/' "$CUTOVER")"
line_prune="$(printf '%s\n' "$prune_main_body" | grep -n 'prune_old_staging_dirs' | head -1 | cut -d: -f1)"
line_cleanup="$(printf '%s\n' "$prune_main_body" | grep -n 'cleanup_success' | head -1 | cut -d: -f1)"
line_enable2="$(printf '%s\n' "$prune_main_body" | grep -n 'enable_deploy_timer' | head -1 | cut -d: -f1)"
[[ -n "$line_prune" && -n "$line_cleanup" && -n "$line_enable2" && "$line_prune" -gt "$line_cleanup" && "$line_prune" -gt "$line_enable2" ]] \
  && ok "main prunes only after enable_deploy_timer + cleanup_success" \
  || bad "prune not placed last in main (enable=$line_enable2 cleanup=$line_cleanup prune=$line_prune)"

# 12e. Functional replay: with N=1 the prune keeps only the newest (RUN_ROOT) and
#      removes all older staging dirs, leaving unrelated /root entries untouched.
prune_sandbox="$(mktemp -d)"
mkdir -p "$prune_sandbox/torii-final-cutover-20260101T000000Z" \
         "$prune_sandbox/torii-final-cutover-20260201T000000Z" \
         "$prune_sandbox/torii-final-cutover-20260301T000000Z" \
         "$prune_sandbox/torii-final-cutover-20260401T000000Z" \
         "$prune_sandbox/unrelated-dir"
run_root="$prune_sandbox/torii-final-cutover-20260401T000000Z"   # newest = current run
keep=1
declare -a sdirs=()
while IFS= read -r -d '' d; do sdirs+=("$d"); done \
  < <(find "$prune_sandbox" -maxdepth 1 -type d -name 'torii-final-cutover-*' -print0 | sort -zr)
rank=0
for d in "${sdirs[@]}"; do
  if [[ "$d" == "$run_root" ]]; then continue; fi
  rank=$((rank + 1))
  (( rank < keep )) && continue
  rm -rf -- "$d"
done
survivors="$(find "$prune_sandbox" -maxdepth 1 -type d -name 'torii-final-cutover-*' | sort | tr '\n' ' ')"
[[ "$survivors" == "$run_root " ]] \
  && ok "prune replay keeps only the newest staging dir (RUN_ROOT)" \
  || bad "prune replay left the wrong survivors ('$survivors')"
[[ -d "$prune_sandbox/unrelated-dir" ]] \
  && ok "prune replay leaves unrelated /root entries untouched" \
  || bad "prune replay removed an unrelated dir"
rm -rf "$prune_sandbox"

# ── 13. OPS-CUTOVER-5: disk-safety (preflight free space + backup excludes) ────
# 13a. A preflight free-space gate is defined, with a pinned MiB floor and the
#      set of filesystems to check.
grep -qF 'preflight_free_space() {' "$CUTOVER" && ok "defines preflight_free_space step" || bad "no preflight_free_space step"
grep -qE 'readonly PREFLIGHT_MIN_FREE_MB=[0-9]+' "$CUTOVER" && ok "pins a preflight free-space floor (MiB)" || bad "no PREFLIGHT_MIN_FREE_MB floor"
grep -qF 'readonly PREFLIGHT_PATHS=' "$CUTOVER" && ok "pins the filesystems to check for free space" || bad "no PREFLIGHT_PATHS list"
# 13b. The gate must die (fail closed) when space is insufficient.
awk '/^preflight_free_space\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'insufficient free space' \
  && ok "preflight dies on insufficient free space" || bad "preflight does not fail closed on low space"
# 13b2. OPS-RETENTION-1: the 2 GiB hard floor is RETAINED and an 80%-used
#       non-fatal capacity warning is ADDED (nudging the retention sweep).
grep -qE 'readonly PREFLIGHT_MIN_FREE_MB=2048' "$CUTOVER" \
  && ok "preflight retains the 2 GiB (2048 MiB) hard floor" || bad "2 GiB preflight floor changed/removed"
grep -qE 'readonly PREFLIGHT_WARN_PCT=80' "$CUTOVER" \
  && ok "preflight pins an 80% capacity warning threshold" || bad "no PREFLIGHT_WARN_PCT=80"
preflight_body="$(awk '/^preflight_free_space\(\) \{/,/^\}/' "$CUTOVER")"
printf '%s\n' "$preflight_body" | grep -qF 'PREFLIGHT_WARN_PCT' \
  && printf '%s\n' "$preflight_body" | grep -qiF 'full' \
  && ok "preflight warns (non-fatal) at/above the 80% threshold" || bad "preflight has no 80% capacity warning"
# 13c. Ordering: preflight runs FIRST in main — before verify_release_sources
#      (which clones) and before any mutation — so a starved host never mutates.
ds_main_body="$(awk '/^main\(\) \{/,/^\}/' "$CUTOVER")"
line_preflight="$(printf '%s\n' "$ds_main_body" | grep -n 'preflight_free_space' | head -1 | cut -d: -f1)"
line_verify="$(printf '%s\n' "$ds_main_body" | grep -n 'verify_release_sources' | head -1 | cut -d: -f1)"
line_deploybase="$(printf '%s\n' "$ds_main_body" | grep -n 'deploy_torii_base' | head -1 | cut -d: -f1)"
[[ -n "$line_preflight" && -n "$line_verify" && -n "$line_deploybase" \
   && "$line_preflight" -lt "$line_verify" && "$line_preflight" -lt "$line_deploybase" ]] \
  && ok "main runs preflight_free_space before clone + any mutation" \
  || bad "preflight not first in main (preflight=$line_preflight verify=$line_verify deploy=$line_deploybase)"
# 13d. The rollback backup tar excludes regenerable cache/build artifacts.
grep -qF 'readonly BACKUP_EXCLUDES=' "$CUTOVER" && ok "defines BACKUP_EXCLUDES for the backup tar" || bad "no BACKUP_EXCLUDES"
awk '/^backup_torii_base_state\(\) \{/,/^\}/' "$CUTOVER" | grep -qF '"${BACKUP_EXCLUDES[@]}"' \
  && ok "backup tar applies the cache/artifact excludes" || bad "backup tar does not use BACKUP_EXCLUDES"
for pat in node_modules .git .cache dist; do
  grep -qF -- "--exclude=*/${pat}" "$CUTOVER" && ok "backup excludes ${pat}" || bad "backup does not exclude ${pat}"
done
# 13e. Excludes must NOT drop config/state — env/registry.json/root_app.conf are
#      still captured, so the excludes only ever match regenerable artifacts.
code_ex="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code_ex" | grep -qE -- '--exclude=[^ ]*(env|registry\.json|root_app\.conf)'; then
  bad "a backup exclude matches a config/state path"
else
  ok "backup excludes never match env/registry.json/root_app.conf"
fi

# 13f. Functional replay: a tar built with the same excludes drops node_modules
#      but preserves a config file, proving state survives the excludes.
ex_sandbox="$(mktemp -d)"
mkdir -p "$ex_sandbox/opt/torii/node_modules/pkg" "$ex_sandbox/opt/torii/.git"
printf 'SECRET=1' > "$ex_sandbox/opt/torii/env"
printf '{}'       > "$ex_sandbox/opt/torii/registry.json"
printf 'junk'     > "$ex_sandbox/opt/torii/node_modules/pkg/index.js"
printf 'g'        > "$ex_sandbox/opt/torii/.git/config"
ex_tar="$ex_sandbox/base.tar"
tar -cpf "$ex_tar" -C "$ex_sandbox" \
  --exclude='*/node_modules' --exclude='*/.git' --exclude='*/.cache' \
  --exclude='*/.npm' --exclude='*/dist' --exclude='*/.vite' \
  opt/torii
listing="$(tar -tf "$ex_tar")"
printf '%s\n' "$listing" | grep -qF 'opt/torii/env' \
  && printf '%s\n' "$listing" | grep -qF 'opt/torii/registry.json' \
  && ok "backup replay preserves config/state (env, registry.json)" \
  || bad "backup replay dropped config/state"
if printf '%s\n' "$listing" | grep -qF 'node_modules'; then
  bad "backup replay included node_modules (exclude ineffective)"
else
  ok "backup replay excludes node_modules"
fi
rm -rf "$ex_sandbox"

# ── 14. OPS-CUTOVER-6: robust onboarding CTA detection ────────────────────────
# 14a. Static: a robust regex-based matcher exists and the CTA probes use it
#      instead of the old exact-substring url_contains/grep -Fq path.
grep -qE "readonly PREVIEW_CTA_REGEX=" "$CUTOVER" && ok "defines a robust PREVIEW_CTA_REGEX" || bad "no PREVIEW_CTA_REGEX"
grep -qF 'text_has_cta() {' "$CUTOVER"  && ok "defines pure text_has_cta matcher"  || bad "no text_has_cta"
grep -qF 'url_has_cta() {' "$CUTOVER"   && ok "defines url_has_cta probe"          || bad "no url_has_cta"
grep -qF 'normalize_cta_text() {' "$CUTOVER" && ok "defines HTML normaliser"       || bad "no normalize_cta_text"
# The layout resolver + post-deploy check must use the robust probes, not the old
# exact-substring path.
awk '/^resolve_preview_layout\(\) \{/,/^\}/' "$CUTOVER" | grep -qF 'url_has_cta' \
  && ok "layout resolver uses robust url_has_cta" || bad "layout resolver still uses exact substring"
grep -qF 'wait_url_has_cta "$PREVIEW_PUBLIC_URL"' "$CUTOVER" \
  && ok "post-deploy check uses robust wait_url_has_cta" || bad "post-deploy check not robust"
if grep -qF 'url_contains "$PREVIEW_ROOT_URL" "$PREVIEW_CTA"' "$CUTOVER" \
   || grep -qF 'wait_url_contains "$PREVIEW_PUBLIC_URL" "$PREVIEW_CTA"' "$CUTOVER"; then
  bad "an old exact-substring CTA check remains"
else
  ok "no exact-substring CTA checks remain"
fi

# 14b. Functional: extract the actual matcher functions + regex from the script
#      and exercise them, proving markup-wrapped/reworded-but-valid CTAs pass and
#      blank/error pages fail closed (the live false-fail this release fixes).
cta_probe="$(mktemp)"
{
  grep -E '^readonly PREVIEW_CTA_REGEX=' "$CUTOVER"
  awk '/^normalize_cta_text\(\) \{/,/^\}/' "$CUTOVER"
  awk '/^text_has_cta\(\) \{/,/^\}/' "$CUTOVER"
} > "$cta_probe"
# shellcheck disable=SC1090
source "$cta_probe"

cta_pass() { text_has_cta "$1" && ok "CTA matches: $2" || bad "CTA should match ($2)"; }
cta_fail() { text_has_cta "$1" && bad "CTA should NOT match ($2)" || ok "CTA rejects: $2"; }

cta_pass '<button><svg></svg><span>Sign in with browser extension</span></button>' 'canonical, markup-wrapped'
cta_pass 'Sign in with a browser extension' 'reworded: "a browser"'
cta_pass 'Sign in using a Nostr extension' 'reworded: "using a Nostr"'
cta_pass '<span>Sign in with</span><svg/><span>browser extension</span>' 'label split across spans'
cta_pass "$(cat "${REPO_ROOT}/preview-assets/onboarding-v0.1.21/index.html")" 'the shipped v0.1.21 asset'
cta_fail '<html><body><h1>Console</h1></body></html>' 'valid HTML without the CTA'
cta_fail '404 Not Found' 'error page'
cta_fail '' 'empty body'
rm -f "$cta_probe"

printf '\n[torii-final-cutover.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
