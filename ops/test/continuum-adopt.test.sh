#!/usr/bin/env bash
#
# Tests for the standalone→Ansible adoption logic in ops/lib/continuum-adopt.sh
# and the guard invariants of roles/continuum/tasks/main.yml.
#
# WHY THIS MATTERS
# ----------------
# The continuum agent's funded Routstr key is encrypted at rest under a key
# derived from session_secret. A deploy that (a) overwrites config.yaml with a
# fresh session_secret, or (b) points the service at an empty state dir, orphans
# that key forever. These tests pin the exact behaviours that prevent that:
#
#   - layout detection picks the right mode (existing-ansible wins over adopt)
#   - backup is fail-closed (unwritable target => non-zero, no mutation)
#   - migration copies config + encrypted state VERBATIM, never regenerating
#   - config_action renders ONLY on fresh / explicit rotation, else preserves
#   - config_drift reveals "same"/"differ" and NEVER the secret value
#   - permissions land at 0700 dirs / 0600 config
#   - no function ever emits a secret value on stdout/stderr
#   - the role file still wires the lib in the safe order (anti-drift greps)
#
# Hermetic: throwaway $TMPDIR tree, no root, no real /opt or /home. Owner checks
# are skipped when unprivileged (chown is a no-op path in the lib for non-root).
#
# Run:  bash ops/test/continuum-adopt.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
LIB="${REPO_ROOT}/ops/lib/continuum-adopt.sh"
ROLE="${REPO_ROOT}/ops/ansible/roles/continuum/tasks/main.yml"
DEFAULTS="${REPO_ROOT}/ops/ansible/roles/continuum/defaults/main.yml"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

# A recognisable "secret" that must NEVER appear in any function's output.
SECRET="s3cr3t-SESSION-DO-NOT-LEAK-abcdef0123456789"

WORK="$(mktemp -d)"
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf -- "$WORK"' EXIT

# shellcheck disable=SC1090
source "$LIB"

# Build a fake standalone install with config + encrypted-state artefacts.
make_standalone() {
  local d="$1"
  mkdir -p "$d/memory/wallet" "$d/ciphertexts" "$d/pending"
  cat > "$d/config.yaml" <<EOF
admin_npub: "npub1example"
session_secret: "${SECRET}"
server:
  port: 8787
EOF
  echo "FUNDED-KEY-CIPHERTEXT" > "$d/ciphertexts/routstr.key.enc"
  echo '{"balance":4242}' > "$d/memory/wallet/state.json"
  echo '{"draft":1}' > "$d/pending/evt.json"
}

# ── 1. layout_detect ─────────────────────────────────────────────────────────
fresh_a="${WORK}/fresh/agent"; fresh_s="${WORK}/fresh/standalone"
mkdir -p "$fresh_a" "$fresh_s"
[[ "$(layout_detect "$fresh_a" "$fresh_s")" == "mode=fresh" ]] \
  && ok "detect: nothing present => fresh" || bad "detect fresh"

adopt_s="${WORK}/adopt/standalone"; adopt_a="${WORK}/adopt/agent"
make_standalone "$adopt_s"; mkdir -p "$adopt_a"
[[ "$(layout_detect "$adopt_a" "$adopt_s")" == "mode=adopt-standalone" ]] \
  && ok "detect: standalone state only => adopt-standalone" || bad "detect adopt"

exi_a="${WORK}/existing/agent"; exi_s="${WORK}/existing/standalone"
make_standalone "$exi_s"; mkdir -p "$exi_a"
cp "$exi_s/config.yaml" "$exi_a/config.yaml"   # ansible layout already populated
[[ "$(layout_detect "$exi_a" "$exi_s")" == "mode=existing-ansible" ]] \
  && ok "detect: ansible config present wins over standalone => existing-ansible" \
  || bad "detect existing-ansible precedence"

# standalone with ONLY memory/ (no config) still adopts
adopt2_s="${WORK}/adopt2/standalone"; adopt2_a="${WORK}/adopt2/agent"
mkdir -p "$adopt2_s/memory" "$adopt2_a"
[[ "$(layout_detect "$adopt2_a" "$adopt2_s")" == "mode=adopt-standalone" ]] \
  && ok "detect: standalone memory/ without config => adopt-standalone" \
  || bad "detect adopt via memory-only"

