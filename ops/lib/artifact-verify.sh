#!/usr/bin/env bash
#
# Torii Continuum — release artifact verification (OPS-ARTIFACT-1, v0.2.103-alpha).
#
# Sourceable library of pure(ish) functions the VPS-side fast deploy path and
# the CI validation step both use to decide whether a downloaded artifact is
# safe to promote. FAIL CLOSED throughout: any missing file, checksum
# mismatch, malformed manifest, or version/tag mismatch is a hard refusal,
# never a warning-and-continue.
#
# No network calls live here — callers (ops/deploy-unattended.sh) own
# downloading. This module only inspects bytes already on disk.

# ── artifact_tag_valid <tag> ─────────────────────────────────────────────────
#   Same strict grammar as the deploy wrapper and the artifact builder.
readonly ARTIFACT_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
artifact_tag_valid() {
  local tag="${1:-}"
  [[ -n "$tag" ]] && [[ "$tag" =~ $ARTIFACT_TAG_RE ]]
}

# ── artifact_verify_checksum <tarball> <sha256-file> ─────────────────────────
#   0 iff the tarball's sha256 matches the checksum file's recorded digest AND
#   the checksum file names exactly the tarball's own basename (prevents a
#   checksum file for a DIFFERENT artifact being paired with this tarball).
artifact_verify_checksum() {
  local tarball="${1:?}" sumfile="${2:?}"
  [[ -f "$tarball" ]] || { echo "artifact_verify_checksum: tarball missing: $tarball" >&2; return 1; }
  [[ -f "$sumfile"  ]] || { echo "artifact_verify_checksum: checksum file missing: $sumfile" >&2; return 1; }

  local base; base="$(basename -- "$tarball")"
  local recorded_name; recorded_name="$(awk '{print $2}' "$sumfile" | head -1)"
  [[ "$recorded_name" == "$base" || "$recorded_name" == "./${base}" ]] \
    || { echo "artifact_verify_checksum: checksum file names '${recorded_name}', expected '${base}'" >&2; return 1; }

  local dir; dir="$(cd -- "$(dirname -- "$tarball")" && pwd -P)"
  ( cd "$dir" && sha256sum -c --strict "$(basename -- "$sumfile")" >/dev/null 2>&1 )
}

# ── artifact_verify_manifest <manifest.json> <expected-tag> ──────────────────
#   0 iff the manifest is present, is well-formed enough to extract "tag" and
#   "version" with plain text tools (no jq dependency assumed on a minimal
#   VPS), and both match the expected tag (version == tag with leading v
#   stripped). Fails closed on any parse ambiguity.
artifact_verify_manifest() {
  local manifest="${1:?}" expected_tag="${2:?}"
  [[ -f "$manifest" ]] || { echo "artifact_verify_manifest: manifest missing: $manifest" >&2; return 1; }

  local m_tag m_version
  m_tag="$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  m_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"

  [[ -n "$m_tag" ]] || { echo "artifact_verify_manifest: could not read tag from manifest" >&2; return 1; }
  [[ -n "$m_version" ]] || { echo "artifact_verify_manifest: could not read version from manifest" >&2; return 1; }

  [[ "$m_tag" == "$expected_tag" ]] \
    || { echo "artifact_verify_manifest: manifest tag '${m_tag}' != expected '${expected_tag}'" >&2; return 1; }
  [[ "$m_version" == "${expected_tag#v}" ]] \
    || { echo "artifact_verify_manifest: manifest version '${m_version}' != expected '${expected_tag#v}'" >&2; return 1; }
  return 0
}

# ── artifact_verify_no_secrets <extracted-dir> ───────────────────────────────
#   0 iff none of the forbidden secret/live-state paths exist in an extracted
#   artifact tree. Defence-in-depth: the builder already refuses to package
#   these, but the VPS re-checks independently before ever pointing a service
#   at extracted content.
artifact_verify_no_secrets() {
  local dir="${1:?}"
  local forbidden=(
    "agent/config.yaml"
    "agent/memory"
    "agent/ciphertexts"
    "agent/pending"
    "agent/.env"
    "agent/.env.local"
  )
  local f
  for f in "${forbidden[@]}"; do
    if [[ -e "${dir}/${f}" ]]; then
      echo "artifact_verify_no_secrets: forbidden path present in artifact: ${f}" >&2
      return 1
    fi
  done
  return 0
}

# ── artifact_verify_contents <extracted-dir> ─────────────────────────────────
#   0 iff the extracted tree has the shape a promotable release requires:
#   dist/index.html, agent/index.mjs, agent/package.json, agent/node_modules
#   (production deps present — the whole point of the fast path), VERSION.
artifact_verify_contents() {
  local dir="${1:?}"
  local required=(
    "dist/index.html"
    "agent/index.mjs"
    "agent/package.json"
    "agent/node_modules"
    "VERSION"
    "MANIFEST.json"
  )
  local p
  for p in "${required[@]}"; do
    if [[ ! -e "${dir}/${p}" ]]; then
      echo "artifact_verify_contents: missing required member: ${p}" >&2
      return 1
    fi
  done
  return 0
}

# ── artifact_verify_all <tarball> <sha256-file> <manifest> <expected-tag> <extracted-dir> ──
#   Convenience wrapper: runs every gate above in the order the deployer needs
#   (checksum before extraction is even trusted, then content/manifest/secrets
#   checks on the extracted tree). Prints which gate failed; returns non-zero
#   on the first failure (fail closed, no partial trust).
artifact_verify_all() {
  local tarball="${1:?}" sumfile="${2:?}" manifest="${3:?}" tag="${4:?}" extracted="${5:?}"

  artifact_tag_valid "$tag" || { echo "artifact_verify_all: invalid tag grammar: $tag" >&2; return 1; }
  artifact_verify_checksum "$tarball" "$sumfile" || { echo "artifact_verify_all: checksum gate FAILED" >&2; return 1; }
  artifact_verify_manifest "$manifest" "$tag" || { echo "artifact_verify_all: manifest gate FAILED" >&2; return 1; }
  artifact_verify_contents "$extracted" || { echo "artifact_verify_all: contents gate FAILED" >&2; return 1; }
  artifact_verify_no_secrets "$extracted" || { echo "artifact_verify_all: secrets gate FAILED" >&2; return 1; }
  echo "artifact_verify_all: OK ($tag)"
  return 0
}

# ── CLI dispatcher (only when executed, not when sourced) ────────────────────
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  cmd="${1:-}"; shift || true
  case "$cmd" in
    tag-valid)        artifact_tag_valid "$@" ;;
    checksum)         artifact_verify_checksum "$@" ;;
    manifest)         artifact_verify_manifest "$@" ;;
    no-secrets)       artifact_verify_no_secrets "$@" ;;
    contents)         artifact_verify_contents "$@" ;;
    all)              artifact_verify_all "$@" ;;
    *)
      echo "usage: artifact-verify.sh {tag-valid|checksum|manifest|no-secrets|contents|all} ..." >&2
      exit 2 ;;
  esac
fi
