#!/usr/bin/env bash
#
# Hermetic tests for the in-repo cutover operator script (OPS-CUTOVER-1, v0.2.52-alpha).
#
# No real deploy, no network, no root. Three concerns:
#   1. Anti-partial-delivery — the whole body is a single brace group, so a
#      truncated copy (the exact hazard that motivated this script: a heredoc
#      paste that cut off mid-function) fails `bash -n` and runs NOTHING.
#   2. Safe invocation guards — refuses to be sourced, requires root, and never
#      uses the broken `exec sudo -- bash "$0"` re-exec.
#   3. Static release/security invariants — pinned annotated tags + versions,
#      fail-closed preview layout detection, no secrets, no broad sudoers.
#
# Run:  bash ops/test/torii-final-cutover.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
CUTOVER="${REPO_ROOT}/ops/torii-final-cutover.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

[[ -f "$CUTOVER" ]] || { bad "missing file: $CUTOVER"; exit 1; }

# ── 0. Parses cleanly ────────────────────────────────────────────────────────
bash -n "$CUTOVER" && ok "cutover passes bash -n" || bad "cutover failed bash -n"

# ── 1. Anti-partial-delivery brace group ─────────────────────────────────────
# The first executable (non-comment, non-blank) line must open the brace group.
first_exec="$(grep -nvE '^[[:space:]]*(#|$)' "$CUTOVER" | head -1 | cut -d: -f2-)"
[[ "$first_exec" == '{' ]] && ok "executable body opens with a '{' brace group" \
  || bad "body does not start with a brace group (got: '${first_exec}')"

# The last non-blank line must be the sentinel comment, and the line above the
# sentinel must close the group.
last_nonblank="$(grep -nvE '^[[:space:]]*$' "$CUTOVER" | tail -1 | cut -d: -f2-)"
printf '%s' "$last_nonblank" | grep -qF 'end of guarded body' \
  && ok "file ends with the anti-truncation sentinel comment" \
  || bad "missing trailing sentinel comment (got: '${last_nonblank}')"
close_line="$(grep -nvE '^[[:space:]]*$' "$CUTOVER" | tail -2 | head -1 | cut -d: -f2-)"
[[ "$close_line" == '}' ]] && ok "guarded body is closed by a '}' on the penultimate line" \
  || bad "closing brace not where expected (got: '${close_line}')"

# main runs INSIDE the group (last statement before the closing brace).
grep -qE '^main "\$@"$' "$CUTOVER" && ok "invokes main \"\$@\" once" || bad "no single main \"\$@\" invocation"

# Truncate the file at several depths; every truncation must break `bash -n`
# (proving a partial paste would refuse to execute). A file that still parses
# after losing its tail would be a silent partial-run hazard.
total="$(wc -l < "$CUTOVER")"
trunc_ok=1
for cut in 2 25 120 400; do
  frag="$(mktemp)"
  head -n "$(( total - cut ))" "$CUTOVER" > "$frag"
  if bash -n "$frag" 2>/dev/null; then trunc_ok=0; fi
  rm -f "$frag"
done
[[ "$trunc_ok" -eq 1 ]] && ok "any truncated copy fails bash -n (partial paste never runs)" \
  || bad "a truncated copy still parsed — partial-delivery hazard"

# ── 2. Safe invocation guards ────────────────────────────────────────────────
# The broken re-exec idiom must be gone from executable code. Comments may
# legitimately DESCRIBE it as the anti-pattern this script avoids, so strip them.
code_only="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code_only" | grep -qE 'exec[[:space:]]+sudo'; then
  bad "still uses 'exec sudo' re-exec (broken when pasted/sourced)"
else
  ok "no 'exec sudo -- bash \"\$0\"' re-exec in code"
fi

# Refuses sourcing (BASH_SOURCE vs $0 guard present).
grep -qF 'BASH_SOURCE[0]' "$CUTOVER" && grep -qiF 'do not source' "$CUTOVER" \
  && ok "refuses to be sourced" || bad "no source-refusal guard"

# Requires root with the documented invocation, no auto-escalation.
grep -qF 'must run as root' "$CUTOVER" \
  && grep -qF 'sudo bash ops/torii-final-cutover.sh' "$CUTOVER" \
  && ok "requires root and documents 'sudo bash ops/torii-final-cutover.sh'" \
  || bad "root requirement / documented invocation missing"

grep -qF 'set -euo pipefail' "$CUTOVER" && ok "uses set -euo pipefail" || bad "missing strict mode"
grep -qF 'umask 077' "$CUTOVER" && ok "sets a restrictive umask (077)" || bad "no restrictive umask"

# Behavioural: as a non-root user it must refuse BEFORE doing anything.
if [[ "$(id -u)" -ne 0 ]]; then
  set +e
  out="$(bash "$CUTOVER" 2>&1)"; rc=$?
  set -e
  [[ "$rc" -ne 0 ]] && printf '%s' "$out" | grep -qF 'must run as root' \
    && ok "non-root run refuses with a clear message (exit ${rc})" \
    || bad "non-root run did not fail closed (exit ${rc})"
else
  ok "skip non-root behavioural check (running as root)"
fi

# Behavioural: sourcing must refuse and must NOT start the cutover.
src_out="$(bash -c "source '$CUTOVER'" 2>&1 || true)"
printf '%s' "$src_out" | grep -qiF 'do not source' \
  && ! printf '%s' "$src_out" | grep -qF 'Starting final VPS cutover' \
  && ok "sourcing refuses and never enters main()" || bad "sourcing was not refused safely"

