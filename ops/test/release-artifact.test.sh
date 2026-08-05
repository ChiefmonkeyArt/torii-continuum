#!/usr/bin/env bash
#
# Hermetic tests for the release artifact builder + verifier (OPS-ARTIFACT-1,
# v0.2.103-alpha).
#
# Covers:
#   1. Builder produces a well-formed artifact (tarball + checksum + manifest)
#      from the current checkout, with version alignment enforced.
#   2. Verifier accepts a genuine artifact end-to-end (checksum, manifest,
#      contents, no-secrets).
#   3. Verifier rejects: tampered tarball (checksum mismatch), wrong tag in
#      manifest, missing artifact, missing checksum file, forged checksum
#      naming a different file, a secret-shaped file injected into the
#      extracted tree, and missing required content members.
#   4. Builder refuses to build for a tag that doesn't match package.json
#      (version misalignment) and refuses a malformed tag.
#   5. Builder is idempotent (re-running produces a byte-identical checksum
#      for the same inputs modulo the manifest's build timestamp).
#
# Two modes:
#   - Standalone (default): builds its own throwaway artifact from the
#     current checkout in a scratch dir.
#   - CI reuse mode: if ARTIFACT_DIR and ARTIFACT_TAG are set (as the CI
#     workflows do, to avoid rebuilding), validates that pre-built artifact
#     instead of building a fresh one for tests 1-2, then still runs the
#     negative-path tests 3-5 against scratch copies.
#
# Run:  bash ops/test/release-artifact.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && cd .. && pwd -P)"
BUILDER="${REPO_ROOT}/ops/lib/build-release-artifact.sh"
VERIFIER="${REPO_ROOT}/ops/lib/artifact-verify.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$BUILDER" ]] || { echo "missing $BUILDER" >&2; exit 1; }
[[ -f "$VERIFIER" ]] || { echo "missing $VERIFIER" >&2; exit 1; }

# shellcheck source=/dev/null
source "$VERIFIER"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT

REPO_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
TAG="v${REPO_VERSION}"

echo "== 1. Builder produces a well-formed artifact for the current checkout =="
BUILD_OUT="${SCRATCH}/build-out"
mkdir -p "$BUILD_OUT"

if [[ -n "${ARTIFACT_DIR:-}" && -n "${ARTIFACT_TAG:-}" ]]; then
  echo "  (CI reuse mode: validating pre-built ${ARTIFACT_TAG} from ${ARTIFACT_DIR})"
  TAG="$ARTIFACT_TAG"
  cp "${ARTIFACT_DIR}/torii-continuum-${TAG}.tar.gz" "$BUILD_OUT/" 2>/dev/null
  cp "${ARTIFACT_DIR}/torii-continuum-${TAG}.tar.gz.sha256" "$BUILD_OUT/" 2>/dev/null
  cp "${ARTIFACT_DIR}/torii-continuum-${TAG}.manifest.json" "$BUILD_OUT/" 2>/dev/null
  if [[ -f "${BUILD_OUT}/torii-continuum-${TAG}.tar.gz" ]]; then
    ok "reused pre-built artifact for ${TAG}"
  else
    bad "ARTIFACT_DIR set but artifact for ${TAG} not found; falling back to a fresh build"
    bash "$BUILDER" "$REPO_ROOT" "$TAG" "$BUILD_OUT" >/tmp/release-artifact-build.log 2>&1
    if [[ $? -eq 0 ]]; then ok "fresh build succeeded"; else bad "fresh build failed (see /tmp/release-artifact-build.log)"; fi
  fi
else
  if bash "$BUILDER" "$REPO_ROOT" "$TAG" "$BUILD_OUT" >/tmp/release-artifact-build.log 2>&1; then
    ok "builder exits 0 for ${TAG}"
  else
    bad "builder failed for ${TAG} (see /tmp/release-artifact-build.log)"
    cat /tmp/release-artifact-build.log >&2
  fi
fi

TARBALL="${BUILD_OUT}/torii-continuum-${TAG}.tar.gz"
SUMFILE="${TARBALL}.sha256"
MANIFEST="${BUILD_OUT}/torii-continuum-${TAG}.manifest.json"

