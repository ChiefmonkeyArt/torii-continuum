#!/usr/bin/env bash
#
# Torii Continuum Agent — standalone installer (SUITE-VPS-READY-2)
#
# Installs / upgrades the agent as a hardened systemd service running under a
# locked `continuum` system user from /opt/torii/continuum-agent, wires an
# optional nginx same-origin /api/ proxy, and proves liveness against
# /api/health.
#
# Design goals:
#   - Idempotent + rerunnable: safe to run again to upgrade code or re-assert
#     ownership/permissions. Never clobbers persistent state (memory/) or an
#     existing config.yaml.
#   - Fail safe: strict mode, root required, every external step checked. A
#     partial run leaves a rerunnable box, never a half-broken one.
#   - Privacy: no hostnames, device names, secrets, or npubs are printed. The
#     generated session_secret is written straight to a 0600 file, never echoed.
#
# Usage:
#   sudo ./ops/install-agent.sh
#   sudo TORII_NGINX_SITE=/etc/nginx/sites-available/torii ./ops/install-agent.sh
#
# Environment overrides (all optional):
#   TORII_NGINX_SITE   path to an nginx server-block file to auto-wire the
#                      `include snippets/torii-api.conf;` line into. Omit to
#                      install the snippet but wire it manually (see ops/README.md).
#   SKIP_NGINX=1       skip all nginx steps (agent + systemd only).
#   SKIP_HEALTHCHECK=1 skip the final /api/health probe (e.g. air-gapped test).

set -euo pipefail
IFS=$'\n\t'
umask 077

# ── Constants ───────────────────────────────────────────────────────────────
readonly SERVICE_USER="continuum"
readonly INSTALL_DIR="/opt/torii/continuum-agent"
readonly SERVICE_NAME="torii-continuum-agent"
readonly SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
readonly NGINX_SNIPPET="/etc/nginx/snippets/torii-api.conf"
readonly NGINX_ZONE_CONF="/etc/nginx/conf.d/torii-api-ratelimit.conf"
readonly NGINX_ZONE_NAME="torii_api_limit"
readonly AGENT_HOST="127.0.0.1"
readonly AGENT_PORT="8787"

# Resolve repo layout from this script's location: ops/install-agent.sh →
# repo root is the parent, agent sources live in <root>/agent.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
readonly AGENT_SRC="${REPO_ROOT}/agent"

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARN: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────
[[ ${EUID} -eq 0 ]] || die "must run as root (try: sudo $0)"

for bin in node npm rsync install openssl systemctl getent; do
  command -v "$bin" >/dev/null 2>&1 || die "required command not found: $bin"
done

[[ -d "$AGENT_SRC" ]] || die "agent sources not found at $AGENT_SRC"
[[ -f "${AGENT_SRC}/index.mjs" ]] || die "agent/index.mjs missing — is this the repo checkout?"
[[ -f "${AGENT_SRC}/config.example.yaml" ]] || die "agent/config.example.yaml missing"

node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[[ "$node_major" -ge 20 ]] || die "Node >= 20 required (found $(node --version))"

# ── 1. Locked system user/group ─────────────────────────────────────────────
if getent group "$SERVICE_USER" >/dev/null 2>&1; then
  log "group $SERVICE_USER exists"
else
  log "creating group $SERVICE_USER"
  groupadd --system "$SERVICE_USER"
fi

if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  log "user $SERVICE_USER exists"
else
  log "creating locked non-login user $SERVICE_USER"
  useradd --system \
    --gid "$SERVICE_USER" \
    --home-dir "$INSTALL_DIR" \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$SERVICE_USER"
fi
# Assert the account can never be used for interactive login, regardless of
# how it was originally created. `passwd -l` is idempotent.
usermod --lock "$SERVICE_USER" >/dev/null 2>&1 || true
usermod --shell /usr/sbin/nologin "$SERVICE_USER" >/dev/null 2>&1 || true

# ── 2. Directory + code sync ────────────────────────────────────────────────
log "ensuring install dir $INSTALL_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /opt/torii
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"

# Persistent runtime state — created if absent, never wiped on re-run.
for d in memory memory/wallet pending ciphertexts; do
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "${INSTALL_DIR}/${d}"
done

