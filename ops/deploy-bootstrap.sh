#!/usr/bin/env bash
#
# Torii Continuum — one-time unattended-deploy bootstrap (OPS-DEPLOY-2, v0.2.50-alpha).
#
# Idempotent, fail-closed installer for the SERVER-SIDE PULL deploy mechanism.
# Run ONCE on the VPS (interactively — the box's SSH prompts for a password, but
# this is the only time you need it). It lays down:
#
#   /usr/local/sbin/torii-continuum-deploy         the root-owned deploy wrapper (0755)
#   /etc/systemd/system/torii-continuum-deploy.{service,timer}
#   /etc/torii/continuum-deploy.conf               root-owned pin file (0600), skeleton
#
# After this, releasing a version is a ROOT-ONLY edit of the pin file
# (CONTINUUM_TARGET_TAG=vX.Y.Z-alpha); the timer picks it up within ~5 min and
# the wrapper delegates to the hardened Ansible role. No SSH in the deploy loop.
#
# Optional flags:
#   --with-remote-principal[=NAME]  create a locked, non-login deploy user
#                                   (default: toriideploy) + install the scoped
#                                   NOPASSWD-on-just-the-wrapper sudoers rule,
#                                   for a remote/CI TRIGGER path.
#   --with-ssh-key                  (implies --with-remote-principal) generate a
#                                   dedicated ed25519 key for the principal and
#                                   print the pubkey + host-key pinning guidance.
#   --no-enable-timer               install the timer but do not enable it.
#
# The unattended deploy itself is a no-op until you set CONTINUUM_TARGET_TAG and
# CONTINUUM_DOMAIN in the pin file, so enabling the timer up-front is safe.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

WRAPPER_SRC="${SCRIPT_DIR}/deploy-unattended.sh"
APPLIER_SRC="${SCRIPT_DIR}/apply-update-request.sh"
SERVICE_SRC="${SCRIPT_DIR}/systemd/torii-continuum-deploy.service"
TIMER_SRC="${SCRIPT_DIR}/systemd/torii-continuum-deploy.timer"
SUDOERS_SRC="${SCRIPT_DIR}/sudoers/torii-continuum-deploy.example"

WRAPPER_DST="/usr/local/sbin/torii-continuum-deploy"
APPLIER_DST="/usr/local/sbin/torii-continuum-update-apply"
UNIT_DIR="/etc/systemd/system"
CONF_DIR="/etc/torii"
CONF_FILE="${CONF_DIR}/continuum-deploy.conf"

PRINCIPAL=""
WITH_SSH_KEY=0
ENABLE_TIMER=1

log()  { printf '[deploy-bootstrap] %s\n' "$*"; }
die()  { printf '[deploy-bootstrap] FATAL: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --with-remote-principal)     PRINCIPAL="toriideploy" ;;
    --with-remote-principal=*)   PRINCIPAL="${arg#*=}" ;;
    --with-ssh-key)              WITH_SSH_KEY=1; [[ -n "$PRINCIPAL" ]] || PRINCIPAL="toriideploy" ;;
    --no-enable-timer)           ENABLE_TIMER=0 ;;
    -h|--help)                   grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                           die "unknown flag: ${arg}" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "run as root (installs to /usr/local/sbin, /etc/systemd, /etc/torii)."
for f in "$WRAPPER_SRC" "$APPLIER_SRC" "$SERVICE_SRC" "$TIMER_SRC" "$SUDOERS_SRC"; do
  [[ -f "$f" ]] || die "missing source file: ${f} (run from a torii-continuum checkout)."
done

# Validate the scripts parse before installing them — never install a broken one.
bash -n "$WRAPPER_SRC" || die "wrapper failed syntax check."
bash -n "$APPLIER_SRC" || die "update-request applier failed syntax check."

# ── 1. Wrapper + applier (root-owned, world-readable, root-writable only) ─────
install -m 0755 -o root -g root "$WRAPPER_SRC" "$WRAPPER_DST"
log "installed wrapper → ${WRAPPER_DST}"
install -m 0755 -o root -g root "$APPLIER_SRC" "$APPLIER_DST"
log "installed update-request applier → ${APPLIER_DST}"

# ── 2. systemd units ─────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$SERVICE_SRC" "${UNIT_DIR}/torii-continuum-deploy.service"
install -m 0644 -o root -g root "$TIMER_SRC"   "${UNIT_DIR}/torii-continuum-deploy.timer"
log "installed systemd service + timer"
systemctl daemon-reload

# ── 3. Pin file skeleton (root-only; never overwrite an existing one) ─────────
install -d -m 0755 -o root -g root "$CONF_DIR"
if [[ -f "$CONF_FILE" ]]; then
  log "pin file ${CONF_FILE} already exists — left untouched"
else
  umask 077
  cat > "$CONF_FILE" <<'CONF'
# Torii Continuum unattended-deploy pin file (root-only, 0600).
# The timer deploys CONTINUUM_TARGET_TAG when the live agent is not already
# serving it. Editing this file is the ONLY action needed to release a version.

# REQUIRED: the release to converge on. Must be a v<semver> tag.
CONTINUUM_TARGET_TAG=

# REQUIRED: your public domain (feeds group_vars/all.yml torii_domain).
CONTINUUM_DOMAIN=

# Repo to pull tags from.
CONTINUUM_REPO=https://github.com/ChiefmonkeyArt/torii-continuum.git

# Supply-chain gate. Set to 1 to REQUIRE `git tag -v` signature verification
# (recommended once you publish signed tags + install the signing pubkey into
# CONTINUUM_GNUPGHOME). Left 0 until then; the strict tag regex + allowlist
# below remain in force either way.
CONTINUUM_REQUIRE_SIGNED_TAGS=0
# CONTINUUM_GNUPGHOME=/etc/torii/deploy-gnupg

# Optional allowlist: if set, only tags listed (one per line) in this file may
# deploy. A configured-but-missing file fails closed.
# CONTINUUM_ALLOWLIST_FILE=/etc/torii/continuum-deploy.allow

CONTINUUM_HEALTH_URL=http://127.0.0.1:8787/api/health
CONTINUUM_DEPLOY_ROOT=/opt/deploy
CONTINUUM_KEEP_RELEASES=3
CONF
  chown root:root "$CONF_FILE"; chmod 0600 "$CONF_FILE"
  log "wrote pin-file skeleton → ${CONF_FILE} (set CONTINUUM_TARGET_TAG + CONTINUUM_DOMAIN to release)"
fi

# ── 4. Optional: locked deploy principal + scoped sudoers ─────────────────────
if [[ -n "$PRINCIPAL" ]]; then
  if ! id -u "$PRINCIPAL" >/dev/null 2>&1; then
    useradd --system --shell /usr/sbin/nologin --create-home --home-dir "/home/${PRINCIPAL}" "$PRINCIPAL"
    passwd --lock "$PRINCIPAL" >/dev/null
    log "created locked non-login principal ${PRINCIPAL}"
  else
    log "principal ${PRINCIPAL} already exists — left untouched"
  fi

  sudoers_dst="/etc/sudoers.d/torii-continuum-deploy"
  sed "s/toriideploy/${PRINCIPAL}/g" "$SUDOERS_SRC" > "${sudoers_dst}.tmp"
  chmod 0440 "${sudoers_dst}.tmp"; chown root:root "${sudoers_dst}.tmp"
  if visudo -cf "${sudoers_dst}.tmp" >/dev/null; then
    mv -f "${sudoers_dst}.tmp" "$sudoers_dst"
    log "installed scoped sudoers rule → ${sudoers_dst} (NOPASSWD on the wrapper ONLY)"
  else
    rm -f "${sudoers_dst}.tmp"
    die "generated sudoers rule failed visudo validation — not installed."
  fi

  if [[ "$WITH_SSH_KEY" -eq 1 ]]; then
    ssh_dir="/home/${PRINCIPAL}/.ssh"
    key="${ssh_dir}/id_ed25519_torii_deploy"
    install -d -m 0700 -o "$PRINCIPAL" -g "$PRINCIPAL" "$ssh_dir"
    if [[ ! -f "$key" ]]; then
      sudo -u "$PRINCIPAL" ssh-keygen -t ed25519 -N '' -C "torii-continuum-deploy@${PRINCIPAL}" -f "$key" >/dev/null
      log "generated dedicated deploy key for ${PRINCIPAL}"
    else
      log "deploy key already exists — left untouched"
    fi
    log "add this public key to the trigger host's authorized_keys (restrict it with command=/from= there):"
    printf '\n  %s\n\n' "$(cat "${key}.pub")"
    log "PIN THE VPS HOST KEY on the trigger host BEFORE first connect:"
    log "  ssh-keyscan -t ed25519 <vps-host> >> ~/.ssh/known_hosts   # then verify the fingerprint out-of-band"
    log "  and connect with -o StrictHostKeyChecking=yes (never accept-new blindly)."
  fi
fi

# ── 5. Enable the timer (deploy stays a no-op until the pin file names a tag) ──
if [[ "$ENABLE_TIMER" -eq 1 ]]; then
  systemctl enable --now torii-continuum-deploy.timer
  log "enabled torii-continuum-deploy.timer"
else
  log "timer installed but NOT enabled (--no-enable-timer). Enable with:"
  log "  sudo systemctl enable --now torii-continuum-deploy.timer"
fi

log "bootstrap complete. Release a version by setting CONTINUUM_TARGET_TAG in ${CONF_FILE}."
log "Trigger immediately (optional) with: sudo systemctl start torii-continuum-deploy.service"
