#!/usr/bin/env bash
# deploy/continuum-deploy.sh — Reproducible Continuum frontend deployment
#
# Builds the frontend from source and deploys to one or more VPS targets.
# Usage:
#   ./deploy/continuum-deploy.sh --vps1          # Deploy to VPS1 (production)
#   ./deploy/continuum-deploy.sh --vps2          # Deploy to VPS2 (test)
#   ./deploy/continuum-deploy.sh --vps1 --vps2   # Deploy to both
#   ./deploy/continuum-deploy.sh --vps1 --agent-url https://agent.example.com
#
# Requirements:
#   - node + npm (for Vite build)
#   - ssh access to the target VPS with sudo privileges
#   - SSH key-based auth (no password prompts)
#
# Environment variables:
#   VITE_AGENT_URL     — Override agent URL (default: https://agent.orangesync.tech)
#   CONTINUUM_VPS1     — Override VPS1 host (default: 66.92.204.38)
#   CONTINUUM_VPS2     — Override VPS2 host (default: 23.182.128.51)
#   CONTINUUM_REPO     — Override repo path (default: repo root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Configuration ---
AGENT_URL="${VITE_AGENT_URL:-https://agent.orangesync.tech}"
VPS1="${CONTINUUM_VPS1:-66.92.204.38}"
VPS2="${CONTINUUM_VPS2:-23.182.128.51}"
SSH_USER="debian"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=no"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1" >&2; }

# --- Parse arguments ---
DEPLOY_VPS1=false
DEPLOY_VPS2=false

for arg in "$@"; do
  case "$arg" in
    --vps1) DEPLOY_VPS1=true ;;
    --vps2) DEPLOY_VPS2=true ;;
    --agent-url=*) AGENT_URL="${arg#*=}" ;;
    --agent-url) echo "Usage: --agent-url=VALUE, not separate"; exit 1 ;;
    --help|-h)
      echo "Usage: $0 [--vps1] [--vps2] [--agent-url=https://...]"
      echo ""
      echo "Deploys Continuum frontend to specified VPS targets."
      echo "If no --vps flag is given, deploys to BOTH by default."
      exit 0
      ;;
    *)
      error "Unknown argument: $arg"
      echo "Usage: $0 [--vps1] [--vps2] [--agent-url=https://...]"
      exit 1
      ;;
  esac
done

# Default to both if no flag specified
if ! $DEPLOY_VPS1 && ! $DEPLOY_VPS2; then
  DEPLOY_VPS1=true
  DEPLOY_VPS2=true
  warn "No VPS target specified, deploying to both VPS1 and VPS2"
fi

# --- Step 1: Build ---
echo ""
info "Building frontend with VITE_AGENT_URL=$AGENT_URL"
cd "$REPO_DIR"
VITE_AGENT_URL="$AGENT_URL" npm run build
info "Build complete"

# --- Step 2: Deploy ---
deploy_to_vps() {
  local VPS_IP="$1"
  local TARGET="$2"
  local SSH_DEST="$SSH_USER@$VPS_IP"

  echo ""
  info "Deploying to $TARGET ($VPS_IP)..."

  # Check SSH connectivity
  if ! ssh $SSH_OPTS "$SSH_DEST" "echo connected" 2>/dev/null; then
    error "Cannot reach $VPS_IP — skipping $TARGET"
    return 1
  fi

  # Copy build artifacts to temp location
  scp $SSH_OPTS -r "$REPO_DIR/dist/"* "$SSH_DEST:/tmp/continuum-deploy/" 2>/dev/null || {
    error "SCP to $VPS_IP failed"
    return 1
  }

  # Deploy with sudo on remote
  if [[ "$TARGET" == "VPS1" ]]; then
    DEPLOY_DIR="/srv/continuum"
    OWNER="www-data:www-data"
  else
    DEPLOY_DIR="/home/continuum/agent/frontend/dist"
    OWNER="continuum:continuum"
  fi

  ssh $SSH_OPTS "$SSH_DEST" "
    sudo cp /tmp/continuum-deploy/index.html $DEPLOY_DIR/ &&
    sudo cp /tmp/continuum-deploy/favicon.svg $DEPLOY_DIR/ &&
    sudo cp -r /tmp/continuum-deploy/assets/* $DEPLOY_DIR/assets/ &&
    sudo chown -R $OWNER $DEPLOY_DIR &&
    rm -rf /tmp/continuum-deploy &&
    echo 'DEPLOY_OK'
  " 2>&1 | grep -q 'DEPLOY_OK' || {
    error "Deploy to $VPS_IP failed"
    return 1
  }

  info "$TARGET deploy complete"
  return 0
}

# Deploy VPS1: production frontend (continuum.orangesync.tech)
if $DEPLOY_VPS1; then
  deploy_to_vps "$VPS1" "VPS1"
fi

# Deploy VPS2: test frontend (continuum-test.orangesync.tech)
if $DEPLOY_VPS2; then
  deploy_to_vps "$VPS2" "VPS2"
fi

# --- Step 3: Verify ---
echo ""
info "Verifying deployments..."
echo ""

if $DEPLOY_VPS1; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$AGENT_URL/api/auth/challenge" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    info "Agent endpoint reachable ($HTTP_CODE)"
  else
    warn "Agent endpoint returned $HTTP_CODE (expected 200)"
  fi
fi

info "All done!"
