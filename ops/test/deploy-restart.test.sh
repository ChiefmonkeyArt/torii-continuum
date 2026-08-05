#!/usr/bin/env bash
#
# Regression test for OPS-DEPLOY-1 (v0.2.48-alpha): a code-only Ansible deploy
# must RESTART the promoted continuum-agent before readiness, and readiness must
# prove the RESTARTED process serves the deployed version — not merely 200 OK.
#
# The bug this locks down: the continuum-agent unit file is version-independent,
# so a code-only redeploy promotes a new release tree WITHOUT changing the unit;
# the `restart continuum-agent` handler is never notified and a plain
# `state: started` is a no-op against the already-running old PID. The swap
# changed the code on disk but the live process kept serving the PREVIOUS
# release (stale /api/health version, new routes 404). The old health gate
# accepted any 200, so the broken deploy passed.
#
# This test has two halves:
#   1. Static wiring assertions on the continuum role's tasks/handlers, proving
#      the restart-before-readiness sequence, the version-asserting health gate,
#      correct handler/daemon_reload ordering, and that the rescue rollback / JIT
#      smoke test / standalone-disable / no_log secret hygiene all survive.
#   2. Pure unit cases for the version-equality logic the health gate's `until`
#      uses (leading-v strip + exact match), proving a stale live version FAILS
#      readiness and the correct version PASSES.
#
# Run:  bash ops/test/deploy-restart.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
ROLE="${REPO_ROOT}/ops/ansible/roles/continuum"
TASKS="${ROLE}/tasks/main.yml"
HANDLERS="${ROLE}/handlers/main.yml"
UNIT="${ROLE}/templates/continuum-agent.service.j2"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$TASKS" ]]    || { bad "tasks not found: $TASKS"; exit 1; }
[[ -f "$HANDLERS" ]] || { bad "handlers not found: $HANDLERS"; exit 1; }
[[ -f "$UNIT" ]]     || { bad "unit template not found: $UNIT"; exit 1; }

# line-number of the FIRST match of a fixed string in $TASKS, or empty.
#
# NOTE: pipefail is scoped off around this specific grep-into-head pipeline.
# $TASKS is a full-size role file; head -1 can close the pipe (SIGPIPE) before
# grep finishes scanning to EOF, and some runners' pipe-buffer/scheduler
# timing turns that into a spurious pipefail failure even though nothing is
# actually wrong -- head's own exit status (checked implicitly via `cut`'s
# input) still reflects whether a match was found.
ln_of() {
  local rc
  set +o pipefail
  rc="$(grep -nF -- "$1" "$TASKS" | head -1 | cut -d: -f1)"
  set -o pipefail
  printf '%s' "$rc"
}

# ── 1. Restart-before-readiness wiring ───────────────────────────────────────

grep -qF 'register: continuum_unit_install' "$TASKS" \
  && ok "unit install registers continuum_unit_install (change detection)" \
  || bad "unit install no longer registers continuum_unit_install"

grep -qF 'ansible.builtin.meta: flush_handlers' "$TASKS" \
  && ok "handlers are flushed mid-play (unit-change restart runs before readiness)" \
  || bad "no flush_handlers — a unit-change restart could run after the health gate"

grep -qF 'state: restarted' "$TASKS" \
  && ok "an explicit state: restarted task exists (code-only promotion)" \
  || bad "no explicit state: restarted — code-only promotion cannot restart"

# The explicit restart must be gated on: promoted AND unit unchanged. Both
# guards must be present so we neither skip a code-only restart nor double-restart
# when the unit file itself changed (that path is the handler's job).
grep -qF 'continuum_promote.changed | default(false) | bool' "$TASKS" \
  && ok "explicit restart is gated on continuum_promote.changed" \
  || bad "explicit restart is not gated on the promotion having happened"
grep -qF 'not (continuum_unit_install.changed | default(false) | bool)' "$TASKS" \
  && ok "explicit restart is suppressed when the unit changed (handler owns that)" \
  || bad "explicit restart not suppressed on unit change — risks a double restart"

grep -qF 'Ensure continuum-agent is enabled and running (idempotent no-op)' "$TASKS" \
  && ok "a final enabled+started ensure task exists (idempotent reruns)" \
  || bad "no idempotent ensure-started task after the restart"

# ── 2. Version-asserting health gate ─────────────────────────────────────────

grep -qF 'return_content: true' "$TASKS" \
  && ok "health gate reads the response body (return_content: true)" \
  || bad "health gate does not read the body — cannot inspect version"

grep -qF "(agent_health.json.version | default('')) == (continuum_version | regex_replace('^v', ''))" "$TASKS" \
  && ok "health gate asserts live version == continuum_version (leading v stripped)" \
  || bad "health gate does not assert the deployed version"

grep -qF 'agent_health.status == 200' "$TASKS" \
  && ok "health gate still requires HTTP 200" \
  || bad "health gate no longer requires HTTP 200"

# ── 3. Ordering: restart MUST precede the readiness gate ─────────────────────
flush_ln="$(ln_of 'ansible.builtin.meta: flush_handlers')"
restart_ln="$(ln_of 'Restart continuum-agent for a code-only promotion')"
ensure_ln="$(ln_of 'Ensure continuum-agent is enabled and running (idempotent no-op)')"
health_ln="$(ln_of 'Wait for agent to answer /api/health with the DEPLOYED version')"

