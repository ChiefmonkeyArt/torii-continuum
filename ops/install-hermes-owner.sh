#!/usr/bin/env bash
#
# Torii Continuum — HERMES-OWNER-1 (v0.2.104-alpha)
#
# Idempotently provision the owner brain on a Debian/Ubuntu VPS:
#   1. 'ollama' system user + local-only Ollama (127.0.0.1:11434) + qwen3:4b
#   2. 'hermes-owner' user + vanilla Nous Research Hermes, 'owner' profile
#   3. Routstr-primary (when ROUTSTR_* are set) with native fallback to Ollama
#
# Usage (run as root):
#   sudo ./ops/install-hermes-owner.sh                            # local-first
#   sudo env ROUTSTR_BASE_URL=https://host/v1 ROUTSTR_MODEL=m \
#        ./ops/install-hermes-owner.sh                            # Routstr-first
#   sudo ./ops/install-hermes-owner.sh --dry-run                  # no changes
#   ./ops/install-hermes-owner.sh --render-config                 # print config, no changes
#
# Security posture (see torii-continuum-strategy.md):
#   - No nsec on disk; NIP-07 browser signing is out of scope here.
#   - hermes-owner HOME 0700, profile .env 0600, never committed or logged.
#   - Ollama binds 127.0.0.1 only; its optional web UI is not started.
#
set -uo pipefail

OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
OLLAMA_USER="ollama"
HERMES_OWNER_USER="hermes-owner"
HERMES_PROFILE="owner"
HERMES_OWNER_HOME="/home/${HERMES_OWNER_USER}"
HERMES_PROFILE_DIR="${HERMES_OWNER_HOME}/.hermes/profiles/${HERMES_PROFILE}"

ROUTSTR_BASE_URL="${ROUTSTR_BASE_URL:-}"
ROUTSTR_MODEL="${ROUTSTR_MODEL:-}"
ROUTSTR_API_KEY="${ROUTSTR_API_KEY:-}"

OLLAMA_INSTALL_URL="https://ollama.com/install.sh"
HERMES_INSTALL_URL="https://hermes-agent.nousresearch.com/install.sh"
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-5m}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo $0 [--dry-run]
Flags:
  --render-config   print the profile config.yaml to stdout and exit (no changes)
  --dry-run         print the plan and exit without making any changes
  -h, --help        this message
Environment:
  OLLAMA_MODEL       local model to serve (default: qwen3:4b)
  ROUTSTR_BASE_URL   primary OpenAI-compatible base URL (https://host/v1)
  ROUTSTR_MODEL      primary model name at that endpoint
  ROUTSTR_API_KEY    primary API key (optional; written to profile .env, 0600)
EOF
}

primary_is_routstr() { [[ -n "${ROUTSTR_BASE_URL}" && -n "${ROUTSTR_MODEL}" ]]; }

# Renders the Hermes owner-profile config.yaml. Pure: no side effects, no env I/O.
render_config_yaml() {
  if primary_is_routstr; then
    cat <<EOF
model:
  provider: custom
  default: "${ROUTSTR_MODEL}"
  base_url: "${ROUTSTR_BASE_URL}"
fallback_providers:
  - provider: custom
    model: "${OLLAMA_MODEL}"
    base_url: "http://localhost:11434/v1"
EOF
  else
    cat <<EOF
# No ROUTSTR_BASE_URL / ROUTSTR_MODEL supplied — local Ollama is the primary
# for now. Run "hermes model" (as ${HERMES_OWNER_USER}) to make Routstr primary;
# the fallback below is what keeps the brain answering while Routstr is down.
model:
  provider: custom
  default: "${OLLAMA_MODEL}"
  base_url: "http://localhost:11434/v1"
fallback_providers:
  - provider: custom
    model: "${OLLAMA_MODEL}"
    base_url: "http://localhost:11434/v1"
EOF
  fi
}

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root (got uid ${EUID:-$(id -u)})"; }

