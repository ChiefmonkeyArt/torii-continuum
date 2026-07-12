# Continuum Codebase — Untested Functionality Gap Analysis

**Date:** 2026-07-07  
**Source:** All `.js` and `.mjs` files in `src/` and `agent/` vs `tests/playwright/comprehensive.spec.ts` (53 tests, 12 groups A–L)

---

## 1. src/main.js — App Entry & Event Listeners

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `setLandingMode(true/false)` | Partial | Side-effect tested via A02/A03 (class toggle on `#app`), but `if (!app) return;` guard is untested |
| `boot()` function | Yes | A01 (SPA loads) exercises the happy path |
| `document.addEventListener('continuum:session-changed', …)` — re-render landing on session change | **NO** | The listener re-renders the landing page when session state changes while on `/`; no test dispatches this event |
| `document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false })` — iOS double-tap zoom prevention | **NO** | Global gesture event listener, no test exercises it |
| `document.readyState === 'loading'` vs `else` branch | **NO** | The deferred-vs-immediate boot path is never verified (always loads as `complete` in Playwright) |
| `if (!root) return;` (missing `#app` element) | **NO** | Silent no-op guard |

---

## 2. src/router.js — Hash Router

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `route(pattern, handler)` | Partial | Implicit via A07 |
| `keysOf(pattern)` (internal) | **NO** | Regex to extract `:param` names |
| `toRegex(pattern)` (internal) | **NO** | Pattern → RegExp conversion |
| `resolve()` | Partial | Implicit via A06 (unknown route → landing) |
| Fallback to landing (line 43: `window.location.hash = '#/'`) | Yes | A06 confirms redirect |
| `navigate(path)` — `if (window.location.hash === '#' + path) { resolve(); }` branch | **NO** | Navigation to the already-active route (no hash change, forces re-resolve) |
| `startRouter()` | **NO** | Not individually verified |
| Hash edge: hash is just `#/` or empty | **NO** | |
| Param decoding via `decodeURIComponent` | **NO** | Special characters in slugs (e.g. spaces, unicode) |

---

## 3. src/auth.js — NIP-07 Login Flow

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `hasSigner()` | **NO** | Requires `window.nostr.signEvent` — no NIP-07 extension in CI |
| `isSessionLive()` | Partial | I01/I02 — checks button presence/label, not the actual return value |
| `endSession()` — dispatches `continuum:session-changed` | **NO** | Event dispatch not listened-for in any test |
| **`startLogin()` — all branches:** | | |
| `loginModalHandle` guard (already-open) | **NO** | Prevents double dialog |
| Branch A: `!isAgentConfigured()` — "Login unavailable in demo" modal | Partial | I03 checks modal exists, but does not verify the specific "demo" subtitle |
| Branch B: `isAgentConfigured()` + `!hasSigner()` — "NIP-07 signer not found" modal | **NO** | Would need agent URL set but no NIP-07 extension |
| Branch C: Full challenge-sign-verify flow | **NO** | Requires NIP-07 extension + agent backend |
| — Sub-branch: `requestChallenge()` fails (`!chal.ok`) | **NO** | Error: "Could not reach agent" |
| — Sub-branch: `window.nostr.signEvent` throws | **NO** | Error: "Signer refused" |
| — Sub-branch: `verifyChallenge()` fails (`!verified.ok`) | **NO** | Error: "Agent rejected signature" |
| — Success path: token stored, session-changed dispatched, modal closes | **NO** | |

---

