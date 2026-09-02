#!/usr/bin/env bash
#
# Hermetic tests for the hermes-owner installer (HERMES-OWNER-1, v0.2.104-alpha).
#
# Covers only the pure, side-effect-free surface of ops/install-hermes-owner.sh
# via its CLI flags (no root, no users/systemd/curl are touched here):
#   1. --render-config with ROUTSTR_* set emits Routstr as primary and the
#      local Ollama qwen3:4b fallback.
#   2. --render-config without ROUTSTR_* emits local Ollama primary + fallback
#      and never leaks a Routstr URL.
#   3. --help exits 0 and prints an Environment: section.
#   4. --dry-run exits 0, prints DRY RUN, and does NOT create /home/hermes-owner.
#   5. Unknown flag exits non-zero.
#   6. OLLAMA_MODEL default is qwen3:4b, and is honoured when overridden.
#
# Run:  bash ops/test/install-hermes-owner.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-hermes-owner.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

contains() { [[ "$1" == *"$2"* ]]; }

# --- 1. Routstr-first rendering -------------------------------------------
out="$(ROUTSTR_BASE_URL="https://node.example/v1" ROUTSTR_MODEL="some-model" \
       bash "${INSTALLER}" --render-config)"

contains "${out}" 'default: "some-model"' \
  && ok "Routstr-first: primary model set"           || bad "Routstr-first: primary model missing"
contains "${out}" 'base_url: "https://node.example/v1"' \
  && ok "Routstr-first: primary base_url set"        || bad "Routstr-first: primary base_url missing"
contains "${out}" 'model: "qwen3:4b"' \
  && ok "Routstr-first: Ollama fallback model set (default)" || bad "Routstr-first: fallback model missing"
contains "${out}" 'base_url: "http://localhost:11434/v1"' \
  && ok "Routstr-first: Ollama fallback base_url set" || bad "Routstr-first: fallback base_url missing"
contains "${out}" 'fallback_providers:' \
  && ok "Routstr-first: fallback_providers block present" || bad "Routstr-first: fallback_providers missing"

# --- 2. Local-first rendering (no Routstr) --------------------------------
out_local="$(env -u ROUTSTR_BASE_URL -u ROUTSTR_MODEL bash "${INSTALLER}" --render-config)"

contains "${out_local}" 'default: "qwen3:4b"' \
  && ok "Local-first: default model is qwen3:4b"     || bad "Local-first: default model wrong"
if contains "${out_local}" 'https://node.example'; then
  bad "Local-first: leaked Routstr URL"
else
  ok "Local-first: no Routstr URL leaked"
fi

# --- 3. --help ------------------------------------------------------------
help_out="$(bash "${INSTALLER}" --help 2>&1)"
contains "${help_out}" 'Environment:' \
  && ok "--help: prints Environment section"         || bad "--help: missing Environment section"

# --- 4. --dry-run (no side effects) ----------------------------------------
rm -rf /home/hermes-owner
dry="$(OLLAMA_MODEL="qwen3:4b" bash "${INSTALLER}" --dry-run 2>&1)"
contains "${dry}" 'DRY RUN' \
  && ok "--dry-run: prints DRY RUN"                  || bad "--dry-run: no DRY RUN banner"
if [[ -e /home/hermes-owner ]]; then
  bad "--dry-run: created /home/hermes-owner"
else
  ok "--dry-run: did not create /home/hermes-owner"
fi

# --- 5. unknown flag --------------------------------------------------------
if bash "${INSTALLER}" --nope >/dev/null 2>&1; then
  bad "unknown flag: exited 0"
else
  ok "unknown flag: exited non-zero"
fi

# --- 6. OLLAMA_MODEL override ----------------------------------------------
out_override="$(OLLAMA_MODEL="qwen3:8b" bash "${INSTALLER}" --render-config)"
contains "${out_override}" 'model: "qwen3:8b"' \
  && ok "OLLAMA_MODEL override honoured"             || bad "OLLAMA_MODEL override ignored"

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]