user_exists() { id -u "$1" >/dev/null 2>&1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

ensure_ollama_user() {
  if user_exists "${OLLAMA_USER}"; then
    info "user '${OLLAMA_USER}' already exists; skipping"
  else
    info "creating system user '${OLLAMA_USER}'"
    useradd --system --home-dir /usr/share/ollama --shell /usr/sbin/nologin "${OLLAMA_USER}"
  fi
}

ensure_hermes_owner_user() {
  if user_exists "${HERMES_OWNER_USER}"; then
    info "user '${HERMES_OWNER_USER}' already exists; skipping"
  else
    info "creating user '${HERMES_OWNER_USER}' (no sudo)"
    useradd --create-home --shell /bin/bash "${HERMES_OWNER_USER}"
  fi
  chmod 0700 "${HERMES_OWNER_HOME}"
  if [[ -f "${HERMES_OWNER_HOME}/.profile" ]]; then
    if ! grep -q '^umask 077' "${HERMES_OWNER_HOME}/.profile"; then
      printf '\numask 077\n' >> "${HERMES_OWNER_HOME}/.profile"
    fi
  fi
}

install_ollama() {
  if command_exists ollama; then
    info "Ollama already installed; skipping"
  else
    info "installing Ollama (official installer)"
    curl -fsSL "${OLLAMA_INSTALL_URL}" | sh
  fi
  # Keep-alive so the model unloads when idle (RAM headroom on a no-swap box).
  local dropin_dir="/etc/systemd/system/ollama.service.d"
  local dropin="${dropin_dir}/keepalive.conf"
  if [[ ! -f "${dropin}" ]]; then
    mkdir -p "${dropin_dir}"
    printf '[Service]\nEnvironment="OLLAMA_KEEP_ALIVE=%s"\n' "${OLLAMA_KEEP_ALIVE}" > "${dropin}"
    systemctl daemon-reload
  fi
  systemctl enable --now ollama.service >/dev/null 2>&1 || warn "could not auto-start ollama.service"
}

pull_ollama_model() {
  local models
  models="$(ollama list 2>/dev/null || true)"
  if [[ "${models}" == *"${OLLAMA_MODEL}"* ]]; then
    info "model '${OLLAMA_MODEL}' already present; skipping pull"
  else
    info "pulling model '${OLLAMA_MODEL}'"
    ollama pull "${OLLAMA_MODEL}"
  fi
}

install_hermes() {
  if runuser -u "${HERMES_OWNER_USER}" -- bash -lc 'command -v hermes >/dev/null 2>&1'; then
    info "Hermes already installed; skipping"
  else
    info "installing vanilla Nous Research Hermes as '${HERMES_OWNER_USER}'"
    runuser -u "${HERMES_OWNER_USER}" -- bash -c "curl -fsSL '${HERMES_INSTALL_URL}' | bash"
  fi
  if [[ -d "${HERMES_PROFILE_DIR}" ]]; then
    info "Hermes profile '${HERMES_PROFILE}' already exists; skipping"
  else
    info "creating Hermes profile '${HERMES_PROFILE}'"
    runuser -u "${HERMES_OWNER_USER}" -- bash -lc "hermes profile create '${HERMES_PROFILE}'"
  fi
}

write_config() {
  mkdir -p "${HERMES_PROFILE_DIR}"
  render_config_yaml > "${HERMES_PROFILE_DIR}/config.yaml"
  chown -R "${HERMES_OWNER_USER}:${HERMES_OWNER_USER}" "${HERMES_OWNER_HOME}/.hermes"
  chmod 0600 "${HERMES_PROFILE_DIR}/config.yaml"
  info "wrote ${HERMES_PROFILE_DIR}/config.yaml (0600)"
}

write_env() {
  if [[ -z "${ROUTSTR_API_KEY}" ]]; then
    info "no ROUTSTR_API_KEY supplied; set Routstr via 'hermes model' later"
    return 0
  fi
  mkdir -p "${HERMES_PROFILE_DIR}"
  umask 077
  printf 'ROUTSTR_API_KEY=%s\n' "${ROUTSTR_API_KEY}" > "${HERMES_PROFILE_DIR}/.env"
  chown "${HERMES_OWNER_USER}:${HERMES_OWNER_USER}" "${HERMES_PROFILE_DIR}/.env"
  chmod 0600 "${HERMES_PROFILE_DIR}/.env"
  info "wrote ${HERMES_PROFILE_DIR}/.env (0600)"
}

record_manifest() {
  local manifest="${HERMES_OWNER_HOME}/.hermes-owner-rebuild-manifest.txt"
  local ollama_version="unknown" hermes_version="unknown" digest="<unknown>"
  local model_show

  if command_exists ollama; then
    ollama_version="$(ollama --version 2>/dev/null || true)"
    model_show="$(ollama show "${OLLAMA_MODEL}" 2>/dev/null || true)"
    digest="$(awk '/[Dd]igest/{print $2}' <<<"${model_show}")"
    [[ -n "${digest}" ]] || digest="<unknown>"
  fi
  if runuser -u "${HERMES_OWNER_USER}" -- bash -lc 'command -v hermes >/dev/null 2>&1'; then
    hermes_version="$(runuser -u "${HERMES_OWNER_USER}" -- bash -lc 'hermes --version 2>/dev/null' || true)"
  fi

  {
    echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ollama: ${ollama_version}"
    echo "hermes: ${hermes_version}"
    echo "ollama_model: ${OLLAMA_MODEL}"
    echo "ollama_model_digest: ${digest}"
    echo "routstr_base_url: ${ROUTSTR_BASE_URL:-<unset>}"
    echo "routstr_model: ${ROUTSTR_MODEL:-<unset>}"
  } > "${manifest}"
  chmod 0644 "${manifest}"
  info "wrote ${manifest}"
}

main() {
  case "${1:-}" in
    --help|-h)        usage; return 0 ;;
    --render-config)  render_config_yaml; return 0 ;;
    --dry-run)
      info "DRY RUN — no changes will be made. Plan:"
      info "  ensure users '${OLLAMA_USER}' + '${HERMES_OWNER_USER}'"
      info "  install Ollama (${OLLAMA_INSTALL_URL}), bind 127.0.0.1:11434, pull ${OLLAMA_MODEL}"
      info "  install Hermes (${HERMES_INSTALL_URL}) as '${HERMES_OWNER_USER}', profile '${HERMES_PROFILE}'"
      info "  write ${HERMES_PROFILE_DIR}/config.yaml:"
      render_config_yaml | sed 's/^/    /'
      return 0 ;;
    "")                ;;
    *)                usage >&2; die "unknown argument: $1" ;;
  esac

  require_root
  ensure_ollama_user
  ensure_hermes_owner_user
  install_ollama
  pull_ollama_model
  install_hermes
  write_config
  write_env
  record_manifest

  info "HERMES-OWNER-1 complete."
  info "Access: sudo -u ${HERMES_OWNER_USER} hermes -p ${HERMES_PROFILE}"
}

main "$@"