#!/usr/bin/env bash
#
# Torii Continuum — HERMES-OWNER-1 (Continuum-router primary)
#
# Idempotently provision the owner brain on a Debian/Ubuntu VPS:
#   1. 'ollama' system user + local-only Ollama (127.0.0.1:11434) + llama3.2:1b
#   2. 'hermes-owner' user + vanilla Nous Research Hermes, 'owner' profile
#   3. Primary = the Continuum agent's OpenAI-compatible /v1 surface at
#      http://127.0.0.1:8787/v1 (which itself routes Routstr-first → Ollama).
#      Fallback = local Ollama llama3.2:1b so the owner brain keeps answering
#      when the paid path is down.
#
# Usage (run as root):
#   sudo env CONTINUUM_ROUTER_TOKEN=<hex64> ./ops/install-hermes-owner.sh
#   sudo ./ops/install-hermes-owner.sh --dry-run                  # no changes
#   ./ops/install-hermes-owner.sh --render-config                 # print, no changes
#
# Security posture (see docs/hermes-two-voice.md):
#   - No nsec on disk; NIP-07 browser signing is out of scope here.
#   - hermes-owner HOME 0700, profile .env 0600, never committed or logged.
#   - Ollama binds 127.0.0.1 only; its optional web UI is not started.
#   - The Continuum router token is a LOCAL bearer (not a Nostr key); still
#     0600 in the profile .env, referenced by api_key_env only.
#
# Hermes gotcha the layout works around:
#   As of the current Nous release, `fallback_providers` set in a PROFILE
#   config.yaml is IGNORED by the CLI worker — only the MAIN
#   `~/.hermes/config.yaml` fallback is read. We therefore write the fallback
#   into the main config too (idempotently, only if the section is missing),
#   so `llama3.2:1b` really kicks in when the router path fails.
#
set -uo pipefail

OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:1b}"
OLLAMA_USER="ollama"
HERMES_OWNER_USER="hermes-owner"
HERMES_PROFILE="owner"
HERMES_OWNER_HOME="/home/${HERMES_OWNER_USER}"
HERMES_MAIN_CONFIG="${HERMES_OWNER_HOME}/.hermes/config.yaml"
HERMES_PROFILE_DIR="${HERMES_OWNER_HOME}/.hermes/profiles/${HERMES_PROFILE}"

# Continuum router (primary inference). Defaults point at the local agent's
# /v1 surface bound to loopback:8787; override CONTINUUM_ROUTER_URL only if the
# agent has been rebound. CONTINUUM_ROUTER_MODEL is the id the /v1 adapter
# advertises (see agent/core/openai-adapter.mjs MODEL_IDS).
CONTINUUM_ROUTER_URL="${CONTINUUM_ROUTER_URL:-http://127.0.0.1:8787/v1}"
CONTINUUM_ROUTER_MODEL="${CONTINUUM_ROUTER_MODEL:-chat}"
CONTINUUM_ROUTER_TOKEN="${CONTINUUM_ROUTER_TOKEN:-}"

OLLAMA_INSTALL_URL="https://ollama.com/install.sh"
HERMES_INSTALL_URL="https://hermes-agent.nousresearch.com/install.sh"
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-5m}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo $0 [--dry-run|--render-config]
Flags:
  --render-config   print the profile config.yaml to stdout and exit (no changes)
  --dry-run         print the plan and exit without making any changes
  -h, --help        this message
Environment:
  OLLAMA_MODEL              local fallback model (default: llama3.2:1b — non-thinking)
  CONTINUUM_ROUTER_URL      primary /v1 base URL (default: http://127.0.0.1:8787/v1)
  CONTINUUM_ROUTER_MODEL    primary model id served by /v1 (default: chat)
  CONTINUUM_ROUTER_TOKEN    bearer for the router /v1 (matches
                            openai_adapter.local_token in agent/config.yaml).
                            Required unless the operator wires this later.
EOF
}

# Renders the Hermes owner-profile config.yaml. Pure: no side effects, no env I/O.
# Note: `fallback_providers` here is a mirror. The MAIN config is what Hermes
# actually reads for fallback; we write both so a future Hermes release that
# fixes the profile-fallback bug picks the same policy up automatically.
render_profile_config_yaml() {
  cat <<EOF
# Torii Continuum — hermes-owner profile
#
# Primary: Continuum agent /v1 (delegates to model-router: Routstr-first → local).
# Fallback: local Ollama llama3.2:1b. See docs/hermes-two-voice.md.
model:
  provider: custom
  default: "${CONTINUUM_ROUTER_MODEL}"
  base_url: "${CONTINUUM_ROUTER_URL}"
  api_key_env: "CONTINUUM_ROUTER_TOKEN"
fallback_providers:
  - provider: custom
    model: "${OLLAMA_MODEL}"
    base_url: "http://127.0.0.1:11434/v1"
EOF
}

