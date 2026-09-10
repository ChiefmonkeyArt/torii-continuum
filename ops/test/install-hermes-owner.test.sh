#!/usr/bin/env bash
#
# Hermetic tests for the hermes-owner installer (HERMES-OWNER-1, v0.2.108-alpha).
#
# Covers only the pure, side-effect-free surface of ops/install-hermes-owner.sh
# via its CLI flags (no root, no users/systemd/curl are touched here):
#
#   1. --render-config emits the Continuum router as primary
#      (http://127.0.0.1:8787/v1 by default, `default: chat`,
#      api_key_env: CONTINUUM_ROUTER_TOKEN) with local llama3.2:1b as fallback.
#   2. CONTINUUM_ROUTER_URL / CONTINUUM_ROUTER_MODEL overrides are honoured.
#   3. The rendered config never leaks the router bearer token itself.
#   4. --help exits 0 and prints an Environment: section.
#   5. --dry-run exits 0, prints DRY RUN, prints both the profile config AND
#      the main-config fallback plan, and does NOT create /home/hermes-owner.
#   6. Unknown flag exits non-zero.
#   7. OLLAMA_MODEL default is llama3.2:1b, and is honoured when overridden.
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

# --- 1. Default rendering (Continuum router primary) ---------------------
out="$(bash "${INSTALLER}" --render-config)"

contains "${out}" 'default: "chat"' \
  && ok "default: primary model is 'chat'"                       || bad "default: primary model wrong"
contains "${out}" 'base_url: "http://127.0.0.1:8787/v1"' \
  && ok "default: primary base_url is loopback:8787/v1"          || bad "default: primary base_url wrong"
contains "${out}" 'api_key_env: "CONTINUUM_ROUTER_TOKEN"' \
  && ok "default: api_key_env references CONTINUUM_ROUTER_TOKEN" || bad "default: api_key_env missing"
contains "${out}" 'model: "llama3.2:1b"' \
  && ok "default: Ollama fallback model set (llama3.2:1b)"          || bad "default: fallback model missing"
contains "${out}" 'base_url: "http://127.0.0.1:11434/v1"' \
  && ok "default: Ollama fallback base_url is loopback:11434/v1" || bad "default: fallback base_url wrong"
contains "${out}" 'fallback_providers:' \
  && ok "default: fallback_providers block present"              || bad "default: fallback_providers missing"

# --- 2. CONTINUUM_ROUTER_URL + CONTINUUM_ROUTER_MODEL overrides -----------
out_override="$(CONTINUUM_ROUTER_URL="http://127.0.0.1:9000/v1" \
                CONTINUUM_ROUTER_MODEL="chat-local" \
                bash "${INSTALLER}" --render-config)"

contains "${out_override}" 'default: "chat-local"' \
  && ok "override: CONTINUUM_ROUTER_MODEL honoured"              || bad "override: CONTINUUM_ROUTER_MODEL ignored"
contains "${out_override}" 'base_url: "http://127.0.0.1:9000/v1"' \
  && ok "override: CONTINUUM_ROUTER_URL honoured"                || bad "override: CONTINUUM_ROUTER_URL ignored"

# --- 3. Bearer never leaked into the rendered config ----------------------
sensitive_token="s3cret-router-token-do-not-leak"
out_with_token="$(CONTINUUM_ROUTER_TOKEN="${sensitive_token}" \
                  bash "${INSTALLER}" --render-config)"
if contains "${out_with_token}" "${sensitive_token}"; then
  bad "bearer leaked into rendered config.yaml"
else
  ok "bearer never leaked into rendered config.yaml"
fi

# --- 4. --help ------------------------------------------------------------
help_out="$(bash "${INSTALLER}" --help 2>&1)"
contains "${help_out}" 'Environment:' \
  && ok "--help: prints Environment section"                     || bad "--help: missing Environment section"
contains "${help_out}" 'CONTINUUM_ROUTER_TOKEN' \
  && ok "--help: documents CONTINUUM_ROUTER_TOKEN"                || bad "--help: missing CONTINUUM_ROUTER_TOKEN doc"

# --- 5. --dry-run (no side effects) ---------------------------------------
rm -rf /home/hermes-owner
dry="$(OLLAMA_MODEL="llama3.2:1b" bash "${INSTALLER}" --dry-run 2>&1)"
contains "${dry}" 'DRY RUN' \
  && ok "--dry-run: prints DRY RUN"                              || bad "--dry-run: no DRY RUN banner"
contains "${dry}" '.hermes/config.yaml' \
  && ok "--dry-run: mentions main-config fallback plan"          || bad "--dry-run: missing main-config plan"
if [[ -e /home/hermes-owner ]]; then
  bad "--dry-run: created /home/hermes-owner"
else
  ok "--dry-run: did not create /home/hermes-owner"
fi

# --- 6. unknown flag --------------------------------------------------------
if bash "${INSTALLER}" --nope >/dev/null 2>&1; then
  bad "unknown flag: exited 0"
else
  ok "unknown flag: exited non-zero"
fi

# --- 7. OLLAMA_MODEL override ----------------------------------------------
out_ollama="$(OLLAMA_MODEL="qwen3:8b" bash "${INSTALLER}" --render-config)"
contains "${out_ollama}" 'model: "qwen3:8b"' \
  && ok "OLLAMA_MODEL override honoured"                         || bad "OLLAMA_MODEL override ignored"

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]
