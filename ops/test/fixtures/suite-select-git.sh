#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
[[ "$1" == -C && "$2" == /opt/torii-suite/checkout ]] || exit 99
shift 2
case "$1" in
  remote)
    if [[ "${MOCK_FAIL:-}" == origin ]]; then echo https://example.invalid/wrong.git
    else echo https://github.com/ChiefmonkeyArt/torii-suite.git; fi ;;
  status) [[ "${MOCK_FAIL:-}" != dirty ]] || echo ' M installers/install-continuum.sh' ;;
  fetch) [[ "${MOCK_FAIL:-}" != fetch ]] ;;
  rev-parse) printf '%040d\n' 1 ;;
  merge-base) [[ "${MOCK_FAIL:-}" != unmerged ]] ;;
  show)
    if [[ "${MOCK_FAIL:-}" == version ]]; then echo v0.9.22-alpha
    else echo v0.9.23-alpha; fi ;;
  checkout) [[ "${MOCK_FAIL:-}" != collision ]] ;;
  *) exit 99 ;;
esac
