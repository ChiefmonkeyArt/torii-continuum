# Continuum SPA — Frontend Interaction Map & Playwright Test Plan

Generated from a full read of `src/main.js`, `src/router.js`, `src/shell.js`,
`src/chat.js`, `src/auth.js`, all `src/views/*.js`, and the data layer
(`src/data/store.js`, `src/data/agent.js`, `src/data/seed.js`, `src/data/schema.js`)
on branch `feat/ansible-one-click-deploy`.

Conventions match the existing `happy-path.spec.ts`:
- `BASE` is the deployed SPA origin; tests navigate via `${BASE}/#/<route>`.
- Hash-based router (no SPA fallback needed).
- Default viewport 1280×900 (see `playwright.config.ts`).
- Tests assume the seed state ships two projects: **Torii Quest** (`torii-quest`)
  and **Continuum** (`continuum`), plus seeded marketplace tasks and a Routstr
  config whose default model is `deepseek-chat`.

---

## 1. Route Map

| Hash             | View module        | Landing mode | Sidebar | Handler signature                              |
|------------------|--------------------|:------------:|:-------:|------------------------------------------------|
| `#/`             | `landing.js`       |     ✅ on    | hidden  | `renderLanding(mainContent())`                 |
| `#/projects`     | `projects.js`      |     off      | shown   | `renderProjects(mainContent())`                |
| `#/projects/:slug` | `projectHome.js` |     off      | shown   | `renderProjectHome(mainContent(), slug)`       |
| `#/marketplace`  | `marketplace.js`   |     off      | shown   | `renderMarketplace(mainContent())`             |
| `#/routstr`      | `routstr.js`       |     off      | shown   | `renderRoutstr(mainContent())`                 |
| `#/dashboard`    | `dashboard.js`     |     off      | shown   | `renderDashboard(mainContent())`               |
| *(unknown)*      | router fallback    |     —        |   —     | `window.location.hash = '#/'` (redirect)       |

`setLandingMode(true)` toggles `landing-mode` class on `#app`, which CSS-hides
`.sidebar` and `.chat-dock`.

---

## 2. Per-View Interaction Map

### 2.1 App Shell (`shell.js`) — present on every non-landing route

DOM: `#app > nav.sidebar` + `main#main-content`; chat dock appended after.

| Element (selector)                                              | Event  | Action / API                                                                                                |
|-----------------------------------------------------------------|--------|-------------------------------------------------------------------------------------------------------------|
| `.brand[role="button"][aria-label="Continuum home"]`            | click  | `navigate('/')`                                                                                             |
| `.nav-item[data-path="/projects"]` (text "Projects")            | click  | `navigate('/projects')`; shows `.nav-badge` = project count                                                 |
| `.nav-item[data-path="/marketplace"]`                           | click  | `navigate('/marketplace')`                                                                                  |
| `.nav-item[data-path="/routstr"]`                               | click  | `navigate('/routstr')`                                                                                      |
| `.nav-item[data-path="/dashboard"]`                             | click  | `navigate('/dashboard')`                                                                                    |
| `.nav-item[data-path="/marketplace?ours=1"]` (text "Our tasks") | click  | navigates to `/marketplace` (query stripped by `el.dataset.path.replace(/\?.*/, '')`)                        |
| `.nav-item[data-path="/routstr"]` (text "Usage")                | click  | `navigate('/routstr')`                                                                                      |
| `button.session-btn[data-session-toggle]`                       | click  | if logged in → `endSession()` + re-render; else `startLogin()`                                              |
| `button.theme-toggle[data-theme-toggle]`                        | click  | `toggleTheme()` + re-render (toggles `data-theme` on `<html>`, persists `continuum.theme` in localStorage)  |
| Any `.nav-item`                                                  | Enter/Space | triggers click (a11y)                                                                                  |

Active route highlights the matching `.nav-item` with class `active`.

Session button visible text: "Sign out" (logged in) · "Login" (agent configured,
logged out) · "Demo mode" (no agent, logged out).

### 2.2 Landing (`#/`, `landing.js`)

| Element                                                          | Event | Action                                                                          |
|------------------------------------------------------------------|-------|---------------------------------------------------------------------------------|
| `svg[aria-label="Continuum torii gate"]` (inline Myōjin torii)   | —     | decorative                                                                      |
| `button.landing-btn.primary` (text "Open the demo →")            | click | `navigate('/projects')`                                                         |
| `button.landing-btn.ghost` (logged out → "Login with Nostr" / "Login (requires self-hosted agent)") | click | `startLogin()` |
| `button.landing-btn.ghost` (logged in → "Go to your dashboard")  | click | `navigate('/dashboard')`                                                        |
| `.pill` (hero microcopy)                                         | —     | text "agent reachable" or "demo mode"                                           |
| `a[href*="github.com/ChiefmonkeyArt/torii-continuum"]`           | —     | external (target `_blank`)                                                      |
| `a[href="https://torii-quest.pplx.app"]`                         | —     | external                                                                        |

