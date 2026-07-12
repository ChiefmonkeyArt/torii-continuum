#!/usr/bin/env bash
# Continuum — build + deploy + verify pipeline
# Reproducible: run from repo root on any machine with SSH+VPS access
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
echo "=== Continuum Build + Deploy + Verify ==="
echo "Root: $REPO_ROOT"
echo ""

# ── Step 1: Install deps ──
echo "--- Step 1: Install dependencies ---"
npm install 2>&1 | tail -3
echo ""

# ── Step 2: Rebuild frontend ──
echo "--- Step 2: Build frontend (VITE_AGENT_URL=${VITE_AGENT_URL:-https://agent.orangesync.tech}) ---"
rm -rf dist/
VITE_AGENT_URL="${VITE_AGENT_URL:-https://agent.orangesync.tech}" npx vite build 2>&1
echo "Build complete: $(du -sh dist/ | cut -f1)"
echo ""

# ── Step 3: Run auth test suite ──
echo "--- Step 3: Run auth flow tests ---"
cd tests/playwright
npx playwright test auth-flow.spec.ts --config playwright.config.ts 2>&1
echo ""

# ── Step 4: Run coverage gap tests ──
echo "--- Step 4: Run coverage gap tests ---"
npx playwright test coverage-gaps.spec.ts --config playwright.config.ts 2>&1
echo ""

# ── Step 5: Run comprehensive smoke tests ──
echo "--- Step 5: Run comprehensive smoke tests ---"
npx playwright test comprehensive.spec.ts --config playwright.config.ts 2>&1
echo ""

# ── Step 6: Deploy to VPS ──
VPS_SSH="${1:-}"
VPS_PATH="${2:-/srv/continuum}"
if [ -n "$VPS_SSH" ]; then
  echo "--- Step 6: Deploy to $VPS_SSH:$VPS_PATH ---"
  # Copy to temp directory first (user has write access to /tmp)
  rsync -avz --delete "$REPO_ROOT/dist/" "${VPS_SSH}:/tmp/continuum-deploy/" 2>&1
  # Move into place with sudo (target dirs owned by www-data or continuum)
  ssh ${VPS_SSH%@*}@${VPS_SSH##*@} "sudo cp /tmp/continuum-deploy/index.html $VPS_PATH/ && \
    sudo cp /tmp/continuum-deploy/favicon.svg $VPS_PATH/ && \
    sudo cp -r /tmp/continuum-deploy/assets/* $VPS_PATH/assets/ && \
    sudo chown -R www-data:www-data $VPS_PATH && \
    rm -rf /tmp/continuum-deploy && echo 'DEPLOY OK'"
  echo "Deploy complete."
else
  echo "--- Step 6: SKIP DEPLOY (no VPS_SSH arg) ---"
  echo "Pass SSH target as arg: $0 user@vps-ip"
  echo "dist/ is ready at $REPO_ROOT/dist/"
fi
echo ""

# ── Step 7: Verify live site ──
if [ -n "${VPS_HOST:-}" ]; then
  echo "--- Step 7: Verify deployed site ---"
  SITE_URL="${3:-https://continuum-test.orangesync.tech}"
  curl -sI "$SITE_URL" | head -3
  echo ""

  echo "--- Step 8: Run login-fix tests ---"
  cd "$REPO_ROOT/tests/playwright"
  npx playwright test login-fix.spec.ts --config playwright.config.ts 2>&1
  echo ""

  echo "--- Step 9: Verify challenge endpoint (regression) ---"
  AGENT_URL="${4:-https://agent-test.orangesync.tech}"
  curl -s -X POST "$AGENT_URL/api/auth/challenge" -H "Origin: $SITE_URL" | python3 -m json.tool
  echo ""
fi

echo "=== All done ==="
echo "Summary: build OK, tests OK, deploy ${VPS_HOST:+OK}" "${VPS_HOST:-SKIPPED}"
