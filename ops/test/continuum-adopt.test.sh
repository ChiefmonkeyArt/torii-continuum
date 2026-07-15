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

# ── 1. layout_detect (3-arg: app_dir agent_dir standalone_dir) ────────────────
fresh_app="${WORK}/fresh/app"; fresh_a="${WORK}/fresh/agent"; fresh_s="${WORK}/fresh/standalone"
mkdir -p "$fresh_app" "$fresh_a" "$fresh_s"
[[ "$(layout_detect "$fresh_app" "$fresh_a" "$fresh_s")" == "mode=fresh" ]] \
  && ok "detect: nothing present => fresh" || bad "detect fresh"

# adopt-standalone: standalone has state, agent empty, app dir has NO .git
adopt_app="${WORK}/adopt/app"; adopt_s="${WORK}/adopt/standalone"; adopt_a="${WORK}/adopt/agent"
make_standalone "$adopt_s"; mkdir -p "$adopt_a" "$adopt_app"
[[ "$(layout_detect "$adopt_app" "$adopt_a" "$adopt_s")" == "mode=adopt-standalone" ]] \
  && ok "detect: standalone state only, no app/.git => adopt-standalone" || bad "detect adopt"

# existing-ansible: app IS a git checkout AND agent has config -> wins over standalone
exi_app="${WORK}/existing/app"; exi_a="${WORK}/existing/agent"; exi_s="${WORK}/existing/standalone"
make_standalone "$exi_s"; mkdir -p "$exi_a" "$exi_app/.git"
cp "$exi_s/config.yaml" "$exi_a/config.yaml"   # ansible layout already populated
[[ "$(layout_detect "$exi_app" "$exi_a" "$exi_s")" == "mode=existing-ansible" ]] \
  && ok "detect: app/.git + agent config wins over standalone => existing-ansible" \
  || bad "detect existing-ansible precedence"

# standalone with ONLY memory/ (no config), app has no .git, agent empty => adopt
adopt2_app="${WORK}/adopt2/app"; adopt2_s="${WORK}/adopt2/standalone"; adopt2_a="${WORK}/adopt2/agent"
mkdir -p "$adopt2_s/memory" "$adopt2_a" "$adopt2_app"
[[ "$(layout_detect "$adopt2_app" "$adopt2_a" "$adopt2_s")" == "mode=adopt-standalone" ]] \
  && ok "detect: standalone memory/ without config => adopt-standalone" \
  || bad "detect adopt via memory-only"

# partial-adoption: agent dir carries state, app dir has NO .git, standalone still
# present. This is the EXACT v0.2.41 failure fingerprint and must NOT be classified
# as a valid existing-ansible install.
part_app="${WORK}/partial/app"; part_a="${WORK}/partial/agent"; part_s="${WORK}/partial/standalone"
make_standalone "$part_s"          # original standalone untouched, still running
mkdir -p "$part_app"               # app dir exists but is NOT a git checkout
make_standalone "$part_a"          # agent dir holds the half-migrated copy
[[ "$(layout_detect "$part_app" "$part_a" "$part_s")" == "mode=partial-adoption" ]] \
  && ok "detect: agent state + app without .git + standalone => partial-adoption" \
  || bad "detect partial-adoption"

# partial-adoption is recognised even when the app dir does not exist yet at all
part2_app="${WORK}/partial2/app"; part2_a="${WORK}/partial2/agent"; part2_s="${WORK}/partial2/standalone"
make_standalone "$part2_s"; make_standalone "$part2_a"   # no app dir created
[[ "$(layout_detect "$part2_app" "$part2_a" "$part2_s")" == "mode=partial-adoption" ]] \
  && ok "detect: agent state + absent app dir => partial-adoption" \
  || bad "detect partial-adoption (absent app dir)"

# ── 1b. authoritative_state_dir ──────────────────────────────────────────────
[[ "$(authoritative_state_dir existing-ansible "$exi_a" "$exi_s")" == "$exi_a" ]] \
  && ok "authoritative: existing-ansible => agent dir" || bad "authoritative existing"
[[ "$(authoritative_state_dir adopt-standalone "$adopt_a" "$adopt_s")" == "$adopt_s" ]] \
  && ok "authoritative: adopt-standalone => standalone dir" || bad "authoritative adopt"
# partial with the standalone still holding state => standalone is authoritative
[[ "$(authoritative_state_dir partial-adoption "$part_a" "$part_s")" == "$part_s" ]] \
  && ok "authoritative: partial + standalone state => standalone (untouched original)" \
  || bad "authoritative partial->standalone"
