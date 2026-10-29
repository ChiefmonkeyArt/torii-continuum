#!/usr/bin/env bash
# Teams FIPS trial — VPS side (docs/trials/teams-fips/README.md).
# Runs as root:  sudo -n bash -s -- <command> [args] < ops/fips-trial/vps.sh
#
# Reuses the node's EXISTING Torii Suite FIPS transport (torii-fips.service,
# /etc/torii/fips, firewall table inet torii_fips). One FIPS identity per node:
# this script never installs a second daemon, never writes /etc/fips and never
# edits Suite files. It only adds tagged allow rules to the Suite's default-deny
# fips0 chain (re-applied by fips-trial-admit.service whenever that firewall
# reloads, so a reload can only close access, never open it).
#
#   status                         read-only report
#   prepare                        check the Suite node is up (no changes)
#   admit    NODES                 fips0 allow rules (+ufw) = exactly NODES (csv FIPS node npubs)
#   services BUNDLE MEMBERS        relay, coordinator, private git as user fipstrial
#   route    on|off                Q3: runtime link to the public test node test-uk01
#   teardown                       remove everything the trial added
#
# Workflow logs are public: never print IPv4 or global IPv6 addresses. Mesh
# (fd00::/8) addresses and node npubs are derived from public keys and are fine.
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive LC_ALL=C

NAK_URL=https://github.com/fiatjaf/nak/releases/download/v0.22.0/nak-v0.22.0-linux-amd64
NAK_SHA=f4cb05c42e2cab2d85f436c42aece1f6e10499e1166b6e0ad1fd3e3973b70712
CORDN_URL=https://github.com/Cordn-msg/cordn-rs/releases/download/v0.5.1-next.3/cordn-server-x86_64-unknown-linux-gnu.tar.gz
CORDN_SHA=47770f83128e0379a8749969734dd10342c0965af2b6e5111911ea4f0581d49a
TEST_UK01=npub1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs
TEST_UK01_ADDR=test-uk01.fips.network:2121

# Suite-owned FIPS node (torii-suite fips/, installers/install-fips.sh). Read only.
SUITE_ETC=/etc/torii/fips
FIPSCTL=/opt/torii/fips/bin/fipsctl
SOCK=/run/torii-fips/control.sock
TABLE="inet torii_fips"
CHAIN=input
TAG=torii-teams-trial

TRIAL=/opt/fips-trial
ADMIT=$TRIAL/admit.nft
UNITS="fips-trial-relay fips-trial-coord fips-trial-grasp"
NPUB_RE='^npub1[02-9ac-hj-np-z]{58}$'
MARK='# managed by torii-continuum ops/fips-trial'

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT

