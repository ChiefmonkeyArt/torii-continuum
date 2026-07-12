#!/usr/bin/env bash
# deploy-login-fix.sh — Reproducible deployment of Continuum login fix
#
# This script deploys the login fix to VPS1 (production):
#   1. Pulls latest code from the deploy branch
#   2. Installs npm dependencies
#   3. Builds the frontend with production agent URL
#   4. Copies to Caddy serve directory
#   5. Restarts the Continuum agent
#   6. Reloads Caddy
#   7. Runs Playwright tests to verify the fix
#
# Usage:
#   ./scripts/deploy-login-fix.sh              # deploy to VPS1
#   ./scripts/deploy-login-fix.sh --skip-tests  # deploy without running tests
#
# Requirements:
#   - SSH host key for 66.92.204.38
#   - sudo access on remote (debian user)
#   - Remote repo at /home/continuum/agent/repo

set -euo pipefail
SSH_HOST="debian@66.92.204.38"
REPO_DIR="/home/continuum/agent/repo"
DEPLOY_DIR="/srv/continuum/dist"
BRANCH="main"
AGENT_URL="https://agent.orangesync.tech"

echo "=== Step 1: Pull latest code ==="
ssh "$SSH_HOST" "sudo git -C $REPO_DIR pull origin $BRANCH"

echo "=== Step 2: Install dependencies ==="
ssh "$SSH_HOST" "sudo -u continuum bash -c 'cd $REPO_DIR && npm ci 2>&1 | tail -3'"

echo "=== Step 3: Build frontend ==="
ssh "$SSH_HOST" "sudo -u continuum bash -c 'cd $REPO_DIR && VITE_AGENT_URL=$AGENT_URL npm run build 2>&1'"

echo "=== Step 4: Copy to Caddy serve dir ==="
ssh "$SSH_HOST" "sudo cp -r $REPO_DIR/dist/* $DEPLOY_DIR/ && sudo chown -R debian:debian $DEPLOY_DIR/"

echo "=== Step 5: Restart agent ==="
ssh "$SSH_HOST" "sudo systemctl restart continuum-agent && sleep 2 && sudo systemctl is-active --quiet continuum-agent && echo 'AGENT_OK' || echo 'AGENT_FAILED'"

echo "=== Step 6: Reload Caddy ==="
ssh "$SSH_HOST" "sudo docker exec tollgate-caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -1"

echo "=== Step 7: Verify challenge endpoint ==="
curl -s -X POST "$AGENT_URL/api/auth/challenge" | head -c 100
echo ""
echo "=== Deploy complete ==="

# Run Playwright tests if not skipped
if [[ "${1:-}" != "--skip-tests" ]]; then
  echo "=== Running Playwright login-fix tests ==="
  cd "$(dirname "$0")/../tests/playwright"
  npx playwright test login-fix.spec.ts --config=playwright.config.ts 2>&1
  echo "=== Tests complete ==="
fi