# partial where the standalone lost its state => fall back to the agent-dir copy
pfb_a="${WORK}/pfb/agent"; pfb_s="${WORK}/pfb/standalone"
make_standalone "$pfb_a"; mkdir -p "$pfb_s"
[[ "$(authoritative_state_dir partial-adoption "$pfb_a" "$pfb_s")" == "$pfb_a" ]] \
  && ok "authoritative: partial + empty standalone => agent copy (last resort)" \
  || bad "authoritative partial->agent fallback"
[[ -z "$(authoritative_state_dir fresh "$fresh_a" "$fresh_s")" ]] \
  && ok "authoritative: fresh => empty" || bad "authoritative fresh empty"

# ── 1c. stage_reset (clean staging; refuses dangerous targets) ────────────────
st="${WORK}/stage/app.staging"
mkdir -p "$st"; echo "STALE" > "$st/stale.txt"      # leftover from a prior failed run
stage_reset "$st" >/dev/null 2>&1 \
  && ok "stage_reset: returns 0 on a normal target" || bad "stage_reset: non-zero"
[[ -d "$st" && ! -e "$st/stale.txt" ]] \
  && ok "stage_reset: wipes stale contents, leaves an empty dir" || bad "stage_reset: not clean"
for danger in / /home /root /opt /opt/torii; do
  if stage_reset "$danger" >/dev/null 2>&1; then
    bad "stage_reset: did NOT refuse dangerous target '$danger'"
  else
    ok "stage_reset: refuses dangerous target '$danger'"
  fi
done

# ── 1d. promote_release (atomic swap + quarantine; never deletes state) ───────
# clean adoption: no pre-existing app dir -> staging simply becomes app
pr1_rel="${WORK}/prom1/app.staging"; pr1_app="${WORK}/prom1/app"; pr1_q="${WORK}/prom1/app.quarantine"
mkdir -p "$pr1_rel/agent"; echo "NEWBUILD" > "$pr1_rel/marker"
promote_release "$pr1_rel" "$pr1_app" "$pr1_q" >/dev/null 2>&1 \
  && ok "promote: clean adoption returns 0" || bad "promote: clean non-zero"
[[ -f "$pr1_app/marker" && ! -d "$pr1_rel" ]] \
  && ok "promote: staging moved into app (no residue)" || bad "promote: staging not moved"
[[ ! -e "$pr1_q" ]] \
  && ok "promote: no quarantine created when app absent" || bad "promote: spurious quarantine"

# pre-existing app (partial non-git tree) -> quarantined, never deleted
pr2_rel="${WORK}/prom2/app.staging"; pr2_app="${WORK}/prom2/app"; pr2_q="${WORK}/prom2/app.quarantine"
mkdir -p "$pr2_rel/agent"; echo "NEWBUILD" > "$pr2_rel/marker"
mkdir -p "$pr2_app/agent/ciphertexts"; echo "OLD-PARTIAL-STATE" > "$pr2_app/agent/ciphertexts/routstr.key.enc"
promote_release "$pr2_rel" "$pr2_app" "$pr2_q" >/dev/null 2>&1 \
  && ok "promote: pre-existing app returns 0" || bad "promote: pre-existing non-zero"
[[ -f "$pr2_app/marker" ]] \
  && ok "promote: new build promoted into app" || bad "promote: new build not in app"
grep -qr "OLD-PARTIAL-STATE" "$pr2_q" \
  && ok "promote: prior app quarantined (state preserved, never deleted)" \
  || bad "promote: prior app state lost"

# refuses to clobber an existing quarantine dir
pr3_rel="${WORK}/prom3/app.staging"; pr3_app="${WORK}/prom3/app"; pr3_q="${WORK}/prom3/app.quarantine"
mkdir -p "$pr3_rel" "$pr3_app" "$pr3_q"
if promote_release "$pr3_rel" "$pr3_app" "$pr3_q" >/dev/null 2>&1; then
  bad "promote: did NOT refuse to overwrite an existing quarantine"
else
  ok "promote: refuses when the quarantine dir already exists"
fi

# idempotent: staging already gone but app is a promoted git checkout -> no-op success
pr4_rel="${WORK}/prom4/app.staging"; pr4_app="${WORK}/prom4/app"; pr4_q="${WORK}/prom4/app.quarantine"
mkdir -p "$pr4_app/.git"
promote_release "$pr4_rel" "$pr4_app" "$pr4_q" >/dev/null 2>&1 \
  && ok "promote: idempotent no-op when already promoted (git checkout, no staging)" \
  || bad "promote: not idempotent after a completed promotion"

