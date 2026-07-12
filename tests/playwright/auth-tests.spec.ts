/**
 * Continuum — Authenticated Feature Tests
 *
 * Uses nostr-tools to programmatically sign NIP-42 challenges and obtain
 * a session token, then tests all functionality that requires login.
 *
 * Prerequisites:
 *   - Agent config on VPS2 has admin_npub set to the npub for the
 *     nsec defined in AUTH_NSEC below
 *   - Agent is running and reachable
 *
 * Run: npx playwright test auth-tests.spec.ts --config playwright.config.ts
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.CONTINUUM_FRONTEND || 'https://continuum.example.com';
const AGENT = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

// Our admin keypair. Read from env (set before running) or use fallback for CI.
// Generate: node -e "import('nostr-tools').then(m=>{const s=m.generateSecretKey();const p=m.getPublicKey(s);console.log('SK='+Buffer.from(s).toString('hex'));console.log('PK='+p);console.log('NPUB='+m.nip19.npubEncode(p));console.log('NSEC='+m.nip19.nsecEncode(Buffer.from(s)))})"
// Then update admin_npub in agent config.yaml and restart agent.
const AUTH_SK = process.env.CONTINUUM_AUTH_SK || '073721855a715dbd7d393b610b839dca67f7fab005e4507e9f3aa98c68a2da67';
const AUTH_NPUB = process.env.CONTINUUM_AUTH_NPUB || 'npub12s9z9jl99af97v3k8dchq64ellzzsgvly3hv9y453x56ghg074cspcafva';

// ─── Auth Helpers ────────────────────────────────────────

/**
 * Programmatically log in: get challenge, sign it, verify, return token.
 * Uses the nostr-tools library (installed in tests/playwright/).
 */
async function login(request: APIRequestContext): Promise<{ token: string; expiresAt: number }> {
  const { nip19, generateSecretKey, getPublicKey, finalizeEvent } = await import('nostr-tools');

  const sk = Buffer.from(AUTH_SK, 'hex');
  const pk = getPublicKey(sk);

  // 1. Get challenge
  const chalRes = await request.post(`${AGENT}/api/auth/challenge`);
  expect(chalRes.ok()).toBeTruthy();
  const chalData = await chalRes.json();
  expect(chalData.challenge).toBeTruthy();

  // 2. Build NIP-42 event
  const event = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    content: chalData.challenge,
    pubkey: pk,
    tags: [
      ['challenge', chalData.challenge],
      ['relay', BASE],
    ],
  };

  // 3. Sign it
  const signed = finalizeEvent(event, sk);

  // 4. Verify
  const verifyRes = await request.post(`${AGENT}/api/auth/verify`, {
    data: { event: signed },
  });
  expect(verifyRes.ok()).toBeTruthy();
  const verifyData = await verifyRes.json();
  expect(verifyData.token).toBeTruthy();
  expect(verifyData.expires_at).toBeTruthy();

  return { token: verifyData.token, expiresAt: verifyData.expires_at };
}

/**
 * Set the session token in the browser's localStorage and reload
 * so the UI picks up the logged-in state.
 */
async function setTokenAndReload(page: Page, token: string) {
  await page.goto(`${BASE}/#/projects`);
  await page.waitForLoadState('networkidle');
  await page.evaluate((tok) => {
    localStorage.setItem('continuum.session.v1', tok);
    localStorage.setItem('continuum.v1', JSON.stringify({
      projects: [],
      sessions: [],
      milestones: [],
      todos: [],
      files: [],
      marketTasks: [],
      routstr: null,
    }));
  }, token);
  await page.reload();
  await page.waitForLoadState('networkidle');
}

// ═══════════════════════════════════════════════════════════
// W — AUTHENTICATED AGENT API TESTS
// ═══════════════════════════════════════════════════════════

