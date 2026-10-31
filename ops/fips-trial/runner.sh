#!/usr/bin/env bash
# Teams FIPS trial — second-machine side, run on a throwaway GitHub runner
# (docs/trials/teams-fips/README.md, phase 5). The runner is a real FIPS node
# with its own TUN interface; every key it makes dies with the runner.
#
#   setup                 install FIPS, node key, peer the VPS, start; make alice/bob/carol
#   wait                  wait for an end-to-end session to the VPS
#   q1                    chat + private git over the mesh (members) and refusal (outsider)
#   q2                    trial ports are not reachable on the public address
#   blocked               mesh connect to the services must FAIL (firewall gate test)
#   reach                 mesh connect to the services must SUCCEED
#   via-test-node         drop the direct VPS peer, peer only test-uk01 (Q3)
#
# Env: VPS_HOST (secret hostname, masked), VPS_NPUB, COORD_PK, W (work dir), BIN.
# Logs are public: no IPv4/global IPv6 is printed (mask()).
set -euo pipefail
export LC_ALL=C
FIPS_VER=0.5.3
FIPS_DEB_SHA=6edd18e67c4f4c47d9d8c7366aacc6505d11df79c1c4b1b1d63246fa66e3e8a3
TEST_UK01=npub1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs
W=${W:?work dir}
BIN=${BIN:?bin dir}
export PATH="$BIN:$W/cli/node_modules/.bin:$PATH"

