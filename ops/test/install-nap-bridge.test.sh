#!/usr/bin/env bash
#
# Hermetic tests for the nap-bridge installer (NAP-BRIDGE-3, v0.2.112-alpha).
#
# Covers only the pure, side-effect-free surface of ops/install-nap-bridge.sh
# via its CLI flags (no root, no users/systemd/dbus are touched here):
#
#   1. --render-env emits the gateway environment with an NPC_NSEC placeholder
#      (the per-install greeter nsec — NOT a bunker client secret), the public
#      npub allowlist, local Ollama, and the greeter SOUL path — and NEVER a
#      router reference, api_key_env, ROUTSTR, cashu, 127.0.0.1:8787, or any
#      bunker remnant (NPC_CLIENT_SECRET / NPC_BUNKER_PUBKEY).
#   2. NPC_MODEL / NPC_OLLAMA_URL / NPC_SOUL_FILE overrides are honoured.
#   3. --render-unit runs as hermes-npc, read-only filesystem (ProtectSystem=
#      strict, ProtectHome=read-only), outbound AF_INET/6 + unix only, and
#      carries NO inline nsec (the nsec lives in the 0600 EnvironmentFile).
#   4. --generate prints npub + 64-hex nsec + nsec1 bech32 (no nostrconnect://).
#   5. Missing NPC_RELAYS/NPC_ALLOWLIST -> non-zero + FATAL.
#   6. --help exits 0 and documents the required Environment: vars.
#   7. Unknown flag exits non-zero.
#   8. Belt-and-suspenders: the rendered surface never leaks a router/paid-path
#      reference or a bunker remnant.
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
  env NPC_RELAYS="wss://relay.damus.io,wss://relay.nostr.band" \
      NPC_ALLOWLIST="npub1alice,abc123" \
      "$@"
}

# --- 1. Default --render-env surface --------------------------------------
out="$(run_installer bash "${INSTALLER}" --render-env)"

contains "${out}" 'NPC_ENABLED=1' \
  && ok "env: NPC_ENABLED=1"                                      || bad "env: NPC_ENABLED missing"
contains "${out}" 'NPC_NSEC=__NSEC__' \
  && ok "env: nsec is a placeholder, not a real nsec"             || bad "env: nsec placeholder wrong"
contains "${out}" 'NPC_ALLOWLIST=npub1alice,abc123' \
  && ok "env: allowlist present"                                  || bad "env: allowlist missing"
contains "${out}" 'NPC_OLLAMA_URL=http://127.0.0.1:11434/v1' \
  && ok "env: local Ollama default"                               || bad "env: Ollama URL wrong"
contains "${out}" 'NPC_MODEL=llama3.2:1b' \
  && ok "env: model llama3.2:1b (default)"                         || bad "env: model wrong"
contains "${out}" 'NPC_RATE_WINDOW_MS=60000' \
  && ok "env: rate window default 60000ms"                        || bad "env: rate window wrong"
contains "${out}" 'NPC_RATE_MAX_PER_WINDOW=6' \
  && ok "env: rate max default 6"                                 || bad "env: rate max wrong"
contains "${out}" 'NPC_PUBLIC=0' \
  && ok "env: NPC_PUBLIC off by default (fail-closed)"            || bad "env: NPC_PUBLIC default wrong"
contains "${out}" 'NPC_WORLD_FILE=/home/hermes-npc/.hermes/profiles/npc/WORLD.md' \
  && ok "env: world lore path default"                            || bad "env: world lore path wrong"
contains "${out}" 'NPC_LORE_FILE=/home/hermes-npc/.hermes/profiles/npc/TORII_LORE.md' \
  && ok "env: metaverse lore path default"                        || bad "env: metaverse lore path wrong"
contains "${out}" 'NPC_NOTICE_AUTHOR=' \
  && ok "env: noticeboard author empty by default (disabled)"     || bad "env: NPC_NOTICE_AUTHOR default wrong"
contains "${out}" 'NPC_NOTICE_TTL_MS=60000' \
  && ok "env: noticeboard TTL default 60000ms"                    || bad "env: NPC_NOTICE_TTL_MS default wrong"

