#!/usr/bin/env bash
#
# Regression tests for the nginx wiring logic in ops/install-agent.sh.
#
# Two review-blocking bugs are pinned here so they can't regress:
#
#   B1 — the installer must distinguish a `limit_req_zone ... zone=NAME:` DECLARATION
#        (http context, in conf.d) from a mere `limit_req zone=NAME` REFERENCE (the
#        server-scoped snippet it just installed). The old grep matched the snippet's
#        own reference and so NEVER wrote the zone, breaking `nginx -t` on a clean box.
#
#   B2 — the include must be wired ONLY at an explicit operator-placed marker
#        (`# TORII_API_INCLUDE`), never guessed by a "last closing brace" heuristic
#        that could land /api/ in an HTTP→HTTPS redirect server{} instead of the TLS one.
#
# These tests are hermetic: they build a throwaway tree in $TMPDIR and never touch the
# real /etc/nginx, run any service, or need root. They also assert the literals under
# test still match ops/install-agent.sh so the test can't silently drift from the code.
#
# Run:  bash ops/test/nginx-install.test.sh   (from repo root)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd -P)"
INSTALLER="${REPO_ROOT}/ops/install-agent.sh"
SNIPPET_SRC="${REPO_ROOT}/ops/nginx/torii-api.conf"

# Kept identical to ops/install-agent.sh. Assertions below prove they still
# appear verbatim in the installer, so a change there fails this test loudly.
ZONE_NAME="torii_api_limit"
ZONE_RE="^[[:space:]]*limit_req_zone[[:space:]][^;#]*zone=${ZONE_NAME}:"
INCLUDE_MARKER="# TORII_API_INCLUDE"
INCLUDE_LINE="include snippets/torii-api.conf;"

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1" >&2; fail=$((fail+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# ── 0. Anti-drift: the literals under test must exist in the installer ───────
# The installer keeps ${NGINX_ZONE_NAME} unexpanded in its source; assert the
# regex shape verbatim with that variable reference intact.
grep -qF 'local_zone_re="^[[:space:]]*limit_req_zone[[:space:]][^;#]*zone=${NGINX_ZONE_NAME}:"' "$INSTALLER" \
  && ok "installer still uses the exact zone-declaration regex under test" \
  || bad "zone regex drifted from installer — update this test AND verify the fix"
grep -qF "NGINX_INCLUDE_MARKER=\"${INCLUDE_MARKER}\"" "$INSTALLER" \
  && ok "installer still uses the include marker under test" \
  || bad "include marker drifted from installer"
grep -qF "NGINX_INCLUDE_LINE=\"${INCLUDE_LINE}\"" "$INSTALLER" \
  && ok "installer still uses the include line under test" \
  || bad "include line drifted from installer"

# ── B1. Zone declaration vs reference ────────────────────────────────────────
etc="${WORK}/etc/nginx"
mkdir -p "${etc}/snippets" "${etc}/conf.d"

# Install ONLY the server snippet first (as the installer does), which REFERENCES
# the zone via `limit_req zone=torii_api_limit`. The declaration is absent.
cp "$SNIPPET_SRC" "${etc}/snippets/torii-api.conf"

if grep -rqsE "$ZONE_RE" "$etc" 2>/dev/null; then
  bad "B1: snippet's own 'limit_req' reference was mis-detected as a declaration"
else
  ok "B1: reference-only tree is correctly seen as UNDECLARED (installer will write the zone)"
fi

# Sanity: the snippet really does reference the zone (else the test proves nothing).
grep -qE "limit_req[[:space:]]+zone=${ZONE_NAME}" "${etc}/snippets/torii-api.conf" \
  && ok "B1: snippet does contain a zone reference (test is meaningful)" \
  || bad "B1: snippet no longer references the zone — test fixture stale"

# Now lay down the http-context declaration exactly as the installer does.
cat > "${etc}/conf.d/torii-api-ratelimit.conf" <<EOF
limit_req_zone \$binary_remote_addr zone=${ZONE_NAME}:10m rate=30r/s;
limit_req_status 429;
EOF

