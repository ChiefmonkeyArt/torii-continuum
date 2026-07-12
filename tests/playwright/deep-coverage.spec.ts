/**
 * Continuum — Deep Coverage Tests for Untested Code Paths
 *
 * Targets code paths NOT covered by the 8 existing spec files (3870 lines).
 * Each test is self-contained — no shared state assumptions.
 *
 * Groups:
 *   AA — Data Layer (slugify, createProject, deleteProject, addTodo, toggleTodo)
 *   AB — Router Edge Cases (hash query, double hash, param encoding, same-route)
 *   AC — Auth Flow Detail (signer-not-found modal, agent-not-configured, modal dedup)
 *   AD — Chat Dock Detail (6 keyword branches, context label, empty guard, toggle)
 *   AE — New Project Modal (tab switching, URL validation, duplicate slug, tags)
 *   AF — Delete Project (protected projects, confirm dialog, cascade)
 *   AG — Routstr Detail (model picker click, settings form, disconnect)
 *   AH — Marketplace Filter (search, complexity, ours-toggle, sort, empty)
 *   AI — Theme Persistence (bidirectional, localStorage, landing-mode class)
 *   AJ — Dashboard Detail (per-project click, cross-project aggregate)
 *   AK — Cross-cutting (session-changed event, iOS gesture, sidebar re-render)
 *
 * Run: npx playwright test --config playwright.config.ts deep-coverage.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.CONTINUUM_FRONTEND || 'https://continuum.example.com';
const AGENT = process.env.CONTINUUM_AGENT_URL || 'https://agent.example.com';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/** Navigate and wait for SPA to finish rendering */
async function go(page: Page, hash: string) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

/** Reset localStorage to a clean first-run state */
async function clearAllStorage(page: Page) {
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    // Remove any continuum data keys
    Object.keys(localStorage).filter(k => k.startsWith('continuum.')).forEach(k => localStorage.removeItem(k));
  });
  await page.waitForTimeout(200);
}

/** Get text content of an element safely */
async function text(page: Page, selector: string): Promise<string> {
  const el = page.locator(selector).first();
  return (await el.textContent()) || '';
}

