#!/usr/bin/env bash
#
# Hermetic tests for the root-side update-request applier (VERSION-UPDATE-1).
#
# Two halves, no real deploy and no root:
#   1. Pure-function unit cases — source apply-update-request.sh and exercise the
#      tag grammar, JSON field extraction, allowlist policy, pin read, atomic pin
#      rewrite, and the full apply_request state machine against temp dirs.
#   2. Static assertions on the applier, the deploy service ExecStartPre wiring,
#      and the bootstrap install, proving the fail-safe privilege-separation
#      model is wired the way the security review depends on.
#
# Run:  bash ops/test/apply-update-request.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
OPS="${REPO_ROOT}/ops"
APPLIER="${OPS}/apply-update-request.sh"
BOOTSTRAP="${OPS}/deploy-bootstrap.sh"
SERVICE="${OPS}/systemd/torii-continuum-deploy.service"
WRAPPER="${OPS}/deploy-unattended.sh"

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

for f in "$APPLIER" "$BOOTSTRAP" "$SERVICE" "$WRAPPER"; do
  [[ -f "$f" ]] || { bad "missing file: $f"; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# Applier must parse.
bash -n "$APPLIER" && ok "applier passes bash -n" || bad "applier failed bash -n"

# Sourcing must be side-effect free (the CLI dispatcher must be guarded).
# shellcheck disable=SC1090
source "$APPLIER"
ok "applier sources without executing apply (dispatcher guarded)"

# ── 1. Tag grammar mirrors the wrapper exactly ───────────────────────────────
for good in v0.2.69-alpha v1.0.0 v10.20.30-rc.1; do
  req_validate_tag "$good" && ok "accepts valid tag ${good}" || bad "rejected valid tag ${good}"
done
for bad_tag in main HEAD 0.2.69-alpha v0.2 "v0.2.69-alpha; rm -rf /" '$(id)' '../evil' ''; do
  if req_validate_tag "$bad_tag"; then bad "accepted INVALID tag '${bad_tag}'"; else ok "rejects invalid tag '${bad_tag}'"; fi
done

# ── 2. JSON field extraction ─────────────────────────────────────────────────
J='{ "tag": "v0.2.70-alpha", "from_version": "0.2.69-alpha", "requested_by": "npub1x" }'
[[ "$(json_string_field "$J" tag)" == "v0.2.70-alpha" ]] && ok "extracts tag field" || bad "tag extract wrong"
[[ "$(json_string_field "$J" from_version)" == "0.2.69-alpha" ]] && ok "extracts from_version" || bad "from_version extract wrong"
[[ -z "$(json_string_field "$J" nope)" ]] && ok "absent field → empty" || bad "absent field not empty"

# ── 3. Allowlist policy (identical to the wrapper) ───────────────────────────
req_tag_allowed v0.2.70-alpha "" && ok "no allowlist → allowed" || bad "empty allowlist denied"
ALLOW="${TMP}/allow"; printf 'v0.2.70-alpha\nv0.2.71-alpha\n' > "$ALLOW"
req_tag_allowed v0.2.70-alpha "$ALLOW" && ok "listed tag allowed" || bad "listed tag denied"
if req_tag_allowed v9.9.9-alpha "$ALLOW"; then bad "unlisted tag allowed"; else ok "unlisted tag denied"; fi
if req_tag_allowed v0.2.70-alpha "${TMP}/missing"; then bad "missing allowlist allowed (should fail-closed)"; else ok "missing allowlist fails closed"; fi

# ── 4. Pin read + atomic rewrite preserves the rest of the file ──────────────
mkpin() {
  cat > "$1" <<CONF
# comment line
CONTINUUM_TARGET_TAG=${2:-}
CONTINUUM_DOMAIN=example.com
CONTINUUM_REPO=https://github.com/ChiefmonkeyArt/torii-continuum.git
CONF
}
PIN="${TMP}/pin.conf"; mkpin "$PIN" v0.2.68-alpha
[[ "$(current_pin_tag "$PIN")" == "v0.2.68-alpha" ]] && ok "reads current pin tag" || bad "pin tag read wrong"

rewrite_pin_tag "$PIN" v0.2.70-alpha && ok "rewrite_pin_tag succeeds" || bad "rewrite failed"
[[ "$(current_pin_tag "$PIN")" == "v0.2.70-alpha" ]] && ok "pin now targets new tag" || bad "pin not updated"
grep -q '^CONTINUUM_DOMAIN=example.com$' "$PIN" && ok "rewrite preserves other lines" || bad "other lines lost"
grep -q '^# comment line$' "$PIN" && ok "rewrite preserves comments" || bad "comments lost"
# invalid tag never rewrites
if rewrite_pin_tag "$PIN" 'garbage'; then bad "rewrote pin with invalid tag"; else ok "refuses to rewrite with invalid tag"; fi

# key absent → appended
PIN2="${TMP}/pin2.conf"; printf 'CONTINUUM_DOMAIN=example.com\n' > "$PIN2"
rewrite_pin_tag "$PIN2" v0.2.70-alpha && ok "appends key when absent" || bad "append failed"
[[ "$(current_pin_tag "$PIN2")" == "v0.2.70-alpha" ]] && ok "appended key readable" || bad "appended key unreadable"

# ── 5. apply_request state machine ───────────────────────────────────────────
run_apply() { apply_request "$1" "$2" >/dev/null 2>&1; }

# 5a. missing spool → no-op, exit 0, pin unchanged
PINA="${TMP}/a.conf"; mkpin "$PINA" v0.2.68-alpha
run_apply "${TMP}/nope.json" "$PINA" && ok "missing spool is a no-op (exit 0)" || bad "missing spool errored"
[[ "$(current_pin_tag "$PINA")" == "v0.2.68-alpha" ]] && ok "missing spool leaves pin unchanged" || bad "pin changed on missing spool"

# 5b. valid, allowed, newer → pin rewritten + request consumed
REQ="${TMP}/req.json"; printf '{ "tag": "v0.2.70-alpha", "schema": 1 }\n' > "$REQ"
run_apply "$REQ" "$PINA" && ok "valid request applies (exit 0)" || bad "valid apply errored"
[[ "$(current_pin_tag "$PINA")" == "v0.2.70-alpha" ]] && ok "valid request rewrites the pin" || bad "valid request did not rewrite pin"
[[ ! -f "$REQ" ]] && ok "valid request is consumed" || bad "valid request not consumed"

# 5c. invalid-tag request → discarded, pin unchanged
PINB="${TMP}/b.conf"; mkpin "$PINB" v0.2.68-alpha
REQB="${TMP}/reqb.json"; printf '{ "tag": "main; rm -rf /" }\n' > "$REQB"
run_apply "$REQB" "$PINB" && ok "invalid-tag request does not block (exit 0)" || bad "invalid-tag request errored"
[[ "$(current_pin_tag "$PINB")" == "v0.2.68-alpha" ]] && ok "invalid-tag request leaves pin unchanged" || bad "invalid-tag request changed pin"
[[ ! -f "$REQB" ]] && ok "invalid-tag request is discarded" || bad "invalid-tag request not discarded"

# 5d. unlisted tag with a configured allowlist → discarded, pin unchanged
PINC="${TMP}/c.conf"
cat > "$PINC" <<CONF
CONTINUUM_TARGET_TAG=v0.2.68-alpha
CONTINUUM_ALLOWLIST_FILE=${ALLOW}
CONF
REQC="${TMP}/reqc.json"; printf '{ "tag": "v9.9.9-alpha" }\n' > "$REQC"
run_apply "$REQC" "$PINC" && ok "unlisted tag does not block (exit 0)" || bad "unlisted tag errored"
[[ "$(current_pin_tag "$PINC")" == "v0.2.68-alpha" ]] && ok "unlisted tag leaves pin unchanged" || bad "unlisted tag changed pin"
[[ ! -f "$REQC" ]] && ok "unlisted tag request discarded" || bad "unlisted request not discarded"

# 5e. request equal to current pin → consumed, no rewrite churn
PIND="${TMP}/d.conf"; mkpin "$PIND" v0.2.70-alpha
REQD="${TMP}/reqd.json"; printf '{ "tag": "v0.2.70-alpha" }\n' > "$REQD"
run_apply "$REQD" "$PIND" && ok "same-tag request is a no-op (exit 0)" || bad "same-tag errored"
[[ ! -f "$REQD" ]] && ok "same-tag request consumed" || bad "same-tag request not consumed"

# 5f. corrupt/empty request → discarded
PINE="${TMP}/e.conf"; mkpin "$PINE" v0.2.68-alpha
REQE="${TMP}/reqe.json"; printf '' > "$REQE"
run_apply "$REQE" "$PINE" && ok "empty request does not block" || bad "empty request errored"
[[ ! -f "$REQE" ]] && ok "empty request discarded" || bad "empty request not discarded"

# ── 6. Static wiring assertions ──────────────────────────────────────────────
grep -q '^ExecStartPre=-/usr/local/sbin/torii-continuum-update-apply$' "$SERVICE" \
  && ok "deploy service wires ExecStartPre applier (fail-safe '-' prefix)" || bad "service missing ExecStartPre applier"
grep -q 'ExecStart=/usr/local/sbin/torii-continuum-deploy' "$SERVICE" \
  && ok "deploy service still runs the wrapper" || bad "service lost ExecStart wrapper"
grep -q 'torii-continuum-update-apply' "$BOOTSTRAP" \
  && ok "bootstrap installs the applier" || bad "bootstrap does not install the applier"
grep -q 'bash -n "\$APPLIER_SRC"' "$BOOTSTRAP" \
  && ok "bootstrap syntax-checks the applier before install" || bad "bootstrap does not syntax-check applier"

# Grammar mirror: the applier RE must equal the wrapper's CONTINUUM_TAG_RE.
appre="$(grep -m1 "CONTINUUM_TAG_RE='" "$APPLIER")"
wrapre="$(grep -m1 "CONTINUUM_TAG_RE='" "$WRAPPER")"
[[ "$appre" == "$wrapre" ]] && ok "applier tag grammar mirrors the wrapper byte-for-byte" || bad "tag grammar drift between applier and wrapper"

# The applier must NEVER exec code or touch secrets: no ansible/curl/eval/source-of-request.
if grep -Eq 'ansible-playbook|eval |source .*update-request' "$APPLIER"; then
  bad "applier appears to exec/deploy — it must only rewrite the pin"
else
  ok "applier never execs a deploy (only rewrites the pin)"
fi

printf '\n[apply-update-request] %d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
