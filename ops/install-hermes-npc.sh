#!/usr/bin/env bash
#
# Torii Continuum — HERMES-NPC-1 (isolated public greeter)
#
# Idempotently provision the public greeter voice on a Debian/Ubuntu VPS:
#   1. reuse the shared 'ollama' local-only backend (127.0.0.1:11434) + qwen3:4b
#   2. 'hermes-npc' user + vanilla Nous Research Hermes, 'npc' profile
#   3. Inference = local Ollama ONLY. No Continuum router, no router token, no
#      paid path, no fallback ladder. The greeter cannot spend the owner's
#      Cashu float because it is never pointed at the /v1 surface that does.
#
# This is the SECOND voice of the two-voice architecture. The primary trust
# boundary is the Unix user: hermes-npc has its own HOME (0700, umask 077) and
# shares nothing with hermes-owner — not memory, not keys, not project access.
# Public prompts are therefore structurally unable to reach owner secrets.
#
# Usage (run as root):
#   sudo ./ops/install-hermes-npc.sh              # provision (idempotent)
#   sudo ./ops/install-hermes-npc.sh --dry-run    # no changes
#   ./ops/install-hermes-npc.sh --render-config   # print profile config, no changes
#   ./ops/install-hermes-npc.sh --render-soul     # print the greeter SOUL.md, no changes
#
# Security posture (see docs/hermes-two-voice.md):
#   - hermes-npc HOME 0700, umask 077; no sudo, no login.
#   - No secrets on disk: local Ollama needs no API key, so there is no .env,
#     no bearer, nothing to exfiltrate.
#   - Ollama binds 127.0.0.1 only (provisioned by install-hermes-owner.sh);
#     this installer reuses it and never rebinds it to a public interface.
#   - No tools are configured: the profile declares no MCP servers, no
#     toolset, no skills beyond the bare Hermes default. Chat only.
#
# Non-goals (later slices, see docs/hermes-two-voice.md):
#   Nostr/NIP-07 gateway + npub allowlist (NAP-BRIDGE-1); sats receipt; any
#   public network exposure. The greeter is loopback-only until NAP-BRIDGE-1.
#
set -uo pipefail

OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
OLLAMA_USER="ollama"
HERMES_NPC_USER="hermes-npc"
HERMES_PROFILE="npc"
HERMES_NPC_HOME="/home/${HERMES_NPC_USER}"
HERMES_PROFILE_DIR="${HERMES_NPC_HOME}/.hermes/profiles/${HERMES_PROFILE}"

# Local-only Ollama (the shared inference backend both voices reuse).
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"

OLLAMA_INSTALL_URL="https://ollama.com/install.sh"
HERMES_INSTALL_URL="https://hermes-agent.nousresearch.com/install.sh"
OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-5m}"

# One- or two-sentence role description for `hermes profile create`, so the
# kanban orchestrator (if ever used) can route by role rather than name.
NPC_DESCRIPTION="${NPC_DESCRIPTION:-Public in-world greeter for Torii. Chat only, no tools, local inference, never touches owner data.}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo $0 [--dry-run|--render-config|--render-soul]
Flags:
  --render-config   print the npc profile config.yaml to stdout and exit (no changes)
  --render-soul     print the greeter SOUL.md to stdout and exit (no changes)
  --dry-run         print the plan and exit without making any changes
  -h, --help        this message
Environment:
  OLLAMA_MODEL      local inference model (default: qwen3:4b)
  OLLAMA_BASE_URL   local Ollama /v1 base URL (default: http://127.0.0.1:11434/v1)
  NPC_DESCRIPTION   one-line role description for 'hermes profile create'
EOF
}

