#!/usr/bin/env bash
#
# Torii Continuum — NAP-BRIDGE-3 (isolated Nostr DM gateway)
#
# Provisions the nap-bridge gateway that drives the hermes-npc greeter over
# Nostr with a LOCAL per-install ephemeral nsec. There is no NIP-46 bunker, no
# nostrconnect:// URI, no one-time approval — the installer mints a throwaway
# greeter nsec on first install and the gateway signs with it directly.
#
# The nsec is disposable by design: it holds no funds, carries no delegation,
# and is unlinkable to the operator's admin/owner npub. If it leaks, the worst
# case is impersonation-as-greeter (an attacker posts as the NPC) — never theft
# or owner-secret exposure. Rotation = `rm /home/hermes-npc/.nap-bridge/.env`
# and reinstall, or overwrite NPC_NSEC with a nsec the operator chose.
#
# Usage (run as root):
#   sudo NPC_RELAYS=<urls> NPC_ALLOWLIST=<npubs> \
#        ./ops/install-nap-bridge.sh                      # provision (idempotent)
#   sudo ./ops/install-nap-bridge.sh --generate           # mint + print a nsec
#   ./ops/install-nap-bridge.sh --render-env              # print .env template
#   ./ops/install-nap-bridge.sh --render-unit             # print systemd unit
#   sudo ./ops/install-nap-bridge.sh --dry-run            # plan, no changes
#
# Environment:
#   NPC_RELAYS          comma-separated Nostr relay URLs. Optional when
#                       TORII_DOMAIN is set -- defaults to
#                       wss://relay.<TORII_DOMAIN> (matches torii-suite
#                       v0.9.8-alpha+'s subdomain relay). Explicit env still
#                       wins.
#   NPC_ALLOWLIST       comma-separated allowed sender npubs/hex (required unless
#                       NPC_PUBLIC=1; fail-closed — empty admits nobody)
#   NPC_PUBLIC          admit EVERY authenticated sender (default: off). When 1/
#                       true the allowlist is ignored and the per-sender rate
#                       limit is the ONLY throttle — public Nakama must run with
#                       NPC_RATE_* set (NAP-BRIDGE-6).
#   NPC_MODEL           local inference model (default: llama3.2:1b — non-
#                       thinking, ~1.3 GB, replies in ~2s on a 8 GB VPS.
#                       qwen3:0.6b is NOT a valid default here: over Ollama's
#                       OpenAI-compat /v1/chat/completions surface it emits its
#                       whole reply into the `reasoning` field and returns an
#                       empty `content`, so the greeter appears to go silent
#                       (NAP-BRIDGE-DEFAULT-RELAY / qwen3 thinking-mode bug).
#                       Override only to another NON-thinking model, or raise
#                       the RAM budget for a larger one on a bigger host.)
#   NPC_OLLAMA_URL      local Ollama /v1 base URL (default: http://127.0.0.1:11434/v1)
#   NPC_SOUL_FILE       greeter SOUL.md path (default: /home/hermes-npc/.hermes/profiles/npc/SOUL.md)
#   NPC_RATE_WINDOW_MS  per-sender rate-limit window in milliseconds (default: 60000)
#   NPC_RATE_MAX_PER_WINDOW  max replies per sender per window (default: 6). Beyond
#                       it the greeter sends ONE throttle notice, then silently
#                       drops until that sender's window resets. Checked BEFORE
#                       inference, so a spammer can force decrypts but never peg
#                       the host CPU (NAP-BRIDGE-5).
#   NAP_BRIDGE_USER     unix user (default: hermes-npc)
#   AGENT_DIR           agent package dir holding npc-gateway.mjs + node_modules
#                       (default: /opt/torii/continuum-agent)
#   NPC_NSEC            reuse an existing nsec (64-hex or nsec1); otherwise minted
#
# Security posture (see docs/nap-bridge-1.md):
#   - The only secret on disk is the greeter nsec (0600) — a throwaway identity
#     with no funds and no delegation. It cannot spend, export owner secrets,
#     or impersonate anything beyond the greeter's own npub.
#   - Fail-closed allowlist: empty => nobody. Checked after unwrap, BEFORE any
#     inference. NPC_PUBLIC=1 opts OUT of the allowlist (every authenticated
#     sender is admitted) and the per-sender rate limit becomes the only gate.
#   - Per-sender rate limit (NAP-BRIDGE-5): free inference still costs CPU, so a
#     spammer cannot peg the host by flooding. Checked BEFORE inference; the
#     first over-limit message earns one throttle notice, the rest drop silently.
#   - Runs as hermes-npc, read-only filesystem, outbound network only.
#
set -uo pipefail

