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
#   at extracted content. SB-18: broadened beyond the six named paths — any
#   secret-/backup-shaped file outside node_modules (fresh registry content,
#   separately checksummed) is also refused, so a copy-all-then-prune builder
#   cannot smuggle a .env.production, private key or editor backup through.
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
  local hit
  hit="$(find "$dir" -type f -not -path '*/node_modules/*' \
      \( -name '.env.production' -o -name '.env.staging' \
         -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \
         -o -name 'id_rsa' -o -name 'id_rsa.*' -o -name 'id_ed25519*' -o -name 'id_ecdsa*' \
         -o -name '*.bak' -o -name '*.orig' -o -name '*~' \) -print -quit 2>/dev/null || true)"
  if [[ -n "$hit" ]]; then
    echo "artifact_verify_no_secrets: secret/backup-shaped file in artifact: ${hit}" >&2
    return 1
  fi
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

# ── artifact_verify_component_hashes <manifest> <extracted-dir> ───────────────
#   0 iff the three component digests the builder recorded in the manifest match
#   a fresh recomputation from the extracted tree using the SAME relative-path
#   method the builder used. This is the deep self-check the manifest promises
#   but the verifier previously never performed (SB-18): it catches a modified
#   component inside an otherwise checksum-valid tarball.
artifact_verify_component_hashes() {
  local manifest="${1:?}" root="${2:?}"
  [[ -f "$manifest" ]] || { echo "artifact_verify_component_hashes: manifest missing: $manifest" >&2; return 1; }

  local exp_dist exp_src exp_deps
  exp_dist="$(node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((m.components&&m.components.dist_sha256)||"");}catch(e){process.stdout.write("");}' "$manifest" 2>/dev/null || true)"
  exp_src="$(node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((m.components&&m.components.agent_src_sha256)||"");}catch(e){process.stdout.write("");}' "$manifest" 2>/dev/null || true)"
  exp_deps="$(node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((m.components&&m.components.agent_node_modules_sha256)||"");}catch(e){process.stdout.write("");}' "$manifest" 2>/dev/null || true)"

  [[ -n "$exp_dist" && -n "$exp_src" && -n "$exp_deps" ]] \
    || { echo "artifact_verify_component_hashes: manifest missing component digests (malformed manifest)" >&2; return 1; }

  local got_dist got_src got_deps bad=0
  got_dist="$(cd "${root}/dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  got_src="$(cd "${root}/agent" && find . -type f -not -path './node_modules/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
  got_deps="$(cd "${root}/agent/node_modules" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

  [[ "$got_dist" == "$exp_dist" ]] \
    || { echo "artifact_verify_component_hashes: dist digest mismatch (manifest != recomputed)" >&2; bad=1; }
  [[ "$got_src" == "$exp_src" ]] \
    || { echo "artifact_verify_component_hashes: agent source digest mismatch (manifest != recomputed)" >&2; bad=1; }
  [[ "$got_deps" == "$exp_deps" ]] \
    || { echo "artifact_verify_component_hashes: agent node_modules digest mismatch (manifest != recomputed)" >&2; bad=1; }
  [[ "$bad" -eq 0 ]]
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
  artifact_verify_component_hashes "$manifest" "$extracted" || { echo "artifact_verify_all: component-digest gate FAILED" >&2; return 1; }
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
    component-hashes) artifact_verify_component_hashes "$@" ;;
    all)              artifact_verify_all "$@" ;;
    *)
      echo "usage: artifact-verify.sh {tag-valid|checksum|manifest|no-secrets|contents|component-hashes|all} ..." >&2
      exit 2 ;;
  esac
fi
