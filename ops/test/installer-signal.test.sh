#!/usr/bin/env bash
#
# Regression test for the signal handling in ops/install-agent.sh.
#
# Pins two properties of the trap block:
#   1. A mid-run SIGINT/SIGTERM ABORTS the script (bash must not resume after the
#      handler) and exits with the conventional 128+signo status (130 / 143).
#   2. Temp artifacts are cleaned exactly once, via the single EXIT trap — the
#      INT/TERM handlers do NOT call cleanup themselves (no double-cleanup).
#
# We run a hermetic harness that mirrors the installer's trap block verbatim, so
# this is a true behavioural test, not just a static grep. An anti-drift check
# also asserts the installer still carries those exact trap lines.
#
# Run:  bash ops/test/installer-signal.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-agent.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# ── Anti-drift: the installer must still use the exact trap wiring under test ──
grep -qF 'trap cleanup EXIT' "$INSTALLER"      && ok "installer registers cleanup on EXIT"          || bad "EXIT trap drifted"
grep -qF "trap 'exit 130' INT" "$INSTALLER"    && ok "installer maps INT → exit 130 (no cleanup call)" || bad "INT trap drifted"
grep -qF "trap 'exit 143' TERM" "$INSTALLER"   && ok "installer maps TERM → exit 143 (no cleanup call)" || bad "TERM trap drifted"

# ── Behavioural harness: mirrors the installer's trap block ──────────────────
# Args: $1 = path-record file, $2 = resume-marker file, $3 = signal to raise.
# Records the temp it created, sends itself the signal, then tries to "resume"
# by writing a marker the parent checks must be absent.
cat > "${WORK}/harness.sh" <<EOS
#!/usr/bin/env bash
set -euo pipefail
TMP_FILES=()
cleanup() { [[ \${#TMP_FILES[@]} -gt 0 ]] && rm -f -- "\${TMP_FILES[@]}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
t="\$(mktemp "${WORK}/harness-temp.XXXXXX")"
TMP_FILES+=("\$t")
printf '%s' "\$t" > "\$1"     # tell the parent which temp we created
kill -"\$3" \$\$              # simulate the operator's Ctrl-C mid-install
printf 'RESUMED' > "\$2"      # MUST NOT run — proves the signal aborted the run
EOS

run_case() {
  local sig="$1" want="$2"
  local pathfile="${WORK}/tmp-path.${sig}" resumed="${WORK}/resumed.${sig}"
  rm -f "$pathfile" "$resumed"
  local code=0
  bash "${WORK}/harness.sh" "$pathfile" "$resumed" "$sig" || code=$?

  [[ "$code" -eq "$want" ]] \
    && ok "$sig: exits ${want} (128+signo), install aborted" \
    || bad "$sig: expected exit ${want}, got ${code}"

  [[ ! -f "$resumed" ]] \
    && ok "$sig: script did NOT resume past the signal" \
    || bad "$sig: script resumed after the handler (RESUMED marker written)"

  local tmp; tmp="$(cat "$pathfile" 2>/dev/null || true)"
  if [[ -n "$tmp" && ! -e "$tmp" ]]; then
    ok "$sig: EXIT trap cleaned the temp artifact"
  else
    bad "$sig: temp artifact not cleaned on abort (path='$tmp')"
  fi
}

run_case INT  130
run_case TERM 143

printf '\n[installer-signal.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
