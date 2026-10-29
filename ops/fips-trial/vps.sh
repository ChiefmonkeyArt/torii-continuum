#!/usr/bin/env bash
# Teams FIPS trial — VPS side (docs/trials/teams-fips/README.md, phases 1–6).
# Runs as root:  sudo -n bash -s -- <command> [args] < ops/fips-trial/vps.sh
#
#   status                         read-only report
#   install  BUNDLE                phase 1+2: firewall first, then key, config, strict ACL, start
#   admit    NODES [FW]            peers.allow = NODES; fips0 drop-in (+ufw) = FW (default NODES)
#   services BUNDLE MEMBERS        phase 3+4: relay, coordinator, private git as user fipstrial
#   route    on|off                Q3: link to the public test node test-uk01 (runtime only)
#   teardown                       phase 6: remove everything the trial added
#
# Workflow logs are public: never print IPv4 or global IPv6 addresses. Mesh
# (fd00::/8) addresses and node npubs are derived from public keys and are fine.
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive LC_ALL=C

FIPS_VER=0.5.3
FIPS_DEB_SHA=6edd18e67c4f4c47d9d8c7366aacc6505d11df79c1c4b1b1d63246fa66e3e8a3
NAK_URL=https://github.com/fiatjaf/nak/releases/download/v0.22.0/nak-v0.22.0-linux-amd64
NAK_SHA=f4cb05c42e2cab2d85f436c42aece1f6e10499e1166b6e0ad1fd3e3973b70712
CORDN_URL=https://github.com/Cordn-msg/cordn-rs/releases/download/v0.5.1-next.3/cordn-server-x86_64-unknown-linux-gnu.tar.gz
CORDN_SHA=47770f83128e0379a8749969734dd10342c0965af2b6e5111911ea4f0581d49a
TEST_UK01=npub1u0z26dc4qeneu5rvwvmpfhtwh3522ed6rlgxr9jarrfnjrc6ew4qxjysrs
TEST_UK01_ADDR=test-uk01.fips.network:2121

ETC=/etc/fips
TRIAL=/opt/fips-trial
DROPIN=$ETC/fips.d/teams-trial.nft
UNITS="fips-trial-relay fips-trial-coord fips-trial-grasp"
NPUB_RE='^npub1[02-9ac-hj-np-z]{58}$'
MARK='# managed by torii-continuum ops/fips-trial'

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT

log() { printf '==> %s\n' "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<ipv4>/g; s/\b[23][0-9a-f]{3}:[0-9a-f:]{3,}/<ipv6>/g'; }
sha_ok() { echo "$2  $1" | sha256sum -c --status; }

# csv of npubs -> validated, de-duplicated, one per line. Never trust input.
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

# Abort criteria shared by every mutating command (README "Abort criteria").
guard() {
  curl -fsS --max-time 8 http://127.0.0.1:8787/api/health | grep -q '"ok":true' \
    || die "Continuum health check failed"
  getent ahosts github.com >/dev/null || die "host DNS resolution broken"
  if ss -Hltn | awk '{print $4}' | grep -E ':(7334|10547)$' | grep -vqE '^\[?fd'; then
    die "a trial port is listening on a non-mesh address"
  fi
}

fips_up() {
  for _ in $(seq 30); do
    ip -6 addr show dev fips0 2>/dev/null | grep -q 'inet6 fd' && return 0
    sleep 1
  done
  return 1
}

ufw_active() { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; }

ufw_clear_trial() {
  ufw_active || return 0
  local n
  while n=$(ufw status numbered | grep 'FIPS trial' | head -1 | sed -E 's/^\[ *([0-9]+)\].*/\1/') && [ -n "$n" ]; do
    ufw --force delete "$n" >/dev/null
  done
}

cmd_status() {
  echo "== fips package: $(dpkg-query -W -f='${Version}' fips 2>/dev/null || echo absent)"
  for u in fips-firewall fips fips-dns $UNITS; do printf '%-18s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
  nft list table inet fips >/dev/null 2>&1 && echo "firewall table inet fips: loaded" || echo "firewall table inet fips: NOT loaded"
  [ -f "$DROPIN" ] && { echo "== drop-in"; grep -v '^#' "$DROPIN" || true; }
  if [ -s $ETC/fips.pub ]; then
    echo "== node npub: $(cat $ETC/fips.pub)"
    echo "== node mesh address: $(fipsctl address)"
  fi
  [ -f $ETC/peers.allow ] && { echo "== peers.allow"; grep -v '^#' $ETC/peers.allow || true; }
  [ -f $ETC/peers.deny ] && echo "== peers.deny: $(grep -v '^#' $ETC/peers.deny | tr '\n' ' ')"
  [ -s $TRIAL/keys/coord.pk ] && echo "== coordinator pubkey: $(cat $TRIAL/keys/coord.pk)"
  [ -f $TRIAL/env ] && grep -E '^MEMBERS=' $TRIAL/env | sed 's/^/== git /'
  if systemctl is-active -q fips; then
    echo "== peers"; fipsctl show peers 2>&1 | mask | head -40
    echo "== sessions"; fipsctl show sessions 2>&1 | mask | head -20
  fi
  echo "== listeners on trial ports"; ss -Hlntu | awk '{print $1, $5}' | grep -E ':(2121|5354|7334|10547|8443)$' | mask || echo none
  if command -v ufw >/dev/null; then echo "== ufw: $(ufw status | head -1)"; ufw status | grep -E '2121|FIPS trial' | mask || true; fi
  echo "== resources: $(free -m | awk '/Mem:/{print $7" MB RAM free"}'), $(df -h / | awk 'NR==2{print $4" disk free"}')"
  curl -fsS --max-time 8 http://127.0.0.1:8787/api/health | grep -o '"version":"[^"]*"' | sed 's/^/== continuum /' || echo "== continuum health: FAILED"
}

cmd_install() {
  local b=${1:?bundle dir}
  guard
  if [ "$(dpkg-query -W -f='${Version}' fips 2>/dev/null || true)" != "$FIPS_VER" ]; then
    log "download fips $FIPS_VER"
    local t=$TMPD
    curl -fsSL --max-time 120 -o "$t/fips.deb" "https://github.com/jmcorgan/fips/releases/download/v$FIPS_VER/fips_${FIPS_VER}_amd64.deb"
    sha_ok "$t/fips.deb" "$FIPS_DEB_SHA" || die "fips .deb checksum mismatch"
    chmod 0644 "$t/fips.deb"; chmod 0755 "$t"
    apt-get install -y -q "$t/fips.deb" >/dev/null
  fi
  # The .deb enables fips + fips-dns but starts neither. Keep it that way
  # until the default-deny fips0 table is loaded.
  systemctl stop fips fips-dns 2>/dev/null || true
  log "firewall first"
  install -d -m 0755 $ETC/fips.d
  [ -f "$DROPIN" ] || printf '%s\n# no members admitted yet\n' "$MARK" >"$DROPIN"
  systemctl enable -q fips-firewall
  systemctl restart fips-firewall
  nft list table inet fips >/dev/null || die "fips0 firewall table did not load"
  log "node key"
  [ -s $ETC/fips.key ] || fipsctl keygen --dir $ETC >/dev/null
  chmod 0600 $ETC/fips.key
  log "config"
  install -m 0644 "$b/fips-vps.yaml" $ETC/fips.yaml
  # Strict ACL before first start: nobody is admitted until `admit`.
  [ -f $ETC/peers.allow ] && grep -q "$MARK" $ETC/peers.allow || printf '%s\n' "$MARK" >$ETC/peers.allow
  printf '%s\nALL\n' "$MARK" >$ETC/peers.deny
  if ufw_active; then ufw allow 2121/udp comment 'FIPS trial transport' >/dev/null; fi
  log "start"
  systemctl restart fips
  fips_up || die "fips0 did not come up"
  systemctl restart fips-dns
  sleep 2
  if ! getent ahosts github.com >/dev/null; then
    systemctl stop fips-dns; die "host DNS broke after fips-dns start (stopped fips-dns)"
  fi
  guard
  cmd_status
}

cmd_admit() {
  systemctl is-active -q fips-firewall || die "run install first"
  npubs "${1:-}" >/dev/null   # validate in this shell so die() aborts
  npubs "${2-$1}" >/dev/null
  mapfile -t nodes < <(npubs "${1:-}")
  mapfile -t fw < <(npubs "${2-$1}")
  local n fd tmp
  tmp=$TMPD/dropin
  { echo "$MARK"; printf '%s\n' "${nodes[@]}"; } | sed '/^$/d' >"$tmp.allow"
  { echo "$MARK"; echo "# roster devices; generated, do not edit"; } >"$tmp"
  ufw_clear_trial
  ufw_active && ufw allow 2121/udp comment 'FIPS trial transport' >/dev/null
  for n in "${fw[@]}"; do
    [ -z "$n" ] && continue
    fd=$(fipsctl address "$n")
    [[ $fd =~ ^fd[0-9a-f:]+$ ]] || die "bad mesh address for ${n:0:12}…"
    echo "ip6 saddr $fd tcp dport { 7334, 10547 } accept" >>"$tmp"
    ufw_active && ufw allow in on fips0 from "$fd" to any port 7334,10547 proto tcp comment 'FIPS trial member' >/dev/null
  done
  cp -p "$DROPIN" "$TMPD/dropin.prev" 2>/dev/null || : >"$TMPD/dropin.prev"
  install -m 0644 "$tmp" "$DROPIN"
  if ! nft -c -f $ETC/fips.nft; then
    install -m 0644 "$TMPD/dropin.prev" "$DROPIN"   # never leave a bad drop-in for the next boot
    die "drop-in failed nft syntax check (previous drop-in restored)"
  fi
  install -m 0644 "$tmp.allow" $ETC/peers.allow   # daemon reloads on mtime change
  systemctl restart fips-firewall
  nft list table inet fips >/dev/null || die "firewall table missing after reload"
  log "peers.allow: ${#nodes[@]} node(s); firewall: ${#fw[@]} node(s)"
  cmd_status
}

unit() { # name exec-script
  cat >/etc/systemd/system/$1.service <<EOF
$MARK
[Unit]
Description=Torii Teams FIPS trial: $1
After=fips.service
Requires=fips.service
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
  systemctl is-active -q fips || die "fips not running; run install first"
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
VPS_NPUB=$(cat $ETC/fips.pub)
VPS_FD=$(fipsctl address)
CORDN_KEY_FILE=$TRIAL/keys/coord.sk
MEMBERS=$csv
EOF
  chmod 0644 $TRIAL/env
  # cordn-server cannot dial bracketed IPv6 literals, so name the relay.
  sed -i '/fips-trial-relay/d' /etc/hosts
  echo "$(fipsctl address) fips-trial-relay $MARK" >>/etc/hosts
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
  systemctl is-active -q fips || die "fips not running"
  case "${1:-}" in
    on)
      grep -qx "$TEST_UK01" $ETC/peers.allow || echo "$TEST_UK01" >>$ETC/peers.allow
      sleep 2
      fipsctl connect "$TEST_UK01" "$TEST_UK01_ADDR" udp 2>&1 | mask ;;
    off)
      fipsctl disconnect "$TEST_UK01" 2>&1 | mask || true
      sed -i "\|^$TEST_UK01\$|d" $ETC/peers.allow ;;
    *) die "route on|off" ;;
  esac
  sleep 3
  fipsctl show peers 2>&1 | mask | head -20
}

