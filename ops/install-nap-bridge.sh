#!/usr/bin/env bash
#
# Torii Continuum — NAP-BRIDGE-1 (isolated Nostr DM gateway)
#
# Provisions the nap-bridge gateway that drives the hermes-npc greeter over
# Nostr WITHOUT any nsec on the VPS. The greeter nsec lives in the operator's
# NIP-46 bunker; this process only decrypts/encrypts/signs via bunker RPC.
#
# One-time human step (this is by design — the human must approve once):
#   the installer generates the gateway's NIP-46 CLIENT key and a
#   `nostrconnect://` URI; the operator approves that URI ONCE in their bunker.
#   After approval the gateway reconnects on every restart using only its
#   burnable client key + the operator's bunker pubkey. No greeter nsec ever
#   touches disk or memory here.
#
# Usage (run as root):
#   sudo NPC_BUNKER_PUBKEY=<npub> NPC_RELAYS=<urls> NPC_ALLOWLIST=<npubs> \
#        ./ops/install-nap-bridge.sh                      # provision (idempotent)
#   sudo ./ops/install-nap-bridge.sh --generate           # make client key + URI
#   ./ops/install-nap-bridge.sh --render-env              # print .env template
#   ./ops/install-nap-bridge.sh --render-unit             # print systemd unit
#   sudo ./ops/install-nap-bridge.sh --dry-run            # plan, no changes
#
# Environment:
#   NPC_BUNKER_PUBKEY   the operator's bunker pubkey/npub holding the greeter nsec
#                       (required)
#   NPC_RELAYS          comma-separated Nostr relay URLs (required)
#   NPC_ALLOWLIST       comma-separated allowed sender npubs/hex (required, fail-closed)
#   NPC_MODEL           local inference model (default: qwen3:4b)
#   NPC_OLLAMA_URL      local Ollama /v1 base URL (default: http://127.0.0.1:11434/v1)
#   NPC_SOUL_FILE       greeter SOUL.md path (default: /home/hermes-npc/.hermes/profiles/npc/SOUL.md)
#   NAP_BRIDGE_USER     unix user (default: hermes-npc)
#   AGENT_DIR           agent package dir holding npc-gateway.mjs + node_modules
#                       (default: /opt/torii/continuum-agent)
#   NPC_CLIENT_SECRET   reuse an existing client secret (hex); otherwise generated
#
# Security posture (see docs/nap-bridge-1.md):
#   - The only secret on disk is the NIP-46 client key (0600) — a burnable
#     delegation, not the greeter nsec. It cannot spend, export, or impersonate
#     beyond the greeter's approved kind-4/NIP-04 scope.
#   - Fail-closed allowlist: empty => nobody. Checked BEFORE any decrypt.
#   - Bunker down => greeter silent (safe failure), never falls back to any
#     other signer.
#   - Runs as hermes-npc, read-only filesystem, outbound network only.
#
set -uo pipefail

NAP_BRIDGE_USER="${NAP_BRIDGE_USER:-hermes-npc}"
AGENT_DIR="${AGENT_DIR:-/opt/torii/continuum-agent}"
NPC_MODEL="${NPC_MODEL:-qwen3:4b}"
NPC_OLLAMA_URL="${NPC_OLLAMA_URL:-http://127.0.0.1:11434/v1}"
NPC_SOUL_FILE="${NPC_SOUL_FILE:-/home/hermes-npc/.hermes/profiles/npc/SOUL.md}"

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
  --generate       generate the NIP-46 client key + nostrconnect:// URI, print it
  --render-env     print the .env template to stdout (no changes; no secret)
  --render-unit    print the systemd unit to stdout (no changes)
  --dry-run        print the plan and exit without making changes
  -h, --help       this message
Environment (see header); NPC_BUNKER_PUBKEY, NPC_RELAYS, NPC_ALLOWLIST required.
EOF
}

node_bin() {
  local nb
  nb="$(command -v node || true)"
  [ -n "$nb" ] || die "node not found on PATH"
  printf '%s' "$nb"
}