Static sections: `.landing-promises` (4 cards), `.landing-pillars` (4),
`.landing-status` (list with `.status-ok`/`.status-next`/`.status-later`).

### 2.3 Chat Dock (`chat.js`) — appended to `#app` on boot

| Element                                       | Event        | Action / API                                                                                              |
|-----------------------------------------------|--------------|-----------------------------------------------------------------------------------------------------------|
| `.chat-toggle[aria-label="Toggle chat"]` (▲/▼)| click        | expand/collapse `.chat-dock` (`expanded`/`collapsed` class swap)                                          |
| `textarea.chat-input[aria-label="Chat input"]`| Enter        | `send()` (Shift+Enter inserts newline)                                                                    |
| `button.chat-send` (text "Send")              | click        | `send()`                                                                                                  |
| — (internal) `send()`                         | —            | pushes `.chat-msg.user`, shows `.chat-thinking`, then if `isSessionLive()` calls `agent.chat()` (POST /api/chat) else `mockReply()` |

Greeting `.chat-msg.ai` differs by session state. `.chat-context` shows
`context · <label>` where label is set per-view via `setChatContext()`.

### 2.4 Projects (`#/projects`, `projects.js`)

| Element                                              | Event | Action / API                                                                                              |
|------------------------------------------------------|-------|-----------------------------------------------------------------------------------------------------------|
| `button.primary` (text "+ New project")              | click | `openNewProject()` → opens `.modal`                                                                       |
| `.project-card[role="button"]` (per seeded project)  | click | `navigate('/projects/<slug>')`                                                                            |
| `.project-card.add[role="button"]`                   | click | `openNewProject()`                                                                                        |
| `.project-card`                                      | Enter/Space | a11y click                                                                                            |

**New Project modal** (`.modal-backdrop > .modal[role="dialog"]`):

| Element                                              | Event | Action / validation                                                                                       |
|------------------------------------------------------|-------|-----------------------------------------------------------------------------------------------------------|
| `.tab[data-tab="blank"]` (active) / `.tab[data-tab="github"]` / `.tab[data-tab="ngit"]` | click | switches `activeTab`; toggles repo URL row visibility + placeholder        |
| `input[type="text"]` (Project name)                  | —     | required; empty → error "Give the project a name."                                                        |
| `input` (repo URL, hidden on Blank)                  | —     | required when tab != blank; validated vs `github.com/...` or `ngit://`/`nostr://` regex                   |
| `textarea` (Description)                             | —     | optional                                                                                                  |
| `input[type="text"]` (Tags, comma separated)         | —     | optional, split on comma                                                                                  |
| `button.ghost` (Cancel)                              | click | `modal.close()`                                                                                           |
| `button.primary` (Create project)                    | click | `createProject({name,description,source,sourceUrl,tags})` → store persist → sidebar re-render → navigate(`/projects/<slug>`) |
| `.modal-backdrop` (click on backdrop, not modal)     | click | closes modal                                                                                              |

Duplicate slug throws → shown in error element (red).

### 2.5 Project Home (`#/projects/:slug`, `projectHome.js`)

Unknown slug → `.empty` card with `button` "Back to projects" → `navigate('/projects')`.

| Element                                                  | Event  | Action / API                                                                                            |
|----------------------------------------------------------|--------|---------------------------------------------------------------------------------------------------------|
| `.crumbs a` (text "Projects")                            | click  | `navigate('/projects')`                                                                                 |
| `button.ghost` (text "Open source ↗")                    | click  | `window.open(sourceUrl)` (only when `sourceUrl` set)                                                    |
| `button.ghost` (text "Delete")                           | click  | `window.confirm(...)` → on accept: `deleteProject(slug)` + sidebar re-render + `navigate('/projects')`. Hidden for slugs `continuum` and `torii-quest`. |
| `.todo input[type="checkbox"]`                           | change | `toggleTodo(ev)` → store persist → full `renderProjectHome` re-render                                   |
| `.todo input.add-input[placeholder="+ add a todo…"]`     | Enter  | `addTodo(slug, value)` → store persist → re-render                                                      |

Static cards: Milestones (`.milestone.done/.active/.pending` with `.pill.ok/.hot/.danger`),
Sessions (`.session`), Files (`.file` with `.kind`, `.mono` path, `.size`),
overview `.grid-3` (Progress %, Open todos, Sessions).

### 2.6 Marketplace (`#/marketplace`, `marketplace.js`)