if [[ -n "$flush_ln" && -n "$restart_ln" && -n "$ensure_ln" && -n "$health_ln" \
      && "$flush_ln" -lt "$restart_ln" && "$restart_ln" -lt "$ensure_ln" \
      && "$ensure_ln" -lt "$health_ln" ]]; then
  ok "order: flush($flush_ln) < restart($restart_ln) < ensure($ensure_ln) < health($health_ln)"
else
  bad "restart sequence is not strictly before the health gate (flush=$flush_ln restart=$restart_ln ensure=$ensure_ln health=$health_ln)"
fi

# daemon_reload must precede the restart: the `reload systemd` handler is defined
# BEFORE `restart continuum-agent`, and flushed handlers run in definition order.
set +o pipefail
reload_h="$(grep -nF 'name: reload systemd' "$HANDLERS" | head -1 | cut -d: -f1)"
restart_h="$(grep -nF 'name: restart continuum-agent' "$HANDLERS" | head -1 | cut -d: -f1)"
set -o pipefail
if [[ -n "$reload_h" && -n "$restart_h" && "$reload_h" -lt "$restart_h" ]]; then
  ok "handler order: 'reload systemd' ($reload_h) before 'restart continuum-agent' ($restart_h)"
else
  bad "daemon-reload handler does not precede the restart handler (reload=$reload_h restart=$restart_h)"
fi

# The unit template stays version-independent — that is WHY a code-only deploy
# doesn't notify the restart handler, which is exactly what the explicit restart
# compensates for. If a version ever leaks into the unit, this assumption breaks.
grep -q 'continuum_version' "$UNIT" \
  && bad "unit template now references continuum_version — restart wiring assumption broken" \
  || ok "unit template is version-independent (code-only deploy needs the explicit restart)"

# ── 4. Rollback / rescue + safety invariants must all survive ────────────────
grep -qF 'rescue:' "$TASKS" \
  && ok "block/rescue rollback semantics preserved" \
  || bad "rescue block missing — rollback lost"
if grep -qF '}} rollback' "$TASKS"; then
  ok "rescue rolls the previous Ansible tree back from quarantine"
else
  bad "rescue no longer rolls back the quarantined tree"
fi
grep -qF 'rollback-webroot' "$TASKS" \
  && ok "rescue restores the prior public webroot" \
  || bad "rescue no longer restores the webroot"
grep -qF 'Re-enable and start the original standalone unit' "$TASKS" \
  && ok "rescue re-enables the standalone unit (adopt/partial modes)" \
  || bad "rescue no longer re-enables the standalone unit"
grep -qF 'Smoke-test Node V8 JIT under the rendered MemoryDenyWriteExecute constraint' "$TASKS" \
  && ok "V8 JIT smoke test preserved" \
  || bad "V8 JIT smoke test lost"
grep -qF 'Disable the standalone unit on adopt/partial (prevents boot races)' "$TASKS" \
  && ok "standalone-unit disabling preserved" \
  || bad "standalone-unit disabling lost"
grep -qF 'Copy authoritative config + encrypted state into the staged release' "$TASKS" \
  && ok "authoritative config/state copy preserved" \
  || bad "config/state copy lost"

# Secret hygiene: the state-copy, backup, and config-render tasks must stay no_log
# so a verbose run never prints config.yaml / session_secret / the funded key.
nolog_count="$(grep -cF 'no_log: true' "$TASKS")"
[[ "$nolog_count" -ge 3 ]] \
  && ok "no_log: true retained on secret-touching tasks (count=$nolog_count)" \
  || bad "no_log guards dropped (count=$nolog_count, expected >=3)"

# Secret VALUES must never reach a printed message. The role may reference
# session_secret in a guarded presence check (| length > 0), but it must never
# appear on a debug/fail `msg:` line where its value would be rendered to output.
if grep -nE 'msg:' "$TASKS" | grep -qF 'session_secret'; then
  bad "a debug/fail msg renders session_secret"
else
  ok "session_secret never appears in a printed msg (guarded presence check only)"
fi

# ── 5. Pure version-equality logic (mirrors the health gate `until`) ──────────
# Ansible evaluates: (json.version) == (continuum_version | regex_replace('^v',''))
# Reproduce that comparison in shell so the readiness pass/fail is proven without
# a live agent or an Ansible run.
version_gate() {
  # $1 = continuum_version (may have leading v), $2 = live /api/health version
  local want="${1#v}" live="$2"
  [[ "$live" == "$want" ]]
}

if version_gate "v0.2.48-alpha" "0.2.43-alpha"; then
  bad "STALE version must FAIL readiness (0.2.43-alpha vs deploy v0.2.48-alpha)"
else
  ok "stale live version 0.2.43-alpha fails readiness against v0.2.48-alpha"
fi

if version_gate "v0.2.48-alpha" "0.2.48-alpha"; then
  ok "correct live version 0.2.48-alpha passes readiness (leading v stripped)"
else
  bad "correct version must PASS readiness"
fi

if version_gate "0.2.48-alpha" "0.2.48-alpha"; then
  ok "tag without leading v also matches"
else
  bad "tag without leading v should still match"
fi

if version_gate "v0.2.48-alpha" ""; then
  bad "empty/absent live version must FAIL readiness"
else
  ok "empty live version (default '') fails readiness"
fi

printf '\n[deploy-restart.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