log() { printf '==> %s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
# Like grep -q but reads all input, so the writer never gets SIGPIPE under pipefail.
has() { grep "$@" >/dev/null; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<ipv4>/g; s/\b[23][0-9a-f]{3}:[0-9a-f:]{3,}/<ipv6>/g'; }
sha_ok() { echo "$2  $1" | sha256sum -c --status; }
fc() { "$FIPSCTL" -s "$SOCK" "$@"; }
node_npub() { tr -d '[:space:]' <"$SUITE_ETC/fips.pub"; }
node_fd() { "$FIPSCTL" address "$(node_npub)"; }

npubs() {
  local out=() n
  IFS=',' read -r -a raw <<<"${1// /}"
  for n in "${raw[@]}"; do
    [ -z "$n" ] && continue
    [[ $n =~ $NPUB_RE ]] || die "not an npub: ${n:0:12}…"
    out+=("$n")
  done
  [ ${#out[@]} -le 32 ] || die "more than 32 entries"
  [ ${#out[@]} -eq 0 ] || printf '%s\n' "${out[@]}" | sort -u
}
ufw_active() { command -v ufw >/dev/null && ufw status 2>/dev/null | has '^Status: active'; }
ufw_clear_trial() {
  ufw_active || return 0
  local n
  while n=$(ufw status numbered | grep 'FIPS trial' | head -1 | sed -E 's/^\[ *([0-9]+)\].*/\1/') && [ -n "$n" ]; do
    ufw --force delete "$n" >/dev/null
  done
}

node_ok() {
  systemctl is-active -q torii-fips-firewall || die "Suite FIPS firewall (torii-fips-firewall) is not active"
  systemctl is-active -q torii-fips || die "Suite FIPS node (torii-fips) is not active"
  nft list chain $TABLE $CHAIN >/dev/null 2>&1 || die "Suite fips0 firewall table missing"
  [ -s "$SUITE_ETC/fips.pub" ] && [ -x "$FIPSCTL" ] || die "Suite FIPS identity or fipsctl missing"
  ip -6 addr show dev fips0 2>/dev/null | has "inet6 $(node_fd)" || die "fips0 does not carry the node mesh address"
}

# Abort criteria shared by every mutating command (README "Abort criteria").
guard() {
  curl -fsS --max-time 8 http://127.0.0.1:8787/api/health | has '"ok":true' \
    || die "Continuum health check failed"
  getent ahosts github.com >/dev/null || die "host DNS resolution broken"
  if ss -Hltn | awk '{print $4}' | grep -E ':(7334|10547)$' | has -vE '^\[?fd'; then
    die "a trial port is listening on a non-mesh address"
  fi
  [ ! -e /etc/fips/fips.yaml ] || die "/etc/fips/fips.yaml exists; one FIPS identity per node (Suite docs/FIPS.md)"
  return 0
}

trial_handles() { nft -a list chain $TABLE $CHAIN 2>/dev/null | grep "comment \"$TAG\"" | sed -E 's/.*# handle ([0-9]+)$/\1/' || true; }

cmd_status() {
  local u
  for u in torii-fips-firewall torii-fips torii-fips-relay fips-trial-admit $UNITS; do
    printf '%-20s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"
  done
  if [ -s "$SUITE_ETC/fips.pub" ] && [ -x "$FIPSCTL" ]; then
    echo "== node npub: $(node_npub)"
    echo "== node mesh address: $(node_fd)"
    echo "== fips: $("$FIPSCTL" --version 2>/dev/null || echo unknown)"
  else
    echo "== Suite FIPS node not installed"
  fi
  echo "== suite peers.json entries: $(grep -c transportNpub "$SUITE_ETC/peers.json" 2>/dev/null || echo 0)"
  echo "== fips0 chain (trial rules tagged $TAG)"
  nft list chain $TABLE $CHAIN 2>/dev/null | grep -E 'dport|drop|comment' | mask || echo "table missing"
  if [ -e /etc/fips/fips.yaml ]; then echo "== WARNING: /etc/fips/fips.yaml exists"; fi
  if [ -s $TRIAL/keys/coord.pk ]; then echo "== coordinator pubkey: $(cat $TRIAL/keys/coord.pk)"; fi
  if [ -f $TRIAL/env ]; then grep -E '^MEMBERS=' $TRIAL/env | sed 's/^/== git /'; fi
  if systemctl is-active -q torii-fips; then
    echo "== peers"; fc show peers 2>&1 | mask | head -40
    echo "== sessions"; fc show sessions 2>&1 | mask | head -20
  fi
  if [ -f $TRIAL/env ]; then
    for u in $UNITS; do echo "== log $u"; journalctl -u "$u" -n 25 --no-pager -o cat 2>/dev/null | mask; done
  fi
  echo "== listeners on trial ports"
  ss -Hlntu | awk '{print $1, $5}' | grep -E ':(2121|7334|10547|7778)$' | mask || echo none
  if command -v ufw >/dev/null; then echo "== ufw: $(ufw status | head -1)"; fi
  echo "== resources: $(free -m | awk '/Mem:/{print $7" MB RAM free"}'), $(df -h / | awk 'NR==2{print $4" disk free"}')"
  curl -fsS --max-time 8 http://127.0.0.1:8787/api/health | grep -o '"version":"[^"]*"' | sed 's/^/== continuum /' \
    || echo "== continuum health: FAILED"
}

cmd_prepare() {
  guard
  node_ok
  log "Suite FIPS node is up; nothing installed"
  cmd_status
}

# Root helper + unit: drop our tagged rules, re-insert from $ADMIT. PartOf the
# Suite firewall unit, so a Suite reload (which flushes the table) re-applies it.
write_admit_unit() {
  cat >$TRIAL/bin/apply-admit.sh <<APPLY
#!/bin/sh
$MARK
set -eu
for h in \$(nft -a list chain $TABLE $CHAIN | grep 'comment "$TAG"' | sed -E 's/.*# handle ([0-9]+)\$/\1/'); do
  nft delete rule $TABLE $CHAIN handle "\$h"
done
if grep -q '^insert rule' $ADMIT; then nft -f $ADMIT; fi
APPLY
  chmod 0755 $TRIAL/bin/apply-admit.sh
  cat >/etc/systemd/system/fips-trial-admit.service <<UNIT
$MARK
[Unit]
Description=Torii Teams FIPS trial: admitted devices on fips0 (re-applied on firewall reload)
After=torii-fips-firewall.service
PartOf=torii-fips-firewall.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$TRIAL/bin/apply-admit.sh
[Install]
WantedBy=torii-fips-firewall.service
UNIT
  systemctl daemon-reload
  systemctl enable -q fips-trial-admit
}

# Render the admit ruleset for the given mesh addresses (pure; tested).
render_admit() {
  local fd
  echo "$MARK"
  for fd in "$@"; do
    [[ $fd =~ ^fd[0-9a-f:]+$ ]] || return 1
    echo "insert rule $TABLE $CHAIN iifname \"fips0\" ip6 saddr $fd tcp dport { 7334, 10547 } accept comment \"$TAG\""
  done
}

cmd_admit() {
  node_ok
  npubs "${1:-}" >/dev/null   # validate in this shell so die() aborts
  local n fds=()
  while read -r n; do
    [ -z "$n" ] && continue
    fds+=("$("$FIPSCTL" address "$n")")
  done < <(npubs "${1:-}")
  render_admit "${fds[@]}" >"$TMPD/admit.nft" || die "bad mesh address (nothing changed)"
  nft -c -f "$TMPD/admit.nft" || die "admit rules failed nft check (nothing changed)"
  install -d -m 0755 -o root -g root $TRIAL $TRIAL/bin
  install -m 0600 "$TMPD/admit.nft" "$ADMIT"
  write_admit_unit
  systemctl restart fips-trial-admit
  [ "$(trial_handles | wc -l)" -eq "${#fds[@]}" ] || die "loaded rule count does not match admitted devices"
  ufw_clear_trial
  if ufw_active; then
    for n in "${fds[@]}"; do ufw allow in on fips0 from "$n" to any port 7334,10547 proto tcp comment 'FIPS trial member' >/dev/null; done
  fi
  log "fips0 admits ${#fds[@]} device(s) to the trial ports"
  cmd_status
}

unit() { # name exec-script
  cat >/etc/systemd/system/$1.service <<EOF
$MARK
[Unit]
Description=Torii Teams FIPS trial: $1
After=torii-fips.service
Requires=torii-fips.service
[Service]
User=fipstrial
Group=fipstrial
Environment=HOME=$TRIAL/run
WorkingDirectory=$TRIAL/run
ExecStartPre=/bin/sh -c 'for i in \$(seq 30); do ip -6 addr show dev fips0 | grep -q "inet6 fd" && exit 0; sleep 1; done; exit 1'
ExecStart=$TRIAL/bin/$2
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
ReadWritePaths=$TRIAL/run
MemoryMax=768M
TasksMax=256
[Install]
WantedBy=multi-user.target
EOF
}

cmd_services() {
  local b=${1:?bundle dir}
  guard
  node_ok
  npubs "${2:-}" >/dev/null
  mapfile -t members < <(npubs "${2:-}")
  [ ${#members[@]} -gt 0 ] || die "MEMBERS is empty; private git needs at least one npub"
  local csv; csv=$(IFS=,; echo "${members[*]}")
  id fipstrial >/dev/null 2>&1 || useradd --system --home-dir $TRIAL --no-create-home --shell /usr/sbin/nologin fipstrial
  install -d -m 0755 -o root -g root $TRIAL $TRIAL/bin
  install -d -m 0700 -o fipstrial -g fipstrial $TRIAL/run $TRIAL/keys
  command -v git >/dev/null || apt-get install -y -q git >/dev/null
  local t=$TMPD
  if ! sha_ok $TRIAL/bin/nak "$NAK_SHA" 2>/dev/null; then
    curl -fsSL --max-time 120 -o "$t/nak" "$NAK_URL"; sha_ok "$t/nak" "$NAK_SHA" || die "nak checksum mismatch"
    install -m 0755 "$t/nak" $TRIAL/bin/nak
  fi
  if [ ! -x $TRIAL/bin/cordn-server ] || [ "$(cat $TRIAL/bin/.cordn.sha 2>/dev/null)" != "$CORDN_SHA" ]; then
    curl -fsSL --max-time 120 -o "$t/c.tgz" "$CORDN_URL"; sha_ok "$t/c.tgz" "$CORDN_SHA" || die "cordn-server checksum mismatch"
    tar -xzf "$t/c.tgz" -C "$t"
    install -m 0755 "$(find "$t" -type f -name cordn-server | head -1)" $TRIAL/bin/cordn-server
    echo "$CORDN_SHA" >$TRIAL/bin/.cordn.sha
  fi
  if [ -f "$b/ngit-grasp" ]; then
    sha_ok "$b/ngit-grasp" "$(cat "$b/ngit-grasp.sha256")" || die "ngit-grasp checksum mismatch"
    install -m 0755 "$b/ngit-grasp" $TRIAL/bin/ngit-grasp
  fi
  [ -x $TRIAL/bin/ngit-grasp ] || die "no ngit-grasp binary in bundle"
  local s; for s in run-relay.sh run-coord.sh run-grasp.sh; do install -m 0755 "$b/$s" $TRIAL/bin/$s; done
  if [ ! -s $TRIAL/keys/coord.sk ]; then
    ( umask 077; $TRIAL/bin/nak key generate >$TRIAL/keys/coord.sk )
    $TRIAL/bin/nak key public "$(cat $TRIAL/keys/coord.sk)" >$TRIAL/keys/coord.pk
    chown fipstrial:fipstrial $TRIAL/keys/coord.sk $TRIAL/keys/coord.pk
    chmod 0600 $TRIAL/keys/coord.sk; chmod 0644 $TRIAL/keys/coord.pk
  fi
  cat >$TRIAL/env <<EOF
$MARK
VPS_NPUB=$(node_npub)
VPS_FD=$(node_fd)
CORDN_KEY_FILE=$TRIAL/keys/coord.sk
MEMBERS=$csv
EOF
  chmod 0644 $TRIAL/env
  # cordn-server cannot dial bracketed IPv6 literals, so name the relay.
  sed -i '/fips-trial-relay/d' /etc/hosts
  echo "$(node_fd) fips-trial-relay $MARK" >>/etc/hosts
  unit fips-trial-relay run-relay.sh
  unit fips-trial-coord run-coord.sh
  unit fips-trial-grasp run-grasp.sh
  systemctl daemon-reload
  systemctl enable -q $UNITS
  systemctl restart fips-trial-relay; sleep 2
  systemctl restart fips-trial-coord fips-trial-grasp; sleep 4
  for u in $UNITS; do systemctl is-active -q "$u" || { journalctl -u "$u" -n 20 --no-pager | mask; die "$u failed to start"; }; done
  guard
  cmd_status
}

cmd_route() {
  node_ok
  case "${1:-}" in
    on)  fc connect "$TEST_UK01" "$TEST_UK01_ADDR" udp 2>&1 | mask ;;
    off) fc disconnect "$TEST_UK01" 2>&1 | mask || true ;;
    *) die "route on|off" ;;
  esac
  sleep 3
  fc show peers 2>&1 | mask | head -20
}

cmd_teardown() {
  local h u
  # shellcheck disable=SC2086
  systemctl disable --now $UNITS fips-trial-admit 2>/dev/null || true
  for h in $(trial_handles); do nft delete rule $TABLE $CHAIN handle "$h"; done
  for u in $UNITS fips-trial-admit; do rm -f "/etc/systemd/system/$u.service"; done
  systemctl daemon-reload
  ufw_clear_trial
  sed -i '/fips-trial-relay/d' /etc/hosts
  rm -rf $TRIAL
  if id fipstrial >/dev/null 2>&1; then userdel fipstrial; fi
  [ -z "$(trial_handles)" ] || die "trial rules still present"
  guard
  log "teardown complete; Suite FIPS node untouched"
  cmd_status
}

main() {
  case "${1:-}" in
    status) cmd_status ;;
    prepare) cmd_prepare ;;
    admit) cmd_admit "${2:-}" ;;
    services) cmd_services "${2:-}" "${3:-}" ;;
    route) cmd_route "${2:-}" ;;
    teardown) cmd_teardown ;;
    *) die "usage: status|prepare|admit NODES|services BUNDLE MEMBERS|route on|off|teardown" ;;
  esac
}

# FIPS_TRIAL_TEST=1 loads the functions for ops/test/fips-trial.test.sh only.
[ "${FIPS_TRIAL_TEST:-}" = 1 ] || main "$@"