| Element                                                            | Event  | Action                                                                  |
|--------------------------------------------------------------------|--------|-------------------------------------------------------------------------|
| `.filter-bar input[type="text"][placeholder="Search tasks or repos…"]` | input  | filters rows by title/repo (case-insensitive) + `draw()`              |
| `.filter-bar select` (complexity: Any size / S / M / L)            | change | filters by `complexity` + `draw()`                                      |
| `.filter-bar select` (sort: bounty / recent / ours)                | change | re-sorts + `draw()`                                                     |
| `.filter-bar button` (text "Show ours only" ⇄ "Show all")          | click  | toggles `filter.oursOnly`, toggles `.primary` class on button + `draw()`|
| `.task-row[role="button"]`                                         | click/Enter | (no handler wired — role/tabindex only, no nav)                    |

Header counts: `.pill` (`N total`) and `.pill.ours` (`N ours`). Empty filter →
`.empty > .big` "∅" + "No tasks match those filters."

### 2.7 Routstr (`#/routstr`, `routstr.js`)

| Element                                                            | Event  | Action / API                                                                                            |
|--------------------------------------------------------------------|--------|---------------------------------------------------------------------------------------------------------|
| `button.primary` (text "Connect Cashu wallet") / `button` "Disconnect" | click  | see `connect()` / `disconnect()` below                                                                |
| `.model` row (clickable)                                           | click  | `updateRoutstr({selectedModel: m.id})` → full re-render; selected row has class `selected`              |
| `input[type="text"]` (Routstr URL, default `https://api.routstr.com`) | change | `updateRoutstr({endpoint})` (empty → reset to default)                                                 |
| `input[type="number"]` (Monthly Cashu budget, default 25000)       | change | `updateRoutstr({usage:{...usage, monthlyBudget}})`                                                      |

`connect()` branching:
- **Demo mode** (`!isAgentConfigured()`): bumps `cashuBalanceSats` to random
  12000–20000, sets `connected:true`, re-renders. **No network call.**
- **Agent configured, not logged in:** calls `startLogin()`.
- **Logged in:** `openTopUpModal()`.

**Top-up modal** (`.modal`):
- `textarea` (Cashu token) — required
- `button.primary` "Redeem to agent" → `walletReceive(token)` → **POST /api/wallet/receive** `{token}` → `{received_sats, balance_sats}`
- `button` "Cancel" → close
- On success: status "Received N sats. New balance: M sats." → `updateRoutstr` + re-render

`disconnect()`: local-only; sets `connected:false, cashuBalanceSats:0`,
`stopBalancePoll()`, re-render.

While logged in, `startBalancePoll()` calls **GET /api/wallet/balance** every
15s and silently updates store.

### 2.8 Dashboard (`#/dashboard`, `dashboard.js`)

| Element                                                  | Event | Action                                                         |
|----------------------------------------------------------|-------|----------------------------------------------------------------|
| `.session[role="button"]` (per project in "By project")  | click | `window.location.hash = '#/projects/<slug>'`                   |
| `a[href="https://torii-quest.pplx.app"]`                 | —     | external (target `_blank`)                                     |

Static: `.grid-3` (Overall progress %, Open todos, Sessions logged) all derived
from local store.

### 2.9 Auth (`auth.js`) — modal flow triggered by session button / landing Login / Routstr connect

`startLogin()` branching (each opens `.modal`):
1. `!isAgentConfigured()` → modal title "Login unavailable in demo" + `button.primary` "OK".
2. `!hasSigner()` (no `window.nostr.signEvent`) → modal title "NIP-07 signer not found" + Chrome/Firefox links + `button.primary` "OK".
3. Otherwise → modal "Login with Nostr":
   - `.login-spinner` + `.muted` status + `button` "Cancel"
   - **POST /api/auth/challenge** → `{challenge, expires_in}`
   - `window.nostr.signEvent({kind:22242, content:challenge, tags:[['challenge',challenge],['relay',origin]]})`
   - **POST /api/auth/verify** `{event}` → `{token, expires_at}` (stored in `continuum.session.v1`)
   - Dispatches `continuum:session-changed` → sidebar + landing re-render

`endSession()`: clears token, dispatches `continuum:session-changed`.

### 2.10 Agent API surface (`agent.js`) — all gated by `VITE_AGENT_URL`

| Function          | Method | Path                       | Auth |
|-------------------|--------|----------------------------|:----:|
| `health()`        | GET    | `/api/health`              |  —   |
| `requestChallenge()` | POST | `/api/auth/challenge`      |  —   |
| `verifyChallenge(event)` | POST | `/api/auth/verify`     |  —   |
| `walletBalance()` | GET    | `/api/wallet/balance`      |  ✅  |
| `walletReceive(token)` | POST | `/api/wallet/receive`   |  ✅  |
| `chat({message,context})` | POST | `/api/chat`           |  ✅  |

When agent URL is empty → every call returns `{ok:false, reason:'offline', offline:true}`
and the UI falls back to mock behaviour. 401 responses auto-clear the session token.