## 4. src/chat.js — AI Chat Dock

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `mountChat(root)` | Partial | H01 (dock visible) |
| `autosize()` (textarea auto-resize) | **NO** | |
| `greet()` — greeting message | Partial | H03 checks >=1 message exists, but does NOT verify the **content** differs based on `isSessionLive()` |
| Branch: live session vs demo greeting text | **NO** | Different greeting for logged-in vs demo |
| `setChatContext(next)` | **NO** | Called by every view, never verified |
| `renderContext()` | **NO** | |
| `push(who, text)` | **NO** | |
| `renderLog()` — `if (thinking)` "thinking" indicator | **NO** | The thinking spinner is never checked |
| `setExpanded(v)` | Partial | H02 (can be expanded) |
| **`send()` — guard branches:** | | |
| `if (!text || thinking) return;` | **NO** | Empty message guard + double-send prevention |
| Auto-expand when collapsed | **NO** | `if (!expanded) setExpanded(true)` |
| **`getReply(text, ctx)` — all branches:** | | |
| Branch A: `isSessionLive()` → `agentChat()` | **NO** | Requires auth |
| Branch A1: agent returns `ok && data.reply` | **NO** | |
| Branch A2: agent returns error with `r.reason && !r.offline` | **NO** | Fallback to mock with "(agent error: …)" prefix |
| Branch A3: agent returns error without reason / offline | **NO** | Fallback with "(agent unreachable — served mock)" prefix |
| Branch B: `!isSessionLive()` → `mockReply()` | Yes | H04 exercises this path |
| **`pickCanned(q, ctx)` — all 7 branches:** | | |
| "help" / "what can" branch | **NO** | |
| "milestone" / "roadmap" branch | **NO** | |
| "todo" / "task" branch | **NO** | |
| "routstr" / "model" / "deepseek" branch | **NO** | |
| "marketplace" / "bounty" branch | **NO** | |
| "new project" / "add repo" / "github" branch | **NO** | |
| Default fallback | **NO** | |
| `toggleChat()` | **NO** | Public API never invoked by any test |

---

## 5. src/views/landing.js — Landing Page

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `toriiSvg()` | Partial | B01 checks "an SVG or hero element" exists — does not verify SVG anatomy |
| **`renderLanding(mount)` — state-dependent rendering:** | | |
| Branch: `loggedIn=true` → shows "Go to your dashboard" button | **NO** | Tested only in logged-out state |
| Branch: `loggedIn=false` + `agentReachable=true` → "Login with Nostr" | **NO** | |
| Branch: `loggedIn=false` + `agentReachable=false` → "Login (requires self-hosted agent)" | **NO** | |
| Status pill: "agent reachable" vs "demo mode" | **NO** | |
| Footer links (github repo, torii-quest) | **NO** | |
| `startLogin` click handler on ghost button | **NO** | Button exists but click not tested in landing context |

---

## 6. src/views/projects.js — Projects List

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `renderProjects(mount)` | Partial | C01 (seeded projects shown) |
| `setChatContext` call | **NO** | |
| **`renderProjectCard(p)` — branches:** | | |
| Source pill: `local` vs `github`/`ngit` | **NO** | |
| Progress bar `width` percentage | **NO** | |
| Keyboard navigation (Enter/Space) | **NO** | `keydown` listeners on cards |
| `renderAddCard()` | **NO** | The "+" card is not individually verified |
| Add-card keyboard navigation | **NO** | |
| **`openNewProject()` — all validation paths:** | | |
| Empty name → "Give the project a name." | **NO** | |
| Non-blank tab, empty URL → URL prompt | **NO** | |
| Invalid GitHub URL → "doesn't look like github.com" | **NO** | |
| Invalid ngit URL → "ngit URLs start with ngit://" | **NO** | |
| Tab switching (blank/github/ngit) | Partial | C04 checks tabs exist, does NOT click between them |
| repoRow visibility toggling on tab switch | **NO** | |
| Placeholder changes on tab switch | **NO** | |
| Tags parsing (split, trim, filter empty) | **NO** | |
| `createProject` try/catch → error display | **NO** | Duplicate slug, etc. |
| `renderSidebar()` call after creation | **NO** | |

---

