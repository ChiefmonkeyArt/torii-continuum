#!/usr/bin/env bash
# SB-18 tests for ops/lib/artifact-verify.sh and ops/lib/build-release-artifact.sh:
# component digests are recomputed from the extracted tree, the manifest
# timestamp is pinned to the commit, and component hashes are computed over
# relative (not absolute) paths. No full npm build here — the component-hash
# and secret-shape gates are exercised against a synthetic tree.
#
# Run:  bash ops/test/artifact-provenance-sb18.test.sh   (from repo root)

set -uo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
VERIFY="${REPO_ROOT}/ops/lib/artifact-verify.sh"
BUILDER="${REPO_ROOT}/ops/lib/build-release-artifact.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

for f in "$VERIFY" "$BUILDER"; do
  [[ -f "$f" ]] || { bad "missing $f"; exit 1; }
  bash -n "$f" && ok "$(basename "$f") parses cleanly" || bad "$(basename "$f") failed bash -n"
done
# shellcheck disable=SC1090
. "$VERIFY"

# ── static: deterministic builder inputs ─────────────────────────────────────
grep -qF 'cd "${stage_root}/dist" && find .' "$BUILDER" \
  && ok "builder hashes dist over relative paths" || bad "builder dist hash still uses absolute paths"
grep -qF "cd \"\${stage_root}/agent/node_modules\" && find ." "$BUILDER" \
  && ok "builder hashes node_modules over relative paths" || bad "builder node_modules hash still uses absolute paths"
grep -qF 'show -s --format=%cI HEAD' "$BUILDER" \
  && ok "builder pins built_at to the commit date (deterministic)" || bad "builder still uses fresh wall-clock build timestamp"
if grep -qF 'date -u +%Y-%m-%dT%H:%M:%SZ' "$BUILDER"; then
  bad "builder still stamps the manifest with a fresh wall-clock time"
else
  ok "builder no longer stamps a fresh wall-clock time"
fi

# ── functional: component-hash gate on a synthetic tree ──────────────────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
ROOT="${SCRATCH}/tree"
mkdir -p "${ROOT}/dist" "${ROOT}/agent/lib" "${ROOT}/agent/node_modules/pkg"
printf '<html>hi</html>\n'  > "${ROOT}/dist/index.html"
printf 'console.log(1)\n'    > "${ROOT}/agent/index.mjs"
printf 'console.log(2)\n'    > "${ROOT}/agent/lib/x.mjs"
printf 'module.exports=1\n'  > "${ROOT}/agent/node_modules/pkg/index.js"

# Compute the three digests exactly as the builder/verifier do (relative paths).
d="$(cd "${ROOT}/dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
s="$(cd "${ROOT}/agent" && find . -type f -not -path './node_modules/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
m="$(cd "${ROOT}/agent/node_modules" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
MANIFEST="${SCRATCH}/manifest.json"
cat > "$MANIFEST" <<JSON
{"tag":"v0.2.100-alpha","version":"0.2.100-alpha","commit":"$(printf 'a%.0s' {1..40})","built_at":"2026-01-01T00:00:00Z","components":{"dist_sha256":"$d","agent_src_sha256":"$s","agent_node_modules_sha256":"$m"}}
JSON

if artifact_verify_component_hashes "$MANIFEST" "$ROOT" 2>/dev/null; then
  ok "component-hash gate accepts a self-consistent tree"
else
  bad "component-hash gate rejected a self-consistent tree"
fi

# A modified component inside a checksum-valid tarball must be caught.
printf 'console.log(999)\n' > "${ROOT}/agent/lib/x.mjs"
if artifact_verify_component_hashes "$MANIFEST" "$ROOT" 2>/dev/null; then
  bad "component-hash gate did not catch a modified component"
else
  ok "component-hash gate rejects a modified component (digest mismatch)"
fi

# A manifest with no component digests must fail closed (schema check).
EMPTY_MANIFEST="${SCRATCH}/empty-manifest.json"
printf '{"tag":"v0.2.100-alpha","version":"0.2.100-alpha"}\n' > "$EMPTY_MANIFEST"
if artifact_verify_component_hashes "$EMPTY_MANIFEST" "$ROOT" 2>/dev/null; then
  bad "component-hash gate accepted a manifest with no component digests"
else
  ok "component-hash gate fails closed on a manifest missing component digests"
fi

# ── functional: broadened no-secrets shape detection ─────────────────────────
for name in '.env.production' 'notes.bak' 'server.pem' 'id_rsa'; do
  BADROOT="${SCRATCH}/bad-${name}"
  mkdir -p "${BADROOT}/agent"
  printf 'x\n' > "${BADROOT}/agent/${name}"
  if artifact_verify_no_secrets "$BADROOT" 2>/dev/null; then
    bad "no-secrets gate accepted a '${name}' file"
  else
    ok "no-secrets gate rejects '${name}'"
  fi
done
# Secret-shaped files inside node_modules are registry content and must NOT trip
# the broadened scanner (they were not copied from a live checkout).
NMROOT="${SCRATCH}/nm"
mkdir -p "${NMROOT}/agent/node_modules/pkg"
printf 'x\n' > "${NMROOT}/agent/node_modules/pkg/.env.example"
artifact_verify_no_secrets "$NMROOT" 2>/dev/null \
  && ok "no-secrets gate ignores node_modules registry content" \
  || bad "no-secrets gate wrongly flagged a node_modules fixture"

echo
echo "artifact-provenance-sb18.test.sh: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]