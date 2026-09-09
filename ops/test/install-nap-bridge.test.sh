#!/usr/bin/env bash
#
# Hermetic tests for the nap-bridge installer (NAP-BRIDGE-1, v0.2.110-alpha).
#
# Covers only the pure, side-effect-free surface of ops/install-nap-bridge.sh
# via its CLI flags (no root, no users/systemd/dbus are touched here):
#
#   1. --render-env emits the gateway environment with a CLIENT-SECRET
#      placeholder (NOT a greeter nsec), the public npub allowlist, local
#      Ollama, and the greeter SOUL path — and NEVER a router reference,
#      api_key_env, ROUTSTR, cashu, or 127.0.0.1:8787.
#   2. NPC_MODEL / NPC_OLLAMA_URL / NPC_SOUL_FILE overrides are honoured.
#   3. --render-unit runs as hermes-npc, read-only filesystem (ProtectSystem=
#      strict, ProtectHome=read-only), outbound AF_INET only, and no NPC_NSEC.
#   4. --generate prints a nostrconnect:// URI and a 64-hex client secret.
#   5. Missing NPC_BUNKER_PUBKEY/NPC_RELAYS/NPC_ALLOWLIST -> non-zero + FATAL.
#   6. --help exits 0 and documents the required Environment: vars.
#   7. Unknown flag exits non-zero.
#   8. Belt-and-suspenders: the rendered surface never leaks the greeter nsec
#      or any owner/paid-path reference.
#
# Run:  bash ops/test/install-nap-bridge.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-nap-bridge.sh"
AGENT_DIR="${REPO_ROOT}/agent"

pass=0; fail=0; skip=0
ok()  { printf '  ok   %s\n' "$1";   pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }
sk()  { printf '  skip %s\n' "$1";   skip=$((skip+1)); }

contains() { [[ "$1" == *"$2"* ]]; }

# Prefix the public (non-secret) required inputs onto any installer invocation.
run_installer() {
  env NPC_BUNKER_PUBKEY="npub1bunker" \
      NPC_RELAYS="wss://relay.damus.io,wss://relay.nostr.band" \
      NPC_ALLOWLIST="npub1alice,abc123" \
      "$@"
}

# --- 1. Default --render-env surface --------------------------------------
out="$(run_installer bash "${INSTALLER}" --render-env)"

contains "${out}" 'NPC_ENABLED=1' \
  && ok "env: NPC_ENABLED=1"                                      || bad "env: NPC_ENABLED missing"
contains "${out}" 'NPC_CLIENT_SECRET=__CLIENT_SECRET__' \
  && ok "env: client secret is a placeholder, not a real nsec"    || bad "env: client secret wrong"
contains "${out}" 'NPC_BUNKER_PUBKEY=npub1bunker' \
  && ok "env: bunker pubkey present"                              || bad "env: bunker pubkey missing"
contains "${out}" 'NPC_ALLOWLIST=npub1alice,abc123' \
  && ok "env: allowlist present"                                  || bad "env: allowlist missing"
contains "${out}" 'NPC_OLLAMA_URL=http://127.0.0.1:11434/v1' \
  && ok "env: local Ollama default"                               || bad "env: Ollama URL wrong"
contains "${out}" 'NPC_MODEL=qwen3:4b' \
  && ok "env: model qwen3:4b"                                     || bad "env: model wrong"

if contains "${out}" 'NPC_NSEC' || contains "${out}" '127.0.0.1:8787' || contains "${out}" 'api_key_env' || contains "${out}" 'ROUTSTR' || contains "${out}" 'cashu'; then
  bad "env: leaked a nsec/router/paid-path reference"
else
  ok "env: no nsec, no router, no api_key_env, no paid path"
fi

# --- 2. Overrides ----------------------------------------------------------
out_o="$(run_installer NPC_MODEL="qwen3:8b" NPC_OLLAMA_URL="http://127.0.0.1:11435/v1" NPC_SOUL_FILE="/tmp/soul.md" \
         bash "${INSTALLER}" --render-env)"

contains "${out_o}" 'NPC_MODEL=qwen3:8b' \
  && ok "override: NPC_MODEL honoured"                            || bad "override: NPC_MODEL ignored"
contains "${out_o}" 'NPC_OLLAMA_URL=http://127.0.0.1:11435/v1' \
  && ok "override: NPC_OLLAMA_URL honoured"                       || bad "override: NPC_OLLAMA_URL ignored"
