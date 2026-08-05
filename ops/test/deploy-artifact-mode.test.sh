#!/usr/bin/env bash
#
# Hermetic tests for the release-artifact fast-path wiring in
# ops/deploy-unattended.sh (OPS-ARTIFACT-1, v0.2.103-alpha).
#
# No real network: download_release_artifact's curl calls are intercepted by a
# stub `curl` placed earlier on PATH that serves fixed fixture bytes/JSON, so
# these tests are deterministic and offline like the rest of the suite.
#
# Covers:
#   1. artifact_repo_slug parses a valid github https url, empty for others.
#   2. write_extra_vars carries the new artifact/mode/fallback fields, stays
#      valid JSON, and remains secret-free.
#   3. download_release_artifact: happy path (checksum+manifest match) prints
#      the tarball path and exits 0.
#   4. download_release_artifact: checksum mismatch → non-zero, no path printed.
#   5. download_release_artifact: manifest tag mismatch → non-zero.
#   6. download_release_artifact: missing release (empty API response) → non-zero.
#   7. download_release_artifact: missing asset in an otherwise-valid release → non-zero.
#   8. download_release_artifact: cache reuse — a second call with an
#      already-verified cached artifact does not re-invoke curl.
#   9. run_deploy wiring (static): artifact mode is the default; source-build
#      is opt-in; fail-closed dep_die path exists for a failed download
#      without fallback enabled.
#
# Run:  bash ops/test/deploy-artifact-mode.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
WRAPPER="${REPO_ROOT}/ops/deploy-unattended.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$WRAPPER" ]] || { echo "missing $WRAPPER" >&2; exit 1; }

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT

# ── Fixture: a genuine tiny "artifact" + matching checksum + manifest ────────
TAG="v9.9.9-alpha"
FIXTURE_DIR="${SCRATCH}/fixture"
mkdir -p "$FIXTURE_DIR"
echo "fake tarball bytes" > "${FIXTURE_DIR}/torii-continuum-${TAG}.tar.gz"
( cd "$FIXTURE_DIR" && sha256sum "torii-continuum-${TAG}.tar.gz" > "torii-continuum-${TAG}.tar.gz.sha256" )
cat > "${FIXTURE_DIR}/torii-continuum-${TAG}.manifest.json" <<JSON
{ "tag": "${TAG}", "version": "9.9.9-alpha", "commit": "deadbeef" }
JSON

release_json_for() {
  local tag="$1" base_url="$2"
  cat <<JSON
{
  "tag_name": "${tag}",
  "assets": [
    {"name": "torii-continuum-${tag}.tar.gz", "browser_download_url": "${base_url}/torii-continuum-${tag}.tar.gz"},
    {"name": "torii-continuum-${tag}.tar.gz.sha256", "browser_download_url": "${base_url}/torii-continuum-${tag}.tar.gz.sha256"},
    {"name": "torii-continuum-${tag}.manifest.json", "browser_download_url": "${base_url}/torii-continuum-${tag}.manifest.json"}
  ]
}
JSON
}

# ── curl stub: serves fixture bytes for our fake "download" URLs, and the
#    release JSON fixture for the "API" URL. Records call count for the cache
#    reuse test. Controlled entirely via env vars so no real network is ever
#    touched.
STUB_BIN="${SCRATCH}/bin"
mkdir -p "$STUB_BIN"
CURL_CALL_LOG="${SCRATCH}/curl-calls.log"
: > "$CURL_CALL_LOG"

make_curl_stub() {
  local mode="$1"  # ok | missing-release | missing-asset | tamper-checksum | tamper-manifest
  cat > "${STUB_BIN}/curl" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "${CURL_CALL_LOG}"
mode="${mode}"
args=("\$@")
# Find -o dest and the final URL argument.
dest=""
url=""
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "-o" ]]; then dest="\${args[i+1]}"; fi
done
url="\${args[-1]}"

