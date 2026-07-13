#!/usr/bin/env bash
#
# Torii Continuum agent — Node runtime floor check (shared, sourceable).
#
# Factored out of install-agent.sh so the preflight gate can be unit-tested with
# arbitrary version strings, independent of the host's own Node version.
#
# The floor is a HARD requirement, not an advisory: @cashu/cashu-ts (the money
# path) declares engines.node >=22.4.0 across the whole v3-lts line. Running the
# wallet on an older runtime is unsupported by the dependency maintainer and is
# refused here before any service/file is touched. Node 22 is itself an LTS line,
# so this is a coordinated-upgrade prerequisite, not a bleeding-edge ask.
#
# No side effects on source: only defines constants + one pure function.

# Minimum supported Node runtime (major.minor.patch).
readonly TORII_NODE_MIN_MAJOR=22
readonly TORII_NODE_MIN_MINOR=4
readonly TORII_NODE_MIN_PATCH=0
readonly TORII_NODE_MIN_STR="${TORII_NODE_MIN_MAJOR}.${TORII_NODE_MIN_MINOR}.${TORII_NODE_MIN_PATCH}"

# node_version_ok <version-string>
#   Returns 0 if the given Node version is >= the supported floor, 1 if it is
#   below, and 2 if the string cannot be parsed as X.Y.Z. Robust major.minor.patch
#   comparison — NOT a major-only check (22.3.x must fail even though 22 >= 22).
#   Accepts an optional leading 'v' and ignores any -prerelease / +build suffix.
node_version_ok() {
  local v="${1#v}"
  v="${v%%[-+]*}"
  local IFS='.'
  # shellcheck disable=SC2206
  local parts=($v)
  local maj="${parts[0]:-}" min="${parts[1]:-0}" pat="${parts[2]:-0}"
  [[ "$maj" =~ ^[0-9]+$ && "$min" =~ ^[0-9]+$ && "$pat" =~ ^[0-9]+$ ]] || return 2
  if (( maj != TORII_NODE_MIN_MAJOR )); then (( maj > TORII_NODE_MIN_MAJOR )); return; fi
  if (( min != TORII_NODE_MIN_MINOR )); then (( min > TORII_NODE_MIN_MINOR )); return; fi
  (( pat >= TORII_NODE_MIN_PATCH ))
}