# Sync code. --delete keeps the tree clean of removed files, but every
# persistent path and the live config.yaml are excluded so an upgrade never
# touches operator state. Source has no config.yaml (gitignored) so it can't
# clobber, but we exclude it explicitly as defence in depth.
log "syncing agent code → $INSTALL_DIR"
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='config.yaml' \
  --exclude='memory/' \
  --exclude='pending/' \
  --exclude='ciphertexts/' \
  "${AGENT_SRC}/" "${INSTALL_DIR}/"

# ── 3. Ownership + permissions ──────────────────────────────────────────────
log "setting ownership + permissions"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
chmod 0750 "$INSTALL_DIR"

# ── 4. Production dependencies ──────────────────────────────────────────────
log "installing production dependencies (npm ci --omit=dev)"
if [[ -f "${INSTALL_DIR}/package-lock.json" ]]; then
  runuser -u "$SERVICE_USER" -- \
    env HOME="$INSTALL_DIR" npm --prefix "$INSTALL_DIR" ci --omit=dev
else
  die "package-lock.json missing in $INSTALL_DIR — cannot npm ci"
fi

# ── 5. Config generation (idempotent; never clobbers) ───────────────────────
CONFIG_PATH="${INSTALL_DIR}/config.yaml"
if [[ -f "$CONFIG_PATH" ]]; then
  log "config.yaml exists — preserving it (no changes)"
else
  log "generating config.yaml from config.example.yaml"
  secret="$(openssl rand -hex 32)"
  # Build atomically in a private temp file, then move into place 0600.
  tmp_cfg="$(mktemp "${INSTALL_DIR}/.config.yaml.XXXXXX")"
  # Ensure cleanup of the temp file on any early exit.
  trap 'rm -f -- "$tmp_cfg"' EXIT
  # Replace the two placeholders. Use a non-/ sed delimiter and a variable
  # (never interpolate the secret into the pattern) so nothing is logged and
  # no shell/sed metacharacter can be injected — the hex secret is [0-9a-f].
  sed \
    -e 's|^session_secret:.*$|session_secret: "__TORII_SECRET__"|' \
    -e 's|^admin_npub:.*$|admin_npub: ""|' \
    "${INSTALL_DIR}/config.example.yaml" > "$tmp_cfg"
  # Swap the sentinel for the real secret with a literal, injection-proof
  # replacement (awk gsub of a fixed string), keeping the secret out of argv
  # visible patterns.
  TORII_SECRET="$secret" awk '
    { gsub(/__TORII_SECRET__/, ENVIRON["TORII_SECRET"]); print }
  ' "$tmp_cfg" > "${tmp_cfg}.2"
  mv -f "${tmp_cfg}.2" "$tmp_cfg"
  chown "$SERVICE_USER":"$SERVICE_USER" "$tmp_cfg"
  chmod 0600 "$tmp_cfg"
  mv -f "$tmp_cfg" "$CONFIG_PATH"
  trap - EXIT
  unset secret TORII_SECRET
  log "config.yaml created (admin_npub empty → first-touch claim armed)"
fi
# Re-assert secure mode/ownership on every run.
chown "$SERVICE_USER":"$SERVICE_USER" "$CONFIG_PATH"
chmod 0600 "$CONFIG_PATH"

# Validate the config actually parses + boots the loader's invariants without
# starting the server. Fails safe before we (re)start the service.
log "validating config"
runuser -u "$SERVICE_USER" -- node -e '
  import("'"${INSTALL_DIR}"'/core/config.mjs").then(m => {
    m.loadConfig("'"${CONFIG_PATH}"'");
    console.log("[install] config OK");
  }).catch(e => { console.error(e); process.exit(1); });
' || die "config validation failed — not touching the running service"

# ── 6. systemd unit ─────────────────────────────────────────────────────────
log "installing systemd unit → $SYSTEMD_UNIT"
install -m 0644 -o root -g root \
  "${SCRIPT_DIR}/systemd/${SERVICE_NAME}.service" "$SYSTEMD_UNIT"

# ── 7. nginx snippets (optional) ─────────────────────────────────────────────
if [[ "${SKIP_NGINX:-0}" == "1" ]]; then
  log "SKIP_NGINX=1 — skipping nginx wiring"
