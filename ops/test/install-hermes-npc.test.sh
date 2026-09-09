#!/usr/bin/env bash
#
# Hermetic tests for the hermes-npc installer (HERMES-NPC-1, v0.2.109-alpha).
#
# Covers only the pure, side-effect-free surface of ops/install-hermes-npc.sh
# via its CLI flags (no root, no users/systemd/curl are touched here):
#
#   1. --render-config emits LOCAL OLLAMA as the sole provider (provider custom,
#      default qwen3:4b, base_url 127.0.0.1:11434/v1) and NEVER references the
#      Continuum router (127.0.0.1:8787), a router token, api_key_env, or a
#      fallback_providers ladder — the greeter has no paid path.
#   2. OLLAMA_MODEL and OLLAMA_BASE_URL overrides are honoured.
#   3. --render-soul emits the greeter persona with hard limits (no tools,
#      local-only, never touch owner data, loopback-only).
#   4. --help exits 0 and prints an Environment: section documenting OLLAMA_MODEL.
#   5. --dry-run exits 0, prints DRY RUN, mentions the profile SOUL.md, and does
#      NOT create /home/hermes-npc.
#   6. Unknown flag exits non-zero.
#   7. The whole rendered surface (config + soul) never mentions the router,
#      an OpenAI bearer, or the owner brain — belt-and-suspenders isolation.
#
# Run:  bash ops/test/install-hermes-npc.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-hermes-npc.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

contains() { [[ "$1" == *"$2"* ]]; }

# --- 1. Default rendering (local Ollama as the ONLY provider) -------------
out="$(bash "${INSTALLER}" --render-config)"

contains "${out}" 'provider: custom' \
  && ok "default: provider is custom"                             || bad "default: provider wrong"
contains "${out}" 'default: "qwen3:4b"' \
  && ok "default: model is qwen3:4b"                              || bad "default: model wrong"
contains "${out}" 'base_url: "http://127.0.0.1:11434/v1"' \
  && ok "default: base_url points at local Ollama"                || bad "default: base_url wrong"

# The greeter must have NO paid path and NO router reference.
if contains "${out}" '127.0.0.1:8787' || contains "${out}" 'api_key_env' || contains "${out}" 'fallback_providers' || contains "${out}" 'CONTINUUM_ROUTER'; then
  bad "default: leaked a router/paid-path reference"
else
  ok "default: no router, no api_key_env, no fallback ladder"
fi

# --- 2. OLLAMA_MODEL + OLLAMA_BASE_URL overrides ---------------------------
out_override="$(OLLAMA_MODEL="qwen3:8b" OLLAMA_BASE_URL="http://127.0.0.1:11435/v1" \
                bash "${INSTALLER}" --render-config)"

contains "${out_override}" 'default: "qwen3:8b"' \
  && ok "override: OLLAMA_MODEL honoured"                         || bad "override: OLLAMA_MODEL ignored"
contains "${out_override}" 'base_url: "http://127.0.0.1:11435/v1"' \
  && ok "override: OLLAMA_BASE_URL honoured"                      || bad "override: OLLAMA_BASE_URL ignored"

# --- 3. --render-soul (greeter persona + hard limits) -----------------------
soul="$(bash "${INSTALLER}" --render-soul)"

contains "${soul}" 'Torii greeter' \
  && ok "soul: identifies as the Torii greeter"                   || bad "soul: greeter identity missing"
contains "${soul}" 'NO tools' \
  && ok "soul: declares no tools"                                 || bad "soul: no-tools limit missing"
contains "${soul}" 'local inference only' \
  && ok "soul: declares local-only inference"                     || bad "soul: local-only limit missing"
contains "${soul}" 'never read, repeat, or infer secrets' \
  && ok "soul: forbids touching secrets/owner data"               || bad "soul: secrets limit missing"
contains "${soul}" 'loopback-only' \
  && ok "soul: declares loopback-only"                            || bad "soul: loopback limit missing"

# --- 4. --help ------------------------------------------------------------
help_out="$(bash "${INSTALLER}" --help 2>&1)"
contains "${help_out}" 'Environment:' \
  && ok "--help: prints Environment section"                      || bad "--help: missing Environment section"
contains "${help_out}" 'OLLAMA_MODEL' \
  && ok "--help: documents OLLAMA_MODEL"                          || bad "--help: missing OLLAMA_MODEL doc"

# --- 5. --dry-run (no side effects) ---------------------------------------
rm -rf /home/hermes-npc
dry="$(OLLAMA_MODEL="qwen3:4b" bash "${INSTALLER}" --dry-run 2>&1)"
contains "${dry}" 'DRY RUN' \
  && ok "--dry-run: prints DRY RUN"                               || bad "--dry-run: no DRY RUN banner"
contains "${dry}" 'SOUL.md' \
  && ok "--dry-run: mentions the greeter SOUL.md"                 || bad "--dry-run: missing SOUL.md"
if [[ -e /home/hermes-npc ]]; then
  bad "--dry-run: created /home/hermes-npc"
else
  ok "--dry-run: did not create /home/hermes-npc"
fi

# --- 6. unknown flag --------------------------------------------------------
if bash "${INSTALLER}" --nope >/dev/null 2>&1; then
  bad "unknown flag: exited 0"
else
  ok "unknown flag: exited non-zero"
fi

# --- 7. Whole-surface isolation (config + soul together) ---------------------
whole="${out}${soul}"
if contains "${whole}" '127.0.0.1:8787' || contains "${whole}" 'CONTINUUM_ROUTER_TOKEN' || contains "${whole}" 'openai_adapter' || contains "${whole}" 'hermes-owner' || contains "${whole}" 'api.routstr'; then
  bad "whole surface leaked a router/owner-brain reference"
else
  ok "whole surface has no router/owner-brain reference"
fi

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]]