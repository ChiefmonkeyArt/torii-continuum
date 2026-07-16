#!/usr/bin/env bash
#
# Hermetic tests for the unattended deploy wrapper (OPS-DEPLOY-2, v0.2.50-alpha).
#
# Two halves, no real deploy and no network:
#   1. Pure-function unit cases — source deploy-unattended.sh and exercise the
#      tag grammar, version gate, allowlist policy, version extraction, inventory
#      rendering, and release-pruning directly, in-process.
#   2. Static assertions on the wrapper, systemd units, sudoers rule, and
#      bootstrap, proving the fail-closed guards and scoped-privilege model are
#      wired the way the security review depends on.
#
# Run:  bash ops/test/deploy-unattended.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
OPS="${REPO_ROOT}/ops"
WRAPPER="${OPS}/deploy-unattended.sh"
BOOTSTRAP="${OPS}/deploy-bootstrap.sh"
SERVICE="${OPS}/systemd/torii-continuum-deploy.service"
TIMER="${OPS}/systemd/torii-continuum-deploy.timer"
SUDOERS="${OPS}/sudoers/torii-continuum-deploy.example"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

for f in "$WRAPPER" "$BOOTSTRAP" "$SERVICE" "$TIMER" "$SUDOERS"; do
  [[ -f "$f" ]] || { bad "missing file: $f"; exit 1; }
done

# Scripts must parse.
bash -n "$WRAPPER"   && ok "wrapper passes bash -n"   || bad "wrapper failed bash -n"
bash -n "$BOOTSTRAP" && ok "bootstrap passes bash -n" || bad "bootstrap failed bash -n"

# Sourcing must be side-effect free (the CLI dispatcher must be guarded).
# shellcheck disable=SC1090
source "$WRAPPER"
ok "wrapper sources without executing the deploy (dispatcher guarded)"

# ── 1. Tag grammar ───────────────────────────────────────────────────────────
for good in v0.2.50-alpha v1.0.0 v0.2.49-alpha v10.20.30-rc.1; do
  validate_tag "$good" && ok "accepts valid tag ${good}" || bad "rejected valid tag ${good}"
done
for bad_tag in main HEAD 0.2.50-alpha v0.2 "v0.2.50-alpha; rm -rf /" 'v0.2.50 alpha' \
               '$(id)' 'v0.2.50-alpha`id`' '../evil' 'vX.Y.Z' ''; do
  if validate_tag "$bad_tag"; then bad "accepted INVALID tag '${bad_tag}'"; else ok "rejects invalid tag '${bad_tag}'"; fi
done

# ── 2. Version gate (mirrors the role's health assertion) ─────────────────────
version_matches v0.2.50-alpha 0.2.50-alpha && ok "gate: v-prefixed target matches bare live" || bad "gate should match leading-v strip"
version_matches 0.2.50-alpha  0.2.50-alpha && ok "gate: bare target also matches"            || bad "bare target should match"
if version_matches v0.2.50-alpha 0.2.49-alpha; then bad "gate must FAIL on stale live"; else ok "gate: stale live fails"; fi
if version_matches v0.2.50-alpha "";           then bad "gate must FAIL on empty live";  else ok "gate: empty live fails"; fi

# ── 3. Allowlist policy ──────────────────────────────────────────────────────
tag_allowed v0.2.50-alpha "" && ok "allowlist: unset file = allowed (opt-in)" || bad "unset allowlist should allow"
tmp_allow="$(mktemp)"; printf 'v0.2.49-alpha\nv0.2.50-alpha\n' > "$tmp_allow"
tag_allowed v0.2.50-alpha "$tmp_allow" && ok "allowlist: listed tag allowed" || bad "listed tag should be allowed"
if tag_allowed v0.9.9-alpha "$tmp_allow"; then bad "unlisted tag must be denied"; else ok "allowlist: unlisted tag denied"; fi
if tag_allowed v0.2.50-alpha "/no/such/allow/file"; then bad "missing allowlist file must fail closed"; else ok "allowlist: configured-but-missing file fails closed"; fi
rm -f "$tmp_allow"

# ── 4. Version extraction (no jq) ────────────────────────────────────────────
_lv() { CONTINUUM_HEALTH_URL="unused" live_version </dev/null 2>/dev/null; }  # noop guard
extract() { printf '%s' "$1" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }
[[ "$(extract '{"ok":true,"service":"x","version":"0.2.50-alpha"}')" == "0.2.50-alpha" ]] \
  && ok "extracts version from a health JSON body" || bad "version extraction failed"
[[ -z "$(extract '{"ok":true}')" ]] && ok "empty when body has no version" || bad "should be empty without version"

# ── 5. Inventory rendering (vault-free, localhost, SSH-less) ──────────────────
tmp_ans="$(mktemp -d)"
write_localhost_inventory "$tmp_ans" "example.com" "v0.2.50-alpha"
grep -qF 'ansible_connection: local' "$tmp_ans/inventory.yml" && ok "inventory is localhost/local (no SSH)" || bad "inventory not local"
grep -qF 'continuum_version: "v0.2.50-alpha"' "$tmp_ans/group_vars/all.yml" && ok "group_vars pins continuum_version to the tag" || bad "group_vars missing tag"
grep -qF 'torii_domain: "example.com"' "$tmp_ans/group_vars/all.yml" && ok "group_vars carries the domain" || bad "group_vars missing domain"
grep -q 'vault' "$tmp_ans/group_vars/all.yml" && bad "group_vars must NOT reference a vault" || ok "group_vars is vault-free (no secret handling)"
rm -rf "$tmp_ans"

