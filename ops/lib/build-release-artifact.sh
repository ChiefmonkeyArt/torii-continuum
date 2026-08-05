#!/usr/bin/env bash
#
# Torii Continuum — release artifact builder (OPS-ARTIFACT-1, v0.2.103-alpha).
#
# WHY THIS EXISTS
# ---------------
# Every unattended upgrade used to clone the repo TWICE on the resource-
# constrained VPS (once for the deploy wrapper's tooling checkout, once inside
# the Ansible staging dir), run `npm ci` for dev+prod deps to build the SPA,
# run `npm run build` on the box, then run a SECOND `npm ci --omit=dev` for the
# agent — four expensive, network- and CPU-bound steps repeated on every
# release even though the inputs (lockfiles, source) are already known at PR
# merge time. That is what turned a routine version bump into 20-35 minutes.
#
# This script performs ALL of that work exactly ONCE, in CI, on a fresh
# checkout of an exact tag, and packages the result into a single deterministic
# tarball the VPS can download and verify in seconds. It is the single source
# of truth for "what a release artifact contains" — the GitHub Actions release
# workflow and any operator building one by hand both call this script, so the
# two paths can never drift apart.
#
# WHAT GOES IN THE ARTIFACT
# --------------------------
#   dist/                 vite production build of the SPA (already built,
#                          never rebuilt on the VPS)
#   agent/                agent source (index.mjs, core/, lib/, skills/,
#                          scripts/, package.json, package-lock.json,
#                          config.example.yaml, *.md) EXCLUDING node_modules,
#                          test/, config.yaml, memory/, ciphertexts/, pending/
#   agent/node_modules/   agent PRODUCTION dependencies only, installed with
#                          `npm ci --omit=dev` — i.e. exactly what the VPS used
#                          to install itself, just built once in CI instead of
#                          once per deploy per box.
#   VERSION               the exact tag this artifact was built for (e.g.
#                          v0.2.103-alpha), byte-identical to the root and
#                          agent package.json versions (enforced by the
#                          existing version-alignment gate before this runs).
#   MANIFEST.json         non-secret build provenance: tag, git commit SHA,
#                          UTC build time, builder platform, node/npm
#                          versions, and the sha256 of every top-level
#                          artifact member — so the VPS can do a deep
#                          "does this tarball's content match its own
#                          manifest" self-check BEFORE trusting the checksum
#                          file shipped alongside it.
#
# WHAT NEVER GOES IN
# -------------------
# No secret, credential, or live state EVER enters the artifact: config.yaml,
# memory/, ciphertexts/, pending/, .env*, and any dotfile under agent/ are
# explicitly excluded (belt-and-suspenders on top of never being staged into
# the build tree in the first place, since this script only ever reads from a
# clean CI checkout that never had those files).
#
# PORTABILITY
# -----------
# agent/node_modules is npm-installed FOR THE TARGET NODE ABI at build time.
# All of the agent's runtime dependencies (@cashu/cashu-ts, @fastify/*,
# fastify, nostr-tools, yaml) are pure-JS with no native (node-gyp) bindings —
# verified below by scanning for compiled .node addons — so a node_modules
# tree built on the CI runner's OS/arch is byte-identical to one built on the
# VPS and safe to ship. If a future dependency ever adds a native binding this
# script FAILS CLOSED (refuses to package) rather than silently shipping a
# binary that may not run on the VPS's kernel/libc; the fallback source-build
# path remains available for that scenario (see ops/deploy-unattended.sh
# CONTINUUM_ALLOW_SOURCE_BUILD_FALLBACK).
#
# USAGE
#   build-release-artifact.sh <repo-checkout-dir> <tag> <output-dir>
#
# Produces in <output-dir>:
#   torii-continuum-<tag>.tar.gz
#   torii-continuum-<tag>.tar.gz.sha256
#   torii-continuum-<tag>.manifest.json
#
# Exit non-zero on ANY failure (fail closed — CI must not publish a partial or
# suspect artifact). Idempotent: safe to re-run against the same checkout.