elif ! command -v nginx >/dev/null 2>&1; then
  warn "nginx not installed — skipping nginx wiring (agent still installed)"
else
  install -d -m 0755 /etc/nginx/snippets /etc/nginx/conf.d
  log "installing nginx location snippet → $NGINX_SNIPPET"
  install -m 0644 -o root -g root "${SCRIPT_DIR}/nginx/torii-api.conf" "$NGINX_SNIPPET"

  # http-context rate-limit zone. Only write it if no zone of the same name is
  # already declared anywhere under /etc/nginx — declaring a duplicate zone is
  # a hard nginx -t error, so we refuse to conflict.
  if grep -rqsa "zone=${NGINX_ZONE_NAME}" /etc/nginx 2>/dev/null; then
    log "rate-limit zone ${NGINX_ZONE_NAME} already declared — leaving it as is"
  else
    log "installing rate-limit zone → $NGINX_ZONE_CONF"
    cat > "$NGINX_ZONE_CONF" <<EOF
# Torii Continuum agent — http-context rate-limit zone (defence in depth).
# Managed by ops/install-agent.sh. Consumed by snippets/torii-api.conf.
limit_req_zone \$binary_remote_addr zone=${NGINX_ZONE_NAME}:10m rate=30r/s;
limit_req_status 429;
EOF
    chmod 0644 "$NGINX_ZONE_CONF"
  fi

  # Optionally wire the include into a server block the operator names.
  if [[ -n "${TORII_NGINX_SITE:-}" ]]; then
    [[ -f "$TORII_NGINX_SITE" ]] || die "TORII_NGINX_SITE not found: $TORII_NGINX_SITE"
    if grep -qs 'include snippets/torii-api.conf;' "$TORII_NGINX_SITE"; then
      log "include already present in $(basename "$TORII_NGINX_SITE")"
    else
      # Insert before the LAST closing brace (assumed to end the server block).
      # Guarded by the grep above so re-runs don't duplicate it.
      log "wiring include into $(basename "$TORII_NGINX_SITE")"
      cp -a "$TORII_NGINX_SITE" "${TORII_NGINX_SITE}.torii.bak"
      awk '
        { lines[NR] = $0 }
        END {
          for (i = NR; i >= 1; i--) if (lines[i] ~ /}/) { last = i; break }
          for (i = 1; i <= NR; i++) {
            if (i == last) print "    include snippets/torii-api.conf;"
            print lines[i]
          }
        }
      ' "${TORII_NGINX_SITE}.torii.bak" > "$TORII_NGINX_SITE"
    fi
  else
    log "no TORII_NGINX_SITE given — snippet installed but not wired."
    log "add this inside your gateway's server{} block: include snippets/torii-api.conf;"
  fi

  # Always validate before reloading. Never reload a broken config.
  log "running nginx -t"
  if nginx -t; then
    log "nginx config OK — reloading"
    systemctl reload nginx || warn "nginx reload failed (is it running?)"
  else
    warn "nginx -t FAILED — not reloading. Review the include/zone above."
    [[ -n "${TORII_NGINX_SITE:-}" && -f "${TORII_NGINX_SITE}.torii.bak" ]] && \
      warn "a backup of your site file is at ${TORII_NGINX_SITE}.torii.bak"
  fi
fi

# ── 8. Enable + (re)start the service ────────────────────────────────────────
log "reloading systemd + enabling service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

# ── 9. Health proof (bounded retry) ──────────────────────────────────────────
if [[ "${SKIP_HEALTHCHECK:-0}" == "1" ]]; then
  log "SKIP_HEALTHCHECK=1 — not probing /api/health"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl not found — skipping health probe (agent still installed/started)"
else
  log "probing http://${AGENT_HOST}:${AGENT_PORT}/api/health"
  healthy=0
  for attempt in $(seq 1 15); do
    if curl -sf "http://${AGENT_HOST}:${AGENT_PORT}/api/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [[ "$healthy" -eq 1 ]]; then
    log "agent healthy ✓"
  else
    warn "agent did not answer /api/health within ~30s"
    warn "inspect: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    die "install completed but health check failed"
  fi
fi

log "done. Service: systemctl status ${SERVICE_NAME}"
log "logs:      journalctl -u ${SERVICE_NAME} -f"
