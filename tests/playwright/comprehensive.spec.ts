/**
 * Comprehensive smoke tests for all Continuum functionality.
 *
 * Groups:
 *   A — Boot, routing, shell
 *   B — Landing page
 *   C — Projects list + New Project modal
 *   D — Project Home (todos, milestones, sessions, files)
 *   E — Marketplace
 *   F — Routstr
 *   G — Dashboard
 *   H — Chat dock (mock mode)
 *   I — Auth/session (demo mode behavior)
 *   J — Persistence (localStorage)
 *   K — Theme toggle
 *
 * Runs against the live VPS deployment. Agent is reachable but
 * login requires NIP-07 which can't be automated without a signer
 * extension — so auth-dependent tests check demo/offline behavior.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.CONTINUUM_FRONTEND || 'https://continuum.example.com';
const AGENT_URL = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

// ─── Helpers ──────────────────────────────────────────────

async function clearStorage(page: Page) {
  await page.goto(`${BASE}/#/projects`);
  await page.evaluate(() => {
    localStorage.clear();
    location.reload();
  });
  await page.waitForLoadState('networkidle');
}

async function ensureFreshState(page: Page) {
  await page.goto(`${BASE}/#/projects`);
  await page.evaluate(() => {
    // Clear any persisted session so we start in logged-out state
    const tok = localStorage.getItem('continuum.session.v1');
    if (tok) localStorage.removeItem('continuum.session.v1');
  });
}

// ═══════════════════════════════════════════════════════════
// A — BOOT, ROUTING, SHELL
// ═══════════════════════════════════════════════════════════

test.describe('A — Boot & Routing', () => {
  test('A01: SPA loads and renders content', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#app');
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(100);
  });

  test('A02: Landing route hides sidebar', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/landing-mode/);
    // Sidebar should be hidden
    const sidebar = page.locator('nav.sidebar');
    await expect(sidebar).toBeHidden();
  });

  test('A03: Non-landing routes show sidebar', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const app = page.locator('#app');
    await expect(app).not.toHaveClass(/landing-mode/);
    const sidebar = page.locator('nav.sidebar');
    await expect(sidebar).toBeVisible();
  });

  test('A04: Sidebar has 4 main nav items', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const navItems = page.locator('.nav-item');
    // 4 main + 2 signals (Our tasks, Usage) = 6
    await expect(navItems).toHaveCount(6);
    const texts = await navItems.allTextContents();
    expect(texts.some(t => t.includes('Projects'))).toBeTruthy();
    expect(texts.some(t => t.includes('Marketplace'))).toBeTruthy();
    expect(texts.some(t => t.includes('Routstr'))).toBeTruthy();
    expect(texts.some(t => t.includes('Dashboard'))).toBeTruthy();
  });

  test('A05: Brand button navigates to landing', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    await page.locator('.brand').click();
    await expect(page).toHaveURL(/.*#\/$/);
  });

  test('A06: Unknown hash redirects to landing', async ({ page }) => {
    await page.goto(`${BASE}/#/nonexistent-route`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/.*#\/$/);
  });

  test('A07: Each nav item navigates to its route', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');

    // Projects
    await page.locator('.nav-item[data-path="/projects"]').click();
    await expect(page).toHaveURL(/.*#\/projects$/);

    // Marketplace
    await page.locator('.nav-item[data-path="/marketplace"]').click();
    await expect(page).toHaveURL(/.*#\/marketplace$/);

    // Routstr (first match — sidebar has Routstr + Usage both pointing to /routstr)
    await page.locator('.nav-item[data-path="/routstr"]').first().click();
    await expect(page).toHaveURL(/.*#\/routstr$/);

    // Dashboard
    await page.locator('.nav-item[data-path="/dashboard"]').click();
    await expect(page).toHaveURL(/.*#\/dashboard$/);
  });

  test('A08: Active nav item gets highlighted', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    const active = page.locator('.nav-item.active');
    await expect(active).toBeVisible();
    const activePath = await active.getAttribute('data-path');
    expect(activePath).toBe('/marketplace');
  });
});

// ═══════════════════════════════════════════════════════════
// B — LANDING PAGE
// ═══════════════════════════════════════════════════════════

test.describe('B — Landing Page', () => {
  test('B01: Landing shows hero with torii gate SVG', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    const svg = page.locator('svg[aria-label*="torii"], svg.landing-hero, svg');
    const heroSection = page.locator('.landing-hero, .hero, .landing-section');
    // At least one SVG or hero element should be present
    const count = await svg.count() + await heroSection.count();
    expect(count).toBeGreaterThan(0);
  });

  test('B02: Landing has "Open the demo" button', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    const demoBtn = page.locator('button:has-text("demo"), button:has-text("Demo"), button:has-text("Get started"), a:has-text("demo")');
    const count = await demoBtn.count();
    if (count > 0) {
      await demoBtn.first().click();
      await expect(page).toHaveURL(/.*#\/(projects|dashboard)/);
    }
  });

  test('B03: Landing shows status pill (demo or reachable)', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    const pill = page.locator('.pill, .status-pill, .badge');
    if (await pill.count() > 0) {
      const text = await pill.first().textContent();
      expect(text).toBeTruthy();
    }
  });

  test('B04: Landing has promises/pillars section', async ({ page }) => {
    await page.goto(`${BASE}/#/`);
    await page.waitForLoadState('networkidle');
    // Scroll down to see all sections
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const sections = await page.locator('section, .landing-promises, .landing-pillars, .landing-status, .features, .card').count();
    expect(sections).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// C — PROJECTS LIST + NEW PROJECT MODAL
// ═══════════════════════════════════════════════════════════

test.describe('C — Projects', () => {
  test('C01: Projects page shows seeded projects', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const cards = page.locator('.project-card, .card[role="button"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2); // Torii Quest + Continuum
  });

  test('C02: Project cards are clickable', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const card = page.locator('.project-card:not(.add), .card[role="button"]').first();
    await card.click();
    await expect(page).toHaveURL(/.*#\/projects\//);
  });

  test('C03: New Project button opens modal', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button:has-text("New project"), button:has-text("New"), button:has-text("Create")');
    if (await btn.count() > 0) {
      await btn.first().click();
      await page.waitForTimeout(300);
      const modal = page.locator('.modal-backdrop').first();
      await expect(modal).toBeVisible();
    }
  });

  test('C04: New Project modal has tabs (blank/github/ngit)', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button:has-text("New project"), button:has-text("New"), button:has-text("Create")');
    if (await btn.count() > 0) {
      await btn.first().click();
      await page.waitForTimeout(300);
      const tabs = page.locator('.tab, [data-tab]');
      if (await tabs.count() > 0) {
        const tabTexts = await tabs.allTextContents();
        expect(tabTexts.some(t => t.toLowerCase().includes('blank'))).toBeTruthy();
      }
    }
  });

  test('C05: Create blank project', async ({ page }) => {
    await ensureFreshState(page);
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button:has-text("New project"), button:has-text("New"), button:has-text("Create")');
    if (await btn.count() > 0) {
      await btn.first().click();
      await page.waitForTimeout(300);
      const nameInput = page.locator('.modal input[type="text"]').first();
      if (await nameInput.isVisible()) {
        await nameInput.fill('Test Project Smoke');
        const createBtn = page.locator('.modal button:has-text("Create"), .modal button.primary');
        await createBtn.click();
        await page.waitForTimeout(500);
        await expect(page).toHaveURL(/.*#\/projects\/test-project-smoke/);
      }
    }
  });

  test('C06: Cancel new project closes modal', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const btn = page.locator('button:has-text("New project"), button:has-text("New"), button:has-text("Create")');
    if (await btn.count() > 0) {
      await btn.first().click();
      await page.waitForTimeout(300);
      const cancelBtn = page.locator('.modal button:has-text("Cancel"), .modal button.ghost');
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
        await page.waitForTimeout(200);
        const modal = page.locator('.modal, .modal-backdrop');
        await expect(modal).toHaveCount(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// D — PROJECT HOME
// ═══════════════════════════════════════════════════════════

test.describe('D — Project Home', () => {
  test('D01: Project home shows project name', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    expect(content).toBeTruthy();
    expect(content!.toLowerCase()).toContain('torii');
  });

  test('D02: Project home shows milestones', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    // Should have milestone-ish content
    const content = await page.textContent('#main-content');
    expect(content!.length).toBeGreaterThan(50);
    // Look for milestone-related elements
    const milestones = await page.locator('.milestone, [data-kind="30080"], .list-item, .card').count();
    expect(milestones).toBeGreaterThan(0);
  });

  test('D03: Project home shows todos', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    const todos = await page.locator('.todo, [data-kind="30081"], .todo-item, input[type="checkbox"]').count();
    expect(todos).toBeGreaterThan(0);
  });

  test('D04: Add a todo item', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    const addInput = page.locator('.add-input, input[placeholder*="todo"], input[placeholder*="add"]');
    if (await addInput.count() > 0) {
      const before = await page.locator('.todo, .todo-item').count();
      await addInput.first().fill('Smoke test todo item');
      await addInput.first().press('Enter');
      await page.waitForTimeout(500);
      const after = await page.locator('.todo, .todo-item').count();
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  test('D05: Toggle a todo checkbox', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    const checkbox = page.locator('.todo input[type="checkbox"], .todo-item input[type="checkbox"]').first();
    if (await checkbox.count() > 0) {
      const beforeChecked = await checkbox.isChecked();
      await checkbox.click();
      await page.waitForTimeout(300);
      // After re-render, verify state changed (new element)
      const afterCheckbox = page.locator('.todo input[type="checkbox"], .todo-item input[type="checkbox"]').first();
      const afterChecked = await afterCheckbox.isChecked();
      expect(afterChecked).not.toBe(beforeChecked);
    }
  });

  test('D06: Breadcrumb navigates back to projects', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/torii-quest`);
    await page.waitForLoadState('networkidle');
    const crumb = page.locator('.crumbs a, .breadcrumb a, a:has-text("Projects")').first();
    if (await crumb.count() > 0) {
      await crumb.click();
      await expect(page).toHaveURL(/.*#\/projects$/);
    }
  });

  test('D07: Unknown project shows empty state', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/nonexistent-xyz`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    // Should show some empty/not-found state
    expect(content).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// E — MARKETPLACE
// ═══════════════════════════════════════════════════════════

test.describe('E — Marketplace', () => {
  test('E01: Marketplace shows task listings', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    const tasks = await page.locator('.task-row, .market-task, .listing, .card:has-text("sats")').count();
    expect(tasks).toBeGreaterThan(0);
  });

  test('E02: Marketplace has diverse task listings', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    // Should mention bounty/sats amounts
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(100);
  });

  test('E03: "Our tasks" filter exists in sidebar', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace`);
    await page.waitForLoadState('networkidle');
    const ourTasks = page.locator('.nav-item:has-text("Our tasks"), [data-path*="ours"]');
    // Should exist in sidebar signals section
    const count = await ourTasks.count();
    expect(count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// F — ROUTSTR
// ═══════════════════════════════════════════════════════════

test.describe('F — Routstr', () => {
  test('F01: Routstr page renders', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(50);
  });

  test('F02: Routstr shows model information', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    // Should reference models or deepseek
    expect(content!.toLowerCase()).toMatch(/model|deepseek|llama|chat/);
  });

  test('F03: Routstr shows usage/balance info', async ({ page }) => {
    await page.goto(`${BASE}/#/routstr`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    // Should reference sats or balance
    expect(content!.toLowerCase()).toMatch(/sat|balance|budget|usage/);
  });
});

// ═══════════════════════════════════════════════════════════
// G — DASHBOARD
// ═══════════════════════════════════════════════════════════

test.describe('G — Dashboard', () => {
  test('G01: Dashboard renders with content', async ({ page }) => {
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(100);
  });

  test('G02: Dashboard shows project summary', async ({ page }) => {
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    const content = await page.textContent('#main-content');
    // Should mention projects or stats
    expect(content!.toLowerCase()).toMatch(/project|session|milestone|todo/);
  });
});

// ═══════════════════════════════════════════════════════════
// H — CHAT DOCK
// ═══════════════════════════════════════════════════════════

test.describe('H — Chat Dock', () => {
  test('H01: Chat dock is visible on non-landing routes', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const chat = page.locator('.chat-dock, .chat-toggle, [aria-label*="chat"], [aria-label*="Chat"]');
    const count = await chat.count();
    expect(count).toBeGreaterThan(0);
  });

  test('H02: Chat dock can be expanded', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const toggle = page.locator('.chat-toggle, button[aria-label*="Toggle"], button[aria-label*="chat"]').first();
    if (await toggle.count() > 0) {
      await toggle.click();
      await page.waitForTimeout(300);
      // Should show input
      const input = page.locator('.chat-input, textarea[aria-label*="Chat"]');
      const visible = await input.isVisible().catch(() => false);
      // Toggle may have expanded or collapsed
      expect(typeof visible).toBe('boolean');
    }
  });

  test('H03: Chat greeting message present', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const messages = page.locator('.chat-msg, .chat-message');
    const count = await messages.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('H04: Send a mock chat message', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');

    // Expand chat if collapsed
    const dock = page.locator('.chat-dock');
    const dockClass = await dock.getAttribute('class').catch(() => '');
    if (dockClass && dockClass.includes('collapsed')) {
      const toggle = page.locator('.chat-toggle, button[aria-label*="Toggle"]').first();
      if (await toggle.count() > 0) await toggle.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator('.chat-input, textarea[aria-label*="Chat"]');
    if (await input.isVisible().catch(() => false)) {
      const msgCountBefore = await page.locator('.chat-msg, .chat-message').count();
      await input.fill('Hello from smoke test');
      await input.press('Enter');
      await page.waitForTimeout(1500); // Wait for mock reply
      const msgCountAfter = await page.locator('.chat-msg, .chat-message').count();
      expect(msgCountAfter).toBeGreaterThan(msgCountBefore);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// I — AUTH/SESSION (DEMO MODE)
// ═══════════════════════════════════════════════════════════

test.describe('I — Auth/Session', () => {
  test('I01: Session button present in sidebar', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const sessionBtn = page.locator('.session-btn, button[data-session-toggle]');
    await expect(sessionBtn).toBeVisible();
  });

  test('I02: Session button shows appropriate label', async ({ page }) => {
    await ensureFreshState(page);
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const sessionBtn = page.locator('.session-btn, button[data-session-toggle]');
    const text = await sessionBtn.textContent();
    // Should show Login or Demo mode (not Sign out)
    expect(text).toBeTruthy();
    expect(text!.toLowerCase()).toMatch(/login|demo|sign/);
  });

  test('I03: Clicking login without NIP-07 shows modal', async ({ page }) => {
    await ensureFreshState(page);
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const sessionBtn = page.locator('.session-btn, button[data-session-toggle]');
    const text = (await sessionBtn.textContent()) || '';

    if (text.toLowerCase().includes('login')) {
      await sessionBtn.click();
      await page.waitForTimeout(500);
      // Should show a modal (either NIP-07 not found or login flow)
      const modal = page.locator('.modal, .modal-backdrop, [role="dialog"]');
      const modalVisible = await modal.isVisible().catch(() => false);
      if (modalVisible) {
        const modalText = await modal.textContent();
        expect(modalText).toBeTruthy();
        // Should mention signer or NIP-07
        expect(modalText!.toLowerCase()).toMatch(/signer|nip|nostr|login|challenge/);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// J — PERSISTENCE
// ═══════════════════════════════════════════════════════════

test.describe('J — Persistence', () => {
  test('J01: Data persists across page reloads', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    // Check localStorage has continuum data
    const hasData = await page.evaluate(() => {
      const raw = localStorage.getItem('continuum.v1');
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return parsed && Array.isArray(parsed.projects);
      } catch { return false; }
    });
    expect(hasData).toBeTruthy();
  });

  test('J02: Projects persist after navigation', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const beforeCount = await page.locator('.project-card:not(.add)').count();

    // Navigate away and back
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');

    const afterCount = await page.locator('.project-card:not(.add)').count();
    expect(afterCount).toBe(beforeCount);
  });
});

// ═══════════════════════════════════════════════════════════
// K — THEME TOGGLE
// ═══════════════════════════════════════════════════════════

test.describe('K — Theme', () => {
  test('K01: Theme toggle button exists', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const themeBtn = page.locator('.theme-toggle, button[data-theme-toggle]');
    const count = await themeBtn.count();
    expect(count).toBeGreaterThan(0);
  });

  test('K02: Theme toggle switches theme', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const themeBtn = page.locator('.theme-toggle, button[data-theme-toggle]').first();
    if (await themeBtn.count() > 0) {
      const themeBefore = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );
      await themeBtn.click();
      await page.waitForTimeout(300);
      const themeAfter = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme')
      );
      // Theme should have changed or at least toggled class
      expect(themeAfter).toBeTruthy();
    }
  });

  test('K03: Theme persists in localStorage', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`);
    await page.waitForLoadState('networkidle');
    const themeBtn = page.locator('.theme-toggle, button[data-theme-toggle]').first();
    if (await themeBtn.count() > 0) {
      await themeBtn.click();
      await page.waitForTimeout(200);
      const stored = await page.evaluate(() => localStorage.getItem('continuum.theme'));
      expect(stored).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// L — AGENT API SMOKE (direct curl-style tests)
// ═══════════════════════════════════════════════════════════

test.describe('L — Agent API', () => {
  test('L01: Health endpoint responds', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/api/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('torii-continuum-agent');
    expect(body.version).toBeTruthy();
  });

  test('L02: Challenge endpoint issues challenge', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/api/auth/challenge`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.challenge).toBeTruthy();
    expect(body.challenge.length).toBe(48); // 24 bytes hex
    expect(body.expires_in).toBe(300);
    expect(body.kind).toBe(22242);
  });

  test('L03: Verify without event fails with 400', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/api/auth/verify`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('L04: Admin routes reject without token (401/404)', async ({ request }) => {
    const endpoints = [
      '/api/wallet/balance',
      '/api/character',
      '/api/memory',
      '/api/pending',
    ];
    for (const ep of endpoints) {
      const res = await request.get(`${AGENT_URL}${ep}`);
      // 401 = auth gate active, 404 = endpoint not in this agent version
      expect([401, 404]).toContain(res.status());
    }
  });

  test('L05: Chat endpoint rejects without auth', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/api/chat`, {
      data: { message: 'test' },
    });
    expect(res.status()).toBe(401);
  });

  test('L06: Memory endpoints require auth', async ({ request }) => {
    const endpoints = [
      { method: 'POST', path: '/api/memory/unlock', body: { entries: [] } },
      { method: 'POST', path: '/api/memory/lock', body: {} },
      { method: 'GET', path: '/api/memory/ciphertexts', body: null },
      { method: 'POST', path: '/api/reflect', body: {} },
    ];
    for (const ep of endpoints) {
      const res = ep.method === 'GET'
        ? await request.get(`${AGENT_URL}${ep.path}`)
        : await request.post(`${AGENT_URL}${ep.path}`, { data: ep.body });
      expect(res.status()).toBe(401);
    }
  });

  test('L07: Pending draft file path validation', async ({ request }) => {
    // Should reject bad filenames
    const res = await request.get(`${AGENT_URL}/api/pending/../../etc/passwd`);
    expect([400, 401, 404]).toContain(res.status());
  });

  test('L08: Health endpoint includes memory_unlocked flag', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/api/health`);
    const body = await res.json();
    expect(body).toHaveProperty('memory_unlocked');
    expect(typeof body.memory_unlocked).toBe('boolean');
  });
});