## 7. src/views/projectHome.js — Project Home

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `getProject` returns null → empty state | Partial | D07 checks content exists but not the specific "No project with that slug." text |
| Source link rendering (with/without `sourceUrl`) | **NO** | |
| Delete button hidden for "continuum" / "torii-quest" | **NO** | Protected projects |
| `openInSource(p)` button | **NO** | |
| **`renderMilestones(slug)`:** | | |
| Empty state "No milestones yet." | **NO** | |
| `statusToPill(status)` — all 4 branches (done/active/blocked/other) | **NO** | |
| **`renderSessions(slug)`:** | **NO** | Entirely untested |
| Empty state "No sessions logged yet." | **NO** | |
| **`renderTodos(slug)` — branches:** | | |
| Empty state (no todos) | **NO** | |
| Empty-text guard in add-input onKeydown (`if (!v) return;`) | **NO** | |
| `renderTodos.refresh` — re-render after add/toggle | **NO** | |
| **`renderFiles(slug)`:** | **NO** | Entirely untested |
| File kind/path/size rendering | **NO** | |
| Empty state "No files tracked yet." | **NO** | |
| `openInSource(p)` | **NO** | `window.open` with noopener/noreferrer |
| `confirmDelete(p)` | **NO** | Uses `window.confirm()` + `deleteProject()` + `navigate()` |

---

## 8. src/views/marketplace.js — Marketplace

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `renderMarketplace(mount)` | Partial | E01 (task listings exist), E02 (diverse content) |
| **Filter system — every interaction:** | | |
| Search input → `filter.query` → `draw()` | **NO** | |
| Complexity selector (S/M/L/all) → `draw()` | **NO** | |
| Sort selector (bounty/recent/ours) → `draw()` | **NO** | |
| "Show ours only" toggle → `filter.oursOnly` flip → `draw()` | **NO** | E03 checks sidebar item exists, not the filter |
| **`draw()` — all branches:** | | |
| Filtered rows empty → "No tasks match those filters." | **NO** | |
| `complexityLabel(c)` — all 4 values (S/M/L/other) | **NO** | |
| Ours-only button text/class toggle | **NO** | |

---

## 9. src/views/routstr.js — Routstr Page

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `renderRoutstr(mount)` | Partial | F01 (renders), F02 (model info), F03 (usage info) |
| **State-dependent rendering:** | | |
| Connected vs disconnected state pills | **NO** | |
| Balance polling start/stop on session change | **NO** | |
| Endpoint input `change` handler | **NO** | |
| Monthly budget input `change` handler | **NO** | |
| Model picker click → `updateRoutstr()` + re-render | **NO** | |
| **`connect()` — all branches:** | | |
| `!isAgentConfigured()` → demo mode (bump mock balance) | **NO** | |
| `!isSessionLive()` → `startLogin()` | **NO** | |
| Both true → `openTopUpModal()` | **NO** | Requires auth |
| **`openTopUpModal()` — all branches:** | | |
| Empty token validation → "Paste a Cashu token first." | **NO** | |
| `walletReceive()` fails → error display | **NO** | |
| `walletReceive()` succeeds → success message + re-render | **NO** | |
| **`disconnect()`** | **NO** | Resets state, stops poll, re-renders |
| **`startBalancePoll(mount)`** | **NO** | Polling loop with `walletBalance()` |
| **`stopBalancePoll()`** | **NO** | `clearInterval` |

---

## 10. src/views/dashboard.js — Dashboard

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `renderDashboard(mount)` | Partial | G01 (renders), G02 (project summary) |
| **Aggregation logic:** | | |
| Empty state: 0 projects | **NO** | Division by zero in `totalMs ? … : 0` |
| Per-project rundown rendering | **NO** | |
| Progress bar widths | **NO** | |

---

## 11. src/views/util.js — Shared Helpers

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `h(tag, attrs, children)` | **NO** | Used by every view, never unit-tested |
| — `onX` event handler binding | **NO** | |
| — `dataset` attribute | **NO** | |
| — `false`/`null` value skipping | **NO** | |
| — Child rendering (null/false skip, text vs element) | **NO** | |
| `clear(node)` | **NO** | |
| `svg(tag, attrs, children)` | **NO** | SVG namespace builder |
| `formatSats(n)` | **NO** | null/NaN→'—', ≥100k→'k' |
| `formatBytes(n)` | **NO** | falsy→'—', B/KB/MB |
| `timeAgo(secTs)` | **NO** | All time windows (s/m/h/d/date), future timestamps |
| `openModal({title, subtitle, body, onClose})` | **NO** | Backdrop click close, null subtitle, onClose callback |

