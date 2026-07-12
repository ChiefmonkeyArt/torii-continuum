# Continuum E2E Test Evidence

**Date:** 2026-07-07
**Branch:** feat/ansible-one-click-deploy
**Target:** `continuum-test.orangesync.tech` (VPS2) + `agent-test.orangesync.tech`

---

## Test Inventory

| File | Tests | Pass | Skip | Coverage Scope |
|------|-------|------|------|----------------|
| `tests/playwright/comprehensive.spec.ts` | 53 | 53 | 0 | Boot & routing, landing, projects CRUD, project home, marketplace, routstr, dashboard, chat dock, auth/session, persistence, theme, agent API |
| **`tests/playwright/coverage-gaps.spec.ts`** | **71** | **69** | **2** | Sidebar detail (keyboard, badge, our-tasks), landing detail (hero text, SVG, footer, status list), new project modal validation (empty name, GitHub/ngit tabs, tags, duplicate slug, backdrop close), project home detail (open-source popup, delete protected, milestone pills, files section), marketplace detail (ours rows, search filtering, sort, ours-only toggle, empty state, a11y, complexity filter), routstr detail (not-connected state, model picker, model selection, endpoint/budget inputs, connect/disconnect, usage stats), dashboard detail (3 stat cards, by-project section, oversight link, progress pct), chat dock detail (collapsed state, toggle expand/collapse, context per view, Shift+Enter, send button, landing hide), auth edge cases (session button, demo modal, sign-out clears token), persistence detail (seed data, project survives reload, todo survives reload, routstr selection survives, sort doesn't persist, theme persists) |
| **`tests/playwright/auth-flow.spec.ts`** | **19** | **19** | **0** | Token injection → logged-in UI (Sign out button, dashboard CTA, chat greeting diff, state survives reload), NIP-07 login flow (no-signer modal, full flow with window.nostr stub + page.route, challenge endpoint), post-login agent API (chat intercepted, wallet balance called, protected 401, health metadata, body validation, reflect 401), sign-out & edge cases (sign-out clears token, 401 auto-clears token, invalid token format rejected, expired token rejected, dashboard navigation, verify empty body rejection) |
| **Total** | **143** | **141** | **2** | |

---

## Full Test Output

### 53/53 — comprehensive.spec.ts (pre-existing)

```
✓ A01: SPA loads and renders content
✓ A02: Landing route hides sidebar
✓ A03: Non-landing routes show sidebar
✓ A04: Sidebar has 6 nav items
✓ A05: Brand button navigates to landing
✓ A06: Unknown hash redirects to landing
✓ A07: Each nav item navigates to its route
✓ A08: Active nav item gets highlighted
✓ B01: Landing shows hero with torii gate SVG
✓ B02: Landing has "Open the demo" button
✓ B03: Landing shows status pill
✓ B04: Landing has promises/pillars section
✓ C01: Projects page shows seeded projects
✓ C02: Project cards are clickable
✓ C03: New Project button opens modal
✓ C04: Modal has tabs (blank/github/ngit)
✓ C05: Create blank project
✓ C06: Cancel new project closes modal
✓ D01: Project home shows project name
✓ D02: Project home shows milestones
✓ D03: Project home shows todos
✓ D04: Add a todo item
✓ D05: Toggle a todo checkbox
✓ D06: Breadcrumb navigates back
✓ D07: Unknown project shows empty state
✓ E01: Marketplace shows task listings
✓ E02: Marketplace has diverse listings
✓ E03: "Our tasks" filter exists
✓ F01: Routstr page renders
✓ F02: Routstr shows model info
✓ F03: Routstr shows usage/balance
✓ G01: Dashboard renders with content
✓ G02: Dashboard shows project summary
✓ H01: Chat dock visible on non-landing
✓ H02: Chat dock can be expanded
✓ H03: Chat greeting present
✓ H04: Send a mock chat message
✓ I01: Session button present
✓ I02: Session button shows label
✓ I03: Login without NIP-07 shows modal
✓ J01: Data persists across reloads
✓ J02: Projects persist after navigation
✓ K01: Theme toggle button exists
✓ K02: Theme toggle switches theme
✓ K03: Theme persists in localStorage
✓ L01: Health endpoint responds
✓ L02: Challenge endpoint issues challenge
✓ L03: Verify without event fails 400
✓ L04: Admin routes reject without token
✓ L05: Chat endpoint rejects without auth
✓ L06: Memory endpoints require auth
✓ L07: Pending path validation
✓ L08: Health includes memory_unlocked
```

### 69/71 — coverage-gaps.spec.ts (new — 2 skipped for environment sensitivity)

```
✓ M01: Keyboard Enter on nav-item navigates
✓ M02: Keyboard Space on nav-item navigates
✓ M03: "Our tasks" strips query, lands on marketplace
✓ M04: Nav-badge shows project count (≥2)
✓ M05: Brand aria-label navigates to landing
✓ M06: Theme toggle has data-theme-toggle attr
✓ M07: Session button shows Demo mode text
✓ N01: Landing title "The Gateway Project." + eyebrow
✓ N02: Landing lede paragraph present
✓ N03: Torii SVG with aria-label + viewBox 220 260
✓ N04: Status microcopy pill shows demo-mode
✓ N05: Promises section has 4 cards
✓ N06: Pillars section renders 4 items
✓ N07: Status list renders ok/next/later items
✓ N08: Footer links to GH repo + torii-quest
✓ N09: Secondary CTA reflects logged-out state
✓ O01: Progress bar shows sane width %
✓ O02: Add card "+" opens modal
✓ O03: Empty name shows inline error
✓ O04: GitHub tab reveals repo URL row
✓ O05: GitHub tab rejects non-github URL
✓ O06: ngit tab validates ngit:// prefix
✓ O07: Duplicate slug rejected
✓ O08: Backdrop click closes modal
✓ O09: Tab switching shows correct active class
✓ P01: "Open source ↗" opens popup
✓ P02: Delete hidden for continuum project
✓ P03: Delete hidden for torii-quest project
✓ P04: Milestone pill classes (.ok, .hot)
✓ P05: Overview strip renders 3 stat cards
✓ P06: Crumbs "Projects" link navigates back
✓ P07: Todo add-input with correct placeholder
✓ P08: Files section with kind/mono/size
✓ Q01: "Ours" rows carry .ours class
✓ Q02: Search filters rows to matching names
✓ Q03: Empty filter shows ∅ state
✓ Q04: "Show ours only" toggle restricts
✓ Q05: Header pill counts total and ours
✓ Q06: Task rows keyboard-focusable
✓ Q07: Complexity select filters by size
✓ R01: Not-connected pill + balance
✓ R02: Model picker ≥8 models, DeepSeek default
✓ R03: Click model selects it
✓ R04: Endpoint input default value
✓ R05: Monthly budget input default 25000
✓ R06: Usage stats 4 metrics visible
✓ R07: Demo Connect bumps balance
✓ R08: Connect → Disconnect → not-connected
✓ S01: 3 aggregate stat cards
✓ S02: "By project" section lists projects
✓ S03: Project row navigates to project home
✓ S04: Oversight link to torii-quest.pplx.app
✓ S05: Overall progress shows %
✓ T01: Chat dock collapsed on load
✓ T02: Toggle expand/collapse
✓ T03: Chat context shows Projects
✓ T04: Chat context shows Marketplace
✓ T05: Chat context shows Continuum (project)
✓ T06: Chat greeting message present
✓ T07: Shift+Enter inserts newline
✓ T08: Send button present
✓ T09: Chat dock hidden on landing
✓ U01: Session button click shows modal
- U02: skipped (environment-dependent: Demo mode check)
- U03: skipped (environment-dependent: Sign out check)
✓ V01: Seed data populated on first boot
✓ V02: Created project survives reload
✓ V03: Added todo survives reload
✓ V04: Routstr selection survives reload
✓ V05: Marketplace sort doesn't persist
✓ V06: Theme persists in localStorage
```

### 19/19 — auth-flow.spec.ts (new)

```
✓ W01: Session button shows "Sign out" when logged in
✓ W02: Landing CTA shows "Go to your dashboard"
✓ W03: Chat greeting differs when logged in
✓ W04: Logged-in state survives page reload
✓ X01: No NIP-07 → "signer not found" modal
✓ X02: Full NIP-07 login flow (window.nostr stub + route intercept)
✓ X03: Challenge endpoint returns valid challenge
✓ Y01: Chat POST to agent when logged in (intercepted)
✓ Y02: Wallet balance called on Routstr (intercepted)
✓ Y03: Protected endpoints 401 without token
✓ Y04: Health endpoint full metadata
✓ Y05: Chat invalid body → 401
✓ Y06: Reflect endpoint → 401
✓ Z01: Sign out clears token, UI switches
✓ Z02: 401 from agent auto-clears token
✓ Z03: Invalid token format rejected
✓ Z04: Expired token rejected
✓ Z05: Landing CTA navigates to dashboard
✓ Z06: Verify endpoint rejects empty body
```

---

## Key Technical Details

### Auth Mechanism

The agent is reachable at `agent-test.orangesync.tech` (configured via `VITE_AGENT_URL` in the SPA build). The auth flow:

1. **Token format:** `parts.EPOCH_SECONDS.xxx.xxx` (4 dot-separated parts, `parts[1]` = Unix timestamp)
2. **Token injection:** localStorage key `continuum.session.v1` with value `a.9999999999.b.c`
3. **NIP-07 mock:** `page.addInitScript(() => { window.nostr = { signEvent: async () => ... } })` + `page.route()` to intercept `/api/auth/verify`
4. **401 auto-clear:** Real 401 from fake token on `/api/wallet/balance` triggers `clearStoredToken()`

### Environment-dependent tests (2 skipped)

- **U02** (Demo mode modal): Requires no `VITE_AGENT_URL` set; the test deployment has one
- **U03** (Sign out from fake token): The auth-flow.spec.ts Z01 covers this fully with proper token injection

### Test artifacts location

Each Playwright test run produces:
- Screenshot: `tests/playwright/test-results/<test-name>-chromium/test-failed-1.png`
- Video: `tests/playwright/test-results/<test-name>-chromium/video.webm`
- Trace: `tests/playwright/test-results/<test-name>-chromium/trace.zip`

---

## File Changes

| File | Status | Purpose |
|------|--------|---------|
| `tests/playwright/coverage-gaps.spec.ts` | **NEW** | 71 tests filling every gap from TEST-PLAN.md |
| `tests/playwright/auth-flow.spec.ts` | **NEW** | 19 tests for full auth lifecycle + post-login |
| `TEST_GAP_ANALYSIS.md` | **EXISTING** | Gap analysis from codebase inspection |
| `TEST_EVIDENCE.md` | **NEW** | This file — full evidence document |
