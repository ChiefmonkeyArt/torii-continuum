#!/bin/bash
# As fipstrial on the VPS. Cordn coordinator; talks only to the trial relay.
. /opt/fips-trial/env   # also CORDN_KEY_FILE=/opt/fips-trial/keys/coord.sk (0600)
export CORDN_SERVER_PRIVATE_KEY="$(cat "$CORDN_KEY_FILE")"
# cordn-server cannot dial bracketed IPv6 literals ("failed to lookup address
# information"); vps.sh maps fips-trial-relay -> $VPS_FD in /etc/hosts.
export CORDN_RELAY_URLS="ws://fips-trial-relay:10547"
export CORDN_STORAGE_BACKEND=sqlite CORDN_SQLITE_PATH=/opt/fips-trial/run/cordn.sqlite
export CORDN_SERVER_NAME=torii-fips-trial
mkdir -p /opt/fips-trial/run
exec /opt/fips-trial/bin/cordn-server