contains "${out_o}" 'NPC_SOUL_FILE=/tmp/soul.md' \
  && ok "override: NPC_SOUL_FILE honoured"                        || bad "override: NPC_SOUL_FILE ignored"

# --- 3. --render-unit surface ---------------------------------------------
unit="$(AGENT_DIR="$AGENT_DIR" bash "${INSTALLER}" --render-unit)"

contains "${unit}" 'User=hermes-npc' \
  && ok "unit: runs as hermes-npc"                                || bad "unit: wrong user"
contains "${unit}" 'EnvironmentFile=/home/hermes-npc/.nap-bridge/.env' \
  && ok "unit: loads the 0600 env file"                           || bad "unit: env file missing"
contains "${unit}" 'ExecStart=' \
  && ok "unit: has ExecStart"                                     || bad "unit: no ExecStart"
contains "${unit}" 'npc-gateway.mjs' \
  && ok "unit: runs npc-gateway.mjs"                              || bad "unit: wrong entrypoint"
contains "${unit}" 'ProtectSystem=strict' \
  && ok "unit: read-only filesystem"                              || bad "unit: ProtectSystem missing"
contains "${unit}" 'ProtectHome=read-only' \
  && ok "unit: read-only home (SOUL.md readable, nothing writable)" || bad "unit: ProtectHome wrong"
contains "${unit}" 'NoNewPrivileges=true' \
  && ok "unit: NoNewPrivileges"                                   || bad "unit: NoNewPrivileges missing"
contains "${unit}" 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' \
  && ok "unit: outbound AF_INET/6 + unix only (no listener)"      || bad "unit: address families wrong"

if contains "${unit}" 'ReadWritePaths=' || contains "${unit}" 'NPC_NSEC'; then
  bad "unit: leaked a writable path or NPC_NSEC reference"
else
  ok "unit: stateless (no ReadWritePaths) and no NPC_NSEC"
fi

# --- 4. --generate (pure key/URI mint; no network, no root) ---------------
# The key/URI mint runs via `node scripts/npc-connect.mjs`, which needs the
# agent package's node_modules (nostr-tools). In CI the ops job does not
# install those, so this block degrades to skips there; the same contract is
# pinned with deps present in agent/test/npc-connect.test.js (agent job).
if command -v node >/dev/null 2>&1 && [ -d "$AGENT_DIR/node_modules/nostr-tools" ]; then
  gen="$(AGENT_DIR="$AGENT_DIR" NPC_RELAYS="wss://relay.damus.io" bash "${INSTALLER}" --generate)"

  contains "${gen}" 'nostrconnect://' \
    && ok "generate: emits a nostrconnect:// URI"                   || bad "generate: no connect URI"
  if contains "${gen}" 'client_secret='; then
    sec="$(printf '%s' "$gen" | sed -n 's/^client_secret=\([0-9a-fA-F]\{64\}\)$/\1/p')"
    [ -n "$sec" ] && ok "generate: 64-hex client secret"            || bad "generate: client secret not 64-hex"
  else
    bad "generate: no client_secret line"
  fi
else
  sk "generate: node + agent node_modules unavailable (covered by agent/test/npc-connect.test.js)"
fi

# --- 5. Missing required inputs fail-closed --------------------------------
err="$(bash "${INSTALLER}" --render-env 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "missing inputs: --render-env exits non-zero" || bad "missing inputs: --render-env did not fail"
contains "${err}" 'FATAL' \
  && ok "missing inputs: FATAL message"                           || bad "missing inputs: no FATAL message"

# --- 6. --help -------------------------------------------------------------
help_out="$(bash "${INSTALLER}" --help)"
contains "${help_out}" 'NPC_BUNKER_PUBKEY' \
  && ok "help: documents NPC_BUNKER_PUBKEY"                       || bad "help: missing NPC_BUNKER_PUBKEY"
contains "${help_out}" 'NPC_RELAYS' \
  && ok "help: documents NPC_RELAYS"                              || bad "help: missing NPC_RELAYS"
contains "${help_out}" 'NPC_ALLOWLIST' \
  && ok "help: documents NPC_ALLOWLIST"                           || bad "help: missing NPC_ALLOWLIST"

# --- 7. Unknown flag -------------------------------------------------------
bash "${INSTALLER}" --bogus >/dev/null 2>&1
[ $? -ne 0 ] && ok "unknown flag exits non-zero"                  || bad "unknown flag did not fail"

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]