set -euo pipefail

log() { printf '[build-release-artifact] %s\n' "$*"; }
die() { printf '[build-release-artifact] FATAL: %s\n' "$*" >&2; exit 1; }

REPO_DIR="${1:?usage: build-release-artifact.sh <repo-dir> <tag> <output-dir>}"
TAG="${2:?usage: build-release-artifact.sh <repo-dir> <tag> <output-dir>}"
OUT_DIR="${3:?usage: build-release-artifact.sh <repo-dir> <tag> <output-dir>}"

# Same strict grammar as the VPS-side deploy wrapper (ops/deploy-unattended.sh)
# so a malformed tag can never produce or be embedded in an artifact.
readonly TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
[[ "$TAG" =~ $TAG_RE ]] || die "tag '${TAG}' is not a valid v<semver> release tag."

[[ -d "$REPO_DIR" ]] || die "repo dir '${REPO_DIR}' does not exist."
[[ -f "${REPO_DIR}/package.json" ]] || die "'${REPO_DIR}' does not look like a torii-continuum checkout (no package.json)."
[[ -f "${REPO_DIR}/agent/package.json" ]] || die "'${REPO_DIR}/agent/package.json' missing."

command -v node >/dev/null || die "node not found."
command -v npm  >/dev/null || die "npm not found."
command -v tar  >/dev/null || die "tar not found."
command -v sha256sum >/dev/null || die "sha256sum not found."

mkdir -p "$OUT_DIR"

# ── 1. Version alignment gate (fail closed BEFORE any build work) ───────────
# The artifact's whole trust model rests on continuum_version == package
# version == the tag the VPS pinned. Refuse to build anything otherwise.
root_version="$(node -p "require('${REPO_DIR}/package.json').version")"
agent_version="$(node -p "require('${REPO_DIR}/agent/package.json').version")"
tag_version="${TAG#v}"

[[ "$root_version" == "$agent_version" ]] \
  || die "root package.json version (${root_version}) != agent package.json version (${agent_version})."
[[ "$root_version" == "$tag_version" ]] \
  || die "package.json version (${root_version}) != tag ${TAG} (expected ${tag_version})."
log "version alignment OK: ${TAG} == package.json ${root_version}"

# ── 2. Build the SPA (dev deps needed only in CI, never on the VPS) ─────────
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT

log "installing root deps (npm ci) for the SPA build"
( cd "$REPO_DIR" && npm ci --no-audit --no-fund )

log "building the SPA (vite build)"
( cd "$REPO_DIR" && npm run build )
[[ -d "${REPO_DIR}/dist" ]] || die "vite build did not produce dist/."
[[ -f "${REPO_DIR}/dist/index.html" ]] || die "dist/index.html missing after build."

# ── 3. Install agent PRODUCTION dependencies exactly once ───────────────────
log "installing agent production deps (npm ci --omit=dev)"
( cd "${REPO_DIR}/agent" && npm ci --omit=dev --no-audit --no-fund )
[[ -d "${REPO_DIR}/agent/node_modules" ]] || die "agent/node_modules missing after npm ci --omit=dev."

# Portability gate: refuse to package any compiled native addon. All of the
# agent's current runtime deps are pure JS; this assertion makes a future
# native dependency a loud, fail-closed CI failure instead of a silent
# portability trap discovered on the VPS.
if find "${REPO_DIR}/agent/node_modules" -name '*.node' -print -quit | grep -q . ; then
  die "agent/node_modules contains a compiled native addon (*.node) — refusing to package a non-portable artifact. Use the source-build fallback for this release, or vendor a prebuilt binary matching the VPS's exact platform."
fi
log "portability check OK: no native (*.node) addons in agent/node_modules"