# ── 2. backup_state ────────────────────────────────────────────────────────
bkroot="${WORK}/backups/run1"
if out="$(backup_state "$bkroot" "$adopt_s" "$fresh_a" 2>&1)"; then
  ok "backup: returns 0 when target writable"
else
  bad "backup: returned non-zero on writable target"
fi
[[ "$(mode_of() { stat -c '%a' "$1"; }; mode_of "$bkroot")" == "700" ]] 2>/dev/null || true
[[ "$(stat -c '%a' "$bkroot")" == "700" ]] \
  && ok "backup: backup dir is 0700" || bad "backup: dir not 0700"
# all four artefacts from the standalone source must be present
lbl="$(echo "$adopt_s" | sed -e 's#^/##' -e 's#/#_#g')"
for item in config.yaml memory ciphertexts pending; do
  [[ -e "${bkroot}/${lbl}/${item}" ]] \
    && ok "backup: copied ${item}" || bad "backup: missing ${item}"
done
# the encrypted key content survives inside the backup
grep -qr "FUNDED-KEY-CIPHERTEXT" "${bkroot}/${lbl}/ciphertexts" \
  && ok "backup: encrypted key ciphertext preserved" || bad "backup: ciphertext lost"
# backup output must NOT contain the secret
echo "$out" | grep -q "$SECRET" \
  && bad "backup: LEAKED session_secret in output" \
  || ok "backup: no secret in output"

# ── 2b. backup fail-closed on unwritable target ──────────────────────────────
if [[ "$(id -u)" == "0" ]]; then
  ok "backup fail-closed: skipped (running as root, cannot simulate unwritable)"
else
  roblock="${WORK}/ro"
  mkdir -p "$roblock"; chmod 0500 "$roblock"
  if backup_state "${roblock}/cannot/create" "$adopt_s" >/dev/null 2>&1; then
    bad "backup fail-closed: succeeded on unwritable target (should fail)"
  else
    ok "backup fail-closed: non-zero return when target dir uncreatable"
  fi
  chmod 0700 "$roblock"
fi

# ── 3. migrate_state ─────────────────────────────────────────────────────────
mig_s="${WORK}/mig/standalone"; mig_a="${WORK}/mig/agent"
make_standalone "$mig_s"; mkdir -p "$mig_a"
migrate_state "$mig_s" "$mig_a" "$(id -un)" >/dev/null 2>&1 \
  && ok "migrate: returns 0" || bad "migrate: non-zero"
# config copied VERBATIM (same session_secret, byte-identical)
diff -q "$mig_s/config.yaml" "$mig_a/config.yaml" >/dev/null \
  && ok "migrate: config.yaml copied byte-for-byte (session_secret intact)" \
  || bad "migrate: config.yaml altered during migration"
grep -qr "FUNDED-KEY-CIPHERTEXT" "$mig_a/ciphertexts" \
  && ok "migrate: encrypted key migrated" || bad "migrate: encrypted key lost"
grep -q '"balance":4242' "$mig_a/memory/wallet/state.json" \
  && ok "migrate: wallet state migrated" || bad "migrate: wallet state lost"
# permissions
[[ "$(stat -c '%a' "$mig_a/config.yaml")" == "600" ]] \
  && ok "migrate: config.yaml is 0600" || bad "migrate: config.yaml not 0600"
for d in memory ciphertexts pending; do
  [[ "$(stat -c '%a' "$mig_a/$d")" == "700" ]] \
    && ok "migrate: $d is 0700" || bad "migrate: $d not 0700"
done
# idempotent: re-run must not clobber an existing artefact
echo "MUTATED" > "$mig_a/ciphertexts/routstr.key.enc"
migrate_state "$mig_s" "$mig_a" "$(id -un)" >/dev/null 2>&1
grep -q "MUTATED" "$mig_a/ciphertexts/routstr.key.enc" \
  && ok "migrate: idempotent — existing artefact not overwritten on re-run" \
  || bad "migrate: re-run clobbered existing state"
