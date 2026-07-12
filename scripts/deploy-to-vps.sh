#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# deploy-to-vps.sh — Deploy Continuum frontend to production VPS
#
# Fixes the "Bad Request" login error by deploying the updated
# agent.js that only sets Content-Type when a body is present.
#
# USAGE:
#   ./scripts/deploy-to-vps.sh <vps-host> [remote-path]
#
# EXAMPLES:
#   ./scripts/deploy-to-vps.sh c03rad0r@66.92.204.38
#   ./scripts/deploy-to-vps.sh c03rad0r@23.182.128.51 /var/www/continuum
# ──────────────────────────────────────────────────────────────

HOST="${1:?Usage: $0 <vps-host> [remote-path]}"
REMOTE_PATH="${2:-/var/www/html/continuum}"
DIST_DIR="dist"

echo "→ Building frontend..."
npm ci
npm run build

echo "→ Checking for built files..."
if [ ! -d "$DIST_DIR" ]; then
  echo "✗ Build failed — $DIST_DIR not found"
  exit 1
fi

echo "→ Deploying to $HOST:$REMOTE_PATH"
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  "$DIST_DIR/" \
  "${HOST}:${REMOTE_PATH}/"

echo "→ Verifying deployment..."
ssh "$HOST" "ls -la ${REMOTE_PATH}/assets/"

echo ""
echo "✓ Deployed successfully"
echo ""
echo "  Next steps:"
echo "  1. Hard-refresh browser (Ctrl+F5 / Cmd+Shift+R)"
echo "  2. Verify the fix:"
echo "     curl -X POST https://continuum.orangesync.tech/api/auth/verify \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{}'"
echo "     # Should return 400 (expected — no event provided)"
echo "     # but NOT 'Body cannot be empty' error"
echo ""
echo "  3. Test login flow:"
echo "     curl -X POST https://agent.orangesync.tech/api/auth/challenge"
echo "     # Should return 200 with { challenge, expires_in }"
echo "     # NOT 400 with 'Empty JSON body'"