if [[ "\$url" == *"/releases/tags/"* ]]; then
  if [[ "\$mode" == "missing-release" ]]; then
    exit 22
  fi
  release_json='$(release_json_for "$TAG" "file://${FIXTURE_DIR}")'
  if [[ "\$mode" == "missing-asset" ]]; then
    release_json='{"tag_name":"${TAG}","assets":[{"name":"torii-continuum-${TAG}.tar.gz","browser_download_url":"file://${FIXTURE_DIR}/torii-continuum-${TAG}.tar.gz"}]}'
  fi
  echo "\$release_json"
  exit 0
fi

if [[ -n "\$dest" ]]; then
  src="\${url#file://}"
  if [[ "\$mode" == "tamper-checksum" && "\$src" == *.tar.gz ]]; then
    echo "tampered bytes, different from what the checksum expects" > "\$dest"
    exit 0
  fi
  if [[ "\$mode" == "tamper-manifest" && "\$src" == *.manifest.json ]]; then
    echo '{ "tag": "v0.0.0-wrong", "version": "0.0.0-wrong" }' > "\$dest"
    exit 0
  fi
  if [[ -f "\$src" ]]; then
    cp "\$src" "\$dest"
    exit 0
  fi
  exit 22
fi
exit 22
STUB
  chmod +x "${STUB_BIN}/curl"
}

# shellcheck source=/dev/null
source "$WRAPPER"

echo "== 1. artifact_repo_slug =="
[[ "$(artifact_repo_slug 'https://github.com/ChiefmonkeyArt/torii-continuum.git')" == "ChiefmonkeyArt/torii-continuum" ]] \
  && ok "parses a valid github https url" || bad "failed to parse a valid github https url"
[[ -z "$(artifact_repo_slug 'https://gitlab.com/foo/bar.git')" ]] \
  && ok "empty slug for a non-github host" || bad "non-empty slug for a non-github host"
[[ -z "$(artifact_repo_slug 'not-a-url')" ]] \
  && ok "empty slug for a non-URL" || bad "non-empty slug for a non-URL"

echo "== 2. write_extra_vars carries the new fields =="
mkdir -p "${SCRATCH}/ev"
write_extra_vars "${SCRATCH}/ev/ev.json" "chiefmonkey.art" "v0.2.61-alpha" \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" \
  "/opt/deploy/artifacts/torii-continuum-v0.2.61-alpha.tar.gz" "artifact" "false"
grep -qF '"continuum_artifact_path": "/opt/deploy/artifacts/torii-continuum-v0.2.61-alpha.tar.gz"' "${SCRATCH}/ev/ev.json" \
  && ok "extra-vars carries the artifact path" || bad "extra-vars missing artifact path"
grep -qF '"continuum_deploy_mode": "artifact"' "${SCRATCH}/ev/ev.json" \
  && ok "extra-vars carries the deploy mode" || bad "extra-vars missing deploy mode"
grep -qF '"continuum_deploy_allow_source_fallback": false' "${SCRATCH}/ev/ev.json" \
  && ok "extra-vars carries the fallback flag as JSON boolean" || bad "extra-vars fallback flag wrong/missing"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "${SCRATCH}/ev/ev.json" \
  && ok "extra-vars (with artifact fields) is valid JSON" || bad "extra-vars (with artifact fields) is not valid JSON"
if grep -qiE 'session_secret|admin_npub|vault' "${SCRATCH}/ev/ev.json"; then
  bad "extra-vars (with artifact fields) must expose no secret"
else
  ok "extra-vars (with artifact fields) is secret-free"
fi
# Backward-compatible defaults when the new args are omitted.
mkdir -p "${SCRATCH}/ev2}" 2>/dev/null
write_extra_vars "${SCRATCH}/ev/ev2.json" "chiefmonkey.art" "v0.2.61-alpha" \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git"
grep -qF '"continuum_deploy_mode": "artifact"' "${SCRATCH}/ev/ev2.json" \
  && ok "write_extra_vars defaults deploy mode to artifact when omitted" || bad "default deploy mode wrong"
grep -qF '"continuum_artifact_path": ""' "${SCRATCH}/ev/ev2.json" \
  && ok "write_extra_vars defaults artifact path to empty when omitted" || bad "default artifact path wrong"

