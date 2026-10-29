#!/bin/bash
# usage: c.sh NAME "command"
n=$1; shift
mkdir -p /tmp/trial/state/$n; chmod 700 /tmp/trial/state/$n
exec /tmp/trial/cli/node_modules/.bin/cordn --private-key-file /tmp/trial/keys/$n.sk \
  --server-pubkey $(cat /tmp/trial/keys/coord.pk) --relay ws://127.0.0.1:10547 \
  --transport-encryption required --state-file /tmp/trial/state/$n/session.json --command "$*"
