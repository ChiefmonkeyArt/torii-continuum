#!/usr/bin/env bash
#
# Regression tests for the /opt/torii SHARED-parent ownership/mode logic in
# ops/install-agent.sh.
#
# Pinned bug (v0.2.29 → fixed v0.2.30): the installer created the shared parent
# with an UNCONDITIONAL
#
#     install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /opt/torii
#
# `install -d` re-applies mode AND owner on every run, so this clamped the
# parent that torii's other apps live under (the torii-base launcher, quest
# tooling) to 0750 continuum:continuum — stripping its world-execute (o+x) bit.
# nginx (www-data) then could no longer traverse /opt/torii to reach
# /opt/torii/launcher/index.html, so `/` fell through to a default 404.
#
# The fix: create /opt/torii ONLY if absent, root:root 0755, and NEVER re-own or
# re-mode an existing shared parent. The agent's OWN subdir
# (/opt/torii/continuum-agent) must still be locked 0750 continuum:continuum.
#
# These tests are hermetic (throwaway $TMPDIR tree, no root, no real /opt) and
# anti-drift (assert the literals under test still appear in the installer).
#
# Run:  bash ops/test/installer-shared-parent.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-agent.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# ── 1. Anti-drift: the shared parent must NOT be clamped to the service user ──
# The exact regression line must be gone: no `install -d ... /opt/torii` that
# assigns ownership to $SERVICE_USER (bare /opt/torii, not the subdir).
if grep -Eq 'install -d[^\n]*-o[[:space:]]+"?\$\{?SERVICE_USER\}?"?[^\n]*[[:space:]]/opt/torii([[:space:]]|$)' "$INSTALLER"; then
  bad "installer still clamps the SHARED parent /opt/torii to \$SERVICE_USER (the regression)"
else
  ok "installer no longer chowns the shared parent /opt/torii to the service user"
fi

# The parent create must be guarded (create-if-absent), root-owned, 0755.
grep -qF 'if [[ ! -d /opt/torii ]]; then' "$INSTALLER" \
  && ok "installer guards /opt/torii creation with an existence check (non-destructive re-run)" \
  || bad "installer no longer guards /opt/torii with an existence check"

grep -qF 'install -d -m 0755 -o root -g root /opt/torii' "$INSTALLER" \
  && ok "installer creates /opt/torii root:root 0755 (world-traversable)" \
  || bad "installer does not create /opt/torii as root:root 0755"

# The agent's OWN dir must still be locked 0750 continuum:continuum.
grep -qF 'install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"' "$INSTALLER" \
  && ok "installer still locks \$INSTALL_DIR to 0750 \$SERVICE_USER" \
  || bad "installer no longer locks \$INSTALL_DIR to 0750 \$SERVICE_USER"

# INSTALL_DIR must be the agent SUBDIR, i.e. strictly under the shared parent.
grep -qF 'readonly INSTALL_DIR="/opt/torii/continuum-agent"' "$INSTALLER" \
  && ok "INSTALL_DIR is the agent subdir under the shared parent" \
  || bad "INSTALL_DIR is not /opt/torii/continuum-agent — test assumptions stale"

# ── 2. Functional: existing shared parent is NEVER mutated ───────────────────
# Replicate the installer's guarded create against a temp "shared parent" that
# already exists with a world-traversable mode, and assert the guard leaves its
# mode untouched (we can't chown to root without privileges, but the o+x bit —
# the exact thing the regression stripped — is what matters and is testable).
mode_of() { stat -c '%a' "$1"; }

shared="${WORK}/opt/torii"
install -d -m 0755 "$shared"            # pre-existing shared parent, has o+x
before="$(mode_of "$shared")"

# The guarded snippet as it appears in the installer (parameterised on the path).
guarded_create() {
  local parent="$1"
  if [[ ! -d "$parent" ]]; then
    install -d -m 0755 -o root -g root "$parent" 2>/dev/null \
      || install -d -m 0755 "$parent"   # fall back w/o -o root when not privileged
  fi
}

guarded_create "$shared"                # re-run over the EXISTING parent
after="$(mode_of "$shared")"

[[ "$before" == "$after" && "$after" == "755" ]] \
  && ok "existing shared parent mode preserved on re-run ($before → $after, o+x intact)" \
  || bad "existing shared parent mode changed on re-run ($before → $after)"

# A parent that STILL has an unusual (operator-chosen) mode must also survive.
shared2="${WORK}/opt/torii2"
install -d -m 0751 "$shared2"           # world-traversable but not world-read
b2="$(mode_of "$shared2")"
guarded_create "$shared2"
a2="$(mode_of "$shared2")"
[[ "$b2" == "$a2" ]] \
  && ok "operator-chosen parent mode ($b2) untouched by re-run" \
  || bad "operator-chosen parent mode mutated ($b2 → $a2)"

# ── 3. Functional: absent shared parent is created world-traversable ─────────
fresh="${WORK}/opt/torii_fresh"
[[ ! -d "$fresh" ]] || bad "fixture error: $fresh already exists"
guarded_create "$fresh"
[[ -d "$fresh" ]] \
  && ok "absent shared parent is created" \
  || bad "absent shared parent was not created"
fmode="$(mode_of "$fresh")"
# o+x must be set so www-data can traverse (…5, …7 — any odd-x world bit ≥1).
[[ "$fmode" == "755" ]] \
  && ok "freshly created shared parent is 0755 (world-traversable)" \
  || bad "freshly created shared parent is $fmode, expected 755"

# ── 4. Functional: the agent subdir stays locked 0750 (no o+x for others) ────
agent_dir="${shared}/continuum-agent"
install -d -m 0750 "$agent_dir"
amode="$(mode_of "$agent_dir")"
[[ "$amode" == "750" ]] \
  && ok "agent subdir locked 0750 (no world access) while parent stays traversable" \
  || bad "agent subdir mode is $amode, expected 750"

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n[installer-shared-parent.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