# Renders the npc profile config.yaml. Pure: no side effects, no env I/O.
# Local Ollama is the sole provider — there is deliberately no fallback ladder
# and no router/api_key_env, so nothing can fall through to a paid path.
render_profile_config_yaml() {
  cat <<EOF
# Torii Continuum — hermes-npc profile
#
# Local Ollama ONLY. No Continuum router, no paid path, no fallback ladder —
# the greeter is structurally unable to spend the owner's Cashu float. See
# docs/hermes-two-voice.md for the isolation boundary.
model:
  provider: custom
  default: "${OLLAMA_MODEL}"
  base_url: "${OLLAMA_BASE_URL}"
EOF
}

# Renders the greeter persona (SOUL.md). Pure, no side effects.
render_soul_md() {
  cat <<'EOF'
# Torii — in-world greeter (hermes-npc)

You are the Torii greeter, a friendly, warm guide who welcomes visitors to the
Torii world and points them toward what they can do next. You are the
*beginnings* of their journey, not the whole journey.

## Who you are

- Curious, approachable, and generous with orientation — never pushy.
- Concise. Answer the actual question, then offer one obvious next step.
- Honest about your limits. When someone asks for something you cannot do, say
  so plainly and suggest who (or what) can.

## What you can do

- Chat and answer questions about the Torii world, its apps (Quest, Continuum,
  Plebeian), and the freedom-tech stack underneath (Nostr, Bitcoin, Cashu).
- Help a visitor orient: what to try first, where to go, who to ask.

## Hard limits (never break these)

- You have NO tools. No shell, no files, no network actions, no code execution.
- You run on local inference only. You cannot spend funds, send payments, or
  touch any wallet.
- You must never read, repeat, or infer secrets, keys, private memory, another
  user's data, or anything outside this public conversation.
- You are loopback-only. You are not a public endpoint yet; do not claim to be.

If a visitor asks for anything that needs tools, a payment, or access you do
not have, tell them clearly it is not something the greeter can do.
EOF
}

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root (got uid ${EUID:-$(id -u)})"; }
user_exists() { id -u "$1" >/dev/null 2>&1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

ensure_ollama() {
  ensure_ollama_user
  install_ollama
  pull_ollama_model
}

ensure_ollama_user() {
  if user_exists "${OLLAMA_USER}"; then
    info "user '${OLLAMA_USER}' already exists; skipping"
  else
    info "creating system user '${OLLAMA_USER}'"
    useradd --system --home-dir /usr/share/ollama --shell /usr/sbin/nologin "${OLLAMA_USER}"
  fi
}

ensure_hermes_npc_user() {
  if user_exists "${HERMES_NPC_USER}"; then
    info "user '${HERMES_NPC_USER}' already exists; skipping"
  else
    info "creating user '${HERMES_NPC_USER}' (no sudo)"
    useradd --create-home --shell /bin/bash "${HERMES_NPC_USER}"
  fi
  chmod 0700 "${HERMES_NPC_HOME}"
  if [[ -f "${HERMES_NPC_HOME}/.profile" ]]; then
    if ! grep -q '^umask 077' "${HERMES_NPC_HOME}/.profile"; then
      printf '\numask 077\n' >> "${HERMES_NPC_HOME}/.profile"
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
  if runuser -u "${HERMES_NPC_USER}" -- bash -lc 'command -v hermes >/dev/null 2>&1'; then
    info "Hermes already installed; skipping"
  else
    info "installing vanilla Nous Research Hermes as '${HERMES_NPC_USER}'"
    runuser -u "${HERMES_NPC_USER}" -- bash -c "curl -fsSL '${HERMES_INSTALL_URL}' | bash"
  fi
  if [[ -d "${HERMES_PROFILE_DIR}" ]]; then
    info "Hermes profile '${HERMES_PROFILE}' already exists; skipping"
  else
    info "creating Hermes profile '${HERMES_PROFILE}'"
    runuser -u "${HERMES_NPC_USER}" -- bash -lc "hermes profile create '${HERMES_PROFILE}' --description \"${NPC_DESCRIPTION}\""
  fi
}

write_profile_config() {
  mkdir -p "${HERMES_PROFILE_DIR}"
  render_profile_config_yaml > "${HERMES_PROFILE_DIR}/config.yaml"
  chown -R "${HERMES_NPC_USER}:${HERMES_NPC_USER}" "${HERMES_NPC_HOME}/.hermes"
  chmod 0600 "${HERMES_PROFILE_DIR}/config.yaml"
  info "wrote ${HERMES_PROFILE_DIR}/config.yaml (0600)"
}

write_soul() {
  mkdir -p "${HERMES_PROFILE_DIR}"
  render_soul_md > "${HERMES_PROFILE_DIR}/SOUL.md"
  chown -R "${HERMES_NPC_USER}:${HERMES_NPC_USER}" "${HERMES_NPC_HOME}/.hermes"
  chmod 0600 "${HERMES_PROFILE_DIR}/SOUL.md"
  info "wrote ${HERMES_PROFILE_DIR}/SOUL.md (0600)"
}

record_manifest() {
  local manifest="${HERMES_NPC_HOME}/.hermes-npc-rebuild-manifest.txt"
  local ollama_version="unknown" hermes_version="unknown" digest="<unknown>"
  local model_show

  if command_exists ollama; then
    ollama_version="$(ollama --version 2>/dev/null || true)"
    model_show="$(ollama show "${OLLAMA_MODEL}" 2>/dev/null || true)"
    digest="$(awk '/[Dd]igest/{print $2}' <<<"${model_show}")"
    [[ -n "${digest}" ]] || digest="<unknown>"
  fi
  if runuser -u "${HERMES_NPC_USER}" -- bash -lc 'command -v hermes >/dev/null 2>&1'; then
    hermes_version="$(runuser -u "${HERMES_NPC_USER}" -- bash -lc 'hermes --version 2>/dev/null' || true)"
  fi

  {
    echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ollama: ${ollama_version}"
    echo "hermes: ${hermes_version}"
    echo "ollama_model: ${OLLAMA_MODEL}"
    echo "ollama_model_digest: ${digest}"
    echo "ollama_base_url: ${OLLAMA_BASE_URL}"
    echo "hermes_profile: ${HERMES_PROFILE}"
    echo "continuum_router: none (isolated local-only voice)"
    echo "secrets_on_disk: none (local Ollama needs no API key)"
  } > "${manifest}"
  chmod 0644 "${manifest}"
  info "wrote ${manifest}"
}

main() {
  case "${1:-}" in
    --help|-h)        usage; return 0 ;;
    --render-config)  render_profile_config_yaml; return 0 ;;
    --render-soul)    render_soul_md; return 0 ;;
    --dry-run)
      info "DRY RUN — no changes will be made. Plan:"
      info "  ensure users '${OLLAMA_USER}' + '${HERMES_NPC_USER}'"
      info "  ensure Ollama (${OLLAMA_INSTALL_URL}) bound 127.0.0.1:11434, pull ${OLLAMA_MODEL}"
      info "  install Hermes (${HERMES_INSTALL_URL}) as '${HERMES_NPC_USER}', profile '${HERMES_PROFILE}'"
      info "  write ${HERMES_PROFILE_DIR}/config.yaml:"
      render_profile_config_yaml | sed 's/^/    /'
      info "  write ${HERMES_PROFILE_DIR}/SOUL.md (greeter persona):"
      render_soul_md | sed -n '1,4p' | sed 's/^/    /'
      info "  no secrets written (local Ollama needs no API key)"
      return 0 ;;
    "")                ;;
    *)                usage >&2; die "unknown argument: $1" ;;
  esac

  require_root
  ensure_ollama
  ensure_hermes_npc_user
  install_hermes
  write_profile_config
  write_soul
  record_manifest

  info "HERMES-NPC-1 complete."
  info "Access: sudo -u ${HERMES_NPC_USER} hermes -p ${HERMES_PROFILE}"
  info "Verify: sudo -u ${HERMES_NPC_USER} bash -lc 'curl -s ${OLLAMA_BASE_URL}/models | head'"
}

main "$@"