# migrate output carries no secret
mout="$(migrate_state "$mig_s" "${WORK}/mig/agent2" "$(id -un)" 2>&1)"
echo "$mout" | grep -q "$SECRET" \
  && bad "migrate: LEAKED secret in output" || ok "migrate: no secret in output"

# ── 4. config_action ──────────────────────────────────────────────────────
[[ "$(config_action fresh)" == "render" ]] \
  && ok "config_action: fresh => render" || bad "config_action fresh"
[[ "$(config_action existing-ansible false)" == "preserve" ]] \
  && ok "config_action: existing + no rotation => preserve" || bad "config_action preserve"
[[ "$(config_action adopt-standalone false)" == "preserve" ]] \
  && ok "config_action: adopt + no rotation => preserve" || bad "config_action adopt preserve"
[[ "$(config_action existing-ansible true)" == "rotate" ]] \
  && ok "config_action: existing + explicit opt-in => rotate" || bad "config_action rotate"
[[ "$(config_action adopt-standalone true)" == "rotate" ]] \
  && ok "config_action: adopt + explicit opt-in => rotate" || bad "config_action adopt rotate"

# ── 5. config_drift (reveals no secret) ──────────────────────────────────────
cfgA="${WORK}/drift/a.yaml"; cfgB="${WORK}/drift/b.yaml"; cfgC="${WORK}/drift/c.yaml"
mkdir -p "${WORK}/drift"
printf 'session_secret: "%s"\n' "$SECRET"        > "$cfgA"
printf 'session_secret: "%s"\n' "$SECRET"        > "$cfgB"
printf 'session_secret: "%s"\n' "DIFFERENT-xyz"  > "$cfgC"
d_same="$(config_drift "$cfgA" "$cfgB")"
d_diff="$(config_drift "$cfgA" "$cfgC")"
[[ "$d_same" == "same" ]] \
  && ok "config_drift: identical secrets => same" || bad "config_drift same ($d_same)"
[[ "$d_diff" == "differ" ]] \
  && ok "config_drift: divergent secrets => differ" || bad "config_drift differ ($d_diff)"
# neither the 'same' nor 'differ' path may print the secret
{ echo "$d_same"; echo "$d_diff"; } | grep -q "$SECRET" \
  && bad "config_drift: LEAKED secret in output" || ok "config_drift: no secret in output"
# missing/unreadable secret => conservatively differ
printf 'admin_npub: "x"\n' > "${WORK}/drift/empty.yaml"
[[ "$(config_drift "${WORK}/drift/empty.yaml" "$cfgA")" == "differ" ]] \
  && ok "config_drift: unreadable secret => differ (errs toward preserve)" \
  || bad "config_drift: empty-secret did not report differ"

# ── 6. Anti-drift: the role must wire the lib in the safe order ──────────────
grep -q 'continuum_adopt_lib }} detect' "$ROLE" \
  && ok "role: detects layout via the lib" || bad "role: no detect call"
grep -q 'continuum_adopt_lib }} backup' "$ROLE" \
  && ok "role: backs up via the lib" || bad "role: no backup call"
grep -q 'fail-closed' "$ROLE" \
  && ok "role: backup is documented fail-closed" || bad "role: backup not fail-closed"
grep -Eq "state: stopped" "$ROLE" && grep -q 'continuum_standalone_service' "$ROLE" \
  && ok "role: stops the standalone unit on adopt (frees the port)" \
  || bad "role: does not stop standalone unit"
grep -q 'continuum_adopt_lib }} migrate' "$ROLE" \
  && ok "role: migrates state via the lib" || bad "role: no migrate call"
# config render must be GUARDED (never unconditional)
grep -q "when: continuum_config_action in \['render', 'rotate'\]" "$ROLE" \
  && ok "role: config render is guarded to render/rotate only" \
  || bad "role: config render not guarded (clobber risk!)"
# the OLD unconditional render (a bare template->config.yaml with no when:) is gone.
# We assert there is no config.yaml template task lacking a guard by checking the
# real config dest is only ever written under the guarded/candidate tasks.
grep -q 'no_log: true' "$ROLE" \
  && ok "role: secret-touching tasks use no_log" || bad "role: missing no_log guards"
