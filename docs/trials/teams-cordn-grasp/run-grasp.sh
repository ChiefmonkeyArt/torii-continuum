#!/bin/bash
# Private (GRASP-08) ngit-grasp on loopback. Members = the roster projection.
T=/tmp/trial; np(){ $T/bin/nak encode npub "$(cat $T/keys/$1.pk)"; }
export NGIT_DOMAIN=localhost:7334 NGIT_BIND_ADDRESS=127.0.0.1:7334
export NGIT_PRIVATE_MODE=true NGIT_PRIVATE_MEMBERS="$(np alice),$(np bob),$(np clanker)"
export NGIT_RELAY_DATA_PATH=$T/run/grasp/relay NGIT_GIT_DATA_PATH=$T/run/grasp/git
export NGIT_RELAY_NAME="Torii team trial" NGIT_LOG_LEVEL=info
mkdir -p $T/run/grasp && cd $T/run/grasp
exec /tmp/trial/ngit-grasp/target/release/ngit-grasp