---

## 3. Playwright Test Cases (numbered, with exact selectors)

> **Note on selector stability:** views are built with `h()` (see `util.js`),
> which only emits `class`, `text`, `dataset`, `on*`, and arbitrary attributes.
> There are no `data-testid` hooks; the selectors below use the stable classes
> and ARIA attributes the code actually emits. Where a class is shared across
> views (e.g. `.card`, `.muted`), scope under `#main-content` or a section class.

### A. Boot & Routing

1. **App boots and mounts shell on first load**
   - Goto `${BASE}/`.
   - `await page.waitForLoadState('networkidle')`.
   - Expect `#app` to be present.
   - Expect `nav.sidebar` OR (on landing) `main#main-content .landing-hero` to be visible.

2. **Unknown hash redirects to landing**
   - Goto `${BASE}/#/this-route-does-not-exist`.
   - Expect `page.url()` to end with `/#/`.
   - Expect `.landing-title` text "The Gateway Project." to be visible.

3. **Hash router resolves all six routes without full reload**
   - For each of `#/`, `#/projects`, `#/marketplace`, `#/routstr`, `#/dashboard`,
     `#/projects/continuum`: goto, then assert the route-specific marker
     (`.landing-title`, `.page-title` "Projects"/"Marketplace"/"Routstr"/"Dashboard",
     or `.crumbs` for project home) is visible.

4. **Landing mode hides sidebar and chat dock**
   - Goto `${BASE}/#/`.
   - Expect `#app` to have class `landing-mode`.
   - Expect `nav.sidebar` not to be visible.
   - Expect `.chat-dock` not to be visible.

5. **Non-landing route restores sidebar and chat dock**
   - Goto `${BASE}/#/projects`.
   - Expect `#app` not to have class `landing-mode`.
   - Expect `nav.sidebar` to be visible.
   - Expect `.chat-dock` to be visible.

### B. Sidebar / Shell

6. **Sidebar renders all four workspace nav items with correct data-path**
   - Goto `${BASE}/#/projects`.
   - `nav.sidebar .nav-item[data-path="/projects"]` contains text "Projects".
   - Same for `/marketplace`, `/routstr`, `/dashboard`.
   - `.nav-item[data-path="/projects"] .nav-badge` text is a digit ≥ "2".

7. **Brand click navigates to landing**
   - Goto `${BASE}/#/projects`.
   - Click `nav.sidebar .brand[role="button"][aria-label="Continuum home"]`.
   - Expect `.landing-title` visible and `#app.landing-mode`.

8. **Nav-item click navigates to its route**
   - Goto `${BASE}/#/projects`.
   - Click `nav.sidebar .nav-item[data-path="/marketplace"]`.
   - Expect URL `…/#/marketplace` and `.page-title` text "Marketplace".

9. **"Our tasks" nav item strips query and lands on marketplace**
   - Goto `${BASE}/#/projects`.
   - Click `nav.sidebar .nav-item[data-path="/marketplace?ours=1"]`.
   - Expect URL `…/#/marketplace` (no `?ours=1`).

10. **Active nav item gets `.active` class matching current route**
    - Goto `${BASE}/#/routstr`.
    - Expect `nav.sidebar .nav-item[data-path="/routstr"].active` (first match) to be visible.

11. **Theme toggle flips `data-theme` on `<html>` and persists**
    - Goto `${BASE}/#/projects`.
    - Read `await page.evaluate(() => document.documentElement.getAttribute('data-theme'))` → record value.
    - Click `nav.sidebar button.theme-toggle[data-theme-toggle]`.
    - Expect `data-theme` to have flipped (dark↔light).
    - Expect `localStorage.getItem('continuum.theme')` to equal the new value.

12. **Session button text reflects agent availability (demo vs login)**
    - Goto `${BASE}/#/projects`.
    - `nav.sidebar button.session-btn[data-session-toggle]` text is either
      "Demo mode" (no agent) or "Login" (agent configured) when logged out.
    - No assertion on logged-in branch unless a token is seeded.

13. **Keyboard activation (Enter) on a nav-item triggers navigation**
    - Goto `${BASE}/#/projects`.
    - Focus `nav.sidebar .nav-item[data-path="/dashboard"]`, press Enter.
    - Expect URL `…/#/dashboard`.

### C. Landing View

14. **Landing hero renders title, eyebrow, lede, and pill**
    - Goto `${BASE}/#/`.
    - `.landing-eyebrow` text matches `/Torii Continuum · v/`.
    - `.landing-title` text "The Gateway Project.".
    - `.landing-cta .pill` text is "agent reachable" OR "demo mode".

15. **Torii gate SVG is present and accessible**
    - Goto `${BASE}/#/`.
    - `svg[aria-label="Continuum torii gate"]` visible with `viewBox="0 0 220 260"`.

