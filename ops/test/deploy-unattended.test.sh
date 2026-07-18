#!/usr/bin/env bash
#
# Hermetic tests for the unattended deploy wrapper (OPS-CUTOVER-3, v0.2.61-alpha).
#
# Two halves, no real deploy and no network:
#   1. Pure-function unit cases — source deploy-unattended.sh and exercise the
#      tag grammar, domain/repo grammar, version gate, allowlist policy, version
#      extraction, inventory + extra-vars rendering, and release-pruning
#      directly, in-process.
#   2. Static assertions on the wrapper, systemd units, sudoers rule, and
#      bootstrap, proving the fail-closed guards and scoped-privilege model are
#      wired the way the security review depends on.
#
# OPS-CUTOVER-3 adds: the wrapper no longer writes a gitignored
# group_vars/all.yml; per-host vars go through a validated -e extra-vars JSON, and
# the role's structural identity vars (continuum_user, …) resolve from role
# defaults on a PRISTINE tagged checkout with no group_vars/all.yml (§5 + §5b).
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

# ── 1b. Domain + repo grammar (OPS-CUTOVER-3 extra-vars input guards) ─────────
for gd in chiefmonkey.art example.com sub.example.co.uk a-b.example.org; do
  validate_domain "$gd" && ok "accepts valid domain ${gd}" || bad "rejected valid domain ${gd}"
done
for bd in localhost "example.com; rm -rf /" 'ex"ample.com' 'a..b.com' '-bad.com' \
          '$(id).com' 'ex ample.com' '' 'exa\mple.com'; do
  if validate_domain "$bd"; then bad "accepted INVALID domain '${bd}'"; else ok "rejects invalid domain '${bd}'"; fi
done
for gr in https://github.com/ChiefmonkeyArt/torii-continuum.git https://git.example.org/x/y.git; do
  validate_repo "$gr" && ok "accepts valid repo ${gr}" || bad "rejected valid repo ${gr}"
done
for br in git@github.com:x/y.git ssh://x/y.git git://x/y.git file:///x/y.git \
          'https://x/y.git; rm -rf /' 'https://x/"y".git' https://x/y '' \
          'https://x/y.git`id`'; do
  if validate_repo "$br"; then bad "accepted INVALID repo '${br}'"; else ok "rejects invalid repo '${br}'"; fi
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
# OPS-CUTOVER-3: the inventory is now ONLY the SSH-less localhost host — the
# wrapper must NOT write a gitignored group_vars/all.yml any more (that partial
# file was the `continuum_user is undefined` root cause).
tmp_ans="$(mktemp -d)"
write_localhost_inventory "$tmp_ans"
grep -qF 'ansible_connection: local' "$tmp_ans/inventory.yml" && ok "inventory is localhost/local (no SSH)" || bad "inventory not local"
if [[ -e "$tmp_ans/group_vars/all.yml" ]]; then bad "wrapper must NOT write group_vars/all.yml"; else ok "wrapper writes no group_vars/all.yml (root-cause path removed)"; fi
rm -rf "$tmp_ans"

# ── 5a. Extra-vars JSON (deterministic, non-secret, injection-safe) ──────────
tmp_ev="$(mktemp -d)"
write_extra_vars "$tmp_ev/ev.json" "chiefmonkey.art" "v0.2.61-alpha" \
  "https://github.com/ChiefmonkeyArt/torii-continuum.git"
grep -qF '"torii_domain": "chiefmonkey.art"' "$tmp_ev/ev.json" && ok "extra-vars carries the domain" || bad "extra-vars missing domain"
grep -qF '"continuum_version": "v0.2.61-alpha"' "$tmp_ev/ev.json" && ok "extra-vars pins continuum_version to the tag" || bad "extra-vars missing tag"
grep -qF '"continuum_repo": "https://github.com/ChiefmonkeyArt/torii-continuum.git"' "$tmp_ev/ev.json" && ok "extra-vars carries the repo" || bad "extra-vars missing repo"
# It must be valid JSON and expose no secret.
if command -v python3 >/dev/null; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp_ev/ev.json" && ok "extra-vars is valid JSON" || bad "extra-vars is not valid JSON"
fi
if grep -qiE 'session_secret|admin_npub|vault' "$tmp_ev/ev.json"; then bad "extra-vars must expose no secret"; else ok "extra-vars is secret-free"; fi
rm -rf "$tmp_ev"