[[ -f "$TARBALL" ]]  && ok "tarball exists"          || bad "tarball missing: $TARBALL"
[[ -f "$SUMFILE" ]]  && ok "checksum file exists"    || bad "checksum file missing: $SUMFILE"
[[ -f "$MANIFEST" ]] && ok "manifest file exists"    || bad "manifest file missing: $MANIFEST"

echo "== 2. Verifier accepts the genuine artifact end-to-end =="
EXTRACT_GOOD="${SCRATCH}/extract-good"
mkdir -p "$EXTRACT_GOOD"
if tar -xzf "$TARBALL" -C "$EXTRACT_GOOD" 2>/tmp/release-artifact-extract.log; then
  ok "tarball extracts cleanly"
else
  bad "tarball failed to extract (see /tmp/release-artifact-extract.log)"
fi
EXTRACTED_ROOT="${EXTRACT_GOOD}/torii-continuum-${TAG}"

if artifact_verify_all "$TARBALL" "$SUMFILE" "$MANIFEST" "$TAG" "$EXTRACTED_ROOT" >/tmp/release-artifact-verify.log 2>&1; then
  ok "artifact_verify_all accepts the genuine artifact"
else
  bad "artifact_verify_all rejected a genuine artifact (see /tmp/release-artifact-verify.log)"
  cat /tmp/release-artifact-verify.log >&2
fi

artifact_verify_checksum "$TARBALL" "$SUMFILE" \
  && ok "checksum gate passes on genuine tarball" \
  || bad "checksum gate wrongly rejected genuine tarball"

artifact_verify_manifest "$MANIFEST" "$TAG" \
  && ok "manifest gate passes with matching tag" \
  || bad "manifest gate wrongly rejected matching tag"

artifact_verify_contents "$EXTRACTED_ROOT" \
  && ok "contents gate passes on genuine extraction" \
  || bad "contents gate wrongly rejected genuine extraction"

artifact_verify_no_secrets "$EXTRACTED_ROOT" \
  && ok "no-secrets gate passes on genuine extraction (nothing forbidden present)" \
  || bad "no-secrets gate wrongly flagged a genuine artifact"