---

## 12. src/data/store.js — Local Store

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `initStore()` | Partial | J01 checks localStorage populated |
| — Loaded data has projects → merge with emptyState | **NO** | |
| — Loaded data missing marketTasks → re-seed | **NO** | |
| — Loaded data missing routstr → re-seed | **NO** | |
| — No loaded data → `seedInitialState()` | **NO** | |
| `subscribe(fn)` / `notify()` | **NO** | Subscriber pattern |
| `createProject()` — duplicate slug error | **NO** | |
| `deleteProject(slug)` — cascade cleanup | **NO** | |
| `sessionsFor()` | **NO** | |
| `milestonesFor()` | **NO** | |
| `todosFor()` | **NO** | |
| `filesFor()` | **NO** | |
| `updateRoutstr(patch)` | **NO** | |
| `slugify(s)` — all edge cases | **NO** | Special chars, empty→fallback, length cap at 48 |
| `loadRaw()` — corrupt JSON → catch null | **NO** | |
| `persist()` — localStorage write failure catch | **NO** | |
| **localStorage corruption edge cases:** | **NO** | All untested |
| — Empty `continuum.v1` key | **NO** | |
| — Non-JSON value in key | **NO** | |
| — Truncated/partial state | **NO** | |
| — `localStorage` unavailable (private browsing) | **NO** | |

---

## 13. src/data/schema.js — Event Schema

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `makeEvent({kind, d, content, tags})` | **NO** | `d` present vs absent → d-tag inclusion |
| `newId(prefix)` | **NO** | |
| `nowSec()` | **NO** | |
| `getTagValue(ev, key)` | **NO** | |

---

## 14. src/data/agent.js — HTTP Client

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `agentUrl()` — priority chain (env var, window override) | **NO** | |
| `isAgentConfigured()` | Partial | Side-effect in demo vs live |
| `getStoredToken()` / `setStoredToken()` / `clearStoredToken()` | **NO** | |
| `isLoggedIn()` — token format (4 parts), expiry check | **NO** | |
| **`req(method, path, body)` — all branches:** | | |
| No base URL → `{ ok: false, offline: true }` | **NO** | |
| Network error → `{ ok: false, offline: true }` | **NO** | |
| 401 response → `clearStoredToken()` | **NO** | |
| JSON parse failure on response → null data | **NO** | |
| `requestChallenge()` | **NO** | Client function (server endpoint tested via L02) |
| `verifyChallenge(event)` | **NO** | Token storage on success |
| `logout()` | **NO** | |
| `walletBalance()` | **NO** | |
| `walletReceive(token)` | **NO** | |
| `chat({message, context})` | **NO** | |
| `health()` | **NO** | |

---

## 15. agent/index.mjs — Agent Server Entry (Server-Side)

