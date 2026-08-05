#!/usr/bin/env bash
#
# Static structural tests for the Ansible-side artifact fast path
# (OPS-ARTIFACT-1, v0.2.103-alpha): role defaults, task wiring, and the
# narrowed fact-gathering in site.yml. These complement (not replace) a real
# `ansible-playbook --syntax-check` / `ansible-lint` run (done manually / in
# CI's ops-shell-tests job) with assertions about SAFETY invariants that a
# syntax check alone wouldn't catch — e.g. "the source-build path still
# exists and is reachable", "artifact mode is the default", "a non-default
# mount path cannot silently use a mismatched artifact".
#
# No ansible-playbook execution here (no inventory/target); pure static
# grep/YAML-load assertions, hermetic and fast like the rest of the suite.
#
# Run:  bash ops/test/continuum-role-artifact-path.test.sh   (from repo root)

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
TASKS="${REPO_ROOT}/ops/ansible/roles/continuum/tasks/main.yml"
DEFAULTS="${REPO_ROOT}/ops/ansible/roles/continuum/defaults/main.yml"
SITE="${REPO_ROOT}/ops/ansible/site.yml"
ADOPT_LIB="${REPO_ROOT}/ops/lib/continuum-adopt.sh"
VERIFY_LIB="${REPO_ROOT}/ops/lib/artifact-verify.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

for f in "$TASKS" "$DEFAULTS" "$SITE" "$ADOPT_LIB" "$VERIFY_LIB"; do
  [[ -f "$f" ]] || { bad "missing file: $f"; exit 1; }
done

echo "== YAML parses =="
python3 -c "import yaml; yaml.safe_load(open('${TASKS}'))" 2>/dev/null \
  && ok "tasks/main.yml is valid YAML" || bad "tasks/main.yml failed to parse as YAML"
python3 -c "import yaml; yaml.safe_load(open('${DEFAULTS}'))" 2>/dev/null \
  && ok "defaults/main.yml is valid YAML" || bad "defaults/main.yml failed to parse as YAML"
python3 -c "import yaml; yaml.safe_load(open('${SITE}'))" 2>/dev/null \
  && ok "site.yml is valid YAML" || bad "site.yml failed to parse as YAML"

echo "== role defaults: artifact-mode toggle =="
grep -qE '^continuum_deploy_mode: *"artifact"' "$DEFAULTS" \
  && ok "continuum_deploy_mode defaults to artifact" || bad "continuum_deploy_mode default is not 'artifact'"
grep -qE '^continuum_deploy_allow_source_fallback: *false' "$DEFAULTS" \
  && ok "continuum_deploy_allow_source_fallback defaults to false (fail closed)" || bad "continuum_deploy_allow_source_fallback default is not false"
grep -qE '^continuum_artifact_path: *""' "$DEFAULTS" \
  && ok "continuum_artifact_path defaults to empty" || bad "continuum_artifact_path default is not empty"

echo "== tasks: both paths present, mutually exclusive by outcome flag =="
grep -qF "Populate staging via the FAST release-artifact path (default)" "$TASKS" \
  && ok "artifact-mode staging block present" || bad "artifact-mode staging block missing"
grep -qF "Populate staging via the SOURCE-BUILD path (opt-in fallback, or non-default mount)" "$TASKS" \
  && ok "source-build staging block present (fallback preserved)" || bad "source-build staging block missing — fallback path was removed"
grep -qF 'ansible.builtin.git:' "$TASKS" \
  && ok "git clone task still exists for the source-build fallback" || bad "git clone task removed entirely — no source-build path left"
grep -qF 'cmd: npm ci' "$TASKS" \
  && ok "npm ci task still exists for the source-build fallback" || bad "npm ci task removed entirely — no source-build path left"
grep -qF 'cmd: npm run build' "$TASKS" \
  && ok "npm run build task still exists for the source-build fallback" || bad "npm run build task removed entirely — no source-build path left"
grep -qF 'cmd: npm ci --omit=dev' "$TASKS" \
  && ok "npm ci --omit=dev task still exists for the source-build fallback" || bad "npm ci --omit=dev task removed entirely — no source-build path left"

echo "== tasks: fail-closed guards =="
grep -qF "differs from the CI-built" "$TASKS" \
  && ok "role refuses artifact mode for a non-default mount path without explicit opt-in" || bad "missing non-default-mount fail-closed guard"
grep -qF "Refusing to promote an unverified artifact" "$TASKS" \
  && ok "role fails closed on artifact verification failure" || bad "missing fail-closed message for verification failure"
grep -qF "silently fall back to the slow source build" "$TASKS" \
  && ok "role fails closed instead of silently falling back to source-build" || bad "missing fail-closed message for implicit fallback"
grep -qF "extra_opts: [\"--strip-components=1\"]" "$TASKS" \
  && ok "artifact extraction strips the top-level release dir wrapper" || bad "missing --strip-components=1 on artifact extraction"

echo "== tasks: extraction only happens after verification succeeds =="
# The unarchive task's `when:` must require both mount compatibility AND rc==0
# from the verify script — never extract an unverified/failed artifact.
awk '/name: Extract the verified artifact directly into staging/,/^- name:/' "$TASKS" \
  | grep -qF "continuum_artifact_verify.rc | default(1) == 0" \
  && ok "extraction task gates on verify rc==0" || bad "extraction task does not gate on verification success"

echo "== continuum-adopt.sh: artifact-verify CLI wired =="
grep -qF "artifact_verify_cli()" "$ADOPT_LIB" \
  && ok "continuum-adopt.sh defines artifact_verify_cli" || bad "continuum-adopt.sh missing artifact_verify_cli"
grep -qF "artifact-verify) artifact_verify_cli" "$ADOPT_LIB" \
  && ok "continuum-adopt.sh CLI dispatcher routes 'artifact-verify'" || bad "continuum-adopt.sh dispatcher missing 'artifact-verify' route"

echo "== site.yml: narrowed but present fact gathering =="
grep -qE '^\s*gather_facts:\s*true' "$SITE" \
  && ok "gather_facts remains enabled (assert tasks still need distribution facts)" || bad "gather_facts was disabled entirely — pre_tasks assert would break"
grep -qE '^\s*gather_subset:' "$SITE" \
  && ok "gather_subset is set (narrowed, not full default gather)" || bad "gather_subset not set — still doing a full fact gather"
grep -qF -- '- min' "$SITE" \
  && ok "gather_subset includes 'min' (covers distribution facts)" || bad "gather_subset missing 'min'"
grep -qF -- '- date_time' "$SITE" \
  && ok "gather_subset includes 'date_time' (covers continuum_stamp)" || bad "gather_subset missing 'date_time'"

echo "== site.yml: OS assert still present and unweakened =="
grep -qF "ansible_distribution == 'Ubuntu'" "$SITE" \
  && ok "Ubuntu distribution assert preserved" || bad "Ubuntu distribution assert missing"
grep -qF "ansible_distribution_major_version in ['22', '24']" "$SITE" \
  && ok "Ubuntu 22/24 version assert preserved" || bad "Ubuntu version assert missing"

echo
echo "continuum-role-artifact-path.test.sh: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