16. **"Open the demo →" navigates to projects**
    - Goto `${BASE}/#/`.
    - Click `.landing-btn.primary` (text "Open the demo →").
    - Expect URL `…/#/projects` and `.page-title` "Projects".

17. **Secondary CTA reflects login state**
    - Goto `${BASE}/#/` (logged out).
    - `.landing-cta .landing-btn.ghost` text is "Login with Nostr" (agent) or
      "Login (requires self-hosted agent)" (demo).
    - (With a seeded valid token in `continuum.session.v1`) the same button
      reads "Go to your dashboard" and navigates to `#/dashboard`.

18. **Landing footer links are external and correct**
    - Goto `${BASE}/#/`.
    - `footer.landing-foot a[href="https://github.com/ChiefmonkeyArt/torii-continuum"]` present.
    - `footer.landing-foot a[href="https://torii-quest.pplx.app"]` present.

19. **Status list renders ok/next/later items**
    - Goto `${BASE}/#/`.
    - `.landing-status-list .status-ok`, `.status-next`, `.status-later` each
      have count ≥ 1.

### D. Projects List

20. **Projects page shows seeded project cards**
    - Goto `${BASE}/#/projects`.
    - `#main-content .project-card` count ≥ 2.
    - Body contains "Torii Quest" and "Continuum".

21. **Project card progress bar width is a sane percentage**
    - Goto `${BASE}/#/projects`.
    - For each `.project-card:not(.add) .project-progress i`, read inline
      `width` and assert it matches `/\d+%/`.

22. **"+ New project" button opens the modal**
    - Goto `${BASE}/#/projects`.
    - Click `#main-content button.primary` (text "+ New project").
    - Expect `.modal` visible, `h3` text "New project".

23. **Add card also opens the modal**
    - Goto `${BASE}/#/projects`.
    - Click `.project-card.add`.
    - Expect `.modal` visible.

24. **Project card click navigates to project home**
    - Goto `${BASE}/#/projects`.
    - Click `.project-card` containing text "Continuum".
    - Expect URL `…/#/projects/continuum` and `.crumbs` visible.

### E. New Project Modal (form validation & creation)

25. **Blank-tab create happy path**
    - Goto `${BASE}/#/projects`; open modal.
    - Fill `.modal input[type="text"]` (Project name) with "Playwright Test Proj".
    - Click `.modal button.primary` (text "Create project").
    - Expect URL `…/#/projects/playwright-test-proj`.
    - Expect `.page-title` text "Playwright Test Proj".

26. **Empty name shows inline error and does not navigate**
    - Open modal; leave name empty; click "Create project".
    - Expect URL unchanged (still `#/projects`).
    - Expect `.modal` still visible and an error element containing "Give the project a name."

27. **Switching to GitHub tab reveals the repo URL row with github placeholder**
    - Open modal; click `.modal .tab[data-tab="github"]`.
    - Expect `.tab[data-tab="github"]` to have class `active`.
    - Expect the repo `input` placeholder to contain `github.com`.

28. **GitHub tab rejects a non-github URL**
    - Open modal; select GitHub tab.
    - Fill name "X", repo URL "https://example.com/x".
    - Click "Create project".
    - Expect error text containing "github.com".

29. **GitHub tab accepts a valid github.com URL**
    - Open modal; select GitHub tab.
    - Name "Repo Test", repo URL "https://github.com/ChiefmonkeyArt/torii-continuum".
    - Click "Create project".
    - Expect URL `…/#/projects/repo-test`; project home shows the github source pill + link.

30. **ngit tab validates `ngit://` prefix**
    - Open modal; select ngit tab.
    - Name "Ngit Test", repo URL "https://not-ngit.example".
    - Click "Create project"; expect error containing "ngit://".
    - Replace URL with `ngit://relay.example/pubkey/repo`; click Create.
    - Expect navigation to `#/projects/ngit-test`.

31. **Tags are split on comma and persisted** (visible via project home source pill / chat context)
    - Open modal; name "Tagged Proj", tags "alpha, beta,gamma".
    - Create; on project home, assert page loaded for slug `tagged-proj`.

32. **Duplicate slug is rejected**
    - Open modal; name "Continuum" (collides with seeded slug).
    - Click Create; expect error containing `already exists` and URL unchanged.

33. **Cancel button closes the modal without creating**
    - Open modal; click `.modal button.ghost` (text "Cancel").
    - Expect `.modal` count 0 and URL unchanged.

34. **Backdrop click closes the modal**
    - Open modal; click `.modal-backdrop` at a point outside `.modal`.
    - Expect `.modal` count 0.

### F. Project Home

35. **Project home renders overview, milestones, todos, sessions, files**
    - Goto `${BASE}/#/projects/continuum`.
    - Expect `.grid-3` with three `.card` (Progress / Open todos / Sessions).
    - Expect a `.card h3` "Milestones", "Sessions", "Todo list", "Files created".

