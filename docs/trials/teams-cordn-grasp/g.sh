#!/bin/bash
# usage: g.sh NAME cmd... -- runs with an isolated HOME and git config for NAME
n=$1; shift
export HOME=/tmp/trial/home/$n GIT_CONFIG_GLOBAL=/tmp/trial/home/$n/.gitconfig GIT_CONFIG_NOSYSTEM=1 XDG_CONFIG_HOME=/tmp/trial/home/$n/.config PATH=/tmp/trial/bin:$PATH
L=ws://localhost:7334
export NGIT_GRASP_DEFAULT_SET=$L NGIT_RELAY_DEFAULT_SET=ws://127.0.0.1:10547 NGIT_RELAY_ANNOUNCEMENT_INDEXER_SET=$L NGIT_RELAY_BLASTER_SET=$L NGIT_RELAY_SIGNER_FALLBACK_SET=ws://127.0.0.1:10547
exec "$@"