| Endpoint / Code Path | Tested? | Notes |
|----------------------|---------|-------|
| GET /api/health | Yes | L01, L08 (ok, service, version, memory_unlocked) |
| GET /api/health/models | **NO** | Provider reachability probe (admin-gated) |
| POST /api/auth/challenge | Yes | L02 (challenge length, kind, expires_in) |
| POST /api/auth/verify | Partial | L03 (empty body → 400); happy path NOT tested |
| GET /api/wallet/balance | **NO** | (L04 checks 401/404 only) |
| POST /api/wallet/receive | **NO** | |
| POST /api/chat | Partial | L05 (no auth → 401); happy path NOT tested |
| — Message length validation (>4000 → 400) | **NO** | |
| — Empty message validation → 400 | **NO** | |
| GET /api/character | **NO** | |
| GET /api/memory | **NO** | |
| POST /api/memory/unlock | **NO** | (L06 checks 401) |
| — Character root verification return | **NO** | |
| — Panic key nudge logic | **NO** | |
| POST /api/memory/panic-nudge/dismiss | **NO** | |
| POST /api/memory/lock | **NO** | |
| POST /api/memory/store | **NO** | Ciphertext validation, kind validation, d_tag validation |
| GET /api/memory/ciphertexts | **NO** | File listing |
| POST /api/reflect | **NO** | |
| GET /api/pending | **NO** | |
| GET /api/pending/:file (happy path) | **NO** | L07 tests only path traversal attack |
| DELETE /api/pending/:file | **NO** | |
| **Server boot failure** (line 427–430) | **NO** | listen fails → process.exit(1) |
| **Graceful shutdown** (SIGINT/SIGTERM, lines 433–440) | **NO** | |
| **Panic-key nudge helpers:** readNudgeState, writeNudgeState, ciphertextsHavePanicKey, maybePanicKeyNudge, dismissPanicKeyNudge | **NO** | |
| **requireAdmin middleware** — valid token path | **NO** | Only tested with no token (401) |

---

## 16. agent/core/config.mjs — Config Loader

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `loadConfig(path)` | **NO** | Requires config.yaml on disk |
| — File read failure → process.exit(1) | **NO** | |
| — YAML parse failure → process.exit(1) | **NO** | |
| — Invalid admin_npub → error list → exit | **NO** | |
| — Placeholder admin_npub (contains 'REPLACE') → error | **NO** | |
| — Invalid session_secret (<64 chars) → error | **NO** | |
| — Placeholder session_secret → error | **NO** | |
| — Missing server.host/port → error | **NO** | |
| — Non-https routstr.endpoint → error | **NO** | |
| — Missing routstr.models.chat/coding → error | **NO** | |
| — Default values for optional fields | **NO** | |
| `agentRoot()` | **NO** | |

---

## 17. agent/core/auth.mjs — Authentication Core

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createAuth(cfg, deps)` — full function | **NO** | |
| — adminHex decode failure → process.exit(1) | **NO** | |
| — `gc()` garbage collection of expired challenges | **NO** | |
| `issueChallenge(clientIp)` | **NO** | (server endpoint tested via L02) |
| **`verifyChallenge(event, clientIp)` — all rejection paths:** | | |
| — No event → ok:false | **NO** | |
| — Wrong kind → ok:false | **NO** | |
| — Wrong pubkey → ok:false | **NO** | |
| — Missing challenge tag → ok:false | **NO** | |
| — Unknown/expired challenge → ok:false | **NO** | |
| — Content/tag mismatch → ok:false | **NO** | |
| — ID mismatch → ok:false | **NO** | |
| — Bad signature → ok:false | **NO** | |
| — IP mismatch warning (allowed) | **NO** | |
| `issueSessionToken()` | **NO** | HMAC signing |
| **`verifySessionToken(token)` — all rejection paths:** | | |
| — No token → ok:false | **NO** | |
| — Malformed (<4 parts) → ok:false | **NO** | |
| — Bad timestamps → ok:false | **NO** | |
| — Expired → ok:false | **NO** | |
| — Not admin pubkey → ok:false | **NO** | |
| — Bad HMAC signature → ok:false | **NO** | |
| — timingSafeEqual catch → ok:false | **NO** | |
| — Valid token → ok:true | **NO** | |

---

## 18. agent/core/wallet.mjs — Cashu Wallet

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createWallet(cfg, log)` — full setup | **NO** | Requires Cashu mint URLs |
| — No mints configured → warning | **NO** | |
| — Mint unreachable at boot → warning | **NO** | |
| `balance()` | **NO** | |
| **`receive(encodedToken)` — all branches:** | | |
| — Bad token encoding → ok:false | **NO** | |
| — Missing mint URL → ok:false | **NO** | |
| — Mint not whitelisted → ok:false | **NO** | |
| — Mint refuses token → ok:false | **NO** | |
| — Happy path → ok:true | **NO** | |
| **`send(sats)` — all branches:** | | |
| — sats < 1 → ok:false | **NO** | |
| — Insufficient balance across all mints → ok:false | **NO** | |
| — Send failed → ok:false | **NO** | |
| — Happy path + rollback function | **NO** | |

