# Continuum — Testing Plan

## Current State

**180/180 tests passing** across 5 test suites. Full coverage of all SPA views, agent API endpoints (both authenticated and unauthenticated), chat keyword routing, project CRUD validation, marketplace filters, theme persistence, and auth states.

## Phase 1 — What Exists Today (Complete)

| Area | Tests | Status |
|------|-------|--------|
| Boot, routing, shell | 8 | ✅ Automated via Playwright |
| Landing page | 4 | ✅ Automated via Playwright |
| Projects CRUD + validation | 9 | ✅ Automated via Playwright |
| Project home (milestones, todos, sessions, files) | 12 | ✅ Automated via Playwright |
| Marketplace (listings, filters, sorts) | 8 | ✅ Automated via Playwright |
| Routstr (render, model info, connect btn) | 4 | ✅ Automated via Playwright |
| Dashboard (stats, per-project, nav) | 5 | ✅ Automated via Playwright |
| Chat dock (all 6 keyword routes, edge cases) | 15 | ✅ Automated via Playwright |
| Auth/session states | 13 | ✅ Automated via Playwright (programmatic NIP-42) |
| Theme toggle + persistence | 7 | ✅ Automated via Playwright |
| Agent API (authenticated, 13 endpoints) | 13 | ✅ Automated via Playwright |
| Agent API (auth gates, 18 endpoints) | 18 | ✅ Automated via Playwright |
| Router edge cases | 1 | ✅ Automated via Playwright |
| Responsive viewports | 3 | ✅ Legacy tests |

## Phase 2 — Needs External Setup (Schedulable Tasks)

These require manual setup before automation is possible. Each task is independent.

### Task 1: Wallet-Funded Authenticated Chat

**Dependency:** A Cashu wallet loaded with test sats on the VPS agent.

1. Generate or obtain a Cashu token from testnut mint
2. Redeem it to the agent via `POST /api/wallet/receive`
3. Verify balance reflects the deposit
4. Write Playwright test that:
   - Logs in (programmatic NIP-42)
   - Navigates to Routstr page
   - Connects wallet (UI flow)
   - Sends a chat message in the dock
   - Verifies the agent responds (not mock)
5. Test that the Routstr cost log increments

**Estimated effort:** 4-6 hours  
**Requires:** Testnut mint operational, agent wallet configured with mint URL

### Task 2: Full NIP-07 Browser Login Flow

**Dependency:** A browser extension or NIP-07 mock that can be loaded into Playwright's Chromium.

1. Research if Playwright can load Chrome extensions (it can — `--disable-extensions-except`)
2. Write a minimal NIP-07 extension that:
   - Exposes `window.nostr.signEvent`
   - Has a pre-configured keypair matching the admin_npub
3. Write Playwright test that:
   - Loads the extension into Chromium
   - Clicks Login
   - Verifies challenge → sign → verify flow completes
   - Verifies session token stored in localStorage
   - Verifies UI switches to logged-in state

**Alternative approach:** Use Playwright's `addInitScript` to inject a mock `window.nostr` object before the page loads. This avoids building an actual extension.

**Estimated effort:** 3-5 hours  
**Requires:** Research on Playwright extension loading or init script approach

### Task 3: Delete Project via Dialog Bypass

**Dependency:** A way to handle `window.confirm()` in Playwright.

1. Playwright can auto-accept dialogs with `page.on('dialog', dialog => dialog.accept())`
2. Write test that:
   - Creates a deletable project (not continuum/torii-quest)
   - Clicks Delete
   - Accepts confirmation
   - Verifies project is removed from list
   - Verifies cascade cleanup (todos, milestones etc removed)
3. Write negative test: cancel delete keeps the project

**Estimated effort:** 1-2 hours  
**Requires:** Nothing beyond current setup

### Task 4: Agent Unit Tests (Config Validation)

**Dependency:** Node test runner or vitest configured in agent/

