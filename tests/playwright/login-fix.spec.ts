/**
 * Login fix verification — tests that the Content-Type header bug is fixed.
 *
 * The bug: agent.js sent Content-Type: application/json on every request,
 * including POST /api/auth/challenge which has NO body. Fastify rejects
 * POST requests with Content-Type: application/json and empty body with:
 *   FST_ERR_CTP_EMPTY_JSON_BODY — "Body cannot be empty when content-type
 *   is set to 'application/json'"
 *
 * Fix: agent.js only sets Content-Type when body !== null && body !== undefined.
 *
 * Groups:
 *   L — API-level verification (direct fetch tests against production agent)
 *   M — UI integration (login button + modal state on production)
 *   N — Deployment verification (ensure fix is in the deployed bundle)
 *   P — Full user experience (reproduces the original bug scenario)
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_PROD = process.env.CONTINUUM_FRONTEND || 'https://continuum.example.com';
const AGENT_PROD = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

// ═══════════════════════════════════════════════════════════
// L — API-LEVEL VERIFICATION (agent.example.com)
// ═══════════════════════════════════════════════════════════

test.describe('L — API-level login fix verification', () => {
  test('L01: challenge with Content-Type + empty body returns 400 (expected error)', async ({ page }) => {
    const resp = await page.request.post(`${AGENT_PROD}/api/auth/challenge`, {
      headers: { 'Content-Type': 'application/json' },
      data: undefined,
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('Bad Request');
    expect(body.message).toContain('empty');
  });

  test('L02: challenge WITHOUT Content-Type + empty body returns 200 (fixed behaviour)', async ({ page }) => {
    const resp = await page.request.post(`${AGENT_PROD}/api/auth/challenge`, {
      headers: {},  // no Content-Type — what the fixed frontend sends
      data: undefined,
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('challenge');
    expect(typeof body.challenge).toBe('string');
    expect(body.challenge.length).toBeGreaterThan(0);
  });

  test('L03: challenge with Content-Type + empty JSON object returns 200 (workaround)', async ({ page }) => {
    const resp = await page.request.post(`${AGENT_PROD}/api/auth/challenge`, {
      headers: { 'Content-Type': 'application/json' },
      data: {},  // empty object, not undefined
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('challenge');
  });
});

// ═══════════════════════════════════════════════════════════
// M — UI INTEGRATION (continuum.example.com)
// ═══════════════════════════════════════════════════════════

test.describe('M — UI-level login fix verification', () => {
  test('M01: login button exists and is visible on projects page', async ({ page }) => {
    // Navigate to a non-landing page so sidebar is visible
    await page.goto(`${BASE_PROD}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const loginBtn = page.locator('[data-session-toggle]');
    await expect(loginBtn).toBeVisible({ timeout: 5000 });
    expect(await loginBtn.innerText()).toMatch(/sign.?in|login|nostr/i);
  });

  test('M02: clicking login does NOT show "Could not reach agent: Bad Request"', async ({ page }) => {
    // Go to a page where sidebar is visible
    await page.goto(`${BASE_PROD}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Click login
    const loginBtn = page.locator('[data-session-toggle]');
    await loginBtn.click();
    await page.waitForTimeout(1500);

    // THE KEY TEST: The page should NOT show "Could not reach agent: Bad Request"
    const pageText = await page.locator('body').innerText();
    expect(pageText).not.toContain('Could not reach agent');
    expect(pageText).not.toContain('Bad Request');

    // Should show either "Requesting challenge" or "NIP-07 signer not found"
    const hasChallengeOrSigner =
      pageText.includes('Requesting challenge') ||
      pageText.includes('signer not found') ||
      pageText.includes('signer will sign');
    expect(hasChallengeOrSigner).toBeTruthy();
  });

  test('M03: modal shows both signer options (nos2x-fox + Plebeian Signer)', async ({ page }) => {
    await page.goto(`${BASE_PROD}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const loginBtn = page.locator('[data-session-toggle]');
    await loginBtn.click();
    await page.waitForTimeout(1500);

    const pageText = await page.locator('body').innerText();
    // nos2x-fox must be mentioned as a signer option
    expect(pageText).toContain('nos2x-fox');
    // Plebeian Signer should still be listed
    expect(pageText).toContain('Plebeian Signer');
  });
});

// ═══════════════════════════════════════════════════════════
// N — DEPLOYMENT BUNDLE VERIFICATION (production)
// ═══════════════════════════════════════════════════════════

test.describe('N — Deployment bundle verification', () => {
  test('N01: deployed JS bundle has conditional Content-Type pattern', async ({ page }) => {
    await page.goto(BASE_PROD, { waitUntil: 'domcontentloaded' });

    // Get the main JS module URL
    const jsUrl = await page.evaluate(() => {
      const script = document.querySelector('script[type="module"][crossorigin]');
      return script ? (script as HTMLScriptElement).src : null;
    });
    expect(jsUrl).toBeTruthy();

    // Fetch the bundle
    const resp = await page.request.get(jsUrl!);
    expect(resp.ok()).toBeTruthy();
    const bundle = await resp.text();

    // The fix is present when Content-Type assignment exists in the bundle.
    // Minified pattern (esbuild/vite): a["Content-Type"]="application/json"
    // or: a["Content-Type"]="application/json"
    // The bundle should have exactly one Content-Type reference (the fixed conditional path).
    // The old bug had it in the fetch options object: {"Content-Type":"application/json"}
    // The fix has it as an assignment to: a["Content-Type"]="application/json"

    // Count how many times Content-Type appears — should be exactly 1
    const contentTypeMatches = bundle.match(/Content-Type/g);
    expect(contentTypeMatches).not.toBeNull();
    expect(contentTypeMatches!.length).toBe(1);

    // Verify the Content-Type assignment is the bracket-access pattern (fixed code)
    // Old pattern (broken): {"Content-Type":"..."} in object literal
    // New pattern (fixed): var["Content-Type"]="..." or var["Content-Type"]=("...") after null guard
    const hasBracketAccessPattern =
      /\[["']Content-Type["']\]\s*[:=]/.test(bundle);
    expect(hasBracketAccessPattern).toBeTruthy();

    // Verify it's NOT an unconditional object-literal pattern (the old bug)
    // Old broken code in fetch options: {"Content-Type":"application/json"}
    const hasObjectLiteralPattern =
      /\{["']Content-Type["']\s*:/.test(bundle);
    expect(hasObjectLiteralPattern).toBeFalsy();
  });

  test('N02: login button text is signer-agnostic (supports nos2x-fox)', async ({ page }) => {
    await page.goto(BASE_PROD, { waitUntil: 'domcontentloaded' });

    const jsUrl = await page.evaluate(() => {
      const script = document.querySelector('script[type="module"][crossorigin]');
      return script ? (script as HTMLScriptElement).src : null;
    });
    expect(jsUrl).toBeTruthy();

    const resp = await page.request.get(jsUrl!);
    expect(resp.ok()).toBeTruthy();
    const bundle = await resp.text();

    // Should contain the signer-agnostic text
    expect(bundle).toContain('your NIP-07 signer');
  });
});

// ═══════════════════════════════════════════════════════════
// P — FULL USER EXPERIENCE VERIFICATION
// ═══════════════════════════════════════════════════════════

test.describe('P — Full user experience (reproduces the original bug scenario)', () => {
  test('P01: landing page loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(BASE_PROD, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    expect(errors.length).toBe(0);
    expect(await page.title()).toBeTruthy();
  });

  test('P02: agent challenge endpoint is reachable from browser context', async ({ page }) => {
    // This is exactly what the Login button does — POST /api/auth/challenge
    const resp = await page.request.post(`${AGENT_PROD}/api/auth/challenge`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('challenge');
    expect(body).toHaveProperty('kind');
    expect(body.kind).toBe(22242);
  });
});