if contains "${out}" 'NPC_CLIENT_SECRET' || contains "${out}" 'NPC_BUNKER_PUBKEY' \
   || contains "${out}" 'nostrconnect://' || contains "${out}" '127.0.0.1:8787' \
   || contains "${out}" 'api_key_env' || contains "${out}" 'ROUTSTR' || contains "${out}" 'cashu'; then
  bad "env: leaked a bunker/router/paid-path reference"
else
  ok "env: no bunker remnant, no router, no api_key_env, no paid path"
fi

# --- 2. Overrides ----------------------------------------------------------
out_o="$(run_installer NPC_MODEL="qwen3:8b" NPC_OLLAMA_URL="http://127.0.0.1:11435/v1" NPC_SOUL_FILE="/tmp/soul.md" \
         NPC_RATE_WINDOW_MS="30000" NPC_RATE_MAX_PER_WINDOW="2" NPC_PUBLIC="1" NPC_WORLD_FILE="/tmp/world.md" \
         NPC_NOTICE_AUTHOR="abcdef0123456789" NPC_NOTICE_TTL_MS="30000" \
         bash "${INSTALLER}" --render-env)"

contains "${out_o}" 'NPC_MODEL=qwen3:8b' \
  && ok "override: NPC_MODEL honoured"                            || bad "override: NPC_MODEL ignored"
contains "${out_o}" 'NPC_OLLAMA_URL=http://127.0.0.1:11435/v1' \
  && ok "override: NPC_OLLAMA_URL honoured"                       || bad "override: NPC_OLLAMA_URL ignored"
contains "${out_o}" 'NPC_SOUL_FILE=/tmp/soul.md' \
  && ok "override: NPC_SOUL_FILE honoured"                        || bad "override: NPC_SOUL_FILE ignored"
contains "${out_o}" 'NPC_RATE_WINDOW_MS=30000' \
  && ok "override: NPC_RATE_WINDOW_MS honoured"                   || bad "override: NPC_RATE_WINDOW_MS ignored"
contains "${out_o}" 'NPC_RATE_MAX_PER_WINDOW=2' \
  && ok "override: NPC_RATE_MAX_PER_WINDOW honoured"               || bad "override: NPC_RATE_MAX_PER_WINDOW ignored"
contains "${out_o}" 'NPC_PUBLIC=1' \
  && ok "override: NPC_PUBLIC honoured"                           || bad "override: NPC_PUBLIC ignored"
contains "${out_o}" 'NPC_WORLD_FILE=/tmp/world.md' \
  && ok "override: NPC_WORLD_FILE honoured"                       || bad "override: NPC_WORLD_FILE ignored"
contains "${out_o}" 'NPC_NOTICE_AUTHOR=abcdef0123456789' \
  && ok "override: NPC_NOTICE_AUTHOR honoured"                    || bad "override: NPC_NOTICE_AUTHOR ignored"
contains "${out_o}" 'NPC_NOTICE_TTL_MS=30000' \
  && ok "override: NPC_NOTICE_TTL_MS honoured"                    || bad "override: NPC_NOTICE_TTL_MS ignored"

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

if contains "${unit}" 'ReadWritePaths=' || contains "${unit}" 'NPC_NSEC='; then
  bad "unit: leaked a writable path or an inline nsec"
else
  ok "unit: stateless (no ReadWritePaths) and no inline nsec (nsec is in the env file)"
fi

# --- 4. --generate (pure nsec mint; no network, no root) -------------------
# The nsec mint runs via `node scripts/npc-nsec.mjs`, which needs the agent
# package's node_modules (nostr-tools). In CI the ops job does not install
# those, so this block degrades to skips there; the same contract is pinned
# with deps present in agent/test/npc-nsec.test.js (agent job).
if command -v node >/dev/null 2>&1 && [ -d "$AGENT_DIR/node_modules/nostr-tools" ]; then
  gen="$(AGENT_DIR="$AGENT_DIR" bash "${INSTALLER}" --generate)"

  contains "${gen}" 'npub=' \
    && ok "generate: emits the greeter npub"                      || bad "generate: no npub"
  contains "${gen}" 'nsec_hex=' \
    && ok "generate: emits the 64-hex nsec"                       || bad "generate: no nsec_hex"
  contains "${gen}" 'nsec_bech32=nsec1' \
    && ok "generate: emits the nsec1 bech32"                      || bad "generate: no nsec_bech32"
  if contains "${gen}" 'nostrconnect://'; then
    bad "generate: leaked a nostrconnect:// URI (bunker is gone)"
  else
    ok "generate: no nostrconnect:// URI"
  fi