echo "== 3. download_release_artifact happy path =="
make_curl_stub ok
: > "$CURL_CALL_LOG"
CACHE1="${SCRATCH}/cache-ok"
result="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE1" 2>"${SCRATCH}/err1.log")"
rc=$?
if [[ $rc -eq 0 && "$result" == "${CACHE1}/torii-continuum-${TAG}.tar.gz" && -f "$result" ]]; then
  ok "happy path returns 0 and prints the local tarball path"
else
  bad "happy path failed (rc=$rc result='$result'); stderr: $(cat "${SCRATCH}/err1.log")"
fi

echo "== 4. download_release_artifact rejects a tampered tarball (checksum mismatch) =="
make_curl_stub tamper-checksum
: > "$CURL_CALL_LOG"
CACHE2="${SCRATCH}/cache-tamper-checksum"
if result="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE2" 2>/dev/null)"; then
  bad "ACCEPTED a tampered tarball with mismatched checksum (should reject)"
else
  ok "rejects a tampered tarball with mismatched checksum"
fi

echo "== 5. download_release_artifact rejects a tag-mismatched manifest =="
make_curl_stub tamper-manifest
: > "$CURL_CALL_LOG"
CACHE3="${SCRATCH}/cache-tamper-manifest"
if result="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE3" 2>/dev/null)"; then
  bad "ACCEPTED an artifact whose manifest tag doesn't match (should reject)"
else
  ok "rejects an artifact whose manifest tag doesn't match the requested tag"
fi

echo "== 6. download_release_artifact rejects a missing release =="
make_curl_stub missing-release
: > "$CURL_CALL_LOG"
CACHE4="${SCRATCH}/cache-missing-release"
if result="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE4" 2>/dev/null)"; then
  bad "ACCEPTED when no release exists for the tag (should reject)"
else
  ok "rejects when no GitHub Release exists for the tag"
fi

echo "== 7. download_release_artifact rejects a release missing an asset =="
make_curl_stub missing-asset
: > "$CURL_CALL_LOG"
CACHE5="${SCRATCH}/cache-missing-asset"
if result="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE5" 2>/dev/null)"; then
  bad "ACCEPTED a release missing the checksum/manifest asset (should reject)"
else
  ok "rejects a release that is missing a required asset"
fi

echo "== 8. download_release_artifact reuses an already-verified cache without re-hitting curl =="
make_curl_stub ok
: > "$CURL_CALL_LOG"
CACHE6="${SCRATCH}/cache-reuse"
first="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE6" 2>/dev/null)"
calls_after_first=$(wc -l < "$CURL_CALL_LOG")
second="$(PATH="${STUB_BIN}:${PATH}" download_release_artifact \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git" "$TAG" "$CACHE6" 2>/dev/null)"
calls_after_second=$(wc -l < "$CURL_CALL_LOG")
if [[ "$first" == "$second" && "$calls_after_second" -eq "$calls_after_first" ]]; then
  ok "second call reuses the verified cache and makes no additional curl calls"
else
  bad "cache reuse did not short-circuit curl (first=$first second=$second calls: $calls_after_first -> $calls_after_second)"
fi

echo "== 9. run_deploy artifact-mode wiring (static assertions) =="
grep -qF 'CONTINUUM_DEPLOY_MODE:=artifact' "$WRAPPER" \
  && ok "artifact mode is the default" || bad "artifact mode is not the default"
grep -qF 'download_release_artifact "$CONTINUUM_REPO" "$tag" "$CONTINUUM_ARTIFACT_CACHE"' "$WRAPPER" \
  && ok "run_deploy calls download_release_artifact for the target tag" || bad "run_deploy does not call download_release_artifact"
grep -qF 'CONTINUUM_ALLOW_SOURCE_FALLBACK is not set; refusing to silently fall back' "$WRAPPER" \
  && ok "run_deploy fails closed when artifact download fails and fallback is disabled" || bad "missing fail-closed dep_die on artifact failure"
grep -qF 'deploy_mode="source-build"' "$WRAPPER" \
  && ok "run_deploy can fall back to source-build when explicitly allowed" || bad "missing source-build fallback assignment"

echo
echo "deploy-artifact-mode.test.sh: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
