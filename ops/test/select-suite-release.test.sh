#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"
cp "$ROOT/ops/test/fixtures/suite-select-git.sh" "$TMP/bin/git"
chmod +x "$TMP/bin/git"
export PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/calls"
SCRIPT="$ROOT/ops/lib/select-suite-release.sh"
pass=0
for fail in dirty origin fetch unmerged version collision; do
  : > "$MOCK_LOG"
  if MOCK_FAIL="$fail" bash "$SCRIPT" v0.9.23-alpha > "$TMP/out" 2>&1; then
    echo "FAIL: $fail was accepted"; exit 1
  fi
  if [[ "$fail" != collision ]] && grep -q ' checkout ' "$MOCK_LOG"; then
    echo "FAIL: checkout attempted after $fail"; exit 1
  fi
  pass=$((pass+1))
done
for tag in main '-x' 'v0.9.23-alpha;id' 'v0.9.23 alpha' ''; do
  : > "$MOCK_LOG"
  if bash "$SCRIPT" "$tag" > "$TMP/out" 2>&1; then
    echo "FAIL: invalid tag accepted"; exit 1
  fi
  [[ ! -s "$MOCK_LOG" ]] || { echo "FAIL: git called for invalid input"; exit 1; }
  pass=$((pass+1))
done
: > "$MOCK_LOG"
bash "$SCRIPT" v0.9.23-alpha
grep -q 'checkout --detach 0000000000000000000000000000000000000001' "$MOCK_LOG"
if grep -Eq ' reset | clean |--force|refs/tags/\*' "$MOCK_LOG"; then
  echo "FAIL: destructive/wildcard git operation"; exit 1
fi
pass=$((pass+1))
echo "select-suite-release: $pass passed"