# Run the key/URI helper once, caching its JSON so a single install only ever
# mints ONE client key. `NPC_CLIENT_SECRET`, when set, reuses that key.
_CONNECT_JSON=""
connect_json() {
  if [ -z "$_CONNECT_JSON" ]; then
    [ -f "$AGENT_DIR/scripts/npc-connect.mjs" ] || \
      die "npc-connect.mjs not found under AGENT_DIR=$AGENT_DIR (is the repo checked out?)"
    _CONNECT_JSON="$(cd "$AGENT_DIR" && \
      NPC_RELAYS="$NPC_RELAYS" \
      ${NPC_CLIENT_SECRET:+NPC_CLIENT_SECRET="$NPC_CLIENT_SECRET"} \
      node scripts/npc-connect.mjs)" || die "npc-connect (key/URI) failed"
  fi
  printf '%s' "$_CONNECT_JSON"
}

connect_field() {
  local field="$1"
  connect_json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).$field))"
}

# Render the .env. NPC_CLIENT_SECRET is the one secret; pass a literal hex to
# write it, or a placeholder to render a template. Bunker pubkey + allowlist are
# public (npubs), not secrets.
render_env() {
  local secret="$1"
  cat <<EOF
# nap-bridge gateway environment (0600). The only secret here is the NIP-46
# CLIENT key — a burnable delegation to the bunker, NOT the greeter nsec.
NPC_ENABLED=1
NPC_CLIENT_SECRET=${secret}
NPC_BUNKER_PUBKEY=${NPC_BUNKER_PUBKEY}
NPC_RELAYS=${NPC_RELAYS}
NPC_ALLOWLIST=${NPC_ALLOWLIST}
NPC_OLLAMA_URL=${NPC_OLLAMA_URL}
NPC_MODEL=${NPC_MODEL}
NPC_SOUL_FILE=${NPC_SOUL_FILE}
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

# Required inputs (all public; none secret).
if [ "$MODE" = "install" ] || [ "$MODE" = "dry-run" ] || [ "$MODE" = "render-env" ]; then
  [ -n "${NPC_BUNKER_PUBKEY:-}" ] || die "NPC_BUNKER_PUBKEY is required (your bunker's npub/hex)"
  [ -n "${NPC_RELAYS:-}" ]        || die "NPC_RELAYS is required (comma-separated relay URLs)"
  [ -n "${NPC_ALLOWLIST:-}" ]     || die "NPC_ALLOWLIST is required (comma-separated npubs/hex)"
fi

case "$MODE" in
  render-env)
    render_env "__CLIENT_SECRET__"
    exit 0
    ;;
  render-unit)
    render_unit
    exit 0
    ;;
  generate)
    [ -n "${NPC_RELAYS:-}" ] || die "NPC_RELAYS is required to generate the connect URI"
    cat <<EOF

Approval URI (approve this ONCE in your bunker, then it is no longer needed):
$(connect_field connect_uri)

The client secret below is stored 0600 by the install step. It is a burnable
delegation to the bunker — NOT the greeter nsec. Do not paste it into docs.

client_secret=$(connect_field client_secret)
EOF
    exit 0
    ;;
esac

# ── install ──────────────────────────────────────────────────────────────────
if [ "$MODE" = "dry-run" ]; then
  info "dry-run: would write $ENV_FILE (0600) and install $UNIT_DEST"
  info "dry-run: user $NAP_BRIDGE_USER, agent dir $AGENT_DIR"
  render_env "__CLIENT_SECRET__"
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

# Reuse an existing client secret (so restarts stay connected to the same
# bunker); otherwise mint a fresh one. Never overwrite a live .env secret.
if [ -f "$ENV_FILE" ] && grep -qE '^NPC_CLIENT_SECRET=[0-9a-f]{64}$' "$ENV_FILE"; then
  info "reusing existing $ENV_FILE (client secret already present)"
  NPC_CLIENT_SECRET="$(grep -E '^NPC_CLIENT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
else
  { render_env "$(connect_field client_secret)"; } > "$ENV_FILE" || die "write $ENV_FILE failed"
  chown "${NAP_BRIDGE_USER}:${NAP_BRIDGE_USER}" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
fi

render_unit > "$UNIT_DEST" || die "write $UNIT_DEST failed"
chmod 0644 "$UNIT_DEST"

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || warn "enable $UNIT_NAME failed"
systemctl restart "$UNIT_NAME" || warn "restart $UNIT_NAME failed — check 'journalctl -u $UNIT_NAME'"

info "nap-bridge installed."
info "If this is the first install, approve this ONCE in your bunker:"
connect_field connect_uri
info "Then confirm the greeter is live: journalctl -u $UNIT_NAME -f"