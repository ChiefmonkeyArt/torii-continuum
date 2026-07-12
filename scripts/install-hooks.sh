#!/usr/bin/env bash
# Install local git hooks so contributors get secret-detection on commit/push.
# Run this once after cloning:  bash scripts/install-hooks.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath .githooks
echo "✔ Git hooks path set to .githooks"