36. **Crumbs "Projects" link returns to list**
    - Goto `${BASE}/#/projects/continuum`.
    - Click `.crumbs a` (text "Projects").
    - Expect URL `…/#/projects`.

37. **Unknown slug renders the empty state**
    - Goto `${BASE}/#/projects/no-such-slug`.
    - Expect `#main-content .empty` visible containing "No project with that slug."
    - Click `.empty button` (text "Back to projects"); expect URL `…/#/projects`.

38. **Todo checkbox toggles done state and re-renders**
    - Goto `${BASE}/#/projects/continuum`.
    - Locate an unchecked `.todo input[type="checkbox"]`; click it.
    - Expect that todo row to gain class `done` and the checkbox to be `:checked`.
    - Click again; expect class `done` removed and checkbox unchecked.

39. **"Add a todo" input creates a todo on Enter**
    - Goto `${BASE}/#/projects/continuum`.
    - Fill `.todo input.add-input[placeholder="+ add a todo…"]` with "pw todo item", press Enter.
    - Expect a new `.todo` row whose `.text` contains "pw todo item".
    - Expect the add input to be cleared.

40. **"Open source ↗" opens the source URL in a new tab (when sourceUrl set)**
    - Goto `${BASE}/#/projects/torii-quest`.
    - Click `button.ghost` (text "Open source ↗").
    - Expect a popup (or `page.waitForEvent('popup')`) navigating to the GitHub URL.

41. **Delete button is hidden for protected slugs**
    - Goto `${BASE}/#/projects/continuum`.
    - Expect `#main-content button.ghost` text "Delete" to have count 0.
    - Repeat for `/projects/torii-quest`.

42. **Delete button confirms then removes a user-created project**
    - Create a throwaway project "Tmp Delete" (see case 25).
    - On its home, click `button.ghost` (text "Delete").
    - `page.on('dialog', d => d.accept())` to auto-accept the confirm.
    - Expect URL `…/#/projects` and no `.project-card` containing "Tmp Delete".

43. **Milestone status renders the correct pill class**
    - Goto `${BASE}/#/projects/torii-quest`.
    - Expect at least one `.milestone.done .pill.ok`, one `.milestone.active .pill.hot`.

### G. Marketplace

44. **Marketplace renders task rows and header counts**
    - Goto `${BASE}/#/marketplace`.
    - `#main-content .task-row` count ≥ 5.
    - `.page-actions .pill.ours` text matches `/\d+ ours/`.

45. **"Ours" rows carry the `.ours` class and amber pill**
    - Goto `${BASE}/#/marketplace`.
    - `#main-content .task-row.ours` count ≥ 1.
    - Each `.task-row.ours .task-title .pill.ours` text is "ours".

46. **Search input filters rows by title**
    - Goto `${BASE}/#/marketplace`.
    - Fill `.filter-bar input[type="text"]` with "strfry".
    - Expect `.task-row` count to shrink and each remaining `.name` to contain "strfry".

47. **Complexity select filters by size**
    - Goto `${BASE}/#/marketplace`.
    - Record initial `.task-row` count.
    - Select `.filter-bar select` (complexity) option "L · Large" → wait.
    - Expect every `.task-cell` (size column) to contain "L".
    - Reset to "Any size"; expect count back to initial.

48. **Sort select reorders by bounty**
    - Goto `${BASE}/#/marketplace`.
    - Select sort "Sort: highest bounty".
    - Read all `.task-cell` bounty values in order; assert non-increasing.

49. **"Show ours only" toggle restricts to ours rows and flips its label/class**
    - Goto `${BASE}/#/marketplace`.
    - Click `.filter-bar button` (text "Show ours only").
    - Expect every `.task-row` to have class `ours`.
    - Expect the same button text "Show all" and to have class `primary`.
    - Click again; expect mixed rows return and button text back to "Show ours only".

50. **Empty filter result renders the ∅ empty state**
    - Goto `${BASE}/#/marketplace`.
    - Fill search with "zzzzz-no-match".
    - Expect `#main-content .empty .big` text "∅".

51. **Task rows are keyboard-focusable** (a11y)
    - Goto `${BASE}/#/marketplace`.
    - `#main-content .task-row[role="button"][tabindex="0"]` count ≥ 1.

### H. Routstr

52. **Routstr hero shows not-connected state on fresh seed**
    - Goto `${BASE}/#/routstr`.
    - `.routstr-hero .pill` text "not connected".
    - `.routstr-hero .stat .value` shows the formatted balance ("0" or "—").
    - `#main-content button` text "Connect Cashu wallet" visible.

53. **Model picker lists all seeded models with DeepSeek default selected**
    - Goto `${BASE}/#/routstr`.
    - `#main-content .model-list .model` count ≥ 6.
    - `.model.selected .name` text "DeepSeek Chat".