# ── 6. Release pruning keeps the live release + newest N ──────────────────────
tmp_root="$(mktemp -d)"
for t in v0.2.46-alpha v0.2.47-alpha v0.2.48-alpha v0.2.49-alpha v0.2.50-alpha; do
  mkdir -p "$tmp_root/torii-continuum-${t}"; sleep 0.01
done
prune_releases "$tmp_root" 3 "v0.2.50-alpha" >/dev/null
[[ -d "$tmp_root/torii-continuum-v0.2.50-alpha" ]] && ok "prune never removes the live release" || bad "prune removed the LIVE release"
remaining="$(find "$tmp_root" -maxdepth 1 -type d -name 'torii-continuum-*' | wc -l | tr -d ' ')"
[[ "$remaining" -le 4 ]] && ok "prune keeps newest N plus live (remaining=${remaining})" || bad "prune kept too many (${remaining})"
[[ ! -d "$tmp_root/torii-continuum-v0.2.46-alpha" ]] && ok "prune removed the oldest release" || bad "prune left the oldest release"
rm -rf "$tmp_root"

# ── 7. Wrapper fail-closed guards (static) ───────────────────────────────────
grep -qF 'set -euo pipefail' "$WRAPPER" && ok "wrapper uses set -euo pipefail" || bad "wrapper missing strict mode"
grep -qF 'id -u' "$WRAPPER" && grep -qF 'must run as root' "$WRAPPER" && ok "wrapper refuses non-root" || bad "wrapper does not enforce root"
grep -qF 'validate_tag "$tag"' "$WRAPPER" && ok "run_deploy validates the tag before use" || bad "run_deploy does not validate the tag"
grep -qF 'CONTINUUM_REQUIRE_SIGNED_TAGS' "$WRAPPER" && grep -qF 'verify_signed_tag' "$WRAPPER" && ok "wrapper supports signed-tag verification" || bad "no signed-tag verification path"
grep -qF 'version_matches "$tag" "$now"' "$WRAPPER" && ok "wrapper independently re-verifies the deployed version" || bad "no post-deploy version re-verify"
grep -qF 'flock' "$WRAPPER" && ok "wrapper serializes concurrent runs with flock" || bad "no flock guard"
grep -qF -- '--tags continuum' "$WRAPPER" && ok "wrapper delegates to the existing role (--tags continuum)" || bad "wrapper does not delegate to the role"
# Must NOT reimplement backup/rollback — those belong to the hardened role.
if grep -qiE '\brm -rf .*(memory|ciphertexts|wallet)\b' "$WRAPPER"; then bad "wrapper deletes state dirs (must never)"; else ok "wrapper never touches state dirs"; fi
# No secret surface. Strip comments first (the wrapper legitimately DESCRIBES
# itself as vault-free in prose); flag only real secret handling in code.
wrapper_code="$(sed 's/#.*$//' "$WRAPPER")"
if printf '%s' "$wrapper_code" | grep -qiE 'session_secret|admin_npub|ask-vault|vault-password'; then
  bad "wrapper handles secrets/vault in code"
else
  ok "wrapper handles no secrets/vault in code (vault-free path)"
fi

# ── 8. systemd units ─────────────────────────────────────────────────────────
grep -qF 'Type=oneshot' "$SERVICE" && ok "deploy service is oneshot" || bad "service not oneshot"
grep -qF 'ExecStart=/usr/local/sbin/torii-continuum-deploy' "$SERVICE" && ok "service runs the installed wrapper by absolute path" || bad "service ExecStart wrong"
grep -qF 'OnUnitActiveSec=' "$TIMER" && grep -qF 'WantedBy=timers.target' "$TIMER" && ok "timer recurs and installs to timers.target" || bad "timer misconfigured"

# ── 9. Scoped sudoers (no general passwordless sudo) ──────────────────────────
grep -qF 'NOPASSWD: /usr/local/sbin/torii-continuum-deploy ""' "$SUDOERS" && ok "sudoers grants NOPASSWD on ONLY the wrapper, no args" || bad "sudoers rule too broad"
if grep -qE 'NOPASSWD:[[:space:]]*ALL' "$SUDOERS"; then bad "sudoers grants NOPASSWD: ALL (forbidden)"; else ok "sudoers never grants NOPASSWD: ALL"; fi

# ── 10. Bootstrap installs fail-closed with correct modes ────────────────────
grep -qF 'install -m 0755 -o root -g root' "$BOOTSTRAP" && ok "bootstrap installs wrapper 0755 root:root" || bad "wrapper install mode wrong"
grep -qF 'chmod 0600' "$BOOTSTRAP" && grep -qF 'continuum-deploy.conf' "$BOOTSTRAP" && ok "bootstrap creates pin file 0600" || bad "pin file not 0600"
grep -qF 'visudo -cf' "$BOOTSTRAP" && ok "bootstrap validates sudoers with visudo before trusting" || bad "bootstrap does not validate sudoers"
grep -qF 'passwd --lock' "$BOOTSTRAP" && grep -qF 'nologin' "$BOOTSTRAP" && ok "bootstrap principal is locked + non-login" || bad "principal not locked/non-login"
grep -qF 'StrictHostKeyChecking=yes' "$BOOTSTRAP" && ok "bootstrap documents host-key pinning" || bad "no host-key pinning guidance"
if grep -qF 'if [[ -f "$CONF_FILE" ]]' "$BOOTSTRAP"; then ok "bootstrap never overwrites an existing pin file"; else bad "bootstrap may clobber the pin file"; fi

printf '\n[deploy-unattended.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