else
  sk "generate: node + agent node_modules unavailable (covered by agent/test/npc-nsec.test.js)"
fi

# --- 5. Missing required inputs fail-closed --------------------------------
err="$(bash "${INSTALLER}" --render-env 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "missing inputs: --render-env exits non-zero" || bad "missing inputs: --render-env did not fail"
contains "${err}" 'FATAL' \
  && ok "missing inputs: FATAL message"                           || bad "missing inputs: no FATAL message"

# --- 5b. TORII_DOMAIN defaults NPC_RELAYS (NAP-BRIDGE-DEFAULT-RELAY-1) -----
# When NPC_RELAYS is unset but TORII_DOMAIN and NPC_ALLOWLIST are set, the
# installer must default NPC_RELAYS=wss://relay.<TORII_DOMAIN> and reach the
# render step (rc=0). This matches torii-suite v0.9.8-alpha's subdomain relay.
render_out="$(env -i PATH="$PATH" HOME=/tmp \
  TORII_DOMAIN=example.test \
  NPC_ALLOWLIST="npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2vlwr7" \
  bash "${INSTALLER}" --render-env 2>&1)"
rc=$?
[ "$rc" -eq 0 ] && ok "TORII_DOMAIN default: --render-env exits 0" \
                 || bad "TORII_DOMAIN default: --render-env failed (rc=$rc) - ${render_out:0:200}"
contains "${render_out}" 'wss://relay.example.test' \
  && ok "TORII_DOMAIN default: NPC_RELAYS derived to wss://relay.example.test" \
  || bad "TORII_DOMAIN default: NPC_RELAYS not derived"

# --- 5c. NPC_PUBLIC=1 admits everyone, no allowlist required (NAP-BRIDGE-6) ---
pub_out="$(env -i PATH="$PATH" HOME=/tmp \
  NPC_RELAYS="wss://relay.example.test" \
  NPC_PUBLIC=1 \
  bash "${INSTALLER}" --render-env 2>&1)"
rc=$?
[ "$rc" -eq 0 ] && ok "public: --render-env exits 0 without NPC_ALLOWLIST" \
                 || bad "public: --render-env failed (rc=$rc) - ${pub_out:0:200}"
contains "${pub_out}" 'NPC_PUBLIC=1' \
  && ok "public: NPC_PUBLIC=1 rendered"                           || bad "public: NPC_PUBLIC not rendered"

# --- 6. --help ---------------------------------------------------------------
help_out="$(bash "${INSTALLER}" --help)"
contains "${help_out}" 'NPC_RELAYS' \
  && ok "help: documents NPC_RELAYS"                              || bad "help: missing NPC_RELAYS"
contains "${help_out}" 'NPC_ALLOWLIST' \
  && ok "help: documents NPC_ALLOWLIST"                           || bad "help: missing NPC_ALLOWLIST"
contains "${help_out}" 'NPC_PUBLIC' \
  && ok "help: documents NPC_PUBLIC"                              || bad "help: missing NPC_PUBLIC"
if contains "${help_out}" 'NPC_BUNKER_PUBKEY'; then
  bad "help: still documents NPC_BUNKER_PUBKEY (bunker is gone)"
else
  ok "help: no bunker var"
fi

# --- 7. Unknown flag ---------------------------------------------------------
bash "${INSTALLER}" --bogus >/dev/null 2>&1
[ $? -ne 0 ] && ok "unknown flag exits non-zero"                  || bad "unknown flag did not fail"

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]