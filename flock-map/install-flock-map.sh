#!/usr/bin/env bash
# install-flock-map.sh — install the Flock Surveillance Map on a Torii VPS.
#
# Static single-page app under the standard Torii layout:
#   /apps/flock-map/{current,releases,data}
# Mirrors the quest/continuum convention: release snapshot + atomic `current`
# symlink flip + nginx fragment + `torii register` for the launcher tile.
#
# Usage (as root on the VPS), with the release tarball in the SAME directory
# as this script (scp both to /tmp):
#   sudo bash install-flock-map.sh
set -euo pipefail

APP="flock-map"
APPS_ROOT="/apps"
DISPLAY_NAME="Flock Map"
DESCRIPTION="Flock Safety / ALPR camera surveillance map"
VERSION="1.0.0"

APP_ROOT="${APPS_ROOT}/${APP}"
RELEASE_DIR="${APP_ROOT}/releases/$(date +%Y%m%d-%H%M%S)"
CURRENT_LINK="${APP_ROOT}/current"
DATA_DIR="${APP_ROOT}/data"
FRAGMENT_FILE="/opt/torii/nginx-fragments/${APP}.conf"
BUNDLE="$(dirname "$0")/flock-release.tar.gz"

log() { printf "\033[36m==>\033[0m %s\n" "$*"; }
die() { printf "\033[31mxx  %s\033[0m\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (sudo bash install-flock-map.sh)"
[[ -f "$BUNDLE" ]] || die "release tarball not found next to script: $BUNDLE"

log "creating /apps/flock-map layout"
install -d -m 0755 "${RELEASE_DIR}" "${DATA_DIR}"

log "extracting release"
tar -xzf "$BUNDLE" -C "${RELEASE_DIR}"
# Static files owned root:www-data (nginx reads as www-data), like quest releases.
chown -R root:www-data "${RELEASE_DIR}"
chown -R root:www-data "${DATA_DIR}"

log "flipping current -> ${RELEASE_DIR}"
rm -f "${CURRENT_LINK}"
ln -s "${RELEASE_DIR}" "${CURRENT_LINK}"

log "writing nginx fragment ${FRAGMENT_FILE}"
install -d -m 0755 /opt/torii/nginx-fragments
cat > "${FRAGMENT_FILE}" <<'NGINX'
# /opt/torii/nginx-fragments/flock-map.conf — Flock Surveillance Map
# Static single-page app mounted at /flock-map/.
location /flock-map/ {
    alias /apps/flock-map/current/;
    # The app's bundles are versioned filenames (cams.js), so immutable.
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
}
location = /flock-map {
    return 301 /flock-map/;
}
location = /flock-map/index.html {
    alias /apps/flock-map/current/index.html;
    add_header Cache-Control "no-store" always;
}
NGINX

log "registering '${APP}' launcher tile"
/usr/local/bin/torii register "${APP}" \
  --display "${DISPLAY_NAME}" \
  --desc "${DESCRIPTION}" \
  --version "${VERSION}"

log "reloading nginx"
/usr/local/bin/torii reload

log "done. open: https://chiefmonkey.art/flock-map/"