---

## 19. agent/core/routstr.mjs — Routstr Client

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createRoutstr(cfg, wallet, log)` | **NO** | |
| **`chat({skill, messages})` — all branches:** | | |
| — Empty messages → ok:false | **NO** | |
| — Primary call succeeds → return result | **NO** | |
| — Primary fails, no fallback ladder → return failure | **NO** | |
| — Primary fails, fallback ladder succeeds → return fallback result | **NO** | |
| — All models fail → return last failure | **NO** | |
| **`callOnce(model, messages, sats)` — all branches:** | | |
| — wallet.send fails → ok:false | **NO** | |
| — Network error → rollback + ok:false | **NO** | |
| — HTTP error → rollback + ok:false | **NO** | |
| — Bad response JSON → rollback + ok:false | **NO** | |
| — No content in response → rollback + ok:false | **NO** | |
| — Happy path → ok:true with content/usage | **NO** | |
| Cost logging (`appendCostLog`) | **NO** | |
| Fallback ladder resolution | **NO** | |
| Model selection per skill | **NO** | |

---

## 20. agent/core/ollama.mjs — Ollama Client

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createOllama(cfg, log)` | **NO** | Requires Ollama running |
| **`probe()` — all branches:** | | |
| — Disabled in config → ok:false | **NO** | |
| — HTTP error → ok:false | **NO** | |
| — Unreachable (fetch throws) → ok:false | **NO** | |
| — Happy path → ok:true with model list | **NO** | |
| **`chat({skill, messages})` — all branches:** | | |
| — Disabled → ok:false | **NO** | |
| — Empty messages → ok:false | **NO** | |
| — Network timeout (AbortError) → ok:false | **NO** | |
| — HTTP error → ok:false | **NO** | |
| — Bad response JSON → ok:false | **NO** | |
| — No content → ok:false | **NO** | |
| — Happy path → ok:true | **NO** | |
| Cost logging | **NO** | |

---

## 21. agent/core/model-router.mjs — Model Router

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createModelRouter({routstr, ollama, cfg, log})` | **NO** | |
| **Strategy `routstr_first` (default):** | **NO** | |
| — Routstr succeeds → return | **NO** | |
| — Routstr fails, Ollama disabled → return Routstr error | **NO** | |
| — Routstr fails with non-payment error, Ollama enabled → no fallback | **NO** | |
| — Routstr fails with payment/net error, Ollama succeeds → fallback | **NO** | |
| — Both fail → merged error message | **NO** | |
| **Strategy `ollama_first`:** | **NO** | |
| — Ollama succeeds → return | **NO** | |
| — Ollama disabled/fails → fallback to Routstr | **NO** | |
| **Strategy `ollama_only`:** | **NO** | |
| — Ollama enabled → use Ollama | **NO** | |
| — Ollama disabled → error "ollama disabled but ollama_only strategy set" | **NO** | |
| **Strategy `routstr_only`:** | **NO** | |
| `isPaymentOrNetworkError(reason)` — exported via `_internals` | **NO** | 6 markers (network, unreachable, 402, payment, insufficient, cashu) |
| `withProvider(result, provider)` | **NO** | |

---

## 22. agent/skills/chat.mjs — Chat Skill

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createChatSkill(router, log, deps)` | **NO** | |
| **`handle({message, context})` — all branches:** | | |
| — Procedural guard blocks → ok:false | **NO** | |
| — Model call fails → ok:false | **NO** | |
| — Episodic append throws (caught, logged) | **NO** | |
| — Happy path → ok:true with reply metadata | **NO** | |
| **`composeSystemPrompt({memory, context})` — all branches (exported):** | | |
| — No context label → empty ctxLine | **NO** | |
| — Memory null/undefined → SKILL_INSTRUCTIONS only | **NO** | |
| — `!status.character_loaded` → "CHARACTER.md missing" notice | **NO** | |
| — Character loaded, `!cache.unlocked` → LOCKED_NOTICE + character fragments | **NO** | |
| — Character loaded, unlocked, `!character_root_verified` → warning + full stack | **NO** | |
| — Full: character verified → character + procedural + semantic | **NO** | |