1. Add a `test/` directory under `agent/`
2. Write tests for:
   - `config.mjs`: All 7 invariant checks, YAML parse failure, defaults
   - `auth.mjs`: Challenge verification rejection paths (15+)
   - `crypto.mjs`: Ciphertext validation (6 paths), memory cache operations
   - `events.mjs`: All 5 event drafters with input validation
   - `reflect.mjs`: Pattern matching, dedup, watermark, dry-run flag
3. Run via `node --test test/` or `vitest run`

**Estimated effort:** 6-8 hours  
**Requires:** Agent repo has test infrastructure configured

### Task 5: Wallet Error Path Tests

**Dependency:** Multiple mint URLs in agent config, ability to control mint responses.

1. Write agent-side tests for:
   - `receive()`: bad token encoding, missing mint URL, non-whitelisted mint, mint refuses token
   - `send()`: sats < 1, insufficient balance, send failed on remote
2. These are server-side tests that don't need a browser — pure unit/integration tests

**Estimated effort:** 3-4 hours  
**Requires:** Mock Cashu mint or testnut with controllable failure modes

### Task 6: Memory Unlock / Encrypt Flow

**Dependency:** NIP-44 encryption library available in test environment.

1. The memory unlock flow encrypts data client-side with NIP-44
2. Write Playwright test that:
   - Logs in (programmatic NIP-42)
   - Unlocks memory via API
   - Verifies memory_unlocked flag flips
   - Verifies reflect works post-unlock
3. Write agent-side test for:
   - Panic key nudge logic
   - Character root verification
   - Ciphertext storage and retrieval

**Estimated effort:** 4-6 hours  
**Requires:** NIP-44 library available, understanding of the encryption flow

### Task 7: Agent Boot Failure & Graceful Shutdown

**Dependency:** Ability to start/stop agent process in test.

1. Write tests that:
   - Start agent with invalid config → verify process.exit(1)
   - Start agent, send SIGTERM → verify graceful shutdown
   - Start agent with missing CHARACTER.md → verify graceful degradation
2. Write test for config validation at startup

**Estimated effort:** 2-3 hours  
**Requires:** Process control in test environment

### Task 8: Performance / Load Tests

**Dependency:** k6 or similar load testing tool.

1. Install k6 on VPS2
2. Write load test scripts for:
   - Health endpoint (high volume, low latency required)
   - Auth challenge (rate limit check)
   - Wallet balance (authenticated, moderate volume)
   - Chat endpoint (authenticated, low volume, measures latency)
3. Establish baseline metrics and acceptable thresholds

**Estimated effort:** 3-4 hours  
**Requires:** k6 installed, understanding of expected traffic patterns

## Phase 3 — Long-Term (Post-PR)

### CI Integration
- Add Playwright tests to GitHub Actions CI
- Run on every PR to the upstream repo
- Configure secret env vars for auth tests (CONTINUUM_AUTH_SK, CONTINUUM_AUTH_NPUB)

### Coverage Reporting
- Integrate `@playwright/test` coverage reporter
- Set up coverage thresholds (80%+ line coverage)
- Publish coverage reports as PR comments

### Cross-Browser Testing
- Add Firefox and WebKit projects to Playwright config
- Run full suite across all 3 browsers in CI

## How to Schedule

Each task is independent. To schedule:

1. Pick a task from Phase 2
2. Ensure the dependency is resolved
3. Create a kanban task with the estimated effort
4. Assign to a worker
5. Run the tests, verify they pass
6. Commit + push to PR branch

### Priority Order (Recommended)

1. **Task 3** — Delete project (lowest effort, no dependencies, highest value)
2. **Task 1** — Wallet-funded chat (validates the core value prop: pay-per-request AI)
3. **Task 2** — Full NIP-07 login (validates the auth flow end-to-end)
4. **Task 4** — Agent unit tests (validates server-side correctness)
5. **Task 6** — Memory unlock (privacy-critical feature)
6. **Task 5** — Wallet error paths (financial integrity)
7. **Task 7** — Boot/shutdown (operational reliability)
8. **Task 8** — Performance (post-stability)