log() { printf '==> %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
# Like grep -q but reads all input, so the writer never gets SIGPIPE under pipefail.
has() { grep "$@" >/dev/null; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<ipv4>/g; s/\b[23][0-9a-f]{3}:[0-9a-f:]{3,}/<ipv6>/g'; }
vps_fd() { fipsctl address "$VPS_NPUB"; }
tcp_ok() { timeout "${3:-8}" bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

config() { # $1 = direct|test-node
  local peer
  if [ "$1" = direct ]; then
    peer="  - npub: \"$VPS_NPUB\"
    alias: \"team-node\"
    addresses:
      - transport: udp
        addr: \"$VPS_HOST:2121\"
    connect_policy: auto_connect"
  else
    peer="  - npub: \"$TEST_UK01\"
    alias: \"test-uk01\"
    addresses:
      - transport: udp
        addr: \"test-uk01.fips.network:2121\"
    connect_policy: auto_connect"
  fi
  sudo tee /etc/fips/fips.yaml >/dev/null <<EOF
node:
  identity:
    persistent: true
  rendezvous:
    nostr:
      enabled: false
tun:
  enabled: true
  name: fips0
  mtu: 1280
dns:
  enabled: true
  bind_addr: "::1"
  port: 5354
transports:
  udp:
    outbound_only: true
peers:
$peer
EOF
}

cmd_setup() {
  mkdir -p "$W/keys" "$W/st" "$W/home"
  curl -fsSL --max-time 120 -o "$W/fips.deb" "https://github.com/jmcorgan/fips/releases/download/v$FIPS_VER/fips_${FIPS_VER}_amd64.deb"
  echo "$FIPS_DEB_SHA  $W/fips.deb" | sha256sum -c --status || die "fips .deb checksum"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$W/fips.deb" >/dev/null
  sudo systemctl enable -q --now fips-firewall   # default-deny fips0 here too
  sudo fipsctl keygen --dir /etc/fips >/dev/null
  config direct
  sudo systemctl restart fips
  sudo systemctl restart fips-dns
  local n
  for n in alice bob carol; do
    nak key generate >"$W/keys/$n.sk"; chmod 0600 "$W/keys/$n.sk"
    nak key public "$(cat "$W/keys/$n.sk")" >"$W/keys/$n.pk"
    nak encode npub "$(cat "$W/keys/$n.pk")" >"$W/keys/$n.npub"
  done
  echo "RUNNER_NODE=$(sudo cat /etc/fips/fips.pub)"
  echo "ALICE=$(cat "$W/keys/alice.npub")"
  echo "BOB=$(cat "$W/keys/bob.npub")"
}

cmd_wait() {
  local fd i; fd=$(vps_fd)
  # Rust nostr clients cannot dial bracketed IPv6 literals; name the relay.
  sudo sed -i '/fips-trial-relay/d' /etc/hosts
  echo "$fd fips-trial-relay" | sudo tee -a /etc/hosts >/dev/null
  # ngit cuts URLs at the first "npub1" (normalize_grasp_server_url), so the
  # canonical <npub>.fips name breaks it. Use a FIPS shortname instead.
  sudo sed -i '/^torii-teams /d' /etc/fips/hosts
  echo "torii-teams $VPS_NPUB" | sudo tee -a /etc/fips/hosts >/dev/null
  for i in $(seq 60); do
    if ping -6 -c1 -W2 "$fd" >/dev/null 2>&1; then log "mesh ping to VPS ok after ${i} tries"; return 0; fi
    sleep 2
  done
  sudo fipsctl show peers 2>&1 | mask | head -20
  sudo fipsctl show sessions 2>&1 | mask | head -20
  die "no mesh path to the VPS"
}

c() { # cordn as identity $1
  local n=$1; shift; mkdir -p "$W/st/$n"
  cordn --private-key-file "$W/keys/$n.sk" --server-pubkey "$COORD_PK" \
    --relay "ws://fips-trial-relay:10547" --transport-encryption required \
    --state-file "$W/st/$n/s.json" --command "$*" 2>&1
}

g() { # git/ngit as identity $1 with isolated config
  local n=$1; shift; local h="$W/home/$n"; mkdir -p "$h"
  local grasp="ws://torii-teams.fips:7334" relay="ws://fips-trial-relay:10547"
  HOME="$h" GIT_CONFIG_GLOBAL="$h/.gitconfig" GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME="$h/.config" \
  GIT_TERMINAL_PROMPT=0 NGIT_INTERACTIVE_MODE=false \
  NGIT_GRASP_DEFAULT_SET="$grasp" NGIT_RELAY_DEFAULT_SET="$relay" NGIT_RELAY_ANNOUNCEMENT_INDEXER_SET="$grasp" \
  NGIT_RELAY_BLASTER_SET="$grasp" NGIT_RELAY_SIGNER_FALLBACK_SET="$relay" "$@"
}

cmd_q1() {
  log "Q1 .fips name resolution"
  getent ahosts "$VPS_NPUB.fips" | head -1 | has '^fd' && echo "PASS $VPS_NPUB.fips resolves to the mesh address" \
    || die ".fips name does not resolve (fips-dns)"
  local i; for i in $(seq 15); do getent ahosts torii-teams.fips | head -1 | has '^fd' && break; sleep 2; done
  getent ahosts torii-teams.fips | head -1 | has '^fd' && echo "PASS torii-teams.fips (FIPS shortname) resolves to the mesh address" \
    || die "FIPS shortname torii-teams.fips does not resolve"
  log "Q1 chat: alice creates the team group, bob joins, both directions"
  c bob gen-kp bob | tail -1
  c bob publish-kp bob | tail -1
  c alice create-group torii-teams | tail -1
  c alice add-member torii-teams "$(cat "$W/keys/bob.pk")" | tail -1
  c bob fetch-welcomes | tail -1
  local ref; ref=$(c bob welcomes | grep -o 'keyPackageRef=[0-9a-f]*' | head -1 | cut -d= -f2)
  [ -n "$ref" ] || die "bob received no welcome"
  c bob accept-welcome "$ref" torii-teams | tail -1
  c alice send-to torii-teams "hello team over FIPS" | tail -1
  c bob sync torii-teams >/dev/null
  c bob messages torii-teams | has 'hello team over FIPS' && echo "PASS bob read alice's message" || die "bob did not get the message"
  c bob send-to torii-teams "hi alice" | tail -1
  c alice sync torii-teams >/dev/null
  c alice messages torii-teams | has 'hi alice' && echo "PASS alice read bob's reply" || die "alice did not get the reply"
  c carol fetch-welcomes | tail -1
  if c carol messages torii-teams | has 'hello team'; then die "outsider read the group"; else echo "PASS outsider carol cannot read the group"; fi

  log "Q1 private git: alice creates, bob clones + opens a PR, carol is refused"
  local n
  for n in alice bob carol; do
    g "$n" git config --global user.name "$n"; g "$n" git config --global user.email "$n@trial.invalid"
    g "$n" git config --global init.defaultBranch master
    g "$n" ngit account login --offline --secret-storage file -n "$(cat "$W/keys/$n.sk")" --alias "$n" | tail -1
  done
  mkdir -p "$W/repo/alice" && cd "$W/repo/alice"
  g alice git init -q . && echo "team art" >README.md && g alice git add . && g alice git commit -qm init
  g alice timeout 120 ngit init --name team-art --identifier team-art --description "Teams FIPS trial" \
    --grasp-server "ws://torii-teams.fips:7334" --private --repo-relay-only -d 2>&1 | mask | tail -40 || true
  g alice timeout 120 git push origin master 2>&1 | mask | tail -40
  local url; url=$(g alice git remote get-url origin)
  cd "$W/repo"
  g bob timeout 120 git clone -q "$url" bob 2>&1 | tail -1 || true
  grep -q 'team art' bob/README.md && echo "PASS member bob cloned the private repo" || die "bob could not clone"
  cd bob && echo "bob was here" >>README.md && g bob git commit -qam "bob: readme"
  local out; out=$(g bob timeout 120 git push origin HEAD:refs/heads/pr/bob-readme 2>&1 || true)
  grep -q 'HEAD -> pr/bob-readme' <<<"$out" && echo "PASS member bob opened a PR" \
    || { mask <<<"$out" | tail -20; die "bob could not open a PR"; }
  cd "$W/repo"
  g carol timeout 120 git clone -q "$url" carol >/dev/null 2>&1 || true
  [ -f carol/README.md ] && die "outsider carol cloned the private repo" || echo "PASS outsider carol refused"
  echo "PASS Q1"
}

cmd_q2() {
  log "Q2 trial ports on the public address must be closed"
  local p bad=0
  for p in 7334 10547 5354 8443; do
    if tcp_ok "$VPS_HOST" "$p" 6; then echo "FAIL public tcp/$p is open"; bad=1; else echo "PASS public tcp/$p closed"; fi
  done
  [ $bad -eq 0 ] && echo "PASS Q2" || die "Q2"
}

cmd_blocked() {
  local fd p; fd=$(vps_fd)
  for p in 7334 10547; do
    if tcp_ok "$fd" "$p" 8; then die "mesh tcp/$p reachable while not admitted by the firewall"; fi
    echo "PASS mesh tcp/$p refused by the fips0 firewall"
  done
}

cmd_reach() {
  local fd p i; fd=$(vps_fd)
  for p in 7334 10547; do
    for i in $(seq 30); do tcp_ok "$fd" "$p" 5 && break; sleep 2; done
    tcp_ok "$fd" "$p" 5 && echo "PASS mesh tcp/$p reachable" || die "mesh tcp/$p not reachable"
  done
}

cmd_via_test_node() {
  config test-node
  sudo systemctl restart fips
  local i
  for i in $(seq 45); do
    sudo fipsctl show peers 2>/dev/null | has "${TEST_UK01:0:16}\|test-uk01" && break; sleep 2
  done
  sudo fipsctl show peers 2>&1 | mask | head -10
}

main() {
  case "${1:-}" in
    setup) cmd_setup ;;
    wait) cmd_wait ;;
    q1) cmd_q1 ;;
    q2) cmd_q2 ;;
    blocked) cmd_blocked ;;
    reach) cmd_reach ;;
    via-test-node) cmd_via_test_node ;;
    *) die "usage: setup|wait|q1|q2|blocked|reach|via-test-node" ;;
  esac
}

[ "${FIPS_TRIAL_TEST:-}" = 1 ] || main "$@"
