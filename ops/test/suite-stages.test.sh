#!/usr/bin/env bash
# The Suite stage allowlist in ops/lib/run-suite-stages.sh and the workflow's
# input check must name the same stages; removal stages must switch their
# INSTALL_* flag off (Suite ADR 0003, ADR 0004).
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $*" >&2; exit 1; }
script=ops/lib/run-suite-stages.sh wf=.github/workflows/suite-stages-vps.yml
mapfile -t keys < <(sed -n '/^declare -A INSTALLER=(/,/^)/p' "$script" | sed -n 's/^  \[\([a-z_]*\)\]=.*/\1/p')
(( ${#keys[@]} >= 9 )) || fail "parsed ${#keys[@]} stages"
alt="$(IFS='|'; echo "${keys[*]}")"
grep -qF "^(${alt})(,(${alt}))*\$" "$wf" || fail "workflow regex does not list exactly: ${alt}"
for k in "${keys[@]}"; do grep -q "in order:.*\b${k}\b" "$wf" || fail "workflow description misses ${k}"; done
grep -q '\[gliclass\]=install-gliclass.sh' "$script" || fail "gliclass installer"
grep -q '\[gliclass_bench\]=bench-gliclass.sh' "$script" || fail "gliclass_bench"
grep -q '\[gliclass_remove\]=remove-gliclass.sh' "$script" || fail "gliclass_remove"
grep -q '\[gliclass\]=INSTALL_GLICLASS' "$script" || fail "gliclass flag"
grep -q 'gliclass_remove) set_env INSTALL_GLICLASS 0' "$script" || fail "remove keeps it off"
grep -q 'ollama_remove) set_env INSTALL_OLLAMA 0' "$script" || fail "ollama remove keeps it off"
# Removal flags are written after enable=1 flags, so a remove stage always wins.
r="$(grep -n 'gliclass_remove) set_env' "$script" | cut -d: -f1)"; e="$(grep -n 'if \[\[ "\$enable" == 1 \]\]' "$script" | cut -d: -f1)"
(( r > e )) || fail "removal must come after enable"
echo "suite-stages: ok (${#keys[@]} stages)"