NAP_BRIDGE_USER="${NAP_BRIDGE_USER:-hermes-npc}"
AGENT_DIR="${AGENT_DIR:-/opt/torii/continuum-agent}"
NPC_MODEL="${NPC_MODEL:-llama3.2:1b}"
NPC_OLLAMA_URL="${NPC_OLLAMA_URL:-http://127.0.0.1:11434/v1}"
NPC_SOUL_FILE="${NPC_SOUL_FILE:-/home/hermes-npc/.hermes/profiles/npc/SOUL.md}"
NPC_RATE_WINDOW_MS="${NPC_RATE_WINDOW_MS:-60000}"
NPC_RATE_MAX_PER_WINDOW="${NPC_RATE_MAX_PER_WINDOW:-6}"
NPC_PUBLIC="${NPC_PUBLIC:-0}"

NAP_BRIDGE_HOME="/home/${NAP_BRIDGE_USER}"
NAP_BRIDGE_DIR="${NAP_BRIDGE_HOME}/.nap-bridge"
ENV_FILE="${NAP_BRIDGE_DIR}/.env"
UNIT_NAME="torii-nap-bridge.service"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd/${UNIT_NAME}"
UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo $0 [--generate|--render-env|--render-unit|--dry-run|-h]
Flags:
  --generate       mint (or reuse NPC_NSEC) and print the greeter nsec + npub
  --render-env     print the .env template to stdout (no changes; no secret)
  --render-unit    print the systemd unit to stdout (no changes)
  --dry-run        print the plan and exit without making changes
  -h, --help       this message
Environment (see header); NPC_RELAYS required; NPC_ALLOWLIST required unless NPC_PUBLIC=1.
EOF
}

node_bin() {
  local nb
  nb="$(command -v node || true)"
  [ -n "$nb" ] || die "node not found on PATH"
  printf '%s' "$nb"
}

# Run the nsec helper once, caching its JSON so a single install only ever
# mints ONE nsec. `NPC_NSEC`, when set, reuses that identity.
_NSEC_JSON=""
nsec_json() {
  if [ -z "$_NSEC_JSON" ]; then
    [ -f "$AGENT_DIR/scripts/npc-nsec.mjs" ] || \
      die "npc-nsec.mjs not found under AGENT_DIR=$AGENT_DIR (is the repo checked out?)"
    _NSEC_JSON="$(cd "$AGENT_DIR" && \
      ${NPC_NSEC:+NPC_NSEC="$NPC_NSEC"} \
      node scripts/npc-nsec.mjs)" || die "npc-nsec (mint) failed"
  fi
  printf '%s' "$_NSEC_JSON"
}

nsec_field() {
  local field="$1"
  nsec_json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).$field))"
}

# Render the .env. NPC_NSEC is the one secret; the 64-hex is what the gateway
# reads, and it is never echoed back after install.
render_env() {
  local secret="$1"
  cat <<EOF
# nap-bridge gateway environment (0600). The only secret here is the greeter
# nsec — a throwaway per-install identity with no funds and no delegation.
NPC_ENABLED=1
NPC_NSEC=${secret}
NPC_RELAYS=${NPC_RELAYS}
NPC_ALLOWLIST=${NPC_ALLOWLIST:-}
NPC_OLLAMA_URL=${NPC_OLLAMA_URL}
NPC_MODEL=${NPC_MODEL}
NPC_SOUL_FILE=${NPC_SOUL_FILE}
NPC_RATE_WINDOW_MS=${NPC_RATE_WINDOW_MS}
NPC_RATE_MAX_PER_WINDOW=${NPC_RATE_MAX_PER_WINDOW}
NPC_PUBLIC=${NPC_PUBLIC}
EOF
}

# Render the systemd unit with this host's node path + agent dir substituted.
render_unit() {
  [ -f "$UNIT_SRC" ] || die "unit template not found: $UNIT_SRC"
  sed -e "s|__NODE_BIN__|$(node_bin)|g" \
      -e "s|__AGENT_DIR__|${AGENT_DIR}|g" \
      "$UNIT_SRC"
}

# ── flag parsing ─────────────────────────────────────────────────────────────
MODE="install"
case "${1:-}" in
  --generate)    MODE="generate";;
  --render-env)  MODE="render-env";;
  --render-unit) MODE="render-unit";;
  --dry-run)     MODE="dry-run";;
  -h|--help)     usage; exit 0;;
  "")            MODE="install";;
  *)             usage; exit 2;;