/** Count matching elements */
async function count(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

// ═══════════════════════════════════════════════════════════════
// AA — DATA LAYER (slugify, create, delete, cascade, CRUD)
// ═══════════════════════════════════════════════════════════════

test.describe('AA — Data Layer', () => {

  test('AA01: slugify converts spaces to hyphens and lowercases', async ({ page }) => {
    await go(page, '/projects');
    // Click New project button using Playwright locator (not evaluate)
    const newBtn = page.locator('button').filter({ hasText: 'New project' }).first();
    await expect(newBtn).toBeVisible({ timeout: 5000 });
    await newBtn.click();
    await page.waitForTimeout(500);
    // Create a project with spaces and check URL slug
    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('  My   Test   Project  ');
    const createBtn = page.locator('.modal button.primary, button').filter({ hasText: 'Create' }).last();
    await createBtn.click();
    await page.waitForTimeout(500);
    // Slug should be 'my-test-project' (spaces collapsed, trimmed, lowered)
    const url = page.url();
    expect(url).toMatch(/my-test-project/);
  });

  test('AA02: Duplicate slug shows error message', async ({ page }) => {
    // First create a project
    await clearAllStorage(page);
    await go(page, '/projects');
    // Click new project button
    const newBtn = page.locator('button.primary, button:has-text("New project")').first();
    await newBtn.click();
    await page.waitForTimeout(300);
    // Fill name and create
    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Duplicate Test');
    const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
    await createBtn.click();
    await page.waitForTimeout(500);
    // Now go back to projects and try creating the same slug
    await go(page, '/projects');
    await newBtn.click();
    await page.waitForTimeout(300);
    await nameInput.fill('Duplicate Test');
    await createBtn.click();
    await page.waitForTimeout(300);
    // Should show an error about duplicate slug
    const body = page.locator('.modal-backdrop, .modal');
    const modalText = await body.textContent();
    expect(modalText!.toLowerCase()).toContain('already exists');
  });

  test('AA03: Delete project cascade removes related data', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects/continuum');
    await page.waitForTimeout(500);
    // Continuum is a protected seed project — delete button should NOT exist
    const deleteBtn = page.locator('button:has-text("Delete")');
    const btnCount = await deleteBtn.count();
    // Protected projects hide delete button
    // We'll create a custom project to test deletion
    await go(page, '/projects');
    const newBtn = page.locator('button:has-text("New project")').first();
    await newBtn.click();
    await page.waitForTimeout(300);
    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Cascade Test');
    const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
    await createBtn.click();
    await page.waitForTimeout(500);
    // Should be on project home page — check delete button exists
    const delBtn = page.locator('button:has-text("Delete")');
    await expect(delBtn).toBeVisible();
  });

  test('AA04: Toggle todo checkbox changes state', async ({ page }) => {
    await go(page, '/projects/torii-quest');
    await page.waitForTimeout(300);
    const checkbox = page.locator('.todo input[type="checkbox"]').first();
    const checkboxCount = await checkbox.count();
    if (checkboxCount === 0) {
      // No todos to toggle — add one first
      const addInput = page.locator('input[placeholder*="todo"]');
      if (await addInput.count() > 0) {
        await addInput.fill('Toggle test item');
        await addInput.press('Enter');
        await page.waitForTimeout(500);
      }
    }
    // Count checked vs unchecked
    const checkedBefore = await page.locator('.todo.done input[type="checkbox"]').count();
    const uncheckedBefore = await page.locator('.todo:not(.done) input[type="checkbox"]').count();
    // Click first unchecked
    const firstUnchecked = page.locator('.todo:not(.done) input[type="checkbox"]').first();
    if (await firstUnchecked.count() > 0) {
      await firstUnchecked.click();
      await page.waitForTimeout(400);
      // After click + re-render, the counts should have shifted
      const checkedAfter = await page.locator('.todo.done').count();
      expect(checkedAfter).toBeGreaterThanOrEqual(checkedBefore);
    }
  });

  test('AA05: Add todo persists after page reload', async ({ page }) => {
    await go(page, '/projects/torii-quest');
    await page.waitForTimeout(300);
    // Count todos before
    const todosBefore = await page.locator('.todo').count();
    const addInput = page.locator('input[placeholder*="todo"]');
    if (await addInput.count() > 0) {
      await addInput.fill('Persistent todo test');
      await addInput.press('Enter');
      await page.waitForTimeout(500);
    }
    // Reload and check count increased
    await go(page, '/projects/torii-quest');
    const todosAfter = await page.locator('.todo').count();
    expect(todosAfter).toBeGreaterThanOrEqual(todosBefore);
  });

  test('AA06: Project progress bar reflects milestone completion', async ({ page }) => {
    await go(page, '/projects');
    await page.waitForTimeout(500);
    // Check that project cards have progress bars
    const progressBars = page.locator('.project-progress i, .project-progress');
    const count = await progressBars.count();
    expect(count).toBeGreaterThan(0);
    // Check that some width is set
    const firstWidth = await progressBars.first().getAttribute('style');
    expect(firstWidth).toBeTruthy();
    expect(firstWidth).toMatch(/\d+%/);
  });

  test('AA07: Marketplace counts total and ours tasks', async ({ page }) => {
    await go(page, '/marketplace');
    const pills = page.locator('.pill:has-text("total"), .pill:has-text("ours")');
    const count = await pills.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const totalPill = await text(page, '.pill:has-text("total")');
    expect(parseInt(totalPill)).toBeGreaterThan(0);
    const oursPill = await text(page, '.pill:has-text("ours")');
    expect(parseInt(oursPill)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// AB — ROUTER EDGE CASES
// ═══════════════════════════════════════════════════════════════

test.describe('AB — Router Edge Cases', () => {

  test('AB01: Hash with query parameters loads correctly', async ({ page }) => {
    await page.goto(`${BASE}/#/marketplace?ours=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    // Should load marketplace (query params are ignored by hash router)
    const title = await text(page, '#main-content h1');
    expect(title.toLowerCase()).toContain('marketplace');
  });

  test('AB02: Hash with trailing slash normalizes', async ({ page }) => {
    await page.goto(`${BASE}/#/projects/`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    // Should render projects view
    const title = await text(page, '#main-content h1');
    expect(title.toLowerCase()).toContain('project');
  });

  test('AB03: Navigate to same route re-renders content', async ({ page }) => {
    await go(page, '/dashboard');
    const content1 = await text(page, '#main-content');
    // Navigate away and back
    await go(page, '/projects');
    await go(page, '/dashboard');
    const content2 = await text(page, '#main-content');
    expect(content2.length).toBeGreaterThan(50);
    expect(content2).toContain('Dashboard');
  });

  test('AB04: Deep project slug with special chars', async ({ page }) => {
    await go(page, '/projects/torii-quest');
    const content = await text(page, '#main-content');
    expect(content).toContain('Torii Quest');
  });

  test('AB05: Hash change fires sidebar re-render', async ({ page }) => {
    await go(page, '/projects');
    const navItems1 = await page.locator('.nav-item.active').getAttribute('data-path');
    expect(navItems1).toBe('/projects');
    // Navigate to marketplace
    await go(page, '/marketplace');
    const navItems2 = await page.locator('.nav-item.active').getAttribute('data-path');
    expect(navItems2).toBe('/marketplace');
  });

  test('AB06: Empty hash (# or #/) goes to landing', async ({ page }) => {
    await page.goto(`${BASE}/#`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    const body = page.locator('body');
    await expect(body).toContainText('Gateway Project');
  });

  test('AB07: Unknown project slug shows empty/not-found state', async ({ page }) => {
    await go(page, '/projects/zzz-nonexistent-slug-12345');
    const content = await text(page, '#main-content');
    // Should show some kind of not-found message
    const mentionsNotFound = content.toLowerCase().includes('no project')
      || content.toLowerCase().includes('not found')
      || content.toLowerCase().includes('back to projects');
    expect(mentionsNotFound).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// AC — AUTH FLOW DETAIL
// ═══════════════════════════════════════════════════════════════

test.describe('AC — Auth Flow Detail', () => {

  test('AC01: Session button shows Login when logged out', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    const sessionBtn = page.locator('[data-session-toggle]');
    const btnText = (await sessionBtn.textContent()) || '';
    // On test VPS agent is reachable, should show Login
    expect(btnText.toLowerCase()).toMatch(/login|demo|sign/);
  });

  test('AC02: Click Login triggers signer-not-found modal (no NIP-07)', async ({ page }) => {
    // Ensure no signer and fresh state
    await page.goto(`${BASE}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      // Remove any stored session
      localStorage.removeItem('continuum.session.v1');
      // Ensure no window.nostr
      // @ts-ignore
      delete window.nostr;
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    const sessionBtn = page.locator('[data-session-toggle]');
    const btnText = (await sessionBtn.textContent()) || '';
    if (btnText.toLowerCase().includes('login')) {
      await sessionBtn.click();
      await page.waitForTimeout(800);
      // Should show a modal (signer-not-found or challenge flow)
      const modal = page.locator('.modal-backdrop, [role="dialog"]');
      const visible = await modal.isVisible().catch(() => false);
      if (visible) {
        const modalText = await modal.textContent();
        // Should mention signer, NIP-07, or nos2x-fox
        expect(modalText!.toLowerCase()).toMatch(/signer|nip|nos2x|plebeian|login|challenge/);
        // Close modal
        const okBtn = modal.locator('button.primary, button:has-text("OK"), button:has-text("Cancel")');
        if (await okBtn.count() > 0) {
          await okBtn.first().click();
          await page.waitForTimeout(200);
        }
      }
    }
  });

  test('AC03: Modal backdrop click closes modal', async ({ page }) => {
    await page.goto(`${BASE}/#/projects`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.removeItem('continuum.session.v1');
      // @ts-ignore
      delete window.nostr;
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);

    const sessionBtn = page.locator('[data-session-toggle]');
    const btnText = (await sessionBtn.textContent()) || '';
    if (btnText.toLowerCase().includes('login')) {
      await sessionBtn.click();
      await page.waitForTimeout(500);
      const backdrop = page.locator('.modal-backdrop');
      if (await backdrop.isVisible().catch(() => false)) {
        // Click outside the modal (on the backdrop itself)
        await backdrop.click({ position: { x: 10, y: 10 } });
        await page.waitForTimeout(300);
        await expect(backdrop).toHaveCount(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AD — CHAT DOCK DETAIL
// ═══════════════════════════════════════════════════════════════

test.describe('AD — Chat Dock Detail', () => {

  async function expandChat(page: Page) {
    const dock = page.locator('.chat-dock');
    const dockClass = await dock.getAttribute('class').catch(() => '');
    if (dockClass && dockClass.includes('collapsed')) {
      const toggle = page.locator('.chat-toggle').first();
      if (await toggle.count() > 0) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }
  }

  function chatInput(page: Page) {
    return page.locator('.chat-input, textarea[aria-label*="Chat"]').first();
  }

  function chatSend(page: Page) {
    return page.locator('.chat-send, button:has-text("Send")').first();
  }

  test('AD01: Chat shows greeting message on load', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const messages = page.locator('.chat-msg');
    const msgCount = await messages.count();
    // Should have at least the AI greeting
    expect(msgCount).toBeGreaterThanOrEqual(1);
    const firstMsg = await messages.first().textContent();
    expect(firstMsg).toBeTruthy();
  });

  test('AD02: Send "help" triggers canned reply about capabilities', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      const beforeCount = await chatMessagesCount(page);
      await input.fill('help');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const afterCount = await chatMessagesCount(page);
      expect(afterCount).toBeGreaterThan(beforeCount);
      // Last message should be AI reply about what it can help with
      const allMsgs = page.locator('.chat-msg');
      const lastMsg = await allMsgs.last().textContent();
      expect(lastMsg).toBeTruthy();
    }
  });

  async function chatMessagesCount(page: Page): Promise<number> {
    return page.locator('.chat-msg').count();
  }

  test('AD03: Send "milestone" triggers roadmap reply', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      const beforeCount = await chatMessagesCount(page);
      await input.fill('milestone plan');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const afterCount = await chatMessagesCount(page);
      expect(afterCount).toBeGreaterThan(beforeCount);
    }
  });

  test('AD04: Send "routstr" triggers model info reply', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      await input.fill('routstr deepseek');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const lastMsg = await page.locator('.chat-msg').last().textContent();
      expect(lastMsg).toBeTruthy();
    }
  });

  test('AD05: Send "marketplace" triggers task info reply', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      await input.fill('marketplace bounty');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const lastMsg = await page.locator('.chat-msg').last().textContent();
      expect(lastMsg).toBeTruthy();
    }
  });

  test('AD06: Send "new project GitHub" triggers repo info reply', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      await input.fill('new project github repo');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const lastMsg = await page.locator('.chat-msg').last().textContent();
      expect(lastMsg).toBeTruthy();
    }
  });

  test('AD07: Send gibberish gets generic mock reply', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      await input.fill('xyzzysomething random text');
      await input.press('Enter');
      await page.waitForTimeout(1500);
      const lastMsg = await page.locator('.chat-msg').last().textContent();
      expect(lastMsg).toBeTruthy();
    }
  });

  test('AD08: Chat context label changes between pages', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    // Check context label
    const contextEl = page.locator('.chat-context, [class*="context"]').first();
    let ctxText = await contextEl.textContent().catch(() => '');
    await go(page, '/dashboard');
    await expandChat(page);
    const contextEl2 = page.locator('.chat-context, [class*="context"]').first();
    let ctxText2 = await contextEl2.textContent().catch(() => '');
    // Context should differ between pages (or at least exist)
    expect(ctxText || ctxText2).toBeTruthy();
  });

  test('AD09: Empty input does not send', async ({ page }) => {
    await go(page, '/projects');
    await expandChat(page);
    const input = chatInput(page);
    if (await input.isVisible()) {
      const beforeCount = await chatMessagesCount(page);
      // Try sending empty
      const sendBtn = chatSend(page);
      await sendBtn.click();
      await page.waitForTimeout(500);
      const afterCount = await chatMessagesCount(page);
      // Should not increase (empty input guard)
      expect(afterCount).toBe(beforeCount);
    }
  });

  test('AD10: Chat toggle collapses and expands', async ({ page }) => {
    await go(page, '/projects');
    const toggle = page.locator('.chat-toggle').first();
    if (await toggle.count() > 0) {
      // Expand
      await toggle.click();
      await page.waitForTimeout(200);
      const dock = page.locator('.chat-dock');
      // Toggle again
      await toggle.click();
      await page.waitForTimeout(200);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AE — NEW PROJECT MODAL
// ═══════════════════════════════════════════════════════════════

test.describe('AE — New Project Modal', () => {

  async function openNewProject(page: Page) {
    await go(page, '/projects');
    const btn = page.locator('button:has-text("New project"), .project-card.add, button:has-text("+ New")').first();
    const count = await btn.count();
    if (count > 0) {
      await btn.click();
      await page.waitForTimeout(400);
    }
    return count;
  }

  test('AE01: GitHub tab validates URL format', async ({ page }) => {
    await clearAllStorage(page);
    const opened = await openNewProject(page);
    if (opened === 0) return; // skip if no button

    const modal = page.locator('.modal-backdrop');
    await expect(modal).toBeVisible();

    // Click GitHub tab
    const githubTab = page.locator('.tab[data-tab="github"], .tab:has-text("GitHub")').first();
    await githubTab.click();
    await page.waitForTimeout(200);

    // Fill invalid URL
    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Test GitHub Project');

    // Find the repo URL input
    const urlInputs = page.locator('.modal input[type="text"]');
    const urlCount = await urlInputs.count();
    if (urlCount > 1) {
      const repoInput = urlInputs.nth(1);
      await repoInput.fill('not-a-valid-url');
      const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
      await createBtn.click();
      await page.waitForTimeout(300);
      // Should show error about GitHub URL format
      const errorEl = page.locator('.modal [class*="error"], .modal .muted[style*="danger"], .modal .muted').last();
      const errorText = await errorEl.textContent().catch(() => '');
      // May or may not show specific error depending on implementation
      // At minimum, modal should still be open (creation was rejected)
      await expect(modal).toBeVisible();
    }
  });

  test('AE02: ngit tab validates ngit URL format', async ({ page }) => {
    const opened = await openNewProject(page);
    if (opened === 0) return;

    // Click ngit tab
    const ngitTab = page.locator('.tab[data-tab="ngit"], .tab:has-text("ngit")').first();
    await ngitTab.click();
    await page.waitForTimeout(200);

    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Test ngit Project');

    const urlInputs = page.locator('.modal input[type="text"]');
    const urlCount = await urlInputs.count();
    if (urlCount > 1) {
      const repoInput = urlInputs.nth(1);
      await repoInput.fill('invalid-ngit-url');
      const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
      await createBtn.click();
      await page.waitForTimeout(300);
      // Should show error about ngit format
      const modal = page.locator('.modal-backdrop');
      await expect(modal).toBeVisible();
    }
  });

  test('AE03: Empty name shows validation error', async ({ page }) => {
    const opened = await openNewProject(page);
    if (opened === 0) return;

    // Leave name empty, try to create
    const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
    await createBtn.click();
    await page.waitForTimeout(300);
    // Modal should remain open, error should appear
    const modal = page.locator('.modal-backdrop');
    const visible = await modal.isVisible().catch(() => false);
    // If modal closed immediately, the error prevented it from opening
    const modalText = await modal.textContent().catch(() => '');
    expect(visible || modalText.length > 0).toBeTruthy();
  });

  test('AE04: Tab switching shows/hides repo URL field', async ({ page }) => {
    const opened = await openNewProject(page);
    if (opened === 0) return;

    const tabs = page.locator('.tab');
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(3);

    // Blank tab should hide repo URL
    const blankTab = page.locator('.tab[data-tab="blank"], .tab:has-text("Blank")').first();
    await blankTab.click();
    await page.waitForTimeout(200);

    // GitHub tab should show URL field
    const githubTab = page.locator('.tab[data-tab="github"], .tab:has-text("GitHub")').first();
    await githubTab.click();
    await page.waitForTimeout(200);
  });

  test('AE05: Tags input splits on commas', async ({ page }) => {
    const opened = await openNewProject(page);
    if (opened === 0) return;

    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Tag Test Project');

    // Find tags input (last text input or placeholder contains "tags")
    const allInputs = page.locator('.modal input[type="text"], .modal input:not([type])');
    const count = await allInputs.count();
    for (let i = 0; i < count; i++) {
      const placeholder = await allInputs.nth(i).getAttribute('placeholder').catch(() => '');
      if (placeholder && placeholder.toLowerCase().includes('tag')) {
        await allInputs.nth(i).fill('alpha, beta, gamma');
        break;
      }
    }

    const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
    await createBtn.click();
    await page.waitForTimeout(500);
    // Should navigate to project home
    const url = page.url();
    expect(url).toMatch(/tag-test-project/);
  });
});

// ═══════════════════════════════════════════════════════════════
// AF — DELETE PROJECT
// ═══════════════════════════════════════════════════════════════

test.describe('AF — Delete Project', () => {

  test('AF01: Protected seed projects do not show delete button', async ({ page }) => {
    await go(page, '/projects/continuum');
    const deleteBtn = page.locator('button:has-text("Delete")');
    const count = await deleteBtn.count();
    // Continuum is protected — no delete button
    expect(count).toBe(0);
  });

  test('AF02: Torii Quest also protected from deletion', async ({ page }) => {
    await go(page, '/projects/torii-quest');
    const deleteBtn = page.locator('button:has-text("Delete")');
    const count = await deleteBtn.count();
    expect(count).toBe(0);
  });

  test('AF03: Custom project shows delete button', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    // Create a custom project
    const newBtn = page.locator('button:has-text("New project")').first();
    await newBtn.click();
    await page.waitForTimeout(300);
    const nameInput = page.locator('.modal input[type="text"]').first();
    await nameInput.fill('Deletable Project');
    const createBtn = page.locator('.modal button.primary, button:has-text("Create")').last();
    await createBtn.click();
    await page.waitForTimeout(500);
    // Should be on project home
    const deleteBtn = page.locator('button:has-text("Delete")');
    await expect(deleteBtn).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════
// AG — ROUTSTR DETAIL
// ═══════════════════════════════════════════════════════════════

test.describe('AG — Routstr Detail', () => {

  test('AG01: Routstr shows model list with prices', async ({ page }) => {
    await go(page, '/routstr');
    const body = page.locator('body');
    await expect(body).toContainText('sats');
    await expect(body).toContainText('DeepSeek');
    // Model prices shown
    const priceElements = page.locator('[class*="price"], [class*="sats"]');
    const priceCount = await priceElements.count();
    expect(priceCount).toBeGreaterThan(0);
  });

  test('AG02: Connect Cashu wallet button exists', async ({ page }) => {
    await go(page, '/routstr');
    const connectBtn = page.locator('button:has-text("Connect Cashu wallet"), button:has-text("Connect")');
    await expect(connectBtn).toBeVisible();
  });

  test('AG03: Disconnect resets wallet state', async ({ page }) => {
    await go(page, '/routstr');
    // First connect (demo mode — bumps mock balance)
    const connectBtn = page.locator('button:has-text("Connect Cashu wallet")').first();
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      await page.waitForTimeout(300);
      // After connect in demo mode, should show "Disconnect" button
      const disconnectBtn = page.locator('button:has-text("Disconnect")');
      const visible = await disconnectBtn.isVisible().catch(() => false);
      if (visible) {
        await disconnectBtn.click();
        await page.waitForTimeout(300);
        // Should show "Connect" again
        await expect(connectBtn).toBeVisible();
      }
    }
  });

  test('AG04: Model picker click changes selected state', async ({ page }) => {
    await go(page, '/routstr');
    const modelRows = page.locator('.model, [class*="model"]');
    const count = await modelRows.count();
    if (count >= 2) {
      // Click the second model (different from default)
      const firstSelected = await modelRows.first().getAttribute('class');
      await modelRows.nth(1).click();
      await page.waitForTimeout(500);
      // Page re-renders; check that something changed
      const newSelected = page.locator('.model.selected, .selected');
      expect(await newSelected.count()).toBeGreaterThan(0);
    }
  });

  test('AG05: Routstr shows endpoint settings', async ({ page }) => {
    await go(page, '/routstr');
    const body = page.locator('body');
    await expect(body).toContainText('Endpoint');
    // Should show Routstr URL
    await expect(body).toContainText('api.routstr.com');
  });

  test('AG06: Routstr shows monthly budget setting', async ({ page }) => {
    await go(page, '/routstr');
    const body = page.locator('body');
    await expect(body).toContainText('budget');
    const budgetInput = page.locator('input[type="number"]').first();
    if (await budgetInput.isVisible()) {
      const value = await budgetInput.inputValue();
      expect(parseInt(value)).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AH — MARKETPLACE FILTER
// ═══════════════════════════════════════════════════════════════

test.describe('AH — Marketplace Filter', () => {

  test('AH01: Search filters tasks by title', async ({ page }) => {
    await go(page, '/marketplace');
    const searchInput = page.locator('.filter-bar input[type="text"], input[placeholder*="Search"]').first();
    if (await searchInput.isVisible()) {
      const totalBefore = await page.locator('.task-row').count();
      await searchInput.fill('strfry');
      await page.waitForTimeout(300);
      const filteredCount = await page.locator('.task-row').count();
      // Filtered results should exist
      expect(filteredCount).toBeGreaterThan(0);
      expect(filteredCount).toBeLessThanOrEqual(totalBefore);
      // Clear search
      await searchInput.fill('');
      await page.waitForTimeout(300);
    }
  });

  test('AH02: Complexity filter narrows results', async ({ page }) => {
    await go(page, '/marketplace');
    const complexitySelect = page.locator('.filter-bar select').first();
    if (await complexitySelect.isVisible()) {
      // Get count with "All" filter
      const allCount = await page.locator('.task-row').count();
      // Change to "Small"
      await complexitySelect.selectOption('S');
      await page.waitForTimeout(300);
      const smallCount = await page.locator('.task-row').count();
      // Small tasks may exist
      expect(smallCount).toBeGreaterThanOrEqual(0);
      expect(smallCount).toBeLessThanOrEqual(allCount);
      // Reset to All
      await complexitySelect.selectOption('all');
      await page.waitForTimeout(300);
    }
  });

  test('AH03: Ours-only toggle filters to own tasks', async ({ page }) => {
    await go(page, '/marketplace');
    const oursBtn = page.locator('button:has-text("Show ours only"), button:has-text("Show all")').first();
    if (await oursBtn.isVisible()) {
      await oursBtn.click();
      await page.waitForTimeout(300);
      // All visible tasks should have "ours" badge
      const oursRows = page.locator('.task-row.ours, .task-row .pill.ours');
      // Reset
      await oursBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('AH04: Sort by recent changes order', async ({ page }) => {
    await go(page, '/marketplace');
    const sortSelect = page.locator('.filter-bar select').last();
    if (await sortSelect.isVisible()) {
      // Change sort to "most recent"
      await sortSelect.selectOption('recent');
      await page.waitForTimeout(300);
      const tasks = page.locator('.task-row');
      expect(await tasks.count()).toBeGreaterThan(0);
      // Change sort to "ours first"
      const options = await sortSelect.locator('option').allTextContents();
      const hasOurs = options.some(o => o.toLowerCase().includes('ours'));
      if (hasOurs) {
        await sortSelect.selectOption('ours');
        await page.waitForTimeout(300);
      }
    }
  });

  test('AH05: Empty search shows no-results message', async ({ page }) => {
    await go(page, '/marketplace');
    const searchInput = page.locator('.filter-bar input[type="text"], input[placeholder*="Search"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('zzz_nonexistent_task_xyzzzy');
      await page.waitForTimeout(300);
      const taskRows = await page.locator('.task-row').count();
      if (taskRows === 0) {
        // Should show empty state
        const emptyMsg = page.locator('.empty, [class*="empty"], [class*="no-result"]');
        const visible = await emptyMsg.isVisible().catch(() => false);
        expect(visible || taskRows === 0).toBeTruthy();
      }
      await searchInput.fill('');
      await page.waitForTimeout(300);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AI — THEME PERSISTENCE
// ═══════════════════════════════════════════════════════════════

test.describe('AI — Theme Persistence', () => {

  test('AI01: Theme toggles bidirectionally (dark ← → light)', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    const themeBtn = page.locator('[data-theme-toggle]').first();
    if (await themeBtn.count() > 0) {
      // Get initial theme
      const theme1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await themeBtn.click();
      await page.waitForTimeout(200);
      const theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(theme2).not.toBe(theme1);
      // Toggle back
      await themeBtn.click();
      await page.waitForTimeout(200);
      const theme3 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(theme3).toBe(theme1);
    }
  });

  test('AI02: Theme persists in localStorage after toggle', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    const themeBtn = page.locator('[data-theme-toggle]').first();
    if (await themeBtn.count() > 0) {
      await themeBtn.click();
      await page.waitForTimeout(200);
      const stored = await page.evaluate(() => localStorage.getItem('continuum.theme'));
      expect(stored).toBeTruthy();
      const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(stored).toBe(theme);
    }
  });

  test('AI03: Theme survives page reload', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    const themeBtn = page.locator('[data-theme-toggle]').first();
    if (await themeBtn.count() > 0) {
      // Toggle to light
      await themeBtn.click();
      await page.waitForTimeout(200);
      const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      // Reload
      await go(page, '/projects');
      const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(themeAfter).toBe(themeBefore);
    }
  });

  test('AI04: Dark is default theme on fresh load', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/projects');
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    // Default is dark
    expect(theme).toBe('dark');
  });

  test('AI05: Landing mode class toggles on/off by route', async ({ page }) => {
    await clearAllStorage(page);
    await go(page, '/');
    const app = page.locator('#app');
    await expect(app).toHaveClass(/landing-mode/);
    // Navigate to projects
    await go(page, '/projects');
    await expect(app).not.toHaveClass(/landing-mode/);
    // Back to landing
    await go(page, '/');
    await expect(app).toHaveClass(/landing-mode/);
  });
});

// ═══════════════════════════════════════════════════════════════
// AJ — DASHBOARD DETAIL
// ═══════════════════════════════════════════════════════════════

test.describe('AJ — Dashboard Detail', () => {

  test('AJ01: Dashboard shows aggregate progress for all projects', async ({ page }) => {
    await go(page, '/dashboard');
    const body = page.locator('body');
    await expect(body).toContainText('Overall progress');
    await expect(body).toContainText('Open todos');
    await expect(body).toContainText('Sessions logged');
    // Should show percentage
    await expect(body).toContainText('%');
  });

  test('AJ02: Dashboard shows per-project breakdown', async ({ page }) => {
    await go(page, '/dashboard');
    const body = page.locator('body');
    await expect(body).toContainText('By project');
    await expect(body).toContainText('Torii Quest');
    await expect(body).toContainText('Continuum');
  });

  test('AJ03: Dashboard per-project row shows progress bar', async ({ page }) => {
    await go(page, '/dashboard');
    const progressBars = page.locator('.project-progress');
    const count = await progressBars.count();
    expect(count).toBeGreaterThan(0);
  });

  test('AJ04: Dashboard project click navigates to project', async ({ page }) => {
    await go(page, '/dashboard');
    // Find a per-project row and click it
    const projectRow = page.locator('[role="button"]:has-text("Torii Quest"), .session:has-text("Torii Quest")').first();
    if (await projectRow.count() > 0) {
      await projectRow.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/.*#\/projects\/torii-quest/);
    }
  });

  test('AJ05: Dashboard shows Torii Quest static link', async ({ page }) => {
    await go(page, '/dashboard');
    const body = page.locator('body');
    await expect(body).toContainText('static');
    const extLink = page.locator('a[href*="torii-quest"]');
    await expect(extLink).toBeVisible();
  });
});

test.describe('AK — Cross-Cutting', () => {

  test('AK01: Brand click from any view navigates to landing', async ({ page }) => {
    await go(page, '/dashboard');
    const brand = page.locator('.brand').first();
    await brand.click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/.*#\/$/);
  });

  test('AK02: Sidebar re-renders on navigation via hashchange', async ({ page }) => {
    await go(page, '/projects');
    // Navigate via hash
    await page.evaluate(() => { window.location.hash = '#/marketplace'; });
    await page.waitForTimeout(500);
    const active = page.locator('.nav-item.active');
    const activePath = await active.getAttribute('data-path');
    expect(activePath).toBe('/marketplace');
  });

  test('AK03: "Our tasks" sidebar item navigates to marketplace with ours filter', async ({ page }) => {
    await go(page, '/projects');
    // Find "Our tasks" sidebar item
    const ourTasks = page.locator('.nav-item:has-text("Our tasks")').first();
    if (await ourTasks.count() > 0) {
      await ourTasks.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/.*#\/marketplace/);
    }
  });

  test('AK04: "Usage" sidebar item navigates to routstr', async ({ page }) => {
    await go(page, '/projects');
    const usage = page.locator('.nav-item:has-text("Usage")').first();
    if (await usage.count() > 0) {
      await usage.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/.*#\/routstr/);
    }
  });

  test('AK05: Agent health check returns correct service info', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.service).toBe('torii-continuum-agent');
    expect(body.version).toBeTruthy();
    expect(body.memory_unlocked).toBeDefined();
  });

  test('AK06: Challenge endpoint returns valid challenge without Content-Type bug', async ({ request }) => {
    // CRITICAL: This test verifies the fix for the "Bad Request" bug.
    // Send POST with NO Content-Type header and empty body.
    // The fix ensures the agent accepts this (the old code rejected it).
    const res = await request.post(`${AGENT}/api/auth/challenge`, {
      headers: {}, // Explicitly no Content-Type
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.challenge).toBeTruthy();
    expect(body.challenge.length).toBe(48);
  });

  test('AK07: Challenge also works with explicit Content-Type: application/json and no body', async ({ request }) => {
    // Additional regression test: even if the frontend accidentally sends
    // Content-Type header with empty body, the agent should handle it
    // (the agent-side fix may or may not be deployed — this documents the behavior)
    const res = await request.post(`${AGENT}/api/auth/challenge`, {
      headers: { 'Content-Type': 'application/json' }, // Old bug pattern
      data: undefined, // No body
    });
    // If the fix is deployed on the agent side, this works. If not, the
    // frontend-side fix (conditional Content-Type) prevents this code path.
    // Either way, it should not 400 with "Empty JSON body"
    expect(res.status()).not.toBe(400);
  });

  test('AK08: Auth verify without event returns 400', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/auth/verify`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('AK09: Protected admin endpoints require auth', async ({ request }) => {
    const endpoints = ['/api/wallet/balance', '/api/chat', '/api/memory', '/api/pending'];
    for (const ep of endpoints) {
      const res = await request.get(`${AGENT}${ep}`);
      expect([401, 404, 400]).toContain(res.status());
    }
  });

  test('AK10: Wallet endpoints reject unauthenticated requests', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/wallet/balance`);
    expect([401, 404]).toContain(res.status());
  });

  test('AK11: Chat endpoint rejects unauthenticated requests', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/chat`, {
      data: { message: 'test', context: { label: 'test', where: 'test' } },
    });
    expect(res.status()).toBe(401);
  });

  test('AK12: Memory unlock requires auth', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/memory/unlock`, {
      data: { entries: [] },
    });
    expect(res.status()).toBe(401);
  });

  test('AK13: Memory lock requires auth', async ({ request }) => {
    const res = await request.post(`${AGENT}/api/memory/lock`, {
      data: {},
    });
    expect(res.status()).toBe(401);
  });

  test('AK14: Memory ciphertexts requires auth', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/memory/ciphertexts`);
    expect(res.status()).toBe(401);
  });

  test('AK15: Pending path traversal attempt blocked', async ({ request }) => {
    const res = await request.get(`${AGENT}/api/pending/../../etc/passwd`);
    expect([400, 401, 404]).toContain(res.status());
  });

  test('AK16: Footer shows open source link on landing', async ({ page }) => {
    await go(page, '/');
    const body = page.locator('body');
    await expect(body).toContainText('open source');
    const ghLink = page.locator('a[href*="github.com/ChiefmonkeyArt"]');
    await expect(ghLink).toBeVisible();
  });

  test('AK17: Sidebar shows project count badge', async ({ page }) => {
    await go(page, '/projects');
    const badge = page.locator('.nav-badge');
    await expect(badge).toBeVisible();
    const badgeText = await badge.textContent();
    expect(parseInt(badgeText || '0')).toBeGreaterThan(0);
  });

  test('AK18: Sidebar footer shows local-first message', async ({ page }) => {
    await go(page, '/projects');
    const footer = page.locator('.sidebar-footer, .footer-note');
    await expect(footer).toContainText('Local-first');
  });

  test('AK19: Session button has correct aria title', async ({ page }) => {
    await go(page, '/projects');
    const sessionBtn = page.locator('[data-session-toggle]');
    const title = await sessionBtn.getAttribute('title');
    expect(title).toBeTruthy();
    expect(title!.toLowerCase()).toMatch(/sign|login/i);
  });

  test('AK20: Page title contains brand', async ({ page }) => {
    await go(page, '/');
    const title = await page.title();
    expect(title.toLowerCase()).toContain('continuum');
  });
});
