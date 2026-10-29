#!/bin/bash
# As fipstrial on the VPS. Private ngit-grasp on the mesh address only.
. /opt/fips-trial/env   # also MEMBERS=npub1alice...,npub1bob...
# FIPS shortname (members map "torii-team <VPS npub>" in /etc/fips/hosts):
# ngit truncates any URL at "npub1", so <npub>.fips cannot be the git host.
export NGIT_DOMAIN="torii-team.fips:7334" NGIT_BIND_ADDRESS="[$VPS_FD]:7334"
export NGIT_PRIVATE_MODE=true NGIT_PRIVATE_MEMBERS="$MEMBERS"
# Private mode signs credentials for https:// unless the domain is loopback; the
# mesh is already encrypted, so declare the plain-http origin explicitly.
export NGIT_PRIVATE_PUBLIC_ORIGIN="http://torii-team.fips:7334"
export NGIT_USER_INDEX_RELAYS="ws://fips-trial-relay:10547"   # no purplepag.es lookups
export NGIT_RELAY_DATA_PATH=/opt/fips-trial/run/grasp/relay NGIT_GIT_DATA_PATH=/opt/fips-trial/run/grasp/git
export NGIT_RELAY_NAME="Torii FIPS trial" NGIT_LOG_LEVEL=info
mkdir -p /opt/fips-trial/run/grasp && cd /opt/fips-trial/run/grasp || exit 1
exec /opt/fips-trial/bin/ngit-grasp
