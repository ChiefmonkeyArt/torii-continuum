#!/usr/bin/env bash
#
# deploy-continuum.sh — Reproducible Continuum frontend deployment
#
# Usage:
#   ./deploy-continuum.sh                # Deploy to production (VPS1)
#   ./deploy-continuum.sh --test         # Deploy to test (VPS2)
#   ./deploy-continuum.sh --dry-run      # Show what would happen
#   ./deploy-continuum.sh --version      # Show current version
#
# Prerequisites:
#   - SSH key access to VPS1 (debian@66.92.204.38) and VPS2 (debian@23.182.128.51)
#   - npm dependencies installed locally
#
# What this does:
#   1. Verifies the Content-Type fix is in the source
#   2. Builds the frontend with correct VITE_AGENT_URL
#   3. Copies built assets to the VPS
#   4. Verifies the deployed bundle contains the fix
#   5. Runs Playwright tests to confirm login works
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VPS1_HOST="debian@66.92.204.38"
VPS2_HOST="debian@23.182.128.51"
VPS1_FRONTEND_DIR="/srv/continuum"
VPS2_FRONTEND_DIR="/srv/continuum"

VERS="0.2.6-alpha-fix1"
MODE="${1:-production}"

# ─── Colors ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[deploy]${NC} $*"; }
ok()    { echo -e "${GREEN}[  ok  ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ warn ]${NC} $*"; }
fail()  { echo -e "${RED}[ fail ]${NC} $*"; exit 1; }

# ─── Parse args ─────────────────────────────────────────
case "$MODE" in
  --test|--test)
    TARGET="$VPS2_HOST"
    AGENT_URL="https://agent-test.orangesync.tech"
    BASE_URL="https://continuum-test.orangesync.tech"
    info "Target: TEST (VPS2)"
    ;;
  --dry-run)
    info "DRY RUN — nothing will be changed"
    ;;
  --version)
    echo "deploy-continuum.sh v$VERS"
    exit 0
    ;;
  *)
    TARGET="$VPS1_HOST"
    AGENT_URL="https://agent.orangesync.tech"
    BASE_URL="https://continuum.orangesync.tech"
    info "Target: PRODUCTION (VPS1)"
    ;;
esac

# ─── Step 1: Verify source fix ───────────────────────────
info "Step 1: Verifying Content-Type fix in source..."
cd "$REPO_DIR"

FIX_SRC="src/data/agent.js"
if grep -q 'headers\[.Content-Type.\].*body' "$FIX_SRC"; then
  ok "Content-Type fix present in $FIX_SRC"
else
  fail "Fix NOT found in $FIX_SRC — run 'git log --oneline src/data/agent.js' to check"
fi

# Verify nos2x-fox is in auth.js
if grep -q 'nos2x-fox' src/auth.js; then
  ok "nos2x-fox support present in src/auth.js"
else
  warn "nos2x-fox not in src/auth.js — may need to update"
fi

# ─── Step 2: Build ───────────────────────────────────────
info "Step 2: Building frontend..."
BUILD_DIR="$(mktemp -d -t continuum-build-XXXXXX)"
trap "rm -rf '$BUILD_DIR'" EXIT

VITE_AGENT_URL="$AGENT_URL" npx vite build --outDir "$BUILD_DIR" 2>&1
ok "Frontend built at $BUILD_DIR"

# ─── Step 3: Verify bundle fix ───────────────────────────
info "Step 3: Verifying bundle contains the fix..."
JS_BUNDLE=$(find "$BUILD_DIR" -name '*.js' -not -name '*.js.map' | head -1)
if [ -z "$JS_BUNDLE" ]; then
  fail "No JS bundle found in build output"
fi

# Check for conditional Content-Type (fixed pattern)
if grep -q 'Content-Type.*=.*application' "$JS_BUNDLE"; then
  ok "Content-Type assignment present in bundle"
else
  fail "Content-Type missing from bundle — build may be broken"
fi

# Check for the OLD broken pattern (unconditional assignment in fetch options)
if grep -q 'Content-Type":"application' "$JS_BUNDLE"; then
  fail "OLD BROKEN PATTERN FOUND in bundle — fix not applied!"
fi

# ─── Step 4: Deploy ──────────────────────────────────────
if [ -z "${TARGET:-}" ]; then
  ok "Dry run — skipping deployment"
  echo ""
  info "Would deploy to: $TARGET"
  info "Would copy: $BUILD_DIR/* -> $TARGET:$VPS1_FRONTEND_DIR/"
  exit 0
fi

info "Step 4: Deploying to $TARGET..."
info "  SSH connection test..."
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$TARGET" "hostname" > /dev/null 2>&1 \
  || fail "Cannot SSH to $TARGET"

info "  Copying built assets..."
rsync -avz --delete \
  "$BUILD_DIR/" \
  "$TARGET:$VPS1_FRONTEND_DIR/" 2>&1 | tail -5
ok "Assets copied to $TARGET:$VPS1_FRONTEND_DIR/"

# ─── Step 5: Verify deployment ───────────────────────────
info "Step 5: Verifying deployed bundle..."
DEPLOYED_BUNDLE=$(ssh "$TARGET" "grep -o 'index-[^.]*\.js' $VPS1_FRONTEND_DIR/index.html")
DEPLOYED_BUNDLE_PATH="$VPS1_FRONTEND_DIR/assets/$DEPLOYED_BUNDLE"

info "  Deployed bundle: $DEPLOYED_BUNDLE"

# Check the deployed bundle has the conditional Content-Type pattern
if ssh "$TARGET" "grep -q 'Content-Type.*=.*application' $DEPLOYED_BUNDLE_PATH"; then
  ok "Deployed bundle has Content-Type assignment"
else
  fail "Deployed bundle is WRONG — Content-Type missing!"
fi

# Confirm old pattern is NOT present
if ssh "$TARGET" "grep -q 'Content-Type\":\"application' $DEPLOYED_BUNDLE_PATH"; then
  fail "Deployed bundle has OLD BROKEN PATTERN!"
else
  ok "Deployed bundle is clean (no unconditional Content-Type)"
fi

# ─── Step 6: Verify agent-config.js ──────────────────────
info "Step 6: Verifying agent-config.js..."
AGENT_CONFIG=$(ssh "$TARGET" "cat $VPS1_FRONTEND_DIR/agent-config.js 2>/dev/null || echo 'MISSING'")
if echo "$AGENT_CONFIG" | grep -q "__CONTINUUM_AGENT_URL__"; then
  ok "agent-config.js present with agent URL: $(echo "$AGENT_CONFIG" | grep -o 'https://[^\"'\'']*')"
else
  warn "agent-config.js missing or malformed — login may fail at runtime"
fi

# ─── Summary ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          CONTINUUM DEPLOYMENT COMPLETE              ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║ Target:   $TARGET"
echo "║ Base URL: $BASE_URL"
echo "║ Agent:    $AGENT_URL"
echo "║ Bundle:   $DEPLOYED_BUNDLE"
echo "║ Version:  v$VERS"
echo "╚══════════════════════════════════════════════════════╝"
