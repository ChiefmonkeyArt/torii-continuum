#!/usr/bin/env bash
# Tests for ops/fips-trial (Teams FIPS trial automation). No root, no network.
set -euo pipefail
cd "$(dirname "$0")/../.."
pass=0; fail=0
ok() { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
no() { fail=$((fail+1)); printf 'FAIL %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

V=ops/fips-trial/vps.sh R=ops/fips-trial/runner.sh WF=.github/workflows/fips-trial.yml T=docs/trials/teams-fips

check "vps.sh parses" "bash -n $V"
check "runner.sh parses" "bash -n $R"
if command -v shellcheck >/dev/null; then
  check "shellcheck clean" "shellcheck -S warning $V $R >/dev/null"
fi

# --- input validation: npubs reach root shell commands, so they must be strict
A=npub1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs
B=npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98
run_npubs() { ( FIPS_TRIAL_TEST=1; . "$V"; npubs "$1" ) 2>/dev/null; }
check "npubs accepts and de-duplicates" "[ \"\$(run_npubs \"$A, $B,$A\" | wc -l)\" = 2 ]"
check "npubs accepts empty" "[ -z \"\$(run_npubs '')\" ]"
check "npubs rejects shell injection" "! run_npubs \"$A;touch /tmp/pwned\""
check "npubs rejects command substitution" "! run_npubs '\$(id)'"
check "npubs rejects nsec" "! run_npubs nsec1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs"
check "npubs rejects bad charset (b,i,o,1 after prefix)" "! run_npubs npub1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
many=$(for _ in $(seq 33); do printf '%s,' "$A"; done)
check "npubs caps at 32 entries" "! run_npubs '$many'"
check "npubs failure aborts the caller (validated outside a subshell)" \
  "grep -q 'npubs \"\${1:-}\" >/dev/null' $V && grep -q 'npubs \"\${2:-}\" >/dev/null' $V"

# --- public logs never carry host addresses
m() { ( FIPS_TRIAL_TEST=1; . "$V"; printf '%s\n' "$1" | mask ); }
check "mask hides IPv4" "[ \"\$(m 'peer 203.0.113.7:2121')\" = 'peer <ipv4>:2121' ]"
check "mask hides global IPv6" "[ \"\$(m 'addr 2a01:4f8:c0c:1::1')\" = 'addr <ipv6>' ]"
check "mask keeps mesh fd addresses" "[ \"\$(m 'fd12:3456::1')\" = 'fd12:3456::1' ]"
check "runner masks too" "grep -q 'mask()' $R"
check "workflow masks the VPS host and its addresses" "grep -q 'add-mask::\$host_only' $WF && grep -q 'add-mask::\$a' $WF"

# --- phase order: firewall loaded before the daemon ever starts
inst=$(sed -n '/^cmd_install()/,/^}/p' $V)
fw=$(grep -n 'systemctl restart fips-firewall' <<<"$inst" | head -1 | cut -d: -f1)
st=$(grep -n 'systemctl restart fips$' <<<"$inst" | head -1 | cut -d: -f1)
check "install: firewall restart precedes first fips start" "[ -n '$fw' ] && [ -n '$st' ] && [ $fw -lt $st ]"
check "install: verifies the nft table is loaded" "grep -q 'nft list table inet fips' <<<\"\$inst\""
check "install: strict ACL (ALL in peers.deny) before start" \
  "[ \$(grep -n 'ALL' <<<\"\$inst\" | head -1 | cut -d: -f1) -lt $st ]"
check "install: stops fips the .deb enabled before firewall" "grep -q 'systemctl stop fips fips-dns' <<<\"\$inst\""
check "install: rolls back fips-dns if host DNS breaks" "grep -q 'systemctl stop fips-dns; die' <<<\"\$inst\""
adm=$(sed -n '/^cmd_admit()/,/^}/p' $V)
nc_=$(grep -n 'nft -c' <<<"$adm" | cut -d: -f1); pa_=$(grep -n 'install .*peers.allow' <<<"$adm" | cut -d: -f1)
check "admit: nft syntax checked before peers.allow changes" "[ -n '$nc_' ] && [ -n '$pa_' ] && [ $nc_ -lt $pa_ ]"
check "admit: bad drop-in is rolled back" "grep -q 'previous drop-in restored' <<<\"\$adm\""

# --- pinned artefacts agree everywhere
sha=$(sed -n 's/^FIPS_DEB_SHA=//p' $V)
check "fips .deb sha pinned identically in vps.sh and runner.sh" "[ -n '$sha' ] && grep -q \"FIPS_DEB_SHA=$sha\" $R"
check "every download is checksum-verified (vps.sh)" "[ \$(grep -c 'curl -fsSL' $V) -eq \$(grep -c 'sha_ok \"\$t/' $V) ]"
check "workflow pins the ngit-grasp commit" "grep -qE 'NGIT_GRASP_COMMIT: [0-9a-f]{40}' $WF"
check "workflow verifies the built commit" "grep -q 'rev-parse HEAD)\" = \"\$NGIT_GRASP_COMMIT\"' $WF"
check "workflow verifies runner downloads" "[ \$(grep -c 'sha256sum -c --status' $WF) -ge 2 ]"
check "cordn CLI pinned by lockfile" "grep -q '\"@cordn/cli\": \"0.9.0\"' ops/fips-trial/cordn-cli/package.json && grep -q integrity ops/fips-trial/cordn-cli/package-lock.json"
check "npm ci runs without install scripts" "grep -q 'npm ci --ignore-scripts' $WF"

# --- services: unprivileged, mesh-only, hardened
check "units run as fipstrial" "grep -q '^User=fipstrial' $V"
for k in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes 'CapabilityBoundingSet=$' MemoryMax=; do
  check "unit hardening: $k" "grep -qE '^$k' $V"
done
check "no trial service binds a wildcard address" "! grep -nE '0\.0\.0\.0|\[::\]|--hostname \"?(::|0)' $T/run-*.sh"
check "relay binds the mesh address" "grep -q -- '--hostname \"\$VPS_FD\"' $T/run-relay.sh"
check "git binds the mesh address" "grep -q 'NGIT_BIND_ADDRESS=\"\[\$VPS_FD\]:7334\"' $T/run-grasp.sh"
check "coordinator uses a hostname (cordn-server cannot dial [v6] literals)" \
  "grep -q 'ws://fips-trial-relay:10547' $T/run-coord.sh && ! grep -q 'CORDN_RELAY_URLS=\"ws://\[' $T/run-coord.sh"
check "private git declares its plain-http mesh origin" "grep -q 'NGIT_PRIVATE_PUBLIC_ORIGIN=\"http://\$VPS_NPUB.fips:7334\"' $T/run-grasp.sh"
check "private mode on, members from env" "grep -q 'NGIT_PRIVATE_MODE=true NGIT_PRIVATE_MEMBERS=\"\$MEMBERS\"' $T/run-grasp.sh"
check "guard aborts if a trial port is on a non-mesh address" "grep -q 'listening on a non-mesh address' $V"
check "guard checks Continuum health" "grep -q '127.0.0.1:8787/api/health' $V"

# --- config templates
check "VPS config: no tcp transport" "! grep -qE '^\s+tcp:' $T/fips-vps.yaml"
check "VPS config: DNS on loopback only" "grep -q 'bind_addr: \"::1\"' $T/fips-vps.yaml"
check "VPS config: no nostr endpoint adverts" "grep -A1 'nostr:' $T/fips-vps.yaml | grep -q 'enabled: false'"
check "runner config: outbound only" "grep -q 'outbound_only: true' $R"

# --- workflow guard rails
check "workflow is manual-only" "grep -q '^  workflow_dispatch:' $WF && ! grep -qE '^  (push|pull_request|schedule):' $WF"
check "workflow shares the deploy-vps lock" "grep -q 'group: deploy-vps' $WF"
check "workflow checks the pinned host key" "grep -q 'VPS host key mismatch' $WF && grep -q 'StrictHostKeyChecking=yes' $WF"
check "workflow read-only token" "grep -q 'contents: read' $WF"
check "workflow always restores the admit list" "grep -A1 'Restore admitted devices' $WF | grep -q 'always()'"
check "teardown removes the hosts entry and trial dirs" "awk '/^cmd_teardown/,/^}/' $V | grep -q 'fips-trial-relay/d' && awk '/^cmd_teardown/,/^}/' $V | grep -q 'rm -rf \$ETC \$TRIAL'"

echo "fips-trial: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