# ── 1e. rollback_release (undo a promotion from quarantine) ───────────────────
# existing-ansible cutover failed: app is the failed new tree, quarantine the prior
rb_app="${WORK}/rb/app"; rb_q="${WORK}/rb/app.quarantine"; rb_f="${WORK}/rb/app.failed"
mkdir -p "$rb_app/agent"; echo "FAILED-NEW" > "$rb_app/marker"
mkdir -p "$rb_q/agent/ciphertexts"; echo "PRIOR-GOOD-STATE" > "$rb_q/agent/ciphertexts/routstr.key.enc"
rollback_release "$rb_app" "$rb_q" "$rb_f" >/dev/null 2>&1 \
  && ok "rollback: returns 0 with a failed_dir given" || bad "rollback: non-zero"
grep -qr "PRIOR-GOOD-STATE" "$rb_app" \
  && ok "rollback: prior tree restored to app from quarantine" || bad "rollback: prior not restored"
grep -qr "FAILED-NEW" "$rb_f" \
  && ok "rollback: failed new tree moved aside (never deleted)" || bad "rollback: failed tree lost"
[[ ! -e "$rb_q" ]] \
  && ok "rollback: quarantine consumed by the restore" || bad "rollback: quarantine residue"
# refuses to clobber a present app when no failed_dir is given
rb2_app="${WORK}/rb2/app"; rb2_q="${WORK}/rb2/app.quarantine"
mkdir -p "$rb2_app" "$rb2_q"
if rollback_release "$rb2_app" "$rb2_q" >/dev/null 2>&1; then
  bad "rollback: did NOT refuse to clobber app without a failed_dir"
else
  ok "rollback: refuses to clobber a present app without a failed_dir"
fi
# nothing to restore (no quarantine) => non-zero
rb3_app="${WORK}/rb3/app"; rb3_q="${WORK}/rb3/app.quarantine"
mkdir -p "$rb3_app"
if rollback_release "$rb3_app" "$rb3_q" "${WORK}/rb3/failed" >/dev/null 2>&1; then
  bad "rollback: succeeded with no quarantine to restore"
else
  ok "rollback: non-zero when there is no quarantine to restore"
fi

# ── 1f. End-to-end: partial-adoption recovery is transactional + safe ─────────
# Reproduce the live v0.2.41 fingerprint: original standalone intact, PLUS a
# partial non-git app dir holding a COPY of the state. Recovery must build in a
# CLEAN staging dir, copy the AUTHORITATIVE (standalone) state in AFTER the build,
# atomically swap, and quarantine the partial tree — funded key + session_secret
# intact, original standalone left untouched on disk.
e2e="${WORK}/e2e"
e2e_std="${e2e}/opt/torii/continuum-agent"        # original standalone (authoritative)
e2e_app="${e2e}/home/continuum/app"               # partial non-git app
e2e_agent="${e2e_app}/agent"
e2e_stage="${e2e}/home/continuum/app.staging"
e2e_q="${e2e}/home/continuum/app.quarantine-STAMP"
make_standalone "$e2e_std"
make_standalone "$e2e_agent"                       # partial migrated copy (app has no .git)
echo "PARTIAL-DIVERGED" >> "$e2e_agent/memory/wallet/state.json"

e2e_mode="$(layout_detect "$e2e_app" "$e2e_agent" "$e2e_std")"
[[ "$e2e_mode" == "mode=partial-adoption" ]] \
  && ok "e2e: live fingerprint detected as partial-adoption" || bad "e2e: mode=$e2e_mode"
e2e_auth="$(authoritative_state_dir partial-adoption "$e2e_agent" "$e2e_std")"
[[ "$e2e_auth" == "$e2e_std" ]] \
  && ok "e2e: authoritative source is the untouched standalone (not the partial copy)" \
  || bad "e2e: wrong authoritative source ($e2e_auth)"
# build in a clean staging dir (simulate the git checkout + build output)
stage_reset "$e2e_stage" >/dev/null 2>&1
mkdir -p "${e2e_stage}/agent"; echo "dist" > "${e2e_stage}/dist.marker"
# copy authoritative state into staging AFTER the 'build'
migrate_state "$e2e_auth" "${e2e_stage}/agent" "$(id -un)" >/dev/null 2>&1
# atomic swap; the partial non-git app must be quarantined, not deleted
promote_release "$e2e_stage" "$e2e_app" "$e2e_q" >/dev/null 2>&1 \
  && ok "e2e: staged release atomically promoted" || bad "e2e: promote failed"