esac

# Required inputs (both public; the nsec is minted, never supplied).
if [ "$MODE" = "install" ] || [ "$MODE" = "dry-run" ] || [ "$MODE" = "render-env" ]; then
  # v0.2.114-alpha (NAP-BRIDGE-DEFAULT-RELAY-1): if NPC_RELAYS is unset,
  # derive it from TORII_DOMAIN (matches torii-suite v0.9.8-alpha default).
  if [ -z "${NPC_RELAYS:-}" ] && [ -n "${TORII_DOMAIN:-}" ]; then
    NPC_RELAYS="wss://relay.${TORII_DOMAIN}"
    echo "[install-nap-bridge] NPC_RELAYS defaulted to ${NPC_RELAYS} (from TORII_DOMAIN)"
  fi
  [ -n "${NPC_RELAYS:-}" ]    || die "NPC_RELAYS is required (comma-separated relay URLs, or set TORII_DOMAIN)"
  export NPC_RELAYS
  # Allowlist is required unless the operator opts into public mode (NAP-BRIDGE-6).
  if [ "${NPC_PUBLIC:-0}" != "1" ] && [ "${NPC_PUBLIC:-0}" != "true" ]; then
    [ -n "${NPC_ALLOWLIST:-}" ] || die "NPC_ALLOWLIST is required (comma-separated npubs/hex), or set NPC_PUBLIC=1 to admit everyone"
  fi
fi

case "$MODE" in
  render-env)
    render_env "__NSEC__"
    exit 0
    ;;
  render-unit)
    render_unit
    exit 0
    ;;
  generate)
    cat <<EOF

Greeter identity (minted at install; the nsec is disposable and holds no funds):

npub=$(nsec_field npub)
nsec_hex=$(nsec_field nsec_hex)
nsec_bech32=$(nsec_field nsec_bech32)

Store nsec_bech32 somewhere safe ONLY if you intend to keep this exact identity
across reinstalls. Otherwise it is safe to lose — a fresh install mints a new one.
EOF
    exit 0
    ;;
esac

# ── install ──────────────────────────────────────────────────────────────────
if [ "$MODE" = "dry-run" ]; then
  info "dry-run: would write $ENV_FILE (0600) and install $UNIT_DEST"
  info "dry-run: user $NAP_BRIDGE_USER, agent dir $AGENT_DIR"
  render_env "__NSEC__"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
id -u "$NAP_BRIDGE_USER" >/dev/null 2>&1 || \
  die "user $NAP_BRIDGE_USER does not exist — run ops/install-hermes-npc.sh first"
[ -f "$AGENT_DIR/npc-gateway.mjs" ] || \
  die "npc-gateway.mjs not found under AGENT_DIR=$AGENT_DIR"

mkdir -p "$NAP_BRIDGE_DIR" || die "mkdir $NAP_BRIDGE_DIR failed"
chown "${NAP_BRIDGE_USER}:${NAP_BRIDGE_USER}" "$NAP_BRIDGE_DIR"
chmod 0700 "$NAP_BRIDGE_DIR"

# Reuse an existing nsec (so restarts/reinstalls stay on the same identity);
# otherwise mint a fresh one. Never overwrite a live .env secret.
if [ -f "$ENV_FILE" ] && grep -qE '^NPC_NSEC=[0-9a-f]{64}$' "$ENV_FILE"; then
  info "reusing existing $ENV_FILE (nsec already present)"
  NPC_NSEC="$(grep -E '^NPC_NSEC=' "$ENV_FILE" | cut -d= -f2-)"
else
  { render_env "$(nsec_field nsec_hex)"; } > "$ENV_FILE" || die "write $ENV_FILE failed"
  chown "${NAP_BRIDGE_USER}:${NAP_BRIDGE_USER}" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

render_unit > "$UNIT_DEST" || die "write $UNIT_DEST failed"
chmod 0644 "$UNIT_DEST"

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || warn "enable $UNIT_NAME failed"
systemctl restart "$UNIT_NAME" || warn "restart $UNIT_NAME failed — check 'journalctl -u $UNIT_NAME'"

info "nap-bridge installed."
if [ "${NPC_PUBLIC}" = "1" ] || [ "${NPC_PUBLIC}" = "true" ]; then
  info "Public mode: Nakama answers every sender, rate-limited. Confirm it is live:"
else
  info "The greeter will only respond to NPC_ALLOWLIST senders. Confirm it is live:"
fi
info "  journalctl -u $UNIT_NAME -f"