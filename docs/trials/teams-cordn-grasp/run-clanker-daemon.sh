#!/bin/bash
# Clanker's Cordn daemon: sole owner of its MLS state; plaintext arrives in inbox/, replies leave via outbox/.
T=/tmp/trial; R=$T/state/clanker
mkdir -p $R/inbox $R/outbox && chmod 700 $R/inbox $R/outbox
exec $T/cli/node_modules/.bin/cordn --private-key-file $T/keys/clanker.sk --server-pubkey "$(cat $T/keys/coord.pk)" \
  --relay ws://127.0.0.1:10547 --transport-encryption required --state-file $R/session.json \
  --daemon --group-alias torii-team --inbox-dir $R/inbox --outbox-dir $R/outbox