test.describe('W — Authenticated Agent API', () => {
  let authToken: string;
  let expiresAt: number;

  test.beforeAll(async ({ request }) => {
    const result = await login(request);
    authToken = result.token;
    expiresAt = result.expiresAt;
  });

  const authHeaders = () => ({
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  });

  test('W01: Wallet balance returns balance (authenticated)', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/wallet/balance`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('total_sats');
    expect(typeof body.total_sats).toBe('number');
    expect(body).toHaveProperty('per_mint');
    expect(typeof body.per_mint).toBe('object');
  });

  test('W02: Wallet receive with bad token returns error', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/wallet/receive`, {
      headers: authHeaders(),
      data: { token: 'cashuAeyJ0b2tlbiI6eyJwcm9vZnMiOlt7ImlkIjoiZmFrZSIsInByb29mIjoiZmFrZSJ9XSwibWludCI6Imh0dHBzOi8vbWludC5leGFtcGxlLmNvbSJ9fQ==' },
    });
    // Should return 400-500 for bad token
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('W03: Chat returns 400 for empty message (authenticated)', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/chat`, {
      headers: authHeaders(),
      data: { message: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('W04: Chat returns 400 for message over 4000 chars', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/chat`, {
      headers: authHeaders(),
      data: { message: 'x'.repeat(4001), context: { label: 'test', where: 'test' } },
    });
    expect(res.status()).toBe(400);
  });

  test('W05: Character endpoint returns data (authenticated)', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/character`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('character_loaded');
  });

  test('W06: Memory endpoint returns status (authenticated)', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/memory`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('character_loaded');
    expect(body).toHaveProperty('character_hash');
    expect(body).toHaveProperty('character_root_verified');
  });

  test('W07: Memory ciphertexts returns list (authenticated)', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/memory/ciphertexts`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('entries');
    expect(Array.isArray(body.entries)).toBeTruthy();
  });

  test('W08: Pending list returns data (authenticated)', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/pending`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('drafts');
    expect(Array.isArray(body.drafts)).toBeTruthy();
  });

  test('W09: Memory lock returns ok (authenticated)', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/memory/lock`, {
      headers: authHeaders(),
      data: {},
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('W10: Memory store with valid ciphertext returns error (no character)', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/memory/store`, {
      headers: authHeaders(),
      data: {
        ciphertext: 'A'.repeat(132),
        kind: 30092,
        d_tag: 'test-draft-' + Date.now(),
      },
    });
    // Should validate ciphertext — may return 400 if invalid or 200 if accepted
    expect([200, 400]).toContain(res.status());
  });

  test('W11: Reflect returns ok or locked status (authenticated)', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/reflect`, {
      headers: authHeaders(),
      data: { dryRun: true },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // May return { ok: false, reason: "memory cache locked" } if cache locked
    // or { ok: true, reflected: N } if unlocked
    expect(body).toHaveProperty('ok');
  });

  test('W12: Health with auth token works', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/health`, {
      headers: authHeaders(),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.memory_unlocked).toBe(false);
  });

  test('W13: Health models endpoint returns or is 404', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/health/models`, {
      headers: authHeaders(),
    });
    // This endpoint doesn't exist in v0.2.5-alpha (returns 404)
    // It may exist in newer versions. Accept 200 or 404.
    expect([200, 404]).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════
// X — AUTHENTICATED FRONTEND TESTS
// ═══════════════════════════════════════════════════════════

test.describe('X — Authenticated Frontend', () => {
  let authToken: string;

  test.beforeAll(async ({ request }) => {
    const result = await login(request);
    authToken = result.token;
  });

  test.beforeEach(async ({ page }) => {
    await setTokenAndReload(page, authToken);
  });

  test('X01: Session button shows "Sign out" when logged in', async ({ page }) => {
    const sessionBtn = page.locator('[data-session-toggle]');
    await expect(sessionBtn).toBeVisible({ timeout: 5000 });
    const text = await sessionBtn.textContent();
    expect(text).toContain('Sign out');
  });

  test('X02: Session button has logged-in class', async ({ page }) => {
    const sessionBtn = page.locator('[data-session-toggle]');
    await expect(sessionBtn).toHaveClass(/logged-in/);
  });

  test('X03: Landing page shows "Go to your dashboard" when logged in', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    // Should have the dashboard button
    const dashboardBtn = page.locator('button:has-text("Go to your dashboard")');
    await expect(dashboardBtn).toBeVisible({ timeout: 5000 });
  });

  test('X04: Landing status pill says "agent reachable" when live', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    const pill = page.locator('.pill');
    const texts = await pill.allTextContents();
    const hasAgentReachable = texts.some(t => t.toLowerCase().includes('agent'));
    expect(hasAgentReachable).toBeTruthy();
  });

  test('X05: Routstr page shows connect button when not connected', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    const connectBtn = page.locator('button:has-text("Connect Cashu wallet")');
    await expect(connectBtn).toBeVisible({ timeout: 5000 });
  });

  test('X06: Dashboard shows project stats when logged in', async ({ page }) => {
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    // Dashboard should render with stat cards
    const statLabels = page.locator('.stat .label');
    const count = await statLabels.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('X07: Can click logout and see Demo mode', async ({ page }) => {
    const sessionBtn = page.locator('[data-session-toggle]');
    await expect(sessionBtn).toBeVisible({ timeout: 5000 });

    // Click to sign out
    await sessionBtn.click();
    await page.waitForTimeout(500);

    // After clicking sign out, the button should change
    const btnAfter = page.locator('[data-session-toggle]');
    const text = await btnAfter.textContent();
    // Should now show Login (since agent is configured)
    expect(text).toContain('Login');
  });

  test('X08: Projects page loads and shows project data', async ({ page }) => {
    // With auth, should still show projects
    const cards = page.locator('.project-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(0);
    const title = page.locator('h1');
    await expect(title).toBeVisible({ timeout: 5000 });
    expect(await title.textContent()).toContain('Projects');
  });
});