54. **Clicking a model selects it and re-renders**
    - Goto `${BASE}/#/routstr`.
    - Click `.model` whose `.name` is "GPT-4o".
    - Expect `.model.selected .name` text "GPT-4o" after re-render.

55. **Endpoint input change persists to store** (visible after re-render)
    - Goto `${BASE}/#/routstr`.
    - Fill the endpoint `input[type="text"]` (current value `https://api.routstr.com`)
      with `https://test.example`, dispatch `change`.
    - Reload `${BASE}/#/routstr`.
    - Expect endpoint input value to be `https://test.example` (store persisted).

56. **Monthly budget input accepts a number and persists**
    - Goto `${BASE}/#/routstr`.
    - Set the budget `input[type="number"]` to `50000`, dispatch `change`.
    - Expect `.usage-bar` and "Monthly budget" label to reflect `50,000` (or `50k`) sats.

57. **Demo-mode Connect bumps balance to connected state with no network call**
    - *(Only runnable when agent is NOT configured — demo build.)*
    - Goto `${BASE}/#/routstr`; ensure `button` text "Connect Cashu wallet".
    - Click it.
    - Expect `.routstr-hero .pill` text "connected".
    - Expect balance value to be a number in `[12000, 20000]`.
    - Expect button text "Disconnect".

58. **Disconnect returns to not-connected with zero balance**
    - Precondition: connected (run case 57 first).
    - Click `button` text "Disconnect".
    - Expect `.routstr-hero .pill` text "not connected" and balance "0".

59. **Agent-configured + logged-out Connect triggers login modal**
    - *(Only when agent configured & no token.)* Inject/assert no `continuum.session.v1`.
    - Goto `${BASE}/#/routstr`; click "Connect Cashu wallet".
    - Expect `.modal` with title "Login with Nostr" OR "NIP-07 signer not found"
      OR "Login unavailable in demo" depending on environment.

60. **Top-up modal redeem calls POST /api/wallet/receive**
    - *(Requires logged-in session.)* Set up a valid token.
    - Open Routstr, click Connect → top-up modal appears.
    - Fill `textarea` with a test Cashu token; click `.modal button.primary` "Redeem to agent".
    - Expect network request `POST /api/wallet/receive` to fire (use `page.route` or `page.waitForRequest`).
    - On `{received_sats, balance_sats}` response, expect status text "Received … sats."

### I. Dashboard

61. **Dashboard renders aggregate stat cards**
    - Goto `${BASE}/#/dashboard`.
    - `.grid-3 .card` count = 3, with labels "Overall progress", "Open todos", "Sessions logged".

62. **"By project" rows navigate to each project home**
    - Goto `${BASE}/#/dashboard`.
    - Click `#main-content .session[role="button"]` whose `.title` is "Torii Quest".
    - Expect URL `…/#/projects/torii-quest`.

63. **Static oversight link is external**
    - Goto `${BASE}/#/dashboard`.
    - `a[href="https://torii-quest.pplx.app"]` present with `target="_blank"`.

### J. Chat Dock

64. **Chat dock is collapsed on load with greeting**
    - Goto `${BASE}/#/projects`.
    - Expect `.chat-dock.collapsed` visible.
    - Expect `.chat-log .chat-msg.ai` count ≥ 1 (greeting).

65. **Toggle button expands and collapses the dock**
    - Goto `${BASE}/#/projects`.
    - Click `.chat-toggle[aria-label="Toggle chat"]`.
    - Expect `.chat-dock.expanded` and toggle text "▼".
    - Click again; expect `.chat-dock.collapsed` and text "▲".

66. **Send via Send button posts user msg and gets a reply (mock path)**
    - Goto `${BASE}/#/projects`; ensure logged out (mock path).
    - Click `.chat-toggle` to expand.
    - Fill `textarea.chat-input` with "help"; click `button.chat-send`.
    - Expect `.chat-msg.user` text "help".
    - Expect a `.chat-thinking` to appear then a second `.chat-msg.ai` reply
      containing "I'm your project engine".

67. **Enter sends; Shift+Enter inserts newline**
    - Expand dock; focus `textarea.chat-input`, type "milestone", press Enter.
    - Expect a user msg and a reply mentioning "milestones".
    - Type "a", press Shift+Enter, type "b": expect the textarea value to contain a newline.

68. **Chat context label updates per view**
    - Goto `${BASE}/#/projects`; `.chat-context` text contains "Projects".
    - Goto `${BASE}/#/marketplace`; `.chat-context` text contains "Marketplace".
    - Goto `${BASE}/#/projects/continuum`; `.chat-context` text contains "Continuum".