---

## 23. agent/lib/reflect.mjs — Reflection Engine

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createReflector({agentRoot, cache, log})` | **NO** | |
| **`reflect({limit, dryRun})` — all branches:** | | |
| — Cache locked → ok:false "memory cache locked" | **NO** | |
| — No episodic files → empty result | **NO** | |
| — Pattern match hits → draft proposed | **NO** | |
| — Pattern match but slug already exists (existing or pending) → skip | **NO** | |
| — Dry run → no files written | **NO** | |
| — Watermark advancement | **NO** | |
| — Limit reached mid-iteration | **NO** | |
| **`appendEpisodic(...)`** | **NO** | Writes to `memory/episodic/YYYY-MM-DD.jsonl` |
| Pattern matching (2 patterns: user-preference, refusal-teach) | **NO** | |
| `shortHash(s)` | **NO** | |
| Internal helpers: readWatermark, writeWatermark, listEpisodicFiles, readEpisodicLines, existingSlugs, pendingSlugs | **NO** | |

---

## 24. agent/lib/events.mjs — Event Drafters

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `draftCharacterRoot(...)` | **NO** | Validates characterHash (64 hex), sourcesHash (64 hex), characterVersion (≤64) |
| `draftSemanticFact(...)` | **NO** | Validates fact length ≥3, confidence in {high,medium,low} |
| `draftProceduralSkill(...)` | **NO** | Validates name, trigger, action all ≥2 chars |
| `draftDestructiveIntent(...)` | **NO** | Validates targetKind in [0,30092,30094,30095], targetDTag non-empty, reason ≥3 chars |
| `draftEmergencyWipe(...)` | **NO** | Validates operatorNpub starts with "npub1" |
| `dirForKind(kind)` — all 5 kinds + unknown throw | **NO** | |
| `unsignedEvent(kind, dTag, content, extraTags)` | **NO** | assertSlug, assertJsonSafe (32KB cap) |
| `assertSlug()` — dTag validation regex | **NO** | |
| `assertJsonSafe()` — size cap | **NO** | |

---

## 25. agent/lib/crypto.mjs — Crypto & Memory Cache

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createMemoryCache(log)` | **NO** | |
| **`unlock(npub, entries)` — all branches:** | | |
| — Missing npub → throw | **NO** | |
| — Missing/non-array entries → throw | **NO** | |
| — Entry missing kind or dTag → skip | **NO** | |
| — Duplicate kind:dTag → keep newer createdAt | **NO** | |
| — Happy path → replaces cache, returns count | **NO** | |
| `get(kind, dTag)` | **NO** | |
| `list(kind, dTagPrefix)` — with/without prefix filter | **NO** | |
| `clear(reason)` — wipes cache, resets state | **NO** | |
| `snapshot()` — by_kind counts | **NO** | |
| `isUnlocked()` | **NO** | |
| `unlockedForNpub()` | **NO** | |
| **`validateCiphertext(ciphertext)` — all rejection paths:** | | |
| — Not a string → ok:false | **NO** | |
| — Too short (<132 chars) → ok:false | **NO** | |
| — Too large (>65535) → ok:false | **NO** | |
| — Invalid base64 → ok:false | **NO** | |
| — Decoded <99 bytes → ok:false | **NO** | |
| — Wrong version byte → ok:false | **NO** | |
| — Valid → ok:true | **NO** | |
| **`ciphertextFilename(eventId)` — all branches:** | | |
| — Valid eventId (64 hex) → `{id}.enc` | **NO** | |
| — Bad eventId → throws | **NO** | |
| — Null eventId → `draft-<random>.enc` | **NO** | |
| `fingerprintCiphertext(ciphertext)` | **NO** | SHA-256 fingerprint |

---

## 26. agent/lib/memory.mjs — Memory Loader

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| `createMemoryLoader({cache, agentRoot, log})` | **NO** | |
| **`loadCharacter()` — all branches:** | | |
| — CHARACTER.md found → hash + cache | **NO** | |
| — File missing/EACCES → ok:false with reason | **NO** | |
| **`verifyCharacterRoot()` — all branches:** | | |
| — No character loaded → ok:false | **NO** | |
| — No root signed (first run) → ok:true with reason | **NO** | |
| — Hash mismatch → ok:false with diff | **NO** | |
| — Match → ok:true | **NO** | |
| **`promptFragments()` — all branches:** | | |
| — Semantic empty → null | **NO** | |
| — Procedural all code-only → null | **NO** | |
| — Full stack | **NO** | |
| `renderSemantic(entries)` — confidence label, why rendering | **NO** | |
| `renderProcedural(entries)` — code-only guard filter, name/trigger/action rendering | **NO** | |
| `applyProceduralGuards(message)` — not-string, empty, valid | **NO** | |
| `panicKey()` | **NO** | |
| `status()` — all fields | **NO** | |

---

## 27. agent/scripts/seed-drafts.mjs — Setup Script

| Code Path | Tested? | Notes |
|-----------|---------|-------|
| Entire script | **NO** | One-time setup, not part of app runtime |

---

## Summary

| Category | Count |
|----------|-------|
| **Source files audited** | 25 (17 in `src/`, 8 in `agent/` excluding `scripts/`) |
| **Tests in comprehensive.spec.ts** | 53 |
| **Testable gaps identified** | **~300+** distinct code paths/functions/edge cases |
| **Fully tested files** | 0 |
| **Partially tested files** | All `src/` files have some coverage via E2E tests |
| **Entirely untested `src/` files** | None (all have some surface coverage) |
| **Entirely untested `agent/` files** | All 8 agent files have **zero** dedicated tests |

### Highest-Risk Untested Areas

1. **localStorage corruption** — `src/data/store.js`: `loadRaw()` catches JSON parse errors, but no test verifies behavior with empty, corrupt, or truncated state
2. **Auth full flow** — `src/auth.js`: Only the "demo mode" modal is tested; the full NIP-07 challenge/sign/verify flow and all error paths are uncovered
3. **Chat agent path** — `src/chat.js`: `getReply()` with live session, agent error fallbacks, and all canned reply variations
4. **Project CRUD edge cases** — `src/views/projects.js`: All validation failures (empty name, invalid URLs, duplicate slugs) and tab switching
5. **Delete project** — `src/views/projectHome.js`: `confirmDelete()` path (window.confirm → deleteProject → navigate)
6. **Marketplace filters** — `src/views/marketplace.js`: All filter/sort interactions and empty results state
7. **Routstr connect/disconnect** — `src/views/routstr.js`: All wallet connection flows, balance polling, top-up modal
8. **Agent server routes** — `agent/index.mjs`: 15/20 endpoints have no happy-path test
9. **Auth core** — `agent/core/auth.mjs`: 15+ rejection paths in challenge verification and token verification
10. **Wallet/Routstr/Ollama clients** — All error branches (network failures, bad responses, timeouts, insufficient balance)
11. **Memory stack** — `agent/lib/crypto.mjs`, `agent/lib/memory.mjs`, `agent/lib/reflect.mjs`, `agent/skills/chat.mjs`: Entire character/memory/reflection pipeline
12. **Event drafters** — `agent/lib/events.mjs`: All 5 event kind drafters with input validation
13. **Config loader** — `agent/core/config.mjs`: All 7 invariant checks + YAML parse failure
14. **Model router** — `agent/core/model-router.mjs`: All 4 routing strategies and payment-error detection
15. **Utility functions** — `src/views/util.js`: `h()`, `formatSats()`, `formatBytes()`, `timeAgo()`, `openModal()` — zero unit tests
