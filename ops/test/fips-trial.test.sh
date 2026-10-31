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
check "runner never wraps a shell function in timeout" "! grep -qE 'timeout [0-9]+ (g|chat|tcp_ok) ' $R"
check "git host is never <npub>.fips (ngit npub1 truncation)" "! grep -qE 'grasp[^ ]*=\"?ws://\\\$VPS_NPUB\\.fips|NGIT_DOMAIN=\"\\\$VPS_NPUB' $R docs/trials/teams-fips/run-grasp.sh && grep -q 'NGIT_DOMAIN=\"torii-teams.fips:7334\"' docs/trials/teams-fips/run-grasp.sh"
check "runner maps the torii-teams FIPS shortname" "grep -q 'torii-teams \$VPS_NPUB\" | sudo tee -a /etc/fips/hosts' $R"
check "runner never pipes a command into grep -q (SIGPIPE under pipefail)" "! grep -vh ExecStartPre $R $V | grep -qE '\\| *grep -[a-zA-Z]*q'"
check "runner masks too" "grep -q 'mask()' $R"
check "workflow masks the VPS host and its addresses" "grep -q 'add-mask::\$host_only' $WF && grep -q 'add-mask::\$a' $WF"

# --- one FIPS identity per host: reuse the Suite node, never install a second
check "vps.sh installs no fips package" "! grep -qE 'dpkg|\.deb|FIPS_DEB' $V"
check "vps.sh never writes /etc/fips" "! grep -vE '^\s*#' $V | grep -qE '(>|install|cp|mkdir|rm -rf).*/etc/fips([/ ]|$)'"
check "vps.sh never writes Suite files" "! grep -vE '^\s*#' $V | grep -qE '(>|install|cp|sed -i|rm).*(/etc/torii|/opt/torii|mesh\.nft)'"
check "vps.sh never restarts or stops the Suite node" "! grep -qE 'systemctl (restart|stop|disable)[^|]*torii-fips' $V"
check "vps.sh drives the Suite control socket" "grep -q 'SOCK=/run/torii-fips/control.sock' $V && grep -q 'FIPSCTL=/opt/torii/fips/bin/fipsctl' $V"
check "guard refuses a second FIPS config" "grep -q '/etc/fips/fips.yaml exists' $V"
check "trial units require torii-fips" "grep -q '^Requires=torii-fips.service' $V && ! grep -qE '^(After|Requires)=fips\.service' $V"
check "admit unit re-applies on Suite firewall reload" "grep -q '^PartOf=torii-fips-firewall.service' $V && grep -q '^WantedBy=torii-fips-firewall.service' $V"
adm=$(sed -n '/^cmd_admit()/,/^}/p' $V)
nc_=$(grep -n 'nft -c' <<<"$adm" | cut -d: -f1); in_=$(grep -n 'install -m 0600' <<<"$adm" | cut -d: -f1)
check "admit: nft checked before the ruleset is installed" "[ -n '$nc_' ] && [ -n '$in_' ] && [ $nc_ -lt $in_ ]"
check "admit: verifies loaded rule count" "grep -q 'loaded rule count does not match' <<<\"\$adm\""
ra() { ( FIPS_TRIAL_TEST=1; . "$V"; render_admit "$@" ); }
check "render_admit: one tagged fips0 rule per device" \
  "[ \"\$(ra fd11::1 fd22::2 | grep -c 'insert rule inet torii_fips input iifname \"fips0\" ip6 saddr fd[0-9a-f:]* tcp dport { 7334, 10547 } accept comment \"torii-teams-trial\"')\" = 2 ]"
check "render_admit: empty list renders no rules" "! ra | grep -q 'insert rule'"
check "render_admit: rejects non-mesh addresses" "! ra 2a01:4f8::1 >/dev/null && ! ra 'fd11::1;drop' >/dev/null"
th() { ( FIPS_TRIAL_TEST=1; . "$V"
  nft() { printf '%s\n' 'table inet torii_fips {' '  chain input { # handle 1' \
    '    iifname "fips0" ip6 saddr fd11::1 tcp dport { 7334, 10547 } accept comment "torii-teams-trial" # handle 41' \
    '    tcp dport 7778 accept # handle 5' '    counter packets 0 bytes 0 drop # handle 6'; }
  trial_handles | tr '\n' ' ' ); }
check "trial_handles selects only tagged rules" "[ \"\$(th)\" = '41 ' ]"
check "teardown deletes only tagged rule handles" "awk '/^cmd_teardown/,/^}/' $V | grep -q 'for h in \$(trial_handles); do nft delete rule'"
check "route uses runtime connect, no config edits" "awk '/^cmd_route/,/^}/' $V | grep -q 'fc connect' && ! awk '/^cmd_route/,/^}/' $V | grep -qE 'peers\.(allow|json)|yaml'"

# --- pinned artefacts agree everywhere
check "runner pins the fips .deb sha" "grep -qE '^FIPS_DEB_SHA=[0-9a-f]{64}$' $R"
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
check "private git declares its plain-http mesh origin" "grep -q 'NGIT_PRIVATE_PUBLIC_ORIGIN=\"http://torii-teams.fips:7334\"' $T/run-grasp.sh"
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
check "teardown removes the hosts entry and trial dirs" "awk '/^cmd_teardown/,/^}/' $V | grep -q 'fips-trial-relay/d' && awk '/^cmd_teardown/,/^}/' $V | grep -q 'rm -rf \$TRIAL'"

echo "fips-trial: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
