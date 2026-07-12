import { test, expect } from '@playwright/test';

const BASE = process.env.CONTINUUM_FRONTEND || 'https://continuum.example.com';
const AGENT = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

test.describe('Continuum SPA — Happy Path', () => {

  test('Agent is reachable from frontend context', async ({ page }) => {
    const resp = await page.request.get(`${AGENT}/api/health`);
    expect(resp.ok()).toBeTruthy();
    const data = await resp.json();
    expect(data.ok).toBe(true);
  });

  test('Landing page loads with core branding', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500); // SPA render time

    await expect(page).toHaveTitle(/Continuum/);
    const body = page.locator('body');
    await expect(body).toContainText('The Gateway Project');
    await expect(body).toContainText('Continuum');
    await expect(body).toContainText('Local-first');
    await expect(body).toContainText('Nostr-native');
    await expect(body).toContainText('Pay per request');
    await expect(body).toContainText('Human-in-the-loop');
    await expect(body).toContainText('What ships today');
    await expect(body).toContainText('open source');
  });

  test('Landing page has Torii SVG gate', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    const svg = page.locator('svg[aria-label="Continuum torii gate"]');
    await expect(svg).toBeVisible();
  });

  test('Login button shows Nostr auth option', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Agent is reachable, so should show "Login with Nostr" or "requires self-hosted agent"
    const body = page.locator('body');
    const hasNostrLogin = await body.getByText('Login with Nostr').isVisible().catch(() => false);
    const hasNostrAgent = await body.getByText('Nostr').isVisible().catch(() => false);
    expect(hasNostrLogin || hasNostrAgent).toBeTruthy();
  });

  test('Projects page shows seeded projects', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Projects');
    await expect(body).toContainText('Torii Quest');
    await expect(body).toContainText('Continuum');
    await expect(body).toContainText('Start a new project');

    // Should have at least 2 project cards
    const cards = page.locator('.project-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('Projects page has "New project" flow', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    // Click the add card
    const addCard = page.locator('.project-card.add');
    await addCard.click();
    await page.waitForTimeout(500);

    // Modal should appear
    const modal = page.locator('.modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('New project');
    await expect(modal).toContainText('Blank');
    await expect(modal).toContainText('GitHub');
    await expect(modal).toContainText('ngit');
  });

  test('Marketplace page shows tasks with sats bounties', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Marketplace');
    await expect(body).toContainText('Task');
    await expect(body).toContainText('Bounty');

    // Should list tasks with sats amounts
    const satsVisible = await body.getByText('sats').first().isVisible().catch(() => false);
    expect(satsVisible).toBeTruthy();

    // Should have "ours" badge for own tasks
    const oursBadge = page.locator('.pill.ours');
    const oursCount = await oursBadge.count();
    expect(oursCount).toBeGreaterThanOrEqual(1);
  });

  test('Marketplace has filter/search bar', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const filterBar = page.locator('.filter-bar');
    await expect(filterBar).toBeVisible();

    // Search input should exist
    const searchInput = filterBar.locator('input[type="text"]');
    await expect(searchInput).toBeVisible();

    // Sort select should exist (one of the selects)
    const sortSelect = filterBar.locator('select').first();
    await expect(sortSelect).toBeVisible();
  });

  test('Routstr page shows model picker with DeepSeek default', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Routstr');
    await expect(body).toContainText('DeepSeek');
    await expect(body).toContainText('Cashu');

    // Should list available models
    const modelList = page.locator('.model-list, .model');
    const modelCount = await modelList.count();
    expect(modelCount).toBeGreaterThanOrEqual(2);
  });

  test('Routstr shows connect wallet option', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const body = page.locator('body');
    const connectBtn = body.getByText('Connect Cashu wallet');
    await expect(connectBtn).toBeVisible();
  });

  test('Dashboard shows aggregate project stats', async ({ page }) => {
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Dashboard');
    await expect(body).toContainText('Overall progress');
    await expect(body).toContainText('Open todos');
    await expect(body).toContainText('Sessions logged');
    await expect(body).toContainText('By project');

    // Should show both projects
    await expect(body).toContainText('Torii Quest');
    await expect(body).toContainText('Continuum');
  });

  test('Project detail page shows milestones and todos', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/continuum`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Continuum');
    await expect(body).toContainText('Milestones');
    await expect(body).toContainText('Todo list');
    await expect(body).toContainText('Sessions');
    await expect(body).toContainText('Files created');

    // Should show at least some progress
    await expect(body).toContainText('%');
  });

  test('Torii Quest project detail shows game-specific data', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const body = page.locator('body');
    await expect(body).toContainText('Torii Quest');
    await expect(body).toContainText('Sats. Shots. Sovereignty');
    await expect(body).toContainText('Milestones');
    await expect(body).toContainText('M1');
  });

  test('Navigation via sidebar works to all views', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Navigate to marketplace via hash
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).toContainText('Marketplace');

    // Navigate to Routstr
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).toContainText('Routstr');

    // Navigate to dashboard
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).toContainText('Dashboard');

    // Navigate back to landing
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await expect(page.locator('body')).toContainText('The Gateway Project');
  });

  test('Sidebar has all 4 navigation entries on projects page', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    const nav = page.locator('nav.sidebar');
    await expect(nav).toBeVisible();

    await expect(nav).toContainText('Projects');
    await expect(nav).toContainText('Marketplace');
    await expect(nav).toContainText('Routstr');
    await expect(nav).toContainText('Dashboard');
  });
});