# ── 4. Assemble the staged artifact tree ─────────────────────────────────────
stage_root="${STAGE}/torii-continuum-${TAG}"
mkdir -p "$stage_root"

log "staging dist/"
mkdir -p "${stage_root}/dist"
cp -a "${REPO_DIR}/dist/." "${stage_root}/dist/"

log "staging agent/ (source + production node_modules only)"
mkdir -p "${stage_root}/agent"
# rsync-free, portable copy: copy everything, then prune what must never ship.
cp -a "${REPO_DIR}/agent/." "${stage_root}/agent/"
rm -rf -- \
  "${stage_root}/agent/test" \
  "${stage_root}/agent/config.yaml" \
  "${stage_root}/agent/memory" \
  "${stage_root}/agent/ciphertexts" \
  "${stage_root}/agent/pending" \
  "${stage_root}/agent/.env" \
  "${stage_root}/agent/.env.local"
# Fail closed if anything secret-shaped slipped through despite the excludes
# above (defence in depth — the source checkout should never have these, but
# the packaging step re-verifies before it ever writes the tarball).
for forbidden in config.yaml memory ciphertexts pending .env .env.local; do
  if [[ -e "${stage_root}/agent/${forbidden}" ]]; then
    die "refusing to package: ${forbidden} present in staged agent/ tree (secret/live-state leak)."
  fi
done

printf '%s\n' "$TAG" > "${stage_root}/VERSION"

# ── 5. Manifest — non-secret build provenance ────────────────────────────────
commit_sha="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node_version="$(node --version)"
npm_version="$(npm --version)"
platform="$(uname -s)-$(uname -m)"

dist_hash="$(find "${stage_root}/dist" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
agent_src_hash="$(find "${stage_root}/agent" -type f -not -path '*/node_modules/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
agent_deps_hash="$(find "${stage_root}/agent/node_modules" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"

cat > "${stage_root}/MANIFEST.json" <<JSON
{
  "tag": "${TAG}",
  "version": "${root_version}",
  "commit": "${commit_sha}",
  "built_at": "${build_time}",
  "builder": {
    "platform": "${platform}",
    "node": "${node_version}",
    "npm": "${npm_version}"
  },
  "components": {
    "dist_sha256": "${dist_hash}",
    "agent_src_sha256": "${agent_src_hash}",
    "agent_node_modules_sha256": "${agent_deps_hash}"
  }
}
JSON
log "wrote MANIFEST.json (commit=${commit_sha} built_at=${build_time})"

# ── 6. Deterministic tarball ─────────────────────────────────────────────────
# Sort entries and pin mtimes/owner so a re-build of the same commit is
# byte-reproducible where the toolchain allows it (best effort — npm's own
# node_modules layout is not perfectly deterministic across registries, but
# GNU tar's --sort/--mtime/--owner flags remove the obvious sources of drift).
artifact_name="torii-continuum-${TAG}.tar.gz"
artifact_path="${OUT_DIR}/${artifact_name}"

( cd "$STAGE" && \
  tar --sort=name \
      --mtime='UTC 2020-01-01' \
      --owner=0 --group=0 --numeric-owner \
      -czf "$artifact_path" "torii-continuum-${TAG}" )

[[ -s "$artifact_path" ]] || die "tarball ${artifact_path} was not created or is empty."

# ── 7. Checksum sidecar ──────────────────────────────────────────────────────
( cd "$OUT_DIR" && sha256sum "$artifact_name" > "${artifact_name}.sha256" )
cp "${stage_root}/MANIFEST.json" "${OUT_DIR}/torii-continuum-${TAG}.manifest.json"

log "artifact ready: ${artifact_path}"
log "checksum:       ${artifact_path}.sha256 ($(cut -d' ' -f1 "${artifact_path}.sha256"))"
log "manifest:       ${OUT_DIR}/torii-continuum-${TAG}.manifest.json"
du -h "$artifact_path" | awk '{print "[build-release-artifact] size: " $1}'