# Fallback block for the MAIN ~/.hermes/config.yaml. Written only if the file
# doesn't already have a `fallback_providers:` key — the operator's own edits
# win, we never rewrite in place.
render_main_fallback_block() {
  cat <<EOF
# HERMES-OWNER-1 — Continuum-managed fallback. Removes safely if you rewire
# your own; do not edit in place — this block is written by the installer
# only when the file has no fallback_providers section (see:
# ops/install-hermes-owner.sh).
fallback_providers:
  - provider: custom
    model: "${OLLAMA_MODEL}"
    base_url: "http://127.0.0.1:11434/v1"
EOF
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

write_profile_config() {
  mkdir -p "${HERMES_PROFILE_DIR}"
  render_profile_config_yaml > "${HERMES_PROFILE_DIR}/config.yaml"
  chown -R "${HERMES_OWNER_USER}:${HERMES_OWNER_USER}" "${HERMES_OWNER_HOME}/.hermes"
  chmod 0600 "${HERMES_PROFILE_DIR}/config.yaml"
  info "wrote ${HERMES_PROFILE_DIR}/config.yaml (0600)"
}

# Idempotent: only appends the fallback block if the main config file is
# missing OR lacks a `fallback_providers:` line. Operator edits are preserved.
ensure_main_fallback() {
  mkdir -p "$(dirname "${HERMES_MAIN_CONFIG}")"
  if [[ -f "${HERMES_MAIN_CONFIG}" ]] && grep -q '^fallback_providers:' "${HERMES_MAIN_CONFIG}"; then
    info "main config already has fallback_providers; leaving it alone"
    return 0
  fi
  {
    [[ -f "${HERMES_MAIN_CONFIG}" ]] && cat "${HERMES_MAIN_CONFIG}"
    printf '\n'
    render_main_fallback_block
  } > "${HERMES_MAIN_CONFIG}.tmp"
  mv -f "${HERMES_MAIN_CONFIG}.tmp" "${HERMES_MAIN_CONFIG}"
  chown "${HERMES_OWNER_USER}:${HERMES_OWNER_USER}" "${HERMES_MAIN_CONFIG}"
  chmod 0600 "${HERMES_MAIN_CONFIG}"
  info "wrote fallback into ${HERMES_MAIN_CONFIG} (0600)"
}

write_env() {
  mkdir -p "${HERMES_PROFILE_DIR}"
  umask 077
  if [[ -z "${CONTINUUM_ROUTER_TOKEN}" ]]; then
    warn "CONTINUUM_ROUTER_TOKEN not set — hermes-owner will 401 against the router until you write ${HERMES_PROFILE_DIR}/.env manually"
    return 0
  fi
  # Only ever WRITE, never READ back. If a stale token is on disk we let
  # this overwrite it — never diff/echo the value.
  printf 'CONTINUUM_ROUTER_TOKEN=%s\n' "${CONTINUUM_ROUTER_TOKEN}" > "${HERMES_PROFILE_DIR}/.env"
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
    echo "ollama_fallback_model: ${OLLAMA_MODEL}"
    echo "ollama_model_digest: ${digest}"
    echo "continuum_router_url: ${CONTINUUM_ROUTER_URL}"
    echo "continuum_router_model: ${CONTINUUM_ROUTER_MODEL}"
    # Deliberately NOT recording the bearer — its presence is captured by
    # whether the profile .env exists and is 0600, which the operator can
    # verify without ever exporting the secret.
    echo "continuum_router_token: <in profile .env if set>"
  } > "${manifest}"
  chmod 0644 "${manifest}"
  info "wrote ${manifest}"
}

main() {
  case "${1:-}" in
    --help|-h)        usage; return 0 ;;
    --render-config)  render_profile_config_yaml; return 0 ;;
    --dry-run)
      info "DRY RUN — no changes will be made. Plan:"
      info "  ensure users '${OLLAMA_USER}' + '${HERMES_OWNER_USER}'"
      info "  install Ollama (${OLLAMA_INSTALL_URL}), bind 127.0.0.1:11434, pull ${OLLAMA_MODEL}"
      info "  install Hermes (${HERMES_INSTALL_URL}) as '${HERMES_OWNER_USER}', profile '${HERMES_PROFILE}'"
      info "  write ${HERMES_PROFILE_DIR}/config.yaml:"
      render_profile_config_yaml | sed 's/^/    /'
      info "  ensure fallback in ${HERMES_MAIN_CONFIG} (if missing):"
      render_main_fallback_block | sed 's/^/    /'
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
  write_profile_config
  ensure_main_fallback
  write_env
  record_manifest

  info "HERMES-OWNER-1 complete."
  info "Access: sudo -u ${HERMES_OWNER_USER} hermes -p ${HERMES_PROFILE}"
  info "Verify: sudo -u ${HERMES_OWNER_USER} bash -lc 'curl -s -H \"Authorization: Bearer \$CONTINUUM_ROUTER_TOKEN\" ${CONTINUUM_ROUTER_URL}/models | head'"
}

main "$@"
