#!/usr/bin/env bash
#
# Regression test for the Node runtime floor gate in ops/install-agent.sh.
#
# The money path (@cashu/cashu-ts v3-lts) declares engines.node >=22.4.0. The
# installer must REFUSE an older runtime before touching any user/service/file,
# using a robust major.minor.patch comparison (a major-only `>= 22` check would
# wrongly wave through 22.0.x–22.3.x, which are below the floor).
#
# We exercise the pure `node_version_ok` helper from ops/lib/node-version.sh with
# fixed version strings, so the result does NOT depend on the host's own Node
# version. An anti-drift block asserts the installer still sources the lib and
# gates on it, and that the helper stays side-effect-free on source.
#
# Run:  bash ops/test/installer-preflight.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-agent.sh"
LIB="${REPO_ROOT}/ops/lib/node-version.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$LIB" ]] || { bad "lib not found: $LIB"; exit 1; }

# ── Side-effect check: sourcing must not run anything or emit output ─────────
src_out="$(source "$LIB" 2>&1)"
[[ -z "$src_out" ]] && ok "sourcing lib is silent (no side effects)" \
                    || bad "sourcing lib produced output: $src_out"

# Load the helper into this shell for the unit cases.
# shellcheck source=../lib/node-version.sh
source "$LIB"

[[ "$TORII_NODE_MIN_STR" == "22.4.0" ]] && ok "floor constant is 22.4.0" \
                                        || bad "floor constant drifted: $TORII_NODE_MIN_STR"

# expect <version> <want-rc> <label>
expect() {
  local ver="$1" want="$2" label="$3" got=0
  node_version_ok "$ver" || got=$?
  [[ "$got" -eq "$want" ]] \
    && ok "$label — '$ver' → rc=$got" \
    || bad "$label — '$ver' expected rc=$want, got rc=$got"
}

# ── Required boundary cases ──────────────────────────────────────────────────
expect "20.20.1" 1 "20.x rejected (below floor)"          # current sandbox default
expect "22.3.9"  1 "22.3.x rejected (minor below floor)"  # NOT waved through by major-only
expect "22.4.0"  0 "22.4.0 accepted (exact floor)"
expect "23.5.0"  0 "later major accepted"

# ── Extra edges around the boundary ──────────────────────────────────────────
expect "22.4.1"    0 "patch above floor accepted"
expect "22.5.0"    0 "minor above floor accepted"
expect "22.3.999"  1 "high patch on low minor still rejected"
expect "18.19.0"   1 "old LTS rejected"
expect "24.0.0"    0 "future major accepted"
expect "v22.4.0"   0 "leading-v tolerated"
expect "22.4.0-nightly" 0 "prerelease suffix ignored"
expect "not.a.version" 2 "unparseable string → rc=2"
expect "22"        1 "bare major (22.0.0) rejected"

# ── Anti-drift: installer must still source the lib and gate on it ───────────
grep -qF 'source "${SCRIPT_DIR}/lib/node-version.sh"' "$INSTALLER" \
  && ok "installer sources the node-version lib" \
  || bad "installer no longer sources lib/node-version.sh"
grep -qF 'node_version_ok "$node_ver"' "$INSTALLER" \
  && ok "installer gates preflight on node_version_ok" \
  || bad "installer no longer calls node_version_ok"
# The gate must sit before the first state-changing step (user creation).
gate_ln="$(grep -n 'node_version_ok "\$node_ver"' "$INSTALLER" | head -1 | cut -d: -f1)"
user_ln="$(grep -n 'creating group\|groupadd --system\|useradd --system' "$INSTALLER" | head -1 | cut -d: -f1)"
if [[ -n "$gate_ln" && -n "$user_ln" && "$gate_ln" -lt "$user_ln" ]]; then
  ok "node gate ($gate_ln) precedes first state change ($user_ln)"
else
  bad "node gate does not clearly precede state-changing steps (gate=$gate_ln user=$user_ln)"
fi

printf '\n[installer-preflight.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