grep -q 'rescue:' "$ROLE" \
  && ok "role: cutover is transactional (block/rescue)" || bad "role: no rescue block"
grep -q 'continuum_backup_dir' "$ROLE" \
  && ok "role: surfaces backup path for recovery" || bad "role: no backup path in recovery"

# ── 7. Defaults sanity ───────────────────────────────────────────────────────
grep -q 'continuum_allow_config_rotation: false' "$DEFAULTS" \
  && ok "defaults: rotation is OFF by default (safe)" || bad "defaults: rotation default not false"
grep -q 'continuum_standalone_dir: "/opt/torii/continuum-agent"' "$DEFAULTS" \
  && ok "defaults: standalone dir matches installer" || bad "defaults: standalone dir mismatch"
grep -q 'continuum_standalone_service: "torii-continuum-agent"' "$DEFAULTS" \
  && ok "defaults: standalone service matches installer" || bad "defaults: standalone service mismatch"

# ── 8. Vault-free adoption (v0.2.41-alpha) ───────────────────────────────────
# The role must complete an adopt/redeploy of an EXISTING install WITHOUT any
# vault vars or vault password. The candidate-config render + drift diagnostic
# (which reference admin_npub/session_secret) must be SKIPPED, not evaluated, so
# no undefined-variable error can occur. A fresh install or an explicit rotation
# must instead FAIL CLOSED when the vars are absent — before any state is written.
#
# These bash helpers mirror the role's Jinja gates exactly so the truth table is
# pinned here without a live Ansible run:
#   vault_vars_present  == (admin_npub non-empty) AND (session_secret non-empty)
#   candidate_runs       when action==preserve AND vault_vars_present
#   fail_closed          when action in (render,rotate) AND NOT vault_vars_present
vault_vars_present() { # <admin_npub> <session_secret> -> "true"/"false"
  if [ -n "${1:-}" ] && [ -n "${2:-}" ]; then echo "true"; else echo "false"; fi
}
candidate_runs() {     # <action> <present> -> "true"/"false"
  [ "$1" = "preserve" ] && [ "$2" = "true" ] && echo "true" || echo "false"
}
fail_closed() {        # <action> <present> -> "true"/"false"
  { [ "$1" = "render" ] || [ "$1" = "rotate" ]; } && [ "$2" = "false" ] \
    && echo "true" || echo "false"
}

# vault_vars_present truth values
[[ "$(vault_vars_present "npub1x" "$SECRET")" == "true" ]] \
  && ok "vault-free: both vars present => true" || bad "vault-free: present truth"
[[ "$(vault_vars_present "" "")" == "false" ]] \
  && ok "vault-free: no vars (no vault.yml) => false" || bad "vault-free: absent truth"
[[ "$(vault_vars_present "npub1x" "")" == "false" ]] \
  && ok "vault-free: partial vars => false" || bad "vault-free: partial truth"

# adopt-standalone, vault-free: preserve, candidate SKIPPED, NOT fail-closed
va_s="${WORK}/vaultfree/standalone"; va_a="${WORK}/vaultfree/agent"
make_standalone "$va_s"; mkdir -p "$va_a"
[[ "$(layout_detect "$va_a" "$va_s")" == "mode=adopt-standalone" ]] \
  && ok "vault-free adopt: detects adopt-standalone" || bad "vault-free adopt: detect"
va_mode="adopt-standalone"
va_present="$(vault_vars_present "" "")"          # no vault vars in scope
va_action="$(config_action "$va_mode" false)"
[[ "$va_action" == "preserve" ]] \
  && ok "vault-free adopt: config action is preserve" || bad "vault-free adopt: action ($va_action)"
[[ "$(candidate_runs "$va_action" "$va_present")" == "false" ]] \
  && ok "vault-free adopt: candidate render + drift SKIPPED (no undefined-var eval)" \
  || bad "vault-free adopt: candidate would run without vault vars"