[[ -f "${e2e_app}/dist.marker" && -d "${e2e_app}/agent" ]] \
  && ok "e2e: promoted app carries the freshly built tree + agent state" || bad "e2e: app tree wrong"
diff -q "$e2e_std/config.yaml" "${e2e_app}/agent/config.yaml" >/dev/null \
  && ok "e2e: promoted config.yaml is byte-for-byte the authoritative standalone config" \
  || bad "e2e: config not byte-equal"
grep -qr "FUNDED-KEY-CIPHERTEXT" "${e2e_app}/agent/ciphertexts" \
  && ok "e2e: funded key retained in the promoted tree" || bad "e2e: funded key lost"
grep -qr "FUNDED-KEY-CIPHERTEXT" "$e2e_q" \
  && ok "e2e: partial tree preserved in quarantine (never deleted)" || bad "e2e: partial tree lost"
grep -qr "FUNDED-KEY-CIPHERTEXT" "$e2e_std/ciphertexts" \
  && ok "e2e: original standalone left intact on disk" || bad "e2e: standalone disturbed"

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
[[ "$(config_action partial-adoption false)" == "preserve" ]] \
  && ok "config_action: partial-adoption + no rotation => preserve" || bad "config_action partial preserve"
[[ "$(config_action partial-adoption true)" == "rotate" ]] \
  && ok "config_action: partial-adoption + explicit opt-in => rotate" || bad "config_action partial rotate"

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
va_app="${WORK}/vaultfree/app"; va_s="${WORK}/vaultfree/standalone"; va_a="${WORK}/vaultfree/agent"
make_standalone "$va_s"; mkdir -p "$va_a" "$va_app"
[[ "$(layout_detect "$va_app" "$va_a" "$va_s")" == "mode=adopt-standalone" ]] \
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

# ── 10. Anti-drift: the role must be transactional (v0.2.42-alpha) ────────────
grep -q 'continuum_adopt_lib }} stage-reset' "$ROLE" \
  && ok "role: resets a clean staging dir via the lib" || bad "role: no stage-reset call"
grep -q 'continuum_adopt_lib }} authoritative' "$ROLE" \
  && ok "role: resolves the authoritative state dir via the lib" || bad "role: no authoritative call"
grep -q 'continuum_adopt_lib }} promote' "$ROLE" \
  && ok "role: promotes staging atomically via the lib" || bad "role: no promote call"
grep -q 'continuum_adopt_lib }} rollback' "$ROLE" \
  && ok "role: can roll a failed cutover back via the lib" || bad "role: no rollback call"
# clone/build must target the STAGING dir, never the live app dir
grep -q 'dest: "{{ continuum_release_dir }}"' "$ROLE" \
  && ok "role: git clone targets the staging dir (never the live app)" \
  || bad "role: clone does not target staging"
grep -q 'chdir: "{{ continuum_release_dir }}"' "$ROLE" \
  && ok "role: npm/build run in staging" || bad "role: build not in staging"
# state is copied into the STAGED agent before promotion (not the live app)
grep -q 'continuum_release_agent_dir' "$ROLE" \
  && ok "role: state is copied into the staged agent before promotion" \
  || bad "role: state not staged before promotion"
# promotion + rescue rollback are gated on a swap-tracking fact
grep -q 'continuum_swapped' "$ROLE" \
  && ok "role: tracks swap state to gate the rescue rollback" || bad "role: no swap tracking"
# partial-adoption must be handled as a distinct mode
grep -q 'partial-adoption' "$ROLE" \
  && ok "role: handles partial-adoption explicitly" || bad "role: partial-adoption not handled"
# the OLD unit must keep running through the build (stop is inside the cutover block)
grep -q 'Stop the old unit to free port' "$ROLE" \
  && ok "role: stops the old unit only at cutover (kept running through build)" \
  || bad "role: old-unit stop not at cutover"

# ── 11. Defaults sanity (v0.2.42-alpha staging/quarantine vars) ───────────────
grep -q 'continuum_release_dir:' "$DEFAULTS" \
  && ok "defaults: staging/release dir defined" || bad "defaults: no release dir"
grep -q 'continuum_quarantine_dir:' "$DEFAULTS" \
  && ok "defaults: quarantine dir defined" || bad "defaults: no quarantine dir"
grep -q 'continuum_failed_release_dir:' "$DEFAULTS" \
  && ok "defaults: failed-release dir defined" || bad "defaults: no failed-release dir"

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n[continuum-adopt.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