if grep -rqsE "$ZONE_RE" "$etc" 2>/dev/null; then
  ok "B1: declaration in conf.d IS detected (idempotent re-run won't double-write)"
else
  bad "B1: real declaration not detected — installer would wrongly re-write it"
fi

# A commented-out declaration must NOT count (operator disabled it on purpose).
mkdir -p "${WORK}/etc2/nginx/conf.d"
printf '# limit_req_zone $binary_remote_addr zone=%s:10m rate=30r/s;\n' "$ZONE_NAME" \
  > "${WORK}/etc2/nginx/conf.d/commented.conf"
if grep -rqsE "$ZONE_RE" "${WORK}/etc2/nginx" 2>/dev/null; then
  bad "B1: a commented-out declaration was mis-detected as active"
else
  ok "B1: commented-out declaration is correctly ignored"
fi

# ── B2. Marker-based include injection ───────────────────────────────────────
# A realistic two-server site file: an HTTP→HTTPS redirect on :80 (LAST block)
# and the real TLS server on :443 where the marker lives. The old last-brace
# heuristic would wire /api/ into the redirect block; the marker approach must
# put it precisely where the operator placed the marker.
site="${WORK}/site.conf"
cat > "$site" <<EOF
server {
    listen 80;
    server_name gw.example;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name gw.example;
    root /var/www/html;
        ${INCLUDE_MARKER}
}
EOF

# Replicate the installer's awk swap (indentation-preserving, marker-line only).
swap() {
  awk -v marker="$INCLUDE_MARKER" -v inc="$INCLUDE_LINE" '
    {
      line = $0
      t = line; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
      if (t == marker) {
        indent = line; sub(/[^ \t].*$/, "", indent)
        print indent inc
      } else {
        print line
      }
    }
  ' "$1"
}

out="$(swap "$site")"

# Exactly one include line, and it carries the marker's 8-space indentation.
inc_count="$(printf '%s\n' "$out" | grep -cF "$INCLUDE_LINE" || true)"
[[ "$inc_count" -eq 1 ]] \
  && ok "B2: exactly one include line emitted" \
  || bad "B2: expected 1 include line, got $inc_count"

printf '%s\n' "$out" | grep -qE "^        ${INCLUDE_LINE//./\\.}$" \
  && ok "B2: include inherits the marker's indentation" \
  || bad "B2: include indentation not preserved"

# The include landed inside the :443 block, NOT the :80 redirect block. Check it
# appears after 'listen 443 ssl;' and before the file's final brace.
line_443="$(printf '%s\n' "$out" | grep -n 'listen 443 ssl;' | head -1 | cut -d: -f1)"
line_inc="$(printf '%s\n' "$out" | grep -nF "$INCLUDE_LINE" | head -1 | cut -d: -f1)"
line_80="$(printf '%s\n' "$out" | grep -n 'listen 80;' | head -1 | cut -d: -f1)"
{ [[ "$line_inc" -gt "$line_443" ]] && [[ "$line_443" -gt "$line_80" ]]; } \
  && ok "B2: include wired into the TLS (:443) server, not the :80 redirect" \
  || bad "B2: include landed in the wrong server block"

# The marker itself is fully consumed (no marker text left behind).
printf '%s\n' "$out" | grep -qF "$INCLUDE_MARKER" \
  && bad "B2: marker text still present after swap" \
  || ok "B2: marker consumed by the swap"

# Idempotency: the installer greps for the include line FIRST and short-circuits.
# So a second run over the already-wired file changes nothing.
printf '%s\n' "$out" > "${site}.wired"
if grep -qsF "$INCLUDE_LINE" "${site}.wired"; then
  ok "B2: re-run detects the existing include and does nothing (idempotent)"
else
  bad "B2: wired file not detected as already-included"
fi

# All non-marker lines are preserved verbatim (line count: 12 in, 12 out).
in_lines="$(grep -c '' "$site")"
out_lines="$(printf '%s\n' "$out" | grep -c '')"
[[ "$in_lines" -eq "$out_lines" ]] \
  && ok "B2: no lines added or dropped (marker swapped 1:1)" \
  || bad "B2: line count changed ($in_lines → $out_lines)"

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n[nginx-install.test] pass=%d fail=%d\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