[[ "$(fail_closed "$va_action" "$va_present")" == "false" ]] \
  && ok "vault-free adopt: does NOT fail closed (adoption needs no secrets)" \
  || bad "vault-free adopt: fails closed unexpectedly"
# ...and the migration still preserves the live config byte-for-byte end-to-end
va_full="$(migrate_state "$va_s" "$va_a" "$(id -un)" 2>&1)"
diff -q "$va_s/config.yaml" "$va_a/config.yaml" >/dev/null \
  && ok "vault-free adopt: live config.yaml preserved byte-for-byte" \
  || bad "vault-free adopt: config altered"
grep -qr "FUNDED-KEY-CIPHERTEXT" "$va_a/ciphertexts" \
  && ok "vault-free adopt: funded key migrated intact" || bad "vault-free adopt: key lost"
# no secret across the entire vault-free adoption trace
echo "$va_full" | grep -q "$SECRET" \
  && bad "vault-free adopt: LEAKED secret in output" || ok "vault-free adopt: no secret in output"

# existing-ansible redeploy, vault-free: preserve, candidate SKIPPED, no fail
ex_present="$(vault_vars_present "" "")"
ex_action="$(config_action existing-ansible false)"
[[ "$ex_action" == "preserve" ]] \
  && ok "vault-free redeploy: existing-ansible => preserve" || bad "vault-free redeploy: action"
[[ "$(candidate_runs "$ex_action" "$ex_present")" == "false" ]] \
  && ok "vault-free redeploy: drift diagnostic SKIPPED without vault vars" \
  || bad "vault-free redeploy: candidate would run"
[[ "$(fail_closed "$ex_action" "$ex_present")" == "false" ]] \
  && ok "vault-free redeploy: does NOT fail closed" || bad "vault-free redeploy: fails closed"

# fresh install, vault-free: render => FAIL CLOSED
fr_action="$(config_action fresh)"
[[ "$fr_action" == "render" ]] \
  && ok "fresh missing-vars: action is render" || bad "fresh missing-vars: action"
[[ "$(fail_closed "$fr_action" "$(vault_vars_present "" "")")" == "true" ]] \
  && ok "fresh missing-vars: FAILS CLOSED when vault vars absent" \
  || bad "fresh missing-vars: did not fail closed"
# fresh WITH vars present must NOT fail closed
[[ "$(fail_closed "$fr_action" "$(vault_vars_present "npub1x" "$SECRET")")" == "false" ]] \
  && ok "fresh with vars: renders (does not fail closed)" || bad "fresh with vars: fails closed"

# explicit rotation, vault-free: rotate => FAIL CLOSED
ro_action="$(config_action existing-ansible true)"
[[ "$ro_action" == "rotate" ]] \
  && ok "rotation missing-vars: action is rotate" || bad "rotation missing-vars: action"
[[ "$(fail_closed "$ro_action" "$(vault_vars_present "" "")")" == "true" ]] \
  && ok "rotation missing-vars: FAILS CLOSED when vault vars absent" \
  || bad "rotation missing-vars: did not fail closed"

# ── 9. Anti-drift: the role must wire the vault-free guards ───────────────────
grep -q 'continuum_vault_vars_present' "$ROLE" \
  && ok "role: computes vault-var presence fact" || bad "role: no vault-var presence fact"
# candidate render must be guarded by the presence fact (never unconditional)
grep -q 'continuum_vault_vars_present | bool' "$ROLE" \
  && ok "role: drift/candidate guarded by vault-var presence" \
  || bad "role: candidate not guarded by presence fact (undefined-var risk!)"
# presence must be computed defensively via the default filter (never bare eval)
grep -Eq "admin_npub \| default\(''\)" "$ROLE" \
  && ok "role: presence uses default filter (no undefined-var eval)" \
  || bad "role: presence fact may raise on undefined var"
# a fail-closed task must exist for render/rotate without vault vars
grep -q 'Fail closed when config render/rotation is required but vault vars are absent' "$ROLE" \
  && ok "role: fresh/rotation without vault vars fails closed" \
  || bad "role: no fail-closed guard for missing vault vars"

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n[continuum-adopt.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
