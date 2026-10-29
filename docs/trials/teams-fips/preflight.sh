#!/usr/bin/env bash
# Teams FIPS trial — read-only preflight. Changes nothing, needs no root.
# Output holds no secrets; strip the address lines before sharing publicly.
set -u
say(){ printf '\n== %s\n' "$*"; }
say "OS / libc"
uname -srm; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || sw_vers 2>/dev/null
ldd --version 2>/dev/null | head -1
say "Memory / disk"
free -m 2>/dev/null || vm_stat 2>/dev/null | head -5
df -h / /opt /tmp 2>/dev/null | awk 'NR==1||!seen[$1]++'
say "TUN device"
[ -e /dev/net/tun ] && echo "/dev/net/tun present" || echo "no /dev/net/tun (macOS uses utun; Linux needs it)"
say "Ports the trial needs (must be free)"
if command -v ss >/dev/null; then
  ss -H -lntup 2>/dev/null | awk '{print $1, $5}' | grep -E ':(2121|8443|5354|7334|10547)$' || echo "all free"
else
  lsof -nP -iUDP:2121 -iTCP:8443 -iUDP:5354 -iTCP:7334 -iTCP:10547 2>/dev/null || echo "all free"
fi
say "Services already listening on all addresses (exposed on fips0 until the mesh firewall is on)"
ss -H -lnt 2>/dev/null | awk '{print $4}' | grep -E '^(\*|\[::\]|0\.0\.0\.0):' | sort -u || true
say "Host firewall"
command -v ufw >/dev/null && { ufw status 2>/dev/null | head -3 || echo "ufw present (run 'sudo ufw status' to see state)"; } || echo "no ufw"
command -v nft >/dev/null && echo "nft present" || echo "no nft"
say "Existing FIPS install"
command -v fipsctl >/dev/null && fipsctl --version || echo "not installed"
say "Toolchain (second machine needs Node 20+ for the Cordn CLI)"
node --version 2>/dev/null || echo "no node"; cargo --version 2>/dev/null || echo "no cargo"
say "Continuum agent (VPS only)"
h=$(curl -sf -m3 http://127.0.0.1:8787/api/health 2>/dev/null) && echo "${h:0:200}" || echo "no agent on this machine"
echo