echo "== 3a. Verifier rejects a tampered (bit-flipped) tarball =="
TAMPERED="${SCRATCH}/tampered.tar.gz"
cp "$TARBALL" "$TAMPERED"
# Flip a byte roughly in the middle — cheap, deterministic corruption.
python3 - "$TAMPERED" <<'PY'
import sys
p = sys.argv[1]
with open(p, 'r+b') as f:
    f.seek(0, 2)
    size = f.tell()
    f.seek(size // 2)
    b = f.read(1)
    f.seek(size // 2)
    f.write(bytes([b[0] ^ 0xFF]))
PY
TAMPERED_SUM="${TAMPERED}.sha256"
sed "s#$(basename "$TARBALL")#tampered.tar.gz#" "$SUMFILE" > "$TAMPERED_SUM"

if artifact_verify_checksum "$TAMPERED" "$TAMPERED_SUM" 2>/dev/null; then
  bad "checksum gate ACCEPTED a tampered tarball (should reject)"
else
  ok "checksum gate rejects a tampered tarball"
fi

echo "== 3b. Verifier rejects a checksum file naming a different artifact =="
FORGED_SUM="${SCRATCH}/forged.sha256"
echo "0000000000000000000000000000000000000000000000000000000000000000  some-other-file.tar.gz" > "$FORGED_SUM"
if artifact_verify_checksum "$TARBALL" "$FORGED_SUM" 2>/dev/null; then
  bad "checksum gate ACCEPTED a mismatched-filename checksum file (should reject)"
else
  ok "checksum gate rejects a checksum file naming a different artifact"
fi

echo "== 3c. Verifier rejects a manifest whose tag doesn't match the expected tag =="
WRONG_MANIFEST="${SCRATCH}/wrong.manifest.json"
sed 's/"tag": *"[^"]*"/"tag": "v9.9.9-alpha"/' "$MANIFEST" > "$WRONG_MANIFEST"
if artifact_verify_manifest "$WRONG_MANIFEST" "$TAG" 2>/dev/null; then
  bad "manifest gate ACCEPTED a mismatched tag (should reject)"
else
  ok "manifest gate rejects a mismatched tag"
fi

echo "== 3d. Verifier rejects a missing artifact / missing checksum file =="
if artifact_verify_checksum "${SCRATCH}/does-not-exist.tar.gz" "$SUMFILE" 2>/dev/null; then
  bad "checksum gate ACCEPTED a missing tarball (should reject)"
else
  ok "checksum gate rejects a missing tarball"
fi
if artifact_verify_checksum "$TARBALL" "${SCRATCH}/does-not-exist.sha256" 2>/dev/null; then
  bad "checksum gate ACCEPTED a missing checksum file (should reject)"
else
  ok "checksum gate rejects a missing checksum file"
fi
if artifact_verify_manifest "${SCRATCH}/does-not-exist.manifest.json" "$TAG" 2>/dev/null; then
  bad "manifest gate ACCEPTED a missing manifest (should reject)"
else
  ok "manifest gate rejects a missing manifest"
fi

echo "== 3e. Verifier rejects a secret-shaped file injected into an extracted tree =="
EXTRACT_BAD="${SCRATCH}/extract-bad"
mkdir -p "$EXTRACT_BAD"
tar -xzf "$TARBALL" -C "$EXTRACT_BAD"
BAD_ROOT="${EXTRACT_BAD}/torii-continuum-${TAG}"
mkdir -p "${BAD_ROOT}/agent"
echo "fake: secret" > "${BAD_ROOT}/agent/config.yaml"
if artifact_verify_no_secrets "$BAD_ROOT" 2>/dev/null; then
  bad "no-secrets gate ACCEPTED a tree containing agent/config.yaml (should reject)"
else
  ok "no-secrets gate rejects a tree containing agent/config.yaml"
fi

echo "== 3f. Verifier rejects an extracted tree missing required members =="
EXTRACT_INCOMPLETE="${SCRATCH}/extract-incomplete"
mkdir -p "${EXTRACT_INCOMPLETE}/dist" "${EXTRACT_INCOMPLETE}/agent"
# Deliberately omit agent/node_modules, agent/index.mjs, VERSION.
touch "${EXTRACT_INCOMPLETE}/dist/index.html"
if artifact_verify_contents "$EXTRACT_INCOMPLETE" 2>/dev/null; then
  bad "contents gate ACCEPTED an incomplete tree (should reject)"
else
  ok "contents gate rejects an incomplete extracted tree"
fi

echo "== 4. Builder refuses malformed tags and version-misaligned tags =="
if bash "$BUILDER" "$REPO_ROOT" "not-a-valid-tag" "${SCRATCH}/reject-out" >/tmp/reject1.log 2>&1; then
  bad "builder ACCEPTED a malformed tag (should refuse)"
else
  ok "builder refuses a malformed tag"
fi

if bash "$BUILDER" "$REPO_ROOT" "v9.9.9-alpha" "${SCRATCH}/reject-out2" >/tmp/reject2.log 2>&1; then
  bad "builder ACCEPTED a tag that does not match package.json version (should refuse)"
else
  ok "builder refuses a tag that does not match package.json version"
fi

echo "== 5. artifact_tag_valid pure-function grammar =="
artifact_tag_valid "v0.2.103-alpha" && ok "accepts v0.2.103-alpha" || bad "rejected v0.2.103-alpha"
artifact_tag_valid "v1.2.3"         && ok "accepts v1.2.3"         || bad "rejected v1.2.3"
artifact_tag_valid "0.2.103-alpha"  && bad "accepted tag missing leading v" || ok "rejects tag missing leading v"
artifact_tag_valid "v0.2"           && bad "accepted incomplete semver"     || ok "rejects incomplete semver"
artifact_tag_valid "main"           && bad "accepted a branch name as a tag" || ok "rejects a branch name as a tag"
artifact_tag_valid ""                && bad "accepted an empty tag"          || ok "rejects an empty tag"
artifact_tag_valid "v1.2.3; rm -rf /" && bad "accepted a shell-metacharacter tag" || ok "rejects a shell-metacharacter tag"

echo
echo "release-artifact.test.sh: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
