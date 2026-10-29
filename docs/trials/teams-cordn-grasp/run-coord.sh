#!/bin/bash
export CORDN_SERVER_PRIVATE_KEY=$(cat /tmp/trial/keys/coord.sk)
export CORDN_RELAY_URLS=ws://127.0.0.1:10547
export CORDN_STORAGE_BACKEND=sqlite CORDN_SQLITE_PATH=/tmp/trial/run/cordn.sqlite CORDN_SERVER_NAME=torii-trial-coordinator
exec /tmp/trial/bin/cordn-server