cmd_teardown() {
  systemctl disable --now $UNITS 2>/dev/null || true
  for u in $UNITS; do rm -f /etc/systemd/system/$u.service; done
  systemctl daemon-reload
  systemctl disable --now fips-dns fips 2>/dev/null || true
  ufw_clear_trial
  ufw_active && ufw delete allow 2121/udp >/dev/null 2>&1 || true
  rm -f "$DROPIN"
  systemctl disable --now fips-firewall 2>/dev/null || true
  apt-get purge -y -q fips >/dev/null 2>&1 || true
  sed -i '/fips-trial-relay/d' /etc/hosts
  rm -rf $ETC $TRIAL
  id fipstrial >/dev/null 2>&1 && userdel fipstrial || true
  guard
  log "teardown complete"
  cmd_status
}

main() {
  case "${1:-}" in
    status) cmd_status ;;
    install) cmd_install "${2:-}" ;;
    admit) if [ $# -ge 3 ]; then cmd_admit "$2" "$3"; else cmd_admit "${2:-}"; fi ;;
    services) cmd_services "${2:-}" "${3:-}" ;;
    route) cmd_route "${2:-}" ;;
    teardown) cmd_teardown ;;
    *) die "usage: status|install BUNDLE|admit NODES|services BUNDLE MEMBERS|route on|off|teardown" ;;
  esac
}

# FIPS_TRIAL_TEST=1 loads the functions for ops/test/fips-trial.test.sh only.
[ "${FIPS_TRIAL_TEST:-}" = 1 ] || main "$@"
