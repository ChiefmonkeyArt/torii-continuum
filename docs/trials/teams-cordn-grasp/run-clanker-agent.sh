#!/bin/bash
# Clanker loop: acts only for roster humans; repo.url is alice's `git remote get-url origin`.
T=/tmp/trial
export REPO_URL="$(cat $T/repo.url)" HUMANS="$(cat $T/keys/alice.pk),$(cat $T/keys/bob.pk)"
exec $T/g.sh clanker node $T/clanker.mjs