69. **Logged-in chat routes through agent (POST /api/chat)**
    - *(Requires valid session.)* Seed token.
    - Expand dock, send "hello".
    - Expect `page.waitForRequest(r => r.url().endsWith('/api/chat') && r.method() === 'POST')`.

### K. Auth / Session

70. **Session button click with no agent opens "Login unavailable in demo"**
    - *(Demo build only.)* Goto `${BASE}/#/projects`.
    - Click `nav.sidebar button.session-btn`.
    - Expect `.modal h3` text "Login unavailable in demo".
    - Click `.modal button.primary` "OK"; expect `.modal` count 0.

71. **Session button click with agent + no signer opens "NIP-07 signer not found"**
    - *(Agent configured, no `window.nostr`.)* Click session button.
    - Expect `.modal h3` text "NIP-07 signer not found".
    - Expect links to Chrome + Firefox stores present.
    - Click "OK"; modal closes.

72. **Login modal surfaces challenge request (POST /api/auth/challenge)**
    - *(Agent configured + NIP-07 stub injected.)*
    - Before clicking, `await page.addInitScript(() => { window.nostr = { signEvent: async () => ({ id:'x', pubkey:'x', sig:'x', kind:22242, content:'', tags:[], created_at:0 }) }; })`.
    - `page.waitForRequest(r => r.url().endsWith('/api/auth/challenge'))`.
    - Click session button; expect request fired and status text to advance
      past "Requesting challenge…".

73. **Successful verify stores token and flips session button**
    - Continue from 72 with a stubbed verify response (mock `/api/auth/verify`
      via `page.route` to return `{token:'a.9999999999.b.c', expires_at:...}`).
    - Expect `localStorage.getItem('continuum.session.v1')` set.
    - Expect `nav.sidebar button.session-btn` to have class `logged-in` and text "Sign out".

74. **Sign out clears token and restores logged-out button**
    - From a logged-in state, click `nav.sidebar button.session-btn` (text "Sign out").
    - Expect `localStorage.getItem('continuum.session.v1')` null.
    - Expect button text back to "Login" or "Demo mode".

75. **401 from any agent call auto-clears the session token**
    - Seed a token; `page.route('**/api/wallet/balance', r => r.fulfill({status:401, body:'{"error":"expired"}'}))`.
    - Goto `${BASE}/#/routstr` (triggers balance poll when logged in).
    - Expect token cleared after the poll fires.

### L. Persistence & Cross-Cutting

76. **localStorage key `continuum.v1` is populated on first boot**
    - Goto `${BASE}/#/` with cleared storage.
    - Expect `JSON.parse(localStorage.getItem('continuum.v1'))` to have
      `projects` (array length 2), `routstr`, `marketTasks`.

77. **Created project survives reload**
    - Create "Persist Proj" (case 25).
    - Reload `${BASE}/#/projects`.
    - Expect `.project-card` containing "Persist Proj".

78. **Added todo survives reload**
    - Add todo "persist-todo" to `/projects/continuum` (case 39).
    - Reload; expect `.todo .text` containing "persist-todo".

79. **Routstr model selection survives reload**
    - Select "GPT-4o" (case 54); reload `/routstr`.
    - Expect `.model.selected .name` "GPT-4o".

80. **Marketplace sort preference does NOT persist (view-local state)** — negative test
    - Goto `/marketplace`; sort "ours first".
    - Reload; expect sort select back to default "Sort: highest bounty".

---

## 4. Notes & Caveats for Implementation

- **No `data-testid`.** All selectors above are CSS-class/ARIA based. If the
  team adds `data-testid` hooks (recommended for the project cards, todo rows,
  model rows), update cases 20–25, 38–43, 53–54 to prefer them.
- **Demo vs. agent builds.** Cases 57–60 and 70–75 are environment-sensitive.
  Gate them with a `test.skip` / `test.fixme` predicate on `isAgentConfigured`
  (probe `${AGENT}/api/health` in a beforeAll) so the suite runs cleanly on
  both `continuum-torii.pplx.app` (demo) and `continuum.example.com` (agent).
- **NIP-07 mocking.** Use `page.addInitScript` to install `window.nostr` before
  any navigation (cases 72–73). Combine with `page.route` to stub
  `/api/auth/verify` so the verify step is deterministic without a real signer.
- **`window.confirm` (case 42).** Register `page.on('dialog', d => d.accept())`
  *before* clicking Delete.
- **`renderTodos.refresh` full re-render** (projectHome.js line 203) means todo
  mutations rebuild the entire `#main-content`; after toggling/adding, re-query
  selectors fresh rather than caching locators across the action.
- **Marketplace task rows have `role="button"` but no click handler** (case 51):
  assert focusability only, not navigation.
- **Existing suite** (`happy-path.spec.ts`) already covers a subset (cases
  14–16, 20, 22–23, 44–48 partially, 52–53, 61, 35, 8). The plan above is a
  superset; dedupe before generating specs.