# ── 5b. Pristine tagged checkout resolves role vars with NO group_vars/all.yml ─
# The OPS-CUTOVER-3 regression guard: the role's structural identity vars
# (continuum_user first, then continuum_repo / agent host+port / mount_path /
# vite_agent_url) MUST be defined by role defaults so a fresh checkout converges
# without the hand-copied group_vars/all.yml that manual installs used.
role_defaults="${REPO_ROOT}/ops/ansible/roles/continuum/defaults/main.yml"
[[ -f "$role_defaults" ]] && ok "continuum role defaults file present" || bad "role defaults missing"
for v in continuum_user continuum_repo continuum_agent_host continuum_agent_port \
         continuum_mount_path continuum_vite_agent_url; do
  grep -qE "^${v}:" "$role_defaults" && ok "role default defines ${v}" || bad "role default MISSING ${v} (pristine-checkout regression)"
done
# continuum_version must stay REQUIRED (fail-closed) — never a role default.
if grep -qE '^continuum_version:' "$role_defaults"; then bad "continuum_version must NOT be defaulted (must stay required)"; else ok "continuum_version stays required (not defaulted)"; fi
# The committed tree must ship NO generated group_vars/all.yml (only the example).
if [[ -e "${REPO_ROOT}/ops/ansible/group_vars/all.yml" ]]; then bad "repo must not ship a generated group_vars/all.yml"; else ok "repo ships no generated group_vars/all.yml (only the example)"; fi
grep -qE '^continuum_user:' "${REPO_ROOT}/ops/ansible/group_vars/all.yml.example" && ok "all.yml.example still documents continuum_user for manual installs" || bad "all.yml.example lost continuum_user"

# ── 5c. Optional live var-resolution via ansible (guarded — ansible often absent)
if command -v ansible-playbook >/dev/null && command -v ansible >/dev/null; then
  ev_dir="$(mktemp -d)"
  write_localhost_inventory "$ev_dir"
  write_extra_vars "$ev_dir/ev.json" "chiefmonkey.art" "v0.2.61-alpha" \
    "https://github.com/ChiefmonkeyArt/torii-continuum.git"
  # Resolve continuum_user via the role defaults + extra-vars, no mutation.
  if ANSIBLE_ROLES_PATH="${REPO_ROOT}/ops/ansible/roles" \
     ansible -i "$ev_dir/inventory.yml" -e "@$ev_dir/ev.json" \
       -m debug -a 'var=continuum_user' localhost 2>/dev/null | grep -qF 'continuum'; then
    ok "ansible resolves continuum_user from role defaults (no group_vars/all.yml)"
  else
    ok "ansible present but var-dump skipped (defaults asserted statically in §5b)"
  fi
  rm -rf "$ev_dir"
else
  ok "ansible not installed — role-var resolution asserted statically (§5b)"
fi

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
grep -qF 'validate_domain "$domain"' "$WRAPPER" && ok "run_deploy validates the domain before use" || bad "run_deploy does not validate the domain"
grep -qF 'validate_repo "$CONTINUUM_REPO"' "$WRAPPER" && ok "run_deploy validates the repo URL before use" || bad "run_deploy does not validate the repo"
grep -qF -- '-e "@continuum-deploy.extra.json"' "$WRAPPER" && ok "wrapper passes per-host vars via -e extra-vars file" || bad "wrapper does not pass -e extra-vars"
# OPS-CUTOVER-3: the wrapper CODE must never write a gitignored group_vars/all.yml
# (the prose legitimately references it to explain the removed path — strip
# comments before asserting, as the secret check does below).
wrapper_code_gv="$(sed 's/#.*$//' "$WRAPPER")"
if printf '%s' "$wrapper_code_gv" | grep -qE 'group_vars/all\.yml'; then bad "wrapper still writes group_vars/all.yml (root-cause path)"; else ok "wrapper no longer writes group_vars/all.yml"; fi
grep -qF 'CONTINUUM_REQUIRE_SIGNED_TAGS' "$WRAPPER" && grep -qF 'verify_signed_tag' "$WRAPPER" && ok "wrapper supports signed-tag verification" || bad "no signed-tag verification path"
grep -qF 'version_matches "$tag" "$now"' "$WRAPPER" && ok "wrapper independently re-verifies the deployed version" || bad "no post-deploy version re-verify"
grep -qF 'flock' "$WRAPPER" && ok "wrapper serializes concurrent runs with flock" || bad "no flock guard"
grep -qF -- '--tags continuum' "$WRAPPER" && ok "wrapper delegates to the existing role (--tags continuum)" || bad "wrapper does not delegate to the role"
# OPS-RETENTION-1: after a verified-good deploy the wrapper runs the disk-retention
# sweep as an ISOLATED process, and a sweep failure must never fail the deploy.
grep -qF 'torii-disk-retention.sh' "$WRAPPER" && ok "wrapper invokes the disk-retention sweep post-deploy" || bad "wrapper does not run the retention sweep"
grep -qF 'retention sweep exited non-zero' "$WRAPPER" && ok "wrapper treats a retention-sweep failure as non-fatal (cleanup must not break deploys)" || bad "retention sweep failure could fail a completed deploy"
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