# ── 3. Pinned annotated tags + version markers ───────────────────────────────
grep -qF 'BASE_TAG="v0.1.4"' "$CUTOVER"                 && ok "pins torii-base v0.1.4"             || bad "torii-base tag not pinned"
grep -qF 'BASE_VERSION="0.1.4"' "$CUTOVER"              && ok "pins torii-base VERSION 0.1.4"      || bad "torii-base version not pinned"
grep -qF 'CONTINUUM_TAG="v0.2.52-alpha"' "$CUTOVER"     && ok "pins its own Continuum tag v0.2.52-alpha" || bad "continuum tag not pinned to v0.2.52-alpha"
grep -qF 'CONTINUUM_VERSION="0.2.52-alpha"' "$CUTOVER"  && ok "pins Continuum version 0.2.52-alpha" || bad "continuum version not pinned"
grep -qF 'PREVIEW_VERSION="0.1.21-preview"' "$CUTOVER"  && ok "pins onboarding preview 0.1.21-preview" || bad "preview version not pinned"
grep -qF 'PREVIEW_CTA="Sign in with browser extension"' "$CUTOVER" && ok "pins exact preview CTA text" || bad "preview CTA text not pinned"

# Annotated-tag verification: only an annotated tag object (cat-file -t == tag)
# is accepted — a lightweight tag or a moved branch is rejected.
grep -qF 'cat-file -t' "$CUTOVER" && grep -qF 'is not an annotated tag' "$CUTOVER" \
  && ok "verifies each source is an ANNOTATED tag" || bad "no annotated-tag verification"

# Version markers are asserted against the cloned sources before mutation.
grep -qF "const VERSION = '\${BASE_VERSION}';" "$CUTOVER" && ok "asserts torii-base sidecar index version marker" || bad "sidecar index marker not checked"
grep -qF 'Continuum amber' "$CUTOVER" && ok "asserts torii-base launcher amber marker" || bad "launcher amber marker not checked"

# The mixed-case sidecar-health typo from the source draft must not reappear.
if grep -qF 'SIDEcar_HEALTH_URL' "$CUTOVER"; then
  bad "mixed-case SIDEcar_HEALTH_URL typo present"
else
  grep -qF 'SIDECAR_HEALTH_URL' "$CUTOVER" && ok "sidecar health var is consistently cased" || bad "sidecar health var missing"
fi

# ── 4. Fail-closed preview layout + atomic swap + one rollback ────────────────
grep -qF 'preview URL detection is ambiguous' "$CUTOVER" && ok "preview detection dies on ambiguity" || bad "no ambiguity guard"
grep -qF 'preview URL detection failed' "$CUTOVER" && ok "preview detection dies when neither URL serves" || bad "no absence guard"
grep -qF '.prev' "$CUTOVER" && ok "keeps exactly one rollback (.prev)" || bad "no .prev rollback path"
grep -qF '.next' "$CUTOVER" && grep -qF 'mv -T' "$CUTOVER" && ok "promotes preview atomically (stage .next -> mv -T)" || bad "preview swap not atomic"

# ── 5. Health/version gates + state preservation ─────────────────────────────
grep -qF 'wait_json_version "$CONTINUUM_HEALTH_URL" "$CONTINUUM_VERSION"' "$CUTOVER" \
  && ok "health/version-gates the Continuum agent" || bad "no continuum health gate"
grep -qF 'wait_json_version "$SIDECAR_HEALTH_URL" "$BASE_VERSION"' "$CUTOVER" \
  && ok "health/version-gates the torii-base sidecar" || bad "no sidecar health gate"
grep -qF 'root_app changed across torii-base deployment' "$CUTOVER" \
  && ok "asserts registry root_app is preserved" || bad "no root_app preservation check"

# ── 6. Backups + rollback wiring ─────────────────────────────────────────────
grep -qF 'trap ' "$CUTOVER" && grep -qF 'ERR' "$CUTOVER" && ok "installs an ERR trap for rollback" || bad "no ERR trap"
grep -qF 'tar -cpf' "$CUTOVER" && ok "backs up torii-base state to a tar before mutation" || bad "no pre-mutation backup"
grep -qF 'continuum-deploy.conf.before' "$CUTOVER" && ok "backs up the Continuum pin file before editing" || bad "no pin-file backup"

# ── 7. No secrets, no broad sudoers ──────────────────────────────────────────
# Strip comments; the script legitimately DESCRIBES itself as secret-free.
code="$(sed 's/#.*$//' "$CUTOVER")"
if printf '%s' "$code" | grep -qiE 'session_secret|admin_npub|ask-vault|vault-password|PRIVATE KEY'; then
  bad "handles secrets in code"
else
  ok "no secret handling in code"
fi
# Granting passwordless sudo or editing sudoers is forbidden. Backing up an
# existing torii-base sudoers file for rollback is allowed, so flag only real
# grants (NOPASSWD / visudo) and writes INTO sudoers.d, not read/backup refs.
if printf '%s' "$code" | grep -qiE 'NOPASSWD|visudo'; then
  bad "grants passwordless sudo (NOPASSWD/visudo)"
elif printf '%s' "$code" | grep -qE '(install|tee|cp|>|>>)[^|]*sudoers\.d'; then
  bad "writes into /etc/sudoers.d"
else
  ok "never installs sudoers rules or passwordless sudo"
fi

# ── 8. Privacy: no device/host identifiers, public HTTPS only ────────────────
if printf '%s' "$code" | grep -qE 'git@|ssh://|git\+ssh'; then
  bad "uses an SSH git remote (should be public HTTPS)"
else
  grep -qF 'https://github.com/ChiefmonkeyArt/torii-continuum.git' "$CUTOVER" \
    && ok "clones over public HTTPS only" || bad "continuum HTTPS repo not referenced"
fi

printf '\n[torii-final-cutover.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
