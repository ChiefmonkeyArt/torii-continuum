# Torii Continuum — Progress log

Living release log for the `torii-continuum` repo. Newest first. One entry per release. Longer slice reports live alongside as `torii-continuum-v0.2.N-<slice>-report.md` when a release warrants deeper narration; this file is the fast scan.

Companion source-of-truth files (per the `Torii` Space instructions, one set per project):

- `torii-continuum-strategy.md` — vision, principles, decision rules, architecture direction.
- `torii-continuum-todo.md` — active task queue.
- `torii-continuum-progress.md` — this file, release log.
- `torii-continuum-handoff.md` — developer entry point / resume point.

## v0.2.58-alpha — ui: fancy glass login with blurred Vermilion Dawn torii background

Frontend-only release (`src/views/login.js` + `src/styles/landing.css` + new `src/assets/torii-login-bg.webp`; **no agent code changed**; onboarding preview stays **v0.1.20-preview**). Root `package.json` + lockfile bumped `0.2.57-alpha → 0.2.58-alpha`.

**Why.** The unauthenticated login screen was a plain card. This redesigns it into a premium, branded surface without touching *when* it appears (the auth gate is unchanged — login still shows only when there is no live session).

**Change.** Login now renders a full-viewport blurred "Vermilion Dawn" torii backdrop (`.login-bg`, `aria-hidden`) under a centered frosted-**glass** modal (`.login-card.glass`, `backdrop-filter: blur(22px) saturate(140%)`). The torii image ships as `src/assets/torii-login-bg.webp` (64 KB) referenced via CSS `url()` so Vite hashes/emits it for cache-busting. Premium wordmark ("Continuum" display + tracked "PROJECT ENGINE" subtitle with a vermilion accent rule), a full-width vermilion→gold gradient sign-in button, and secondary links below. Subtle motion (slow ken-burns on the backdrop + modal entrance) is fully disabled under `prefers-reduced-motion`. Reuses the existing `--font-display` system stack (no external fonts — strict no-CDN policy). Version stamp preserved as a small muted modal footer line. All rendering stays `h()`/textContent (no innerHTML); NIP-07 sign-in, "Explore the demo", and About links preserved verbatim.

**Tests.** Root `vitest run` **1103/1103** (unchanged — source-structure login assertions still hold). `npm run build` clean; `dist/assets/torii-login-bg-*.webp` emitted and referenced from the hashed CSS.
## v0.2.58-alpha — OPS-CUTOVER-1: audited combined cutover as an in-repo, root-owned operator script

Ops-only release (**no app/agent runtime code changed** — a new script + test + README under `ops/`, docs, and the version stamps; onboarding preview stays **v0.1.21-preview**). Root + agent `package.json` bumped `0.2.51-alpha → 0.2.52-alpha` (the script targets its own release tag and the Continuum health gate asserts that version).

**Why.** A prior delivery pasted the standalone cutover script body straight into an interactive VPS shell and the paste **truncated mid-function**. An interactive shell executes whatever it has received, so a truncated paste can begin a partial, dangerous run. This release incorporates the same audited cutover into the repo so it is fetched from **one immutable annotated release tag** and invoked with a short command from a verified clone: `sudo bash ops/torii-final-cutover.sh`.

**Two structural defenses replace the broken delivery.**
- **Anti-partial-delivery brace group.** The entire executable body lives inside a single `{ … }` group whose closing brace is the last line. `bash` parses to the matching brace before running anything, so a truncated copy is missing the brace, fails `bash -n`, and runs **nothing** (verified at four truncation depths).
- **No `exec sudo -- bash "$0"`.** When pasted/sourced, `$0` is the interactive shell (e.g. `-bash`), so that idiom re-execs the wrong thing. The script instead **requires root** (dies with the documented invocation) and **refuses to be sourced** (`BASH_SOURCE[0]` ≠ `$0`).

**Behaviour preserved from the audited source** (`/home/user/workspace/torii-final-cutover.sh`, reviewed line-by-line against the current repos): exact annotated-tag verification (`git cat-file -t` == `tag`) + version markers for torii-base **v0.1.4** (VERSION / sidecar `package.json` / `const VERSION = '0.1.4';` / launcher 'Continuum amber'), torii-continuum **v0.2.58-alpha**, onboarding preview **v0.1.21-preview** (VERSION + exact CTA "Sign in with browser extension"); root-only timestamped backups under `/root/torii-final-cutover-<UTC>/`; torii-base redeploy via its sanctioned bootstrap (`TORII_DOMAIN` + `SKIP_CERTBOT=1`); Continuum OPS-DEPLOY-2 bootstrap + root-only pin + `systemctl start` with a `/api/health` **version gate**; **fail-closed** onboarding-preview layout detection (root-symlink vs continuum-dir; ambiguity/absence aborts) with an atomic stage → `mv -T` → `.prev` swap that keeps exactly one rollback; registry `root_app` / app-name preservation checks; ERR-trap rollback. Also fixed the source draft's mixed-case `SIDEcar_HEALTH_URL` typo.

**Security / privacy.** Public HTTPS clones only; no secret read, written, or printed; no broad sudoers, no `NOPASSWD`, no auth weakened; existing `config.yaml` / `session_secret` / funded key preserved byte-for-byte by the hardened role (the script delegates, never reimplements). This script does **not** deploy on your behalf.

**Docs.** New `ops/torii-final-cutover.README.md` (invocation, rollback locations, and a **preflight** confirming the prior truncated paste made no mutations).

**Tests / verification (Node 20.20.1).** New `ops/test/torii-final-cutover.test.sh` **36/36** (brace-group structure + truncation-fails-`bash -n`, root/source guards, no `exec sudo`, pinned annotated tags + version markers, fail-closed preview detection, atomic swap + single rollback, health gates, backups, no-secrets / no-broad-sudoers, HTTPS-only). All ops shell suites green (`continuum-adopt` 219, `deploy-unattended` 55, `deploy-restart` 25, `installer-preflight` 18, `installer-shared-parent` 10, `installer-signal` 9, `nginx-install` 13), root `vitest run` **1032/1032**, `npm run build` clean (0.2.52-alpha, `dist/` free of `preview-assets/`). shellcheck UNAVAILABLE in sandbox (`bash -n` clean on every ops script). Sole attribution Chiefmonkey. Code + PR only — **not merged, tagged, or deployed.**

## v0.2.57-alpha — ui: build-time version stamp in sidebar footer + login modal

Frontend-only release (`src/shell.js` + `src/styles/landing.css` + `vitest.config.js` + new `src/version-stamp.test.js`; **no agent code changed**; onboarding preview stays **v0.1.20-preview**). Root `package.json` + lockfile bumped `0.2.56-alpha → 0.2.57-alpha`.

**Why.** The UI showed no version anywhere in the shell, so an operator couldn't tell which build was deployed. The Vite build already baked `__APP_VERSION__` (read from `package.json`) into the bundle — the login card + landing eyebrow used it, but the always-visible sidebar did not.

**Change.** The sidebar footer now renders a small muted `v0.2.57-alpha` stamp beneath the "Local-first…" blurb, visible to both logged-in and demo/unauthenticated users. New exported `appVersion()` helper in `src/shell.js` returns `v${__APP_VERSION__}` (falls back to `v—` outside Vite); `renderSidebar()` fills a `data-app-version` placeholder via **textContent** (never innerHTML, even though the constant is a trusted build value). New `.sidebar-version` style reuses existing muted tokens (no new design language — the login redesign is a separate later PR). The login modal already surfaces the version in its eyebrow; unchanged.



## v0.2.56-alpha — npub: add independent NIP-19 oracle test vectors (cross-validated against nostr-tools)

Test-only release (frontend; `src/lib/npub.test.js` only — **no runtime code changed**, `src/lib/npub.js` untouched; onboarding preview stays **v0.1.20-preview**). Root `package.json` + lockfile bumped `0.2.55-alpha → 0.2.56-alpha`.

**Why.** The hand-rolled Bech32 codec (`parseNpub`/`toNpub`/`shortNpub`) was cross-validated against nostr-tools `nip19` (the de-facto NIP-19 reference) on 131 checks, but the committed suite only asserted a single canonical vector + self round-trips. Two of those known-good real-world vectors are now permanent regression tests, tying the codec to the reference rather than to its own round-trip.

**Change.** New `describe('npub — independent NIP-19 oracle vectors')` block asserting, per vector, `toNpub(hex) === npub`, `parseNpub(npub) === { ok:true, hex }`, and cross-form canonicalization (`parseNpub(npub).hex === parseNpub(hex).hex`). Vectors: fiatjaf `npub180cvv07tjdrrgpa0j7j7tmnymzyc8huy2kl8le9cy49xcrn63edql23cv2` and `npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echycx3ys7gdt7w`.

**Tests.** Root `vitest run` **938/938** (was 932, +6). `src/lib/npub.test.js` 12 → 18.

## v0.2.55-alpha / agent v0.2.50-alpha — FIXUP-1: accept npub1 operator input + scrub error logs + dashboard caption

Reviewer-remediation release on the `feature/continuum-extra-jobs-batch` branch, touching BOTH frontend and agent (new `src/lib/npub.js` + `src/lib/npub.test.js`, `src/data/store.js`, `src/views/team.js`, `src/data/members.test.js`, `src/views/dashboard.js`; new `agent/lib/scrub.mjs` + `agent/test/scrub.test.js`, `agent/index.mjs`). Root `package.json` bumped `0.2.54-alpha → 0.2.55-alpha`; agent `package.json` bumped `0.2.49-alpha → 0.2.50-alpha` (both lockfiles synced). Onboarding preview stays **v0.1.20-preview**.

**FIX A (BLOCKING) — accept Bech32 `npub1…` operator input.** TEAMS-1 validated the operator npub as 64-hex only, so real `npub1…` keys were rejected. New **dependency-free** Bech32 codec `src/lib/npub.js` (`parseNpub`/`toNpub`/`shortNpub`; standard BIP-173 polymod, generator `[0x3b6a57b2,…]`, final XOR 1 — root frontend stays vite+vitest-only): `parseNpub` accepts a checksum-verified `npub1…` OR a raw 64-hex key, returning canonical lowercase hex. `store.js addMember` validates+normalizes via `parseNpub` and stores canonical hex so dedupe holds across equivalent forms; `team.js` uses the shared `shortNpub` and accepts either input form. Tests: `src/lib/npub.test.js` (12, canonical NIP-19 vector) + `members.test.js` +3.

**FIX B — scrub the generic error-handler logging.** `agent/index.mjs`'s `setErrorHandler` logged the full `err` (stack/secret-bearing). Now logs `{url, code, name, msg: scrub(err.message)}` only. New `agent/lib/scrub.mjs` redacts ≥16-hex runs + `nostr+?walletconnect://…` URIs then truncates to 200 chars — its own module so it's testable without booting Fastify. <500 pass-through + sanitized 5xx unchanged. Test: `agent/test/scrub.test.js` (6).

**FIX C — document a dashboard progress limitation.** `dashboard.js` per-project progress gains a muted caption ("Counts local board cards; imported read-only cards not included.") — imported read-only source-sync cards aren't persisted so `boardStatsFor` can't count them; folding them in is deferred as **KANBAN-PROG-2** (new not-started TODO).

**Tests.** Root `vitest run` **913/913** (was 898, +15). Agent `node --test` **178/178** (+6). `npm run build` clean (version stamp 0.2.55-alpha). Code + local commit only — not pushed, not a PR.

## v0.2.54-alpha — CARD-AGENT-1: Kanban card → agent "vibe code" action (prefill-only)

Frontend-only release (`src/chat.js` + `src/views/board.js` + new `src/views/card-prompt.js` + new `src/views/card-prompt.test.js`; **no agent code changed, no agent version bump**; onboarding preview stays **v0.1.20-preview**). Root `package.json` bumped `0.2.53-alpha → 0.2.54-alpha` (agent stays at `0.2.49-alpha`).

**Ask (job #1 tail).** *"The team can get tasks and vibe code their responses."*

**Change.** Each Kanban card gains one new action button (glyph `✦`, aria-label "Ask Continuum to work on this task") in the existing `.card-moves` row. Clicking it drafts a bounded task prompt from the card and **prefills it into the chat dock — it does not send it.** A new chat export `compose(text)` (`src/chat.js`) sets `mode='page'`, re-derives the active thread via `syncActiveThread()` (so the turn lands in the project board thread), fills + autosizes the input, expands + focuses the dock, and re-renders the context chip — it never calls `send()` and no-ops if the dock isn't mounted. In `board.js`, the new iconBtn calls `askContinuum(slug, card, columns)`, which derives the project name (+ slug) and column name, re-asserts the board chat context, and calls `compose(prompt)`; the button is always enabled (works in mock mode too). The pure DOM-free `buildCardPrompt(card, projectName, columnName)` (`src/views/card-prompt.js`) composes `Work on this task.\nTitle: …` + optional `Details: …` (omitted when empty) + `Project: …` + `Status: …`, trims each field, and caps the total at ~600 chars.

**Consent boundary (critical).** The agent spends sats per request, so `compose()` only prefills/expands/focuses — the operator reviews the drafted turn and explicitly hits Send. A consent gate on `/api/chat` itself and the agent-side "task → pending draft" skill (vibe-coded output landing in `agent/pending/` for human approve + sign/publish) are deferred to **CARD-AGENT-2** (new not-started TODO); no `agent/` code changed here.

**Tests.** New `src/views/card-prompt.test.js` (6 cases: full shape; Details omitted on empty/missing description; each field trimmed; ~600-char cap; bare content object). Root `vitest run` **898/898** (was 892, +6). `npm run build` clean. Code + local commit only — not pushed, not a PR.

## v0.2.53-alpha — TEAMS-1: operator roster + Kanban card attribution (local-first foundation)

Frontend-only release (`src/data/schema.js` + `src/data/store.js` + new `src/views/team.js` + `src/main.js` + `src/shell.js` + `src/views/board.js` + new `src/data/members.test.js`; **no agent code changed, no agent version bump**; onboarding preview stays **v0.1.20-preview**). Root `package.json` bumped `0.2.52-alpha → 0.2.53-alpha` (agent stays at `0.2.49-alpha`).

**Ask (job #1).** *"Lets open up teams… the admin can invite other npubs to an editors level… maybe we should call them operators… the team can all add their own notes and tasks… and these can be entered on the kanban and moved around."*

**Scope decision.** LOCAL-FIRST FOUNDATION only. The roster is a local list of operator npubs the admin has designated; it carries **no authorization weight** and the agent's `requireAdmin` is untouched. Real server-side operator authorization + relay multi-user sync are explicitly deferred to TEAMS-2.

**Change.** New addressable kind `KIND.TEAM_MEMBER = 30093` (`d = member:<npub>`). `emptyState()` gains a **global** `members: []` (workspace-wide, so `deleteProject` does NOT cascade to it), with defensive `initStore()` coercion. Three exported store helpers mirror `addTodo`/`addCard`: `listMembers()` (sorted by `addedAt`), `addMember({npub,label})` (validates a 64-hex npub, lowercases + trims, rejects duplicates, clamps label to 40 via `cleanText`, role `'operator'`, `addedBy 'admin'`), and `removeMember(npub)` (case-insensitive, no-op on unknown). A new Team view (`src/views/team.js`, route `/team`, nav item after Dashboard) lets the admin add operator npubs (with optional labels) and remove them; every row renders via `h()`/`textContent` only and re-renders in place through a `subscribe()` handler. On the Kanban, `openCardEditor`'s free-text assignee input becomes a `<select>` populated from the roster ("Unassigned" + operator display strings), reusing the existing `assignee` field unchanged; an empty roster degrades to just "Unassigned" and a pre-roster assignee is preserved as a "(not on roster)" option.

**Tests.** New `src/data/members.test.js` (17 cases: npub validate/lowercase/trim, empty/short/non-hex reject, duplicate reject, label clamp, default empty label, `listMembers` sort + copy, `removeMember` variants, persistence, legacy coercion, no `deleteProject` cascade). Root `vitest run` **892/892** (was 875, +17). `npm run build` clean. Code + local commit only — not pushed, not a PR.

## v0.2.52-alpha — CHAT-CONTEXT-1: project-scoped + page-aware chat threads

Frontend-only release (`src/chat.js` + new `src/chat-threads.js` + `src/chat-threads.test.js` + `src/styles/chat.css`; **no agent code changed, no agent version bump**; onboarding preview stays **v0.1.20-preview**). Root `package.json` bumped `0.2.51-alpha → 0.2.52-alpha` (agent stays at `0.2.49-alpha`).

**Ask (jobs #5 + #6).** #5 *"The chat should be page aware… a side conversation like, whilst you're doing that job on continuum, can you find me the best things to do in Costa Rica."* #6 *"The chat in the Projects area however are specific to that project… these apps are all interoperable."*

**Change.** The chat dock's single global message array is replaced by a per-thread map keyed by context+mode. A new pure DOM-free module `src/chat-threads.js` exports `threadKeyFor(ctx, mode)`: general mode → one shared `'general'` thread; page mode inside a project → `'project:<slug>'` (all pages of that project share the thread); page mode elsewhere → `'page:<route>'` (per page). Slug comes from an explicit router `projectSlug` else parsed from the view `where` (`project:<slug>`/`project-board:<slug>`; the `projects` index has no colon so it is a page thread). A small accessible `<button class="chat-mode">` next to the context chip flips "This page" (default) ↔ "General" (`aria-pressed` + dynamic `aria-label`; chip reads `context · general` in general mode). The context object sent to the agent is enriched with `label`, `where`, `mode`, `route`, `pageType` (via `pageTypeFor`), `projectSlug`, and best-effort `columnId`/`cardId` (null); the agent ignores unknown fields and mock replies still work. Threads persist to `localStorage['continuum.chat.threads']`, each bounded to `THREAD_CAP=100` (oldest trimmed via `trimThread`), loaded defensively (`sanitizeThreads`, try/catch → in-memory only on failure). `send()` pins the turn to `activeKey` before the await so a late AI reply lands in the originating thread. User/AI text is still rendered only via `textContent`. True in-app agent editing is **not in scope** — a follow-up TODO is recorded.

**Tests.** New `src/chat-threads.test.js` (19 cases: thread-key derivation across project board/home/dashboard/marketplace/projects-index/general/missing-route, slug parsing, page-type mapping, trim cap, sanitize drop/cap). Root `vitest run` **875/875** (was 856, +19). Code + local commit only — not pushed, not a PR.

## v0.2.51-alpha — KANBAN-PROG-1: dashboard progress from real kanban data

Frontend-only release (`src/data/store.js` + `src/views/dashboard.js` + `src/data/board.test.js`; **no agent code changed**; onboarding preview stays **v0.1.20-preview**). Root `package.json` bumped `0.2.50-alpha → 0.2.51-alpha` (agent stays at `0.2.49-alpha`).

**Ask (job #2).** *"Connect the progress to the data on the Kanban."*

**Root cause.** The dashboard's per-project progress and the top "Overall progress" card were both derived from milestone status (`milestonesFor`), which is mock-ish seed data disconnected from what the operator actually manages on the Kanban boards.

**Change.** New pure store helper `boardStatsFor(slug)` (exported) returns `{ total, backlog, todo, doing, done, percent }` by counting cards per column and folding each column name into a status bucket via `bucketForColumnName()` — the inverse of `board.js`'s `columnForStatus()`, sharing its regex vocabulary (done|complete|shipped → done; doing|progress|active|wip|review → doing; backlog|icebox|someday → backlog; todo|to do|to-do|inbox → todo; default → todo) so board placement and dashboard progress agree. `percent` = done/total rounded, 0 when total is 0; safe for a project with no board/cards. The dashboard's "Overall progress" card now aggregates board stats across all projects (done/total cards), and the "By project" section shows per-project total, a Done/Doing/Todo/Backlog breakdown line, and a done/total progress bar. The per-project section is now re-rendered in place via a `subscribe()` handler (cleaned up alongside the provider poll on leaving `#/dashboard`) so adding/moving a card reflects immediately.

**Tests.** `src/data/board.test.js` +3: default Todo/Doing/Done buckets + percent; empty board → all zeros/percent 0; custom names (Review → doing, Icebox → backlog). Root suite 856 pass.

## v0.2.51-alpha — ONBOARD-UI-1: clearer signer-extension login copy + stronger step wayfinding

Onboarding-preview UI release (**no app/agent runtime code changed** — the change is confined to the vendored design-review mockup under `preview-assets/`, which `vite build` never bundles). Closes GitHub issue **#57**. Root + agent `package.json` bumped `0.2.50-alpha → 0.2.51-alpha`; onboarding preview advanced to **v0.1.21-preview** (`preview-assets/onboarding-v0.1.21/`, cut as a fresh self-contained version dir from v0.1.20 per the repo convention; v0.1.20 stays frozen).

**Why.** Live review flagged two onboarding rough edges: the Step-1 login button named a specific product ("Sign with Plebeian Signer") rather than the signer *mechanism*, and the numbered step indicators didn't make "where am I / what's done" obvious enough.

**Changes.**
- **Login copy.** Primary Step-1 CTA now reads exactly **"Sign in with browser extension"**; the lede names the mechanism ("a browser extension such as Plebeian Signer, nos2x or Alby"); ghost button → "Use a remote signer instead"; no-signer message → "No browser extension signer found — install a NIP-07 extension (e.g. Plebeian Signer, nos2x or Alby)". No tracking/CDN/key material added; `onboarding-client.js` is byte-identical to v0.1.20 apart from that one message string (routing, `CONTINUUM_HOME`, `data-claimed`, `renderSuccessAdvance`, duplicate-pay guards all intact).
- **Step wayfinding (`shared.css`).** Completed steps are **filled** (bronze `--bronze` chip, dark numeral, weight 600); the current step gets a **brighter** amber-bright 3px ring + glow + weight 600 (was a 2px `--amber` ring), 36px chip size preserved. Added `.step-dot:focus-visible` amber-bright outline for keyboard nav. No new animation (reduced-motion safe). Colour-blind safe via size + fill + ring cues.
- **Doc fix.** Stale onboarding `README.md` header `0.1.19-preview` → `0.1.21-preview`; top-level `preview-assets/README.md` "Current preview" pointer → v0.1.21 with a rewritten deploy example.

**Preserved.** Claimed-Routstr simplified terminal state + routing to app/login/dashboard unchanged.

**Accessibility.** WCAG: completed numeral on bronze **5.78:1** (AA small text), current numeral on amber **10.75:1**, current/focus ring vs bar **14.15:1** (≥3 UI); keyboard focus ring added; reduced-motion honoured.

**Tests / verification (Node 20.x).** New v0.1.21 tests assert the new button copy (+ absence of the old string), the browser-extension/Plebeian-Signer step-1 context, the new signer-not-found message + NIP-07 mention, the step-dot wayfinding states, and the README version header. Root `vitest run` **1032/1032** (19 files, +160), `npm run build` clean (0.2.51-alpha, `dist/` free of `preview-assets/`). No headed browser in sandbox → static QA artifact (desktop + mobile step strips, all states) + programmatic WCAG audit. Sole attribution Chiefmonkey. Code + PR only — **not merged, tagged, or deployed.**

## v0.2.50-alpha — LAYOUT-1: constrain chat dock to the main column + full-height sidebar

Frontend-only release (CSS only — `src/styles/layout.css` + `src/styles/chat.css`; **no JS/shell/agent code changed**; onboarding preview stays **v0.1.20-preview**). Root `package.json` bumped `0.2.48-alpha → 0.2.50-alpha` (agent stays at `0.2.49-alpha` from the NWC-ERR-1 slice on this batch branch; root lockfile top-level `version` left as-is per prior convention).

**Ask (job #4).** *"Make the chat bar at the bottom stay within the page content… and the left sidebar should extend to the bottom of the page 100%."*

**Root cause.** `#app` is a CSS grid (`grid-template-columns: var(--sidebar-w) 1fr; grid-template-rows: 1fr auto`) whose areas were `"sidebar main" / "chat chat"` — so the chat dock spanned **both** columns at the bottom, sitting under the sidebar too, and the sidebar stopped at the top of that chat row instead of running full height.

**Fix.** Changed the grid areas to `"sidebar main" / "sidebar chat"`: the sidebar now spans **both** rows (full height to the very bottom), and the chat dock occupies only the second column under `main`, so it's constrained to the main content width. Rows stay `1fr auto` (the `auto` row sizes to the chat dock's collapsed `--chat-h` / expanded `46vh`; `main` keeps `overflow-y: auto` and takes the `1fr` remainder, so there's no page overflow or double scrollbar). Aligned the chat dock's horizontal padding with the main column (`12px 16px → 12px 32px`, matching main's `32px` side padding) so the input row's edges line up with the content; on mobile (`max-width: 900px`, grid `68px 1fr`) the dock padding drops to `16px` to match the narrower mobile main padding. The chat dock remains a direct child of `#app` (`mountChat(root)` in `src/main.js`), so `grid-area: chat` still applies — no shell restructuring. `.sidebar { overflow-y: auto }` and `.sidebar-footer { margin-top: auto }` continue to scroll internally and pin the footer to the bottom of the now-full-height sidebar. Both light and dark themes unaffected (structural change only).

**Tests.** No new tests (pure CSS). Full root suite green: `vitest run` **853/853** (incl. the `dist/`-building `no-external-cdn` + `nginx-continuum-routing` checks).


## v0.2.50-alpha — OPS-DEPLOY-2: safe unattended deployment (server-side pull)

Ops-only release (**no app/agent runtime code changed** — only new files under `ops/`, docs, and the version stamps). Closes GitHub issue **#54**. Root + agent `package.json` bumped `0.2.49-alpha → 0.2.50-alpha` for the health-gate version invariant.

**Why.** Local-device automation cannot make outbound SSH and interactive VPS SSH prompts for a password, so a push deploy is impossible; the existing role's redeploy still needed a human to run `ansible-playbook` on the box. This adds a **server-side pull** so releasing a version is a single root-only pin-file edit, with no SSH in the deploy loop.

**Design — delegate, don't reimplement.** A small, root-owned wrapper drives the *already-hardened* `continuum` role. State backup, the atomic staging→swap cutover, the version-asserting health gate, rescue rollback, and cleanup all stay in the role; the wrapper only adds the safe transport + tag-verification layer on top.

**New files (all `ops/`):**
- `deploy-unattended.sh` → `/usr/local/sbin/torii-continuum-deploy`. Strict `^v<semver>(-prerelease)?$` tag grammar (rejects branches/SHAs/shell+YAML metacharacters); optional fail-closed allowlist; optional `git tag -v` signed-tag gate (`CONTINUUM_REQUIRE_SIGNED_TAGS=1`); **idempotent no-op** when live `/api/health` version already matches; fresh per-tag clone under `/opt/deploy`; renders localhost vault-free inventory (`continuum_version`+`torii_domain` only); runs `--tags continuum`; **independently re-verifies** the live version; prunes old releases keeping newest N and never the live one. `flock`-guarded, `set -euo pipefail`, refuses non-root, sourceable for in-process tests.
- `systemd/torii-continuum-deploy.{service,timer}` — oneshot + ~5min timer, no inbound SSH/ports.
- `sudoers/torii-continuum-deploy.example` — OPTIONAL remote/CI trigger; locked non-login `toriideploy` principal, `NOPASSWD` on **exactly the wrapper, no args**; never general passwordless sudo.
- `deploy-bootstrap.sh` — idempotent, fail-closed one-time installer (wrapper 0755 root:root; units; root-only `0600` pin-file skeleton it never clobbers; optional principal+sudoers validated with `visudo -cf`; optional dedicated ed25519 key + host-key-pinning guidance).

**Security.** No secret is read, written, or logged — the vault-free path preserves `config.yaml` / `session_secret` / the funded Routstr key byte-for-byte. No auth weakened, no general sudo, no ports opened. A bad release fails closed and self-reverts via the role's rollback.

**Tests / verification.** New `ops/test/deploy-unattended.test.sh` **55/55** (tag grammar incl. injection strings, version gate, allowlist fail-closed, version extraction, localhost/vault-free inventory, prune-keeps-live, wrapper fail-closed guards, oneshot/timer wiring, scoped-sudo/no-`NOPASSWD: ALL`, bootstrap modes/visudo/locked-principal/host-key-pin/no-clobber). Existing `deploy-restart` **25/25**, root `npx vitest run` **872/872**, `npm run build` clean (0.2.50-alpha). No hostnames/devices/secrets. Sole attribution Chiefmonkey. Code + PR only — not merged/tagged/deployed.

## v0.2.49-alpha — NWC-ERR-1: harden NWC onboarding Step 2 error paths

Agent-only release (onboarding preview stays **v0.1.20-preview**; only `agent/` changed). Agent `package.json` + lockfile bumped `0.2.48-alpha → 0.2.49-alpha`; root untouched.

**Root cause.** Step 2 of onboarding (connecting an NWC wallet) surfaced a raw "Internal Server Error" to the operator. `walletConnect()` / `walletTest()` in `agent/core/onboarding.mjs` called `client.getInfo()` inside a `try { … } finally { close() }` with **no catch**. The live NIP-47 path can *throw* (relay unreachable, nip04 encrypt/decrypt failure, JSON parse) rather than returning `{ ok:false }`; the uncaught exception propagated out of the thin Fastify route adapter, and with no app-level error handler Fastify answered a bare `500 "Internal Server Error"`.

**Fix.**
- `agent/core/onboarding.mjs`: wrapped `getInfo()` in `walletConnect()` and `walletTest()` (and `payInvoice()` in `routstrPay()`) with `try/catch`, keeping the `finally { close() }`. A throw now folds into the existing sanitized `502 { ok:false, error:'wallet did not respond to get_info' }` shape so the frontend treats it identically to a non-throwing failure. A new `sanitizeReason()` helper logs a short, bounded reason with any long hex run (secret/pubkey) redacted — the URI/secret never enters a log line or response.
- `agent/index.mjs`: added an app-level `app.setErrorHandler` — defense in depth. Client errors (`statusCode < 500`, e.g. Fastify validation/empty-body 400s) pass through unchanged; any 5xx/unexpected throw is logged in full server-side and answered with a sanitized JSON `500 { ok:false, error:'internal error' }` (no stack, no message, no secret). Structured `{code,body}` onboarding responses, auth 401/403, and rate-limit 429s are all sent via `reply.code().send()` / the rate-limit `errorResponseBuilder`, so they never reach the handler.

**Tests.** Extended `agent/test/onboarding.test.js`: a throwing `getInfo` in `walletConnect()` and `walletTest()` each return 502 (not a bare 500) with `close()` still called; a throwing `payInvoice` in `routstrPay()` returns 502 with `close()` still called; and a secret-discipline test proves the URI/secret never appears in the response body or any log line even when the thrown error message embeds them. Full agent suite: **172 pass / 0 fail**.

## v0.2.49-alpha — CONT-LIVE-UI-1: surface live provider/wallet/kanban data in the UI

Frontend-only release (onboarding preview stays **v0.1.20-preview**; **no agent runtime code changed** — only `src/views/{dashboard,routstr,board}.js`, three new vitest files, docs, and the version stamps). Closes GitHub issue **#52**. Root + agent `package.json` bumped `0.2.48-alpha → 0.2.49-alpha` for the health-gate version invariant.

**Live v0.2.48-alpha acceptance (authenticated) found three UI regressions** where correct backend data never reached the operator:

1. **Dashboard Providers panel blank** despite "Polling every 20s". Root cause: `ProviderCard()` ran the first `tickProvider(body)` synchronously *before* the card was appended, so `body.isConnected` was `false`, the tick bailed (and cleared its own poll), and the body stayed empty until the first 20s interval — a slow/erroring probe made it look permanently blank. Fix: render a synchronous "Checking providers…" placeholder and defer the first tick to `queueMicrotask(() => tickProvider(body))` (the card is in the DOM by the time the microtask runs); the 20s interval is unchanged.

2. **Routstr shows a green `connected` pill but an em-dash Cashu balance.** Root cause: field-name mismatch — `GET /api/wallet/balance` returns `{ total_sats, per_mint, ... }`, but the balance poll read `r.data.balance_sats` → `undefined` → `formatSats(undefined)` → `—`, while the same tick still set `connected:true` and persisted `cashuBalanceSats:undefined`, so the em dash stuck across re-renders. The top-up modal shared the bug (read `received_sats`/`balance_sats`; the endpoint returns `added_sats` only). Fix: pure exported `readBalanceSats()` (prefers `total_sats`, `balance_sats` fallback, returns `null` — not `0` — when absent); the poll writes the number in place (`balanceNumEl.textContent`, no page tear); the receive modal reads `added_sats` then re-reads the authoritative balance.

3. **Kanban header total + per-column counts exclude imported read-only cards.** Root cause: `totalCards` and each `col-count` summed only native store cards (`cardsFor`), never `importedCardsFor`, so a board/column of only imported work read `0`. Fix: both counts now add the imported cards; the distribution primitive is extracted as a pure exported `filterImportedForColumn()`.

**Security.** Fail-closed posture unchanged: every wallet/health/source route remains `requireAdmin`; no proofs, tokens, secrets, or full mint endpoints are rendered; the wallet probe stays a read-only NUT-07/identity check. These are pure client-side field/ordering fixes with no new network or storage surface.

**Note on "expected blank" vs bug.** The dashboard wallet card already states `disabled`/`unreachable`/`degraded` honestly for an unconfigured/missing wallet. The Routstr hero previously rendered `—` for a *configured* wallet purely because of the field bug; with the fix a funded-but-empty or freshly-configured wallet now shows an honest `0 sats` (`/api/wallet/balance` sums to 0 across mints) rather than an em dash. Requirement to see a non-zero balance: one or more `cashu.mints` configured on the agent AND proofs redeemed via top-up (`/api/wallet/receive`).

**Tests.** `src/views/routstr.test.js` (8), `src/views/board-counts.test.js` (7), `src/views/dashboard-structure.test.js` (4). Verification (Node 20.x): root `npx vitest run` **872/872** (18 files, +19), agent `node --test` **168/168** (unchanged), `npm run build` clean (0.2.49-alpha), `npm audit --omit=dev` root prod **0** / agent prod **0**; root full audit **5** dev-only (vite/vitest/esbuild). Sole attribution Chiefmonkey. Code + PR only — not merged/tagged/deployed.


## v0.2.48-alpha — OPS-DEPLOY-1: restart the promoted agent + verify the deployed version

Ops-only release (onboarding preview stays **v0.1.20-preview**; **no app/agent runtime code changed** — only `ops/ansible/roles/continuum/tasks/main.yml`, a new ops test, and the version stamps). Closes GitHub issue **#49**. Root + agent `package.json` bumped `0.2.47-alpha → 0.2.48-alpha` for the version invariant; lockfile top-level `version` fields left as-is (prior releases never bumped them; `npm ci` validates the dependency tree, not that field).

**Root cause (diagnosed from the live 0.2.43-vs-0.2.47 incident).** The `continuum-agent` systemd unit file is version-independent (`ExecStart=/usr/bin/node index.mjs`, no version baked in). So a code-only redeploy atomically promotes a new release tree WITHOUT changing the unit file → the role's `restart continuum-agent` handler is never notified, and the pre-existing `state: started` task is a no-op against the already-running PID. The atomic swap changed the code on disk, but the live process kept serving the PREVIOUS release: `/api/health` reported the stale version and the v0.2.47 routes (`/api/wallet/health`, `/api/projects/:slug/sources`) 404'd. The old readiness gate accepted any HTTP 200, so the broken deploy passed as "green".

**Fix (`ops/ansible/roles/continuum/tasks/main.yml`).**
- The unit-install task now `register:`s `continuum_unit_install` (change detection).
- After the V8 JIT smoke test, the role runs `meta: flush_handlers` so any unit-file-change restart fires BEFORE readiness. Handlers run in definition order (`reload systemd` daemon-reload, then `restart continuum-agent`), so daemon-reload always precedes the restart.
- An explicit `state: restarted` task runs **only when `continuum_promote.changed` AND NOT `continuum_unit_install.changed`** — the exact code-only case the handler misses. The `not unit_install.changed` guard prevents a double restart when the unit file itself changed (that path is the handler's job). Exactly one restart happens per real deploy.
- A final enabled+`state: started` ensure is a genuine no-op when the process is already up (idempotent reruns don't churn the service).
- Readiness is strengthened: `uri` now sets `return_content: true` and the `until` requires HTTP 200 AND `agent_health.json.version == (continuum_version | regex_replace('^v',''))`. A stale process left running by a missed restart reports the OLD version and FAILS readiness, tripping the existing block/rescue rollback instead of passing a broken deploy. The gate always inspects the post-restart process.

**Preserved verbatim:** block/rescue rollback semantics (quarantine restore + webroot rollback + standalone re-enable + secret-free failure message), fail-closed pre-mutation backup, authoritative config/state verbatim copy (`session_secret` and the funded Routstr key never rotated/regenerated), all adoption modes, the V8 JIT smoke test, standalone-unit disabling, and `no_log` secret hygiene. The unit template stays version-independent — that is precisely why the explicit restart is required — and a regression test locks that assumption so a future version leak into the unit is caught.

**Tests.** New `ops/test/deploy-restart.test.sh` (**25** hermetic assertions): restart-before-readiness wiring (register / flush_handlers / guarded `state: restarted` / idempotent ensure); the version-asserting health gate (return_content + version equality + 200); strict task ordering (flush < restart < ensure < health) and handler ordering (reload systemd before restart); the version-independent-unit lock; survival of rescue rollback / webroot rollback / standalone re-enable / JIT smoke / config-state copy; `no_log` retention + no secret rendered in any `msg`; and pure version-equality cases proving a **stale 0.2.43-alpha live version FAILS** readiness while the **correct 0.2.48-alpha PASSES** (leading `v` stripped; empty version fails).

**Full verification (Node 20.20.1 sandbox; agent code unchanged).** ops shell: `deploy-restart` **25/25**, `continuum-adopt` **219/219**, `installer-preflight` **18/18**, `installer-shared-parent` **10/10**, `installer-signal` **9/9**, `nginx-install` **13/13**. Root `npx vitest run` **853/853** (15 files). Agent `node --test` **168/168**. `npm run build` clean (index.html 1.31 kB, CSS 39.56 kB/7.30 gz, JS 81.15 kB/25.20 gz; version stamps 0.2.48-alpha). `npm audit`: root prod (`--omit=dev`) **0**, agent prod **0**, agent full **0**; root **full** **5** (3 moderate/1 high/1 critical) all dev-only `@vitest/mocker`/`esbuild`/`vite`/`vite-node`/`vitest` toolchain (not in `dist/`; breaking major-vite fix deferred). No hostnames/devices/secrets in code, tests, or docs. Sole attribution Chiefmonkey. Code + PR only — **not merged, tagged, or deployed.**

**Post-review metadata correction (PR #50).** Both lockfiles' self `version` fields were synchronized to `0.2.48-alpha` (root `package-lock.json` `0.2.46-alpha` → `0.2.48-alpha`; `agent/package-lock.json` `0.2.43-alpha` → `0.2.48-alpha`) — 4 lines total, top-level `version` + `packages[""].version` only, **no dependency churn**. `npm ci` reverified clean in both roots (root: 5 dev-only vulns unchanged; agent: 0 vulns). The tag-only `continuum_version` constraint was documented (see below); no expected-version variable was added in this release.

**Deploy / rollback notes.** Redeploy as usual (`ansible-playbook -i inventory.yml site.yml --tags continuum`, `continuum_version: v0.2.48-alpha`, config preserved). On this deploy the agent is guaranteed to restart onto the promoted tree and readiness will refuse to pass unless `/api/health` reports `0.2.48-alpha`. If the deployed process reports the wrong version, readiness fails and the block/rescue automatically rolls the previous tree back from quarantine, restores the prior webroot, and restarts the restored unit — no manual step needed beyond reading the printed backup/quarantine paths.

**`continuum_version` must be a v-prefixed release tag in production.** As of this release it is BOTH the git checkout ref AND the expected live version the readiness gate asserts (`/api/health` version == `continuum_version` with a leading `v` stripped). Deploying a **branch** (`main`) or a **commit SHA** checks out fine but never matches `package.json`, so readiness fails and the deploy **intentionally rolls back** (fails closed). This coupling is deliberate for v0.2.48-alpha — no separate expected-version variable was introduced; branch/SHA refs are for local/dev only. Keep the git tag and both `package.json` versions in lockstep. Documented in `ops/README.md` and `group_vars/all.yml.example`.

## v0.2.47-alpha — KANBAN-SYNC + wallet health: read-only project-source import + real Cashu wallet probe

Feature release across agent + frontend (onboarding preview stays **v0.1.20-preview**). Closes GitHub issues **#44** (DOCS-CURRENT-1), **#45** (CONT-KANBAN-SYNC-2), **#46** (CONT-KANBAN-SYNC-1), **#47** (CONT-HEALTH-2). Both package.json + lockfiles bumped `0.2.46-alpha → 0.2.47-alpha`.

**#46 — read-only server-side project-source adapters (agent).** New `agent/core/project-sources.mjs` + `agent/lib/markdown-todo.mjs` import from two source types, both **strictly allowlisted and fail-closed**:
- **Local Markdown todos.** Only files whose fully-resolved real path (symlinks resolved) stays inside a configured `local_root`; `../` traversal and symlink-escape are rejected before any read; file size bounded (`max_file_bytes`, default 256 KiB). The parser (`parseMarkdownTodos`, frozen `MD_LIMITS`) maps checkbox state and section headings to status conservatively — a checked box → done, an open box → todo/doing by heading, plain bullets counted only under a mapped heading, checkbox wins over heading — with `maxTasks`/`maxLines`/title-length bounds and pathological-long-line skipping.
- **Public GitHub issues.** Only `owner/repo` pairs on the configured `allow_github` allowlist; **no credential required** (public API). The GitHub base URL is pinned (`_ghPin`, `redirect:'error'`) so a redirect cannot pivot off-origin (SSRF guard). Bounded per-response bytes, `max_issues` (default 200), `max_pages`, request timeout, and rate-limit detection (`x-ratelimit-remaining: 0` / 403 → graceful `rate_limited`, last snapshot retained). PRs are excluded; open→todo, closed→done, useful labels lift priority.

Records normalize to `{ fingerprint, project, source{type,ref,label,id}, title, description, status, priority, labels[], url, readOnly:true, createdAt, updatedAt }` with a content-stable fingerprint; `dedupeRecords` collapses repeated imports + duplicate representations by (project, type, lowercased title). The last valid normalized snapshot is cached per project and **retained on partial/offline/error**, so a transient failure never wipes the board. Nothing logs content, tokens, full identifiers, or credentials.

Config: new `project_sources:` block (`enabled` default false, `local_root`, `allow_github[]`, `sources[]`, `max_issues` 200, `max_pages`, `github_api` default `https://api.github.com`) validated in `loadConfig` — an enabled source outside its allowlist, a markdown source without `local_root`, a malformed `allow_github` entry, or an unknown type all **refuse boot** (`process.exit(1)`). New knob `rate_limit.project_sources_refresh_per_min` (default 12). New admin-gated endpoints in `index.mjs`: `GET /api/projects/:slug/sources` and `POST /api/projects/:slug/sources/refresh` (rate-limited), both slug-validated against `PROJECT_SLUG_RE`.

**#45 — imported source cards on every per-project Kanban (frontend, non-mutating).** `src/views/board.js` holds imported records in an **ephemeral per-slug `importState` Map that is never written to the board store** — the local kinds 30083/30084 mutators are never called with imported records, so manual cards are never overwritten and **repeated refreshes never duplicate** anything (records keyed by fingerprint; re-render replaces the map). Each record maps to the best-fit column via `columnForStatus` (name-aware done/doing/backlog/todo with positional fallbacks) and renders as a `board-card imported` container: **not draggable, no move/edit controls**, a source badge, priority + label pills, an explicit read-only `imported-badge`, an aria-label `Read-only imported card: …`, and a safe external source link (`target:'_blank'`, `rel:'noopener noreferrer'`). A `renderSyncBar` adds source + status filters, a manual **Refresh** button (`doRefresh` → `refreshProjectSources`), a last-sync line (server `syncedAt` is MILLISECONDS → converted to seconds for `timeAgo`), and a `sync-banner` surfacing stale/partial/error states with the sanitized reason; empty/loading/offline states handled. New client fns `walletHealth`/`projectSources`/`refreshProjectSources` in `src/data/agent.js` (GET bodyless / GET slug-encoded / POST JSON; offline short-circuit). The mounted `/continuum/` base path, accessibility (link/nav semantics, non-interactive cards + explicit controls), mobile layout, dark canonical styling, and existing login/dashboard/about behavior are preserved. New CSS in `pages.css` (`.sync-bar`, `.board-card.imported`, `.imported-badge`, filters, banners, mobile).

**#47 — real Cashu wallet health probe (agent + frontend).** New admin-gated `GET /api/wallet/health` (returns `{ version, ... }`) backed by a **non-mutating** `wallet.health()` in `agent/core/wallet.mjs` using only read primitives of the pinned cashu-ts (^3.7.1) v3 API — `loadMint()` + `getMintInfo()` identity getters (`.name`/`.pubkey`/`.version`, `.isSupported(7)` for NUT-07) and `groupProofsByState(proofs)` for a balance breakdown. **No mint/melt/swap or proof/wallet-state mutation**, so the serialized on-disk wallet (`memory/wallet/*.json`) is untouched and existing wallets stay compatible. Honest per-mint states — **disabled / healthy / degraded / unreachable** — each with an actionable sanitized reason; output carries mint identity (name or a `mint_fingerprint`) and `balance_sats` and **never** exposes tokens, proofs, secrets, or private material; logs stay prefix-only. `src/views/dashboard.js` adds a wallet-health row to the existing Provider card (`renderWalletHealth`, polled alongside `healthModels()` via `Promise.all`).

**#44 — docs refreshed.** `torii-continuum-todo.md`, this file, `torii-continuum-handoff.md`, and `README.md` brought current through v0.2.46 (stale "next-action" claims removed — the CONT-HEALTH-2 "(next)" line is now DONE) with the full history preserved, then this release recorded with the evidence below. All examples are generic/configurable — no real hostnames, credentials, or personal identifiers, and no other Torii project's queue is imported.

**Security posture.** Privacy/security-first: strict allowlists for both local paths and GitHub repos; traversal + symlink-escape rejected; SSRF-pinned GitHub origin with `redirect:'error'`; bounded file/response/issue/page counts, redirects, and timeouts; graceful rate-limit/network degradation with snapshot retention; imported sources are strictly **read-only** (no write-back to Markdown or GitHub, never persisted to the local store); wallet probe is strictly read-only; no secrets, tokens, proofs, or full identifiers ever logged or returned. No new runtime dependencies added.

**Tests / build / audit (all green):**
- New agent tests: `project-sources.test.js` (**29**), `markdown-todo.test.js` (**12**), `project-sources-config.test.js` (**9**, subprocess-driven — validation exits the process), `wallet-health.test.js` (**14**). Extended frontend tests: `src/data/agent.test.js` (**23**, +4 client-fn cases), `src/views/board-structure.test.js` (**14**, +6 imported-card guardrails).
- **Root `vitest run` 853/853** (15 files); agent **`node --test` 168/168**.
- `npm run build` clean — `dist/index.html` 1.31 kB, CSS 39.56 kB / 7.30 kB gzip, JS 81.08 kB / 25.17 kB gzip.
- `npm audit`: **0 vulnerabilities** — root prod (`--omit=dev`), agent prod, agent full. Root **full** audit shows **5 dev-only** findings (3 moderate / 1 high / 1 critical) in the `esbuild`/`vite`/`vitest` build toolchain — dev dependencies not shipped in `dist/`; the fix is a breaking `npm audit fix --force` (major vite bump) deferred as out-of-scope for this release.
- Ops shell suites: `continuum-adopt` **219**, `installer-preflight` **18**, `installer-shared-parent` **10**, `installer-signal` **9**, `nginx-install` **13**.

**Migration / deployment.** Additive and backward-compatible: `project_sources` defaults to disabled, so an existing config boots unchanged; enabling it requires the operator to set `enabled: true` + `local_root` and/or `allow_github` (an enabled-but-unallowlisted source fails closed at boot). The wallet health probe reads existing serialized wallet state without mutation — no migration needed. Deploy is the normal operator step (re-run `ops/install-agent.sh` on the Node 22 LTS host, or the Ansible `--tags continuum` redeploy). Code + PR only — **not merged, tagged, or deployed.**

**Review remediation (PR #48, same branch — version held at v0.2.47-alpha).** A blocking review was addressed in place (no new PR/merge/deploy):
- **M1 — partial-refresh data loss.** `project-sources.mjs refresh()` now keeps a per-source last-valid cache (`bySource` Map keyed by a stable `sourceKey`). On a partial refresh it replaces only the healthy sources and **carries forward the failed sources' last-valid records** (`partial:true, retained:true`) instead of shrinking the board; a total failure preserves the **full** last-valid snapshot + its `syncedAt` and reports `stale:true`. New tests prove partial-failure retention, healthy-source updates still apply, recovery replaces retained data, and total failure preserves the full snapshot.
- **M2 — dedupe dropped distinct same-title GitHub issues.** `dedupeRecords` now collapses exact duplicates by stable native `fingerprint` first (GitHub `gh:issue:<n>` includes the number), then applies title-collapse **only to Markdown** records (which lack a stable native id). Distinct same-title issues and cross-repo same-title pairs are retained; exact repeats and duplicate Markdown tasks still collapse. Documented + tested.
- **M3 — wallet connected path untested.** `mintHealth({ url, wallet, proofs, timeoutMs })` extracted + exported (proofs injected, not disk-read) and covered with a mocked cashu-ts v3 wallet across healthy/degraded (no NUT-07, spent/pending, proof-state failure, info unavailable)/unreachable/timeout, plus balance/state derivation, reason sanitization, proof non-mutation, and no-secret-leak. Verified against the cashu-ts 3.7.1 read API (`loadMint`/`getMintInfo`/`groupProofsByState`).
- **Lower findings.** `GET /api/wallet/health` bounded by `rate_limit.wallet_health_per_min` (default 6) + a 15 s server cache (**L4**); manual-card `insertionIndex` ignores imported cards (**L5**); `local_root` must be absolute (**L6**); numeric bounds hard-ceilinged in code via `CEILINGS` (**L7**); dead `cache_ttl_sec` option + docs removed (**L8**); redundant `|| allOk` simplified to `ok: anyOk` (**L9**); empty sync bar suppressed when no sources are configured (**L10**); doc/PR wording corrected so the wallet probe is described as a read-only identity/NUT-07 probe (no "cryptographically signed" claim) and the board/wallet tests as source/behaviour + mocked-wallet unit guards, not live-browser interaction tests (**N11/N12**).
- **Re-verification:** agent `node --test` **168/168** (+18), root `vitest run` **853/853**, `npm run build` clean (index.html 1.31 kB, CSS 39.56 kB/7.30 kB gz, JS 81.15 kB/25.20 kB gz), `npm audit` **0** on root prod / agent prod / agent full (root full unchanged at 5 dev-only toolchain findings). No ops files touched. Sole attribution Chiefmonkey.

## v0.2.46-alpha — LOGIN-FIX: sidebar/demo Login "Could not reach agent: Bad Request"

Frontend-only release (no agent code changed; agent stays **v0.2.43-alpha**, onboarding preview stays **v0.1.20-preview**). Fixes a live production bug: in the demo shell (`#/projects`), clicking the bottom-left sidebar **Login** with Plebeian Signer installed failed with *"Could not reach agent: Bad Request"*.

- **Root cause.** The SPA↔agent client `req()` in `src/data/agent.js` always sent `Content-Type: application/json`, even for the **bodyless** `POST /api/auth/challenge`. Fastify v5's JSON parser rejects an empty body carrying that content-type with **400 `FST_ERR_CTP_EMPTY_JSON_BODY`** (`error: "Bad Request"`) *before* the handler runs, so the challenge never issued. The onboarding client's `postJson` was already hardened against this (see `preview-assets/onboarding-v0.1.20`, and the pinning test in `agent/test/fastify-v5-api.test.js`); the SPA client had **drifted** and never got the same fix.
- **Fix.** `req()` now declares `Content-Type: application/json` **only when a JSON body is actually sent** (`hasBody`), mirroring the onboarding client exactly so the two agent clients cannot drift apart again. The bodyless challenge POST now reaches the handler and 200s. No agent/protocol change — the agent's empty-body 400 is correct, standard Fastify v5 behaviour.
- **Safer error detail.** New pure exported `errorReason(json, status)` surfaces the specific Fastify `message` over the generic `error` label (capped at 200 chars, server-controlled strings only — never stack traces), so future failures read e.g. `"Bad Request: Body cannot be empty…"` instead of a bare label.
- **Consolidation.** Both login entry points — the dedicated login view (`src/views/login.js`) and the sidebar button (`src/shell.js`) — already call the single `startLogin()` in `src/auth.js`; no duplicate flow remained to merge. The drift was in the shared HTTP client beneath them, now fixed in one place.
- **Privacy/keys unchanged.** nsec never leaves the extension; the agent still fully verifies event id + signature + admin pubkey + challenge freshness. No secrets logged.
- **Tests.** New regression coverage in `src/data/agent.test.js` (12 cases): mocks a NIP-07 signer + fetch and asserts the challenge POST carries **no** content-type and no body, the verify POST carries the exact `{event}` body with a JSON content-type and adopts the returned token, plus the full `errorReason` mapping. `vitest run` **843/843**; agent `node --test` **104/104**; ops shell suites all green; `npm run build` clean (74.5 kB / 23.2 kB gzip). Root version → v0.2.46-alpha. Code + PR only — not merged/tagged/deployed.
- **Kanban discoverability (reported, not redesigned).** The board lives at `#/projects/:slug/board`, reached via the **Overview · Board** switcher on a project's page; all three project routes are demo-browsable (only `/dashboard` is auth-gated), so the Board link **is** visible in demo mode — but only after opening a specific project (no Board affordance on the `#/projects` index cards).

## v0.2.45-alpha — KANBAN: production Kanban board for every project

Frontend-only release (no agent code changed; onboarding preview stays **v0.1.20-preview**). Every Continuum project now has a first-class Kanban board, integrated into the project's Amber multi-view navigation (an **Overview · Board** switcher in the project header, plus route `#/projects/:slug/board`) — not a disconnected demo.

- **Default columns** Todo · Doing · Done, created lazily per project by `ensureBoard(slug)` so existing and freshly-created projects alike get a board on first access with no destructive rewrite of persisted state.
- **Custom columns**: add, rename, reorder (drag or accessible `‹ ›` buttons), delete. Deleting a non-empty column requires choosing a destination — every card is relocated first (`deleteColumn` → `moveToColumnId`); the final column can't be deleted. Cards are never lost.
- **Cards** (lean model): title + description + optional assignee + due date. Create/edit/delete via modal; move within/between columns by HTML5 drag-drop **or** accessible `‹ ↑ ↓ ›` controls for keyboard/touch. Both paths share one `moveCard` primitive with dense `order` reindexing.
- **Data**: new Nostr-shaped kinds 30083 (column, `d=<slug>:col:<id>`) and 30084 (card, `d=<slug>:card:<id>`), persisted via the existing local store; per-project isolation by `projectSlug`; `deleteProject` cascades. Migration is additive and fail-closed.
- **Safety/limits** (`BOARD_LIMITS`): ≤20 columns, ≤200 cards/column, title ≤120, description ≤2000, assignee ≤80, name ≤40; due date accepts only `YYYY-MM-DD`. All rendering via the XSS-safe `util.h()` (textContent, no raw HTML). Responsive scroller + dark-Amber styling; empty states throughout.
- **Tests**: new `src/data/board.test.js` (32 cases). `vitest run` 43/43; `npm run build` clean (74.6 kB / 23.2 kB gzip). No headed browser in sandbox — logic proven via the pure store layer (repo's no-DOM convention). Root version → v0.2.45-alpha; agent unchanged. Code + PR only — not merged/tagged/deployed.

## v0.2.44-alpha — APP-ROUTING: application-first root (login + dashboard), sales page isolated to #/about

Frontend-only release (no agent code changed; onboarding preview stays **v0.1.20-preview**). The root (`/continuum/`) was the marketing/sales page; it is now the application. Fulfils the operator ask: *"separate out that sales page from the root of continuum and replace it with a login page and the dashboard."*

**1. Root is application-first.** A pure guard layer (`src/nav-guard.js`) decides root behaviour: **logged in → redirect to `#/dashboard`; logged out → render a branded Amber login page in place at root.** The root never renders the sales page.

**2. Dedicated login page (`src/views/login.js`).** A branded Continuum Amber surface (shared torii mark, amber-on-bronze), full-bleed inside `landing-mode`. It drives the **existing NIP-07 / Plebeian Signer flow** via `startLogin()` — no password auth invented, no key material in the DOM. Small non-primary links lead to `#/about` and the read-only demo shell.

**3. Sales/marketing isolated to `#/about`.** The former landing view (`src/views/landing.js`) is reframed and exported as `renderAbout`; it is reachable only from the non-primary About link and is **never** the root or an onboarding-completion target. `toriiSvg` is exported from it and reused by the login page.

**4. Dashboard protected, no loops.** `#/dashboard` is guarded by `guardRedirect('/dashboard', …)`: a logged-out visitor (including a refresh or a deep link) is bounced to the login page at root. Because root renders login **in place** (it never itself bounces when logged out), `protected → root → login` is terminal — no redirect loop. Session-drop while on a protected view (sign-out / 401 expiry) reactively returns to login via the `continuum:session-changed` listener.

**5. Onboarding handoff preserved.** `adoptOnboardingSession()` still runs before first render, so a freshly onboarded operator arriving at `/continuum/#/dashboard` with a live `torii.session` is adopted into `continuum.session.v1` and lands authenticated on the dashboard — no login bounce. Demo shell views (`#/projects`, `#/marketplace`, `#/routstr`) and all Amber navigation are preserved.

**No external requests.** No Google/gstatic/Fontshare/CDN/analytics added; login/about use only local/system assets and inline SVG. Verified by the (rebuilding) `test/no-external-cdn.test.js` and per-source assertions in the new suite.

**Browser QA note:** the sandbox has no headless/headed browser and no jsdom/happy-dom, so an interactive `#/dashboard` walkthrough could not be run here. The routing/auth contract is instead proven by (a) the exhaustive pure guard-decision tests and (b) source-structure locks on `main.js`/views that pin the app-first mapping and sales-page isolation, plus the rebuilding no-external-request scan. The guards run on every router resolve — including the initial resolve, which is exactly what a refresh / deep link triggers — so refresh and deep-link behaviour is covered by the same decision layer.

**Changes:** new `src/nav-guard.js` (pure guard decisions), new `src/views/login.js`, `src/views/landing.js` (`renderLanding → renderAbout`, `toriiSvg` exported, header reframed), `src/main.js` (app-first routes + `/about` + dashboard guard + reactive session handling), `src/styles/landing.css` (login-page styling), new `test/app-routing-auth.test.js` (20 tests). Root `package.json` **0.2.43-alpha → 0.2.44-alpha**.

**Addendum — root-app selector correction (ops).** A live v0.2.43 rerun surfaced one more exact bug: `group_vars/all.yml.example` shipped `torii_root_app: launcher`, but the installed CLI/API accepts `torii set-root <registered-name|none>` and returned **404 `{error: app_not_installed, name: launcher}`** — the Torii Suite launcher at `/` is the sentinel **`none`**, not a registered app — so the deploy rolled back (rollback worked; the operator reran with `-e torii_root_app=none`). Fix, entirely additive and no-Google/no-CDN preserving: the example default is now **`torii_root_app: "none"`**; the role no longer calls `set-root` raw but routes through **`continuum-adopt.sh set-root-safe`**, which `normalize_root_app`-maps legacy/empty/`launcher` (+ `torii`/`base`/`root`/`home`/`homepage`/`default`) → `none`, sources the admin token silently from `/opt/torii/env`, **skips** when `torii get-root` already matches, and returns 0 for the default so a normal install can never trip the rescue. An explicit **registered** app still passes through; `continuum`-as-root warns (discouraged) but is honoured when deliberate. **Continuum is never made root by its own installer.** `ops/README.md` gains a "Root-app selector correction (v0.2.44-alpha)" subsection; `continuum-adopt.test.sh` 188 → **219** (mock CLI reproducing the exact 404; `launcher`→`none`; default skip/idempotent; explicit-app honoured; no-token-leak; example/role anti-drift greps).

**Tests / build / audit (all green):** `vitest run` **795/795** (775 prior + 20 new); agent `node --test` **104/104**; `continuum-adopt.test.sh` **219**, installer-preflight 18, shared-parent 10, signal 9, nginx-install 13; root `npm run build` clean, `dist/` free of external loading vectors (only the inert Plebeian-Signer store anchor remains); `npm audit --omit=dev` 0 vulns (root + agent). Code + PR only — **not merged, tagged, or deployed.**

## v0.2.43-alpha — OPS-HARDENING: encode three live-discovered cutover corrections

Ops-only release (no app/agent code paths changed; onboarding preview stays **v0.1.20-preview**). The v0.2.42-alpha cutover succeeded manually on the live box, but three environment realities had to be worked around by hand. This release encodes all three permanently so a clean re-run needs no manual steps.

**1. Torii CLI `register` uses flags, not positionals.** The installed CLI is `torii register <name> [--display …] [--desc …] [--version …]`; the old positional form failed live with `unknown flag: Continuum`. The role now calls `torii register {{ continuum_register_name }} --display … --desc … --version <bare-semver>`, deriving the bare version from `continuum_version` via `regex_replace('^v','')`. New `continuum_register_name` / `_display` / `_desc` defaults.

**2. `MemoryDenyWriteExecute` must be `no` for Node 22.** V8 JITs with W^X memory; `MemoryDenyWriteExecute=yes` makes the kernel refuse the mprotect and V8 aborts on startup (fatal `SetPermissions` / errno 12 / `SIGTRAP`). The rendered `continuum-agent.service.j2` now sets `MemoryDenyWriteExecute=no` with an inline rationale, retaining every other compatible directive (`NoNewPrivileges`, the `Protect*` set, `RestrictNamespaces`, `LockPersonality`, empty `CapabilityBoundingSet`). The role runs a **Node V8 JIT smoke test** under the rendered MDWE value (transient `systemd-run` scope) before starting the real service, so a reintroduced `=yes` fails fast instead of crash-looping.

**3. nginx cannot traverse `/home/continuum`.** The `0750` home + the unit's `ProtectHome` mean www-data cannot descend into it, so aliasing the SPA out of the private app dir returned HTTP 500. The build is now published to a **public webroot `/var/www/torii/continuum`** (root-owned, dirs `0755` / files `0644`) via `deploy_webroot` — an atomic staged swap that keeps the prior webroot as a timestamped backup. Only the static bundle is copied out; the app/agent **source + encrypted state stay private** under `/home/continuum/app`. A **single** `location /continuum/` prefix alias serves both the SPA entry and the hashed `assets/*` bundle (no regex-alias, no `/home`).

**Transactionality:** the cutover `rescue` now also rolls the webroot back from its backup (`rollback_webroot`) and reloads nginx on failure. Re-running against the now-live v0.2.42 Ansible layout is idempotent — re-detects `existing-ansible`, **preserves** config (never rotates `session_secret`, never touches the funded key), re-publishes the webroot keeping the prior bundle as backup.

### Amendment (pre-merge, same PR #40): frontend zero-external-request hardening + asset-route 404 fix

Three further corrections landed on the same branch after live browser testing of the v0.2.42 box:

**4. No third-party CDNs / no Google in production.** The production `index.html` preconnected to and loaded webfonts from `fonts.googleapis.com`, `fonts.gstatic.com`, and `api.fontshare.com`. All such preconnects/stylesheets are removed; typography now uses a **deliberate local system font stack** (`src/styles/theme.css` — `system-ui`/`-apple-system`/`ui-monospace` families), so production makes **zero external requests**. No fonts were downloaded or vendored. Enforced by a new `test/no-external-cdn.test.js` that builds `dist/` and asserts index + every emitted asset are free of banned CDN/font hosts and of any external stylesheet/font/preconnect **loading** vector (same-origin `/continuum/api` allowed; inert outbound `<a target="_blank">` links are not loading vectors).

**5. Hashed asset 404 (black page) fixed permanently.** The nested `location /continuum/assets/` alias+`try_files` re-mapped the path and returned 404 for the hashed `.js`/`.css`, so the live page rendered black. Removing that nested block lets the parent `/continuum/` alias serve the bundle directly (verified live: Amber dashboard, zero console/network errors). Both nginx templates now carry a single parent alias only; a new `test/nginx-continuum-routing.test.js` stands up an HTTP server modelling the nginx `alias`+`try_files` semantics and, using the **actual hashed filenames** from `dist/index.html`, proves `/continuum/` (index), the hashed `.js` and `.css` all return **200** and a deep SPA route falls back to `index.html`. The ops bash suite's nginx section is inverted to a **regression lock** (fails if any nested `location .../assets/` reappears).

**6. Operator upgrade instructions corrected to the real live paths.** The live v0.2.42 checkout is `/opt/deploy/torii-continuum-v0.2.42-alpha` with the app at `/home/continuum/app` — the previously documented `/opt/torii/src/torii-continuum` does **not** exist. `ops/README.md` now prescribes a fresh, version-specific public clone of the final tag into a parallel dir, a localhost inventory, and a vault-free `existing-ansible` redeploy.

**Browser QA note:** the sandbox has no headed browser, so a live browser pass could not be run here. Verified instead: fresh build; HTTP-200 resolution of the real hashed index/JS/CSS + SPA fallback under `/continuum/`; static proof that every runtime `fetch` targets same-origin `/api/*` and no external resource is loaded. The app is a hash-router SPA (`#/`, `#/projects`, `#/marketplace`, `#/routstr`, `#/dashboard`), so the server contract is fully exercised by the integration test; the live box already rendered the dashboard with zero console/network errors after the manual asset-route fix.

**Changes:** `ops/lib/continuum-adopt.sh` (+`deploy_webroot`, +`rollback_webroot`, +CLI cases); `roles/continuum/defaults/main.yml` (+webroot + register vars); `roles/continuum/templates/continuum-agent.service.j2` (MDWE=no + rationale); `roles/continuum/templates/continuum.nginx.conf.j2` + `ops/nginx/continuum.conf.template` (public webroot, **single parent alias — nested assets block removed**); `roles/continuum/tasks/main.yml` (flag register, webroot deploy, V8 smoke, webroot rollback in rescue); `ops/test/continuum-adopt.test.sh` (**117 → 188** assertions; nginx section inverted to a no-nested-assets regression lock); `ops/README.md` (v0.2.43 subsection + corrected real-path upgrade command). Frontend amendment: `index.html` (external font links removed), `src/styles/theme.css` (local system font stack), new `test/no-external-cdn.test.js` + `test/nginx-continuum-routing.test.js`. Versions bumped root + agent `package.json` + both lockfiles `0.2.42-alpha → 0.2.43-alpha`.

**Tests / build / audit (all green):** `continuum-adopt.test.sh` **188/188**; `vitest run` **775/775** (762 prior + 13 new frontend/routing); installer-preflight/shared-parent/signal + nginx-install regressions; `bash -n` clean on all `ops/*.sh` + `ops/lib/*.sh`; role YAML parses; agent `node --test`; root `npm run build` clean; `npm audit --omit=dev` 0 vulns (root + agent).

## v0.2.42-alpha — OPS-HARDENING: transactional adoption/cutover + partial-adoption recovery

Ops-only release (no app/agent code paths changed; onboarding preview stays **v0.1.20-preview**). Fixes the live v0.2.41-alpha adoption failure: the role migrated live state *into* `/home/continuum/app/agent` and only *then* ran `ansible.builtin.git` into `/home/continuum/app` — cloning into a directory already populated with runtime state. That aborted, leaving the box with the **original standalone layout intact** AND a **partial, non-git `/home/continuum/app`** holding a copy of the state. The role now re-architects adoption to be transactional and idempotently recoverable from exactly that state.

**Fix (`ops/lib/continuum-adopt.sh` + `roles/continuum/tasks/main.yml`):**
- `layout_detect` takes a 3rd `app_dir` arg and adds a **`partial-adoption`** mode — agent dir has state but `app/.git` is absent while the standalone is still present. A real git-backed Ansible install still wins; a non-git app dir carrying state is recovered, never built on top of.
- New `authoritative_state_dir` resolves the single live/funded source per mode (standalone for adopt/partial with the untouched original preferred over the partial copy; agent dir for existing-ansible).
- New `stage_reset` / `promote_release` / `rollback_release`: the git checkout + `npm ci` + `vite build` happen in a **clean staging dir** (`/home/continuum/app.staging`) while the **old unit keeps serving**; authoritative state is copied in **only after a successful build**; the old unit is stopped only immediately before an **atomic same-filesystem swap** into `/home/continuum/app`, quarantining (never deleting) any pre-existing app dir to `app.quarantine-<UTC>`.
- The cutover is wrapped in `block`/`rescue`: on any promotion or `/api/health` failure it stops the new unit, rolls an existing-Ansible tree back from quarantine (or re-enables the original standalone for adopt/partial), and prints backup + quarantine paths with an exact, **secret-free** recovery command.

**Tests / docs:** `ops/test/continuum-adopt.test.sh` extended to **117** hermetic assertions (3-arg detect incl. partial-adoption + absent-app-dir; `authoritative_state_dir`; `stage_reset` refuses dangerous targets; `promote_release` clean/quarantine/refuse/idempotent; `rollback_release` restore/refuse/no-quarantine; end-to-end partial-adoption recovery with byte-for-byte config equality + funded-key retention + quarantine preservation + untouched standalone; v0.2.42 anti-drift greps). New "Transactional cutover + partial-adoption recovery (v0.2.42-alpha)" subsection in `ops/README.md` with the exact recovery invocation for the current partial-adoption VPS. Root + agent version → v0.2.42-alpha (+ both lockfiles). Verified: adopt **117/117**, ops regressions 18/10/9/13, `bash -n` clean, agent `node --test`, root build + vitest, `npm audit --omit=dev` 0 vulns. Code + PR only — **not merged, tagged, or deployed.**

## v0.2.41-alpha — OPS-HARDENING: vault-free standalone adoption / redeploy

Ops-only release (no app/agent code paths changed; onboarding preview stays **v0.1.20-preview**). Closes the blocker identified after v0.2.40-alpha: adopting or redeploying an **existing** install preserves the live `config.yaml` byte-for-byte, yet the preserve path still rendered a `.config.candidate.yaml` from `config.yaml.j2` (which references `{{ admin_npub }}`/`{{ session_secret }}`) purely for the drift diagnostic — so a genuinely vault-free run (no `group_vars/vault.yml`, no vault password) failed with an undefined-variable error before adoption completed.

**Fix (`roles/continuum/tasks/main.yml`):**
- New `continuum_vault_vars_present` fact, computed with the `default('')` filter so an undefined `admin_npub`/`session_secret` yields `false` rather than raising.
- The candidate render, `config-drift` script, candidate removal, and "differ" warning are all guarded behind `continuum_vault_vars_present | bool` and are skipped entirely when the vault vars are absent; a non-secret debug notes the diagnostic was skipped. The live config is still preserved untouched, so the funded Routstr key stays decryptable.
- A fresh install or an explicit `continuum_allow_config_rotation=true` rotation still requires the vault vars; their absence in those modes now **fails closed** with a clear, non-secret `ansible.builtin.fail` before any state is mutated.

**Tests / docs:** `ops/test/continuum-adopt.test.sh` extended to **66** hermetic assertions (vault-free adopt end-to-end with byte-for-byte config preservation + funded-key migration + no-secret output; existing-ansible redeploy; fresh missing-vars fail-closed; explicit-rotation missing-vars fail-closed; vault-var presence truth table; anti-drift greps for the new guards). New "Vault-free adoption / redeploy (v0.2.41-alpha)" subsection in `ops/README.md` with the exact secret-free localhost invocation. Root + agent version → v0.2.41-alpha (+ both lockfiles). Verified: adopt **66/66**, ops regressions 18/10/9/13, `bash -n` clean, agent `node --test`, root build + vitest, `npm audit --omit=dev` 0 vulns. Code + PR only — **not merged, tagged, or deployed.**

## v0.2.40-alpha — OPS-HARDENING: safe standalone→Ansible adoption, no config clobber, fail-closed backups

Ops-only release (no app/agent code paths changed; onboarding preview stays
**v0.1.20-preview**). Fixes the dangerous deployment mismatch found while
preparing the live v0.2.39-alpha rollout: the continuum Ansible role cloned to
`/home/continuum/app` and **re-rendered `config.yaml` / `session_secret`
unconditionally on every run**, while the live standalone installer uses
`/opt/torii/continuum-agent` + unit `torii-continuum-agent.service`. Running the
old role over a live standalone box would have overwritten the session_secret
(orphaning the funded Routstr key, which is encrypted at rest under a key derived
from that secret) and/or double-bound port 8787.

**What changed.** The risky detect/backup/migrate/config-decision logic is
factored into a sourceable, unit-tested shell lib
`ops/lib/continuum-adopt.sh` (mirrors the `node-version.sh` "no side effects on
source" convention), and the role `roles/continuum/tasks/main.yml` is now a thin
guarded orchestrator that calls it:

- **Layout detection** — `fresh | adopt-standalone | existing-ansible`. An
  already-populated Ansible layout always wins, so adoption never clobbers a
  migrated tree.
- **Fail-closed backup before any mutation** — `config.yaml` + `memory/` +
  `ciphertexts/` + `pending/` from both layouts are copied to a timestamped
  root-only `0700` dir `/root/continuum-backup-<UTC>/`. If the backup can't be
  written, the play aborts and nothing is touched.
- **Standalone adoption** — stops + disables `torii-continuum-agent.service`
  (freeing 8787), then migrates the existing config + encrypted state **verbatim**
  into the Ansible layout. `session_secret` is copied byte-for-byte, never
  regenerated, so the funded key stays decryptable. Migration is idempotent
  (never overwrites an artefact already present at the destination).
- **No routine config clobber** — config.yaml is rendered from vault **only** on
  a genuinely fresh install, or when the operator explicitly opts in with
  `-e continuum_allow_config_rotation=true` (OFF by default). On a preserve, a
  one-way `session_secret` drift check reports only `same`/`differ` and prints
  **no secret value**; a `differ` result surfaces a safe "rotation pending"
  notice rather than silently rotating.
- **Untracked encrypted state can't be deleted by the checkout/build** — the git
  module's `force:true` resets only tracked files; `memory/`, `ciphertexts/`,
  `pending/`, `config.yaml` are gitignored, so a re-checkout leaves them intact.
- **Transactional cutover** — service + nginx + launcher registration + health
  probe run in a `block`; on failure a `rescue` prints the backup path and an
  exact recovery command (restore-from-backup, or re-enable the standalone unit).

New `roles/continuum/defaults/main.yml` holds the safe non-secret tunables
(`continuum_standalone_dir`, `continuum_standalone_service`,
`continuum_backup_root`, `continuum_allow_config_rotation: false`). Secret-touching
tasks carry `no_log: true`. All logic is pinned by `ops/test/continuum-adopt.test.sh`
(44 hermetic assertions: detection precedence, fail-closed backup, verbatim +
idempotent migration, config-action matrix, no-secret drift, permissions, and
anti-drift greps that the role wires the lib in the safe order). Docs: new
"Adopting a standalone install with Ansible" runbook in `ops/README.md`. Operator
handles **no secrets** at any point.

## v0.2.39-alpha — ONBOARDING-GATING + APP-MOUNT: real claimed-state Step-3 gating, dup-pay race closed, completion lands on the actual app dashboard

Onboarding preview bumped to **v0.1.20-preview** (`preview-assets/onboarding-v0.1.20/`).
Two production defects on the live v0.1.19/v0.2.38 stack, plus the app-mount
follow-through. **The user-funded Routstr key, all encrypted agent memory, and
every prior payment state are preserved — no invoice was created, paid, or
re-submitted, and no `memory/**` was touched.**

**Part A — claimed-state gating (root cause).** In v0.1.19 a verified, funded
key still rendered both setup-choice cards, the key-entry/reveal controls,
*Verify & connect*, and *Request an invoice*. Root cause was a CSS cascade
defect, not logic: author `display` rules (`.btn-primary{inline-flex}`,
`.wallet-choices/.routstr-paths{flex}`, `.choice-card{grid}`) outrank the UA
sheet's `[hidden]{display:none}`, so setting `el.hidden = true` on those elements
did nothing and `collapseStep3Setup` visually no-op'd. Fix is one canonical
override in `shared.css`: `[hidden] { display: none !important; }`. The
status-only resume path (page load onto an already-verified key) now funnels
through `renderSuccessAdvance` via a single `showClaimed` helper (replacing the
old `showConnected`) so *every* claimed entry point collapses identically. After
collapse the panel carries `data-claimed="1"` as the single source of truth, and
the verified green summary + exactly one standalone Continue button are all that
remain.

**Part A — duplicate-payment race closed.** `data-claimed` is checked as the
first line of the quote (`quoteBtn`), key-connect (`keyConnectBtn`), and
pay-confirm (`payBtn`) handlers, so a stale/racing UI in claimed state can never
initiate a second invoice or payment; the pay button also stays permanently
disabled once claimed. This makes duplicate invoice/payment initiation
structurally impossible in claimed state, not merely hidden.

**Part B — completion lands on the real app.** `CONTINUUM_HOME` changed from
`/continuum/` to `/continuum/#/dashboard` (and the Step-3 curtain-open anchor in
`index.html` likewise), so onboarding completion opens the multi-view Amber
Continuum SPA dashboard rather than the marketing page served at the mount root.
The open-redirect guard on the `window.__toriiContinuumHome` override is
preserved (same-origin only).

**Part B — session handoff (no forced re-login).** Onboarding writes
`localStorage['torii.session']` (JSON envelope); the SPA reads
`localStorage['continuum.session.v1']` (raw token). A freshly onboarded user
previously hit the SPA with no SPA-shaped session and was bounced to the
sales/login screen. `src/data/agent.js` gained `adoptOnboardingSession()` (called
once in `main.js` at boot before `initStore()`): it fails closed if the SPA
already has a live session, else reads/parses the onboarding envelope and adopts
its token **only if `tokenLooksLive` passes** (well-formed `iat.exp.pubkey.sig`
shape + unexpired). Also added `deriveSameOriginBase(pathname)` — under the
`/continuum/` mount the SPA's `agentUrl()` now falls back to the same-origin
`/continuum` base when an onboarding session is present, so API calls hit
same-origin `/api` with no third-party origin and no CDN.

**App mount — no separate torii-suite PR required.** The `/continuum/` alias with
subpath refresh (`try_files … /continuum/index.html`), the `/continuum/api/*`
proxy (prefix-stripped to the loopback agent), the SPA build with
`VITE_AGENT_URL=/continuum`, agent install, nginx fragment, and launcher
registration are ALL in this repo's `ops/ansible` role — the root Torii Suite
launcher is never overwritten. Safe idempotent deploy (operator step, NOT run
here, from `ops/ansible/`): `ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags continuum`.

**Part C — wording.** Residual "VPS/daemon/box" user-facing copy in
`src/views/routstr.js`, `src/views/landing.js`, and `src/auth.js` scrubbed to
"your Torii, your gateway".

Tests: root vitest **762/762** (new `src/data/agent.test.js` 11 cases for the
session handoff + same-origin base; preview v0.1.20 **153**, with new gating and
dashboard-landing describe blocks proving claimed state exposes only Continue
while unclaimed states keep all controls), agent `node --test` **104/104**,
`npm run build` clean, `npm audit --omit=dev` **0 vulnerabilities** (root +
agent), dist verified to carry the session-adoption + `/#/dashboard` + relative
base and no "VPS" copy. **Honest QA limitation:** no jsdom/live-agent in this
environment, so a live interactive funded-agent browser pass was not possible;
claimed-state gating is proven by the CSS `!important` cascade guarantee plus
source/behaviour guards rather than a live click-through. Code + PR only — **not
merged, tagged, or deployed.**

## v0.2.38-alpha — ONBOARDING-FINISH: verified-state cleanup, correct balance units, inline key reveal, deterministic final curtain

Onboarding preview bumped to **v0.1.19-preview** (`preview-assets/onboarding-v0.1.19/`).
A focused live UX/completion pass on the wizard from three screenshots. No
character/animation/CDN/provider-pinning behaviour changed, and no payment/NWC
semantics changed beyond how balances are *displayed* and how the full key is
safely *retrieved*. The funded Routstr key and all prior state are preserved.

**Balance units (root cause).** Routstr denominates wallet balances in
MILLISATS, but `extractBalanceSats` surfaced the raw `balance` verbatim, so a
10,000-sat funded key showed as "10000000 sats". The provider adapter now
divides msat fields to whole sats (explicit `*_sats` fields trusted as-is). A
marker-guarded `displayBalanceSats` migration divides legacy stored envelopes
(no `balance_units`) by 1000 on read; new envelopes carry `balance_units:'sat'`.
All balances render through `formatSats` (e.g. `10,000 sats`).

**Step 3 verified state.** Once the key is claimed/encrypted/verified,
`collapseStep3Setup` hides the two path cards, both input forms, the invoice
card, the progress/scanning bar and all three setup CTAs, leaving one green
verified summary and a SINGLE Continue button outside it. No countdown/
auto-advance (supersedes the v0.1.18 countdown). Advance stays idempotent.

**Step 5 recovery kit.** Removed the unbranded "Reveal full Routstr key
(one-time)" button and its `window.confirm` flow (which never revealed the key).
The ROUTSTR KEY row now has branded inline eye + copy controls; both fetch the
key over the existing admin-authenticated no-store export endpoint, hold it in
memory only, and never touch localStorage/sessionStorage/URL/logs. Re-masks on
toggle, step-leave, tab hide, session loss, and a conservative timeout. The
Download click is itself the explicit confirmation and embeds the full key in
the saved file while still excluding the NWC secret.

**Final curtain.** The old curtain only `console.log`'d a commented redirect and
spun forever. `initCurtain` navigates deterministically to the resolved
same-origin `/continuum/` home (a `window.__toriiContinuumHome` override is
accepted only same-origin — open-redirect guard), reveals a real "Open Continuum
now" fallback link on a bounded timer, honours reduced motion, and drops the
spinner shortly after the nav attempt so it can never hang.

Tests: agent `node --test` **104/104**, root vitest **269/269** (preview v0.1.19
**145**), `npm run build` clean, `npm audit --omit=dev` **0 vulnerabilities**
(root + agent). Code + PR only — not deployed.

## v0.2.37-alpha — ONBOARDING-PAY-RECOVERY: paid-but-unclaimed Routstr recovery + payment progress state machine + working recovery kit

Onboarding preview bumped to **v0.1.18-preview** (`preview-assets/onboarding-v0.1.18/`).
Fixes a live onboarding incident: an operator connected NWC and paid 10,000 sats
to fund a Routstr session, but the UI said "payment confirmed" without surfacing
the key, never auto-advanced, and the Recovery Kit "download" was a no-op that
just stepped the deck. No new invoice was created or paid to diagnose or fix it.

**Recovery-first.** Shipped a safe SSH runbook before any code: inspect
`memory/secrets/*.enc` by existence/metadata only (never decrypt), reuse the
operator's existing browser session token against the loopback admin API, and
claim the already-paid key with the **idempotent** `POST /api/onboarding/routstr/recover`
(empty body → the agent re-submits the stored bolt11; **never re-pays**). All
status/verify responses are redacted by design; the full key is revealed only
by an explicit one-time no-store export. Established that **payment-confirmed
does not imply the key is stored** — the claim is a separate post-settlement
step — and enumerated the recovery states (paid+claimed / paid+unclaimed / unpaid).

**Agent (v0.2.37-alpha).** New admin-gated endpoints: `GET /recovery/state`
(redacted resume snapshot, `claimable` true only when a pending invoice is
stored with no key yet), `GET /recovery-kit` (`Cache-Control: no-store`,
secret-free by default), and `POST /routstr/export-key` (one-time full-key
reveal; requires `confirm:true`, `no-store`, rate-limited, persists
`export_count`/`last_exported_at` audit fields, logs a warning but never the key).

**Preview (v0.1.18).** A pure `ONBOARD_PHASES`/`PHASE_META` state machine drives
an accessible (role=status, aria-live) progress + scanning bar and elapsed timer
across connect → quote → pay → claim → verify. **SUCCESS is reached only when
the agent reports `key_stored === true`** — `classifyPayResult`/
`classifyRecoverResult` map a bare paid/recoverable result to a retryable
`PAID_UNCLAIMED` phase, so the UI never claims success while the key is unissued.
The invoice Confirm button is permanently disabled after the first click
(duplicate-payment prevention). Success renders the redacted key then
auto-advances after a short countdown with an immediate Continue-now. On load,
Step 3 reads `recovery/state` and, when `claimable`, finishes the claim via an
empty-body `recover` without re-paying (refresh-resume). The Recovery Kit
download now builds a real text bundle via a Blob object URL; the default kit
excludes the NWC secret and full key, carrying redacted previews and restoration
instructions, and the full key is included only after an explicit confirmed
one-time reveal. Step 5 markup no longer prints static secret-adjacent values.

Preserved: character/animation behaviour, self-hosted Three.js (no CDN),
provider pinning, redaction discipline, rate limits, no autonomous spend, no
nsec on the server. Tests: agent `node --test` **102/102**, root vitest
**453/453** (preview v0.1.18 **124**), `npm run build` clean, `npm audit
--omit=dev` **0 vulnerabilities** (root + agent). Code + PR only — not deployed.

## v0.2.36-alpha — ONBOARDING-ASSET: new Chiefmonkey GLB + forbidden-safe animation state machine

Onboarding preview bumped to **v0.1.17-preview** (`preview-assets/onboarding-v0.1.17/`).
A substantial asset + animation upgrade: a fresh Chiefmonkey source GLB replaces
the old `chiefmonkey6.glb`, every walking/running/knock-down clip is removed
from the shipped model, and the runtime plays a dedicated, forbidden-safe clip
per onboarding step plus a curated pool of click reactions.

**New optimized asset (`assets/chiefmonkey-onboarding.glb`).** Produced by a new
reproducible local optimizer `tools/optimize-glb.mjs` (gltf-transform 4.4.1 +
draco3dgltf 1.5.7 + sharp 0.35.3, all build-time only — no third-party runtime
CDN). Pipeline: `dedup → weld → resample → textureCompress(webp,q82,≤1024²) →
prune → draco(edgebreaker)`, and it drops every forbidden locomotion/knock-down
clip using the runtime's own `isForbiddenClip` predicate (single source of
truth, imported from `onboarding-client.js`). Deterministic — the same source
bytes yield byte-identical output.
- Source: 9,298,852 bytes, SHA-256 `87b0048c…c37dd` — **kept out of git**
  (build artifact only; see `tools/SOURCE.md`).
- Optimized: **2,347,780 bytes, 74.75% smaller** (target was ≥60%), SHA-256
  `0253d5e1…e2fcb`. Ships with a `.manifest.json` recording sizes, %reduction,
  the deterministic SHA, and the retained/dropped clip inventory.
- **13 clips retained, 5 forbidden dropped** (`Clapping_Run`, `Knock_Down`,
  `Running`, `Stylish_Walk_inplace`, `Walking`). Mesh/skin (24 joints)/material/
  texture counts all preserved nonzero; clip names survive Draco compression.

**Forbidden-clip filter (REQ2).** `isForbiddenClip`/`filterForbidden` in
`onboarding-client.js` do case-insensitive semantic matching robust to spaces /
underscores / camelCase (walk, walking, run, running, jog, sprint,
knock(-/ )down, fall-down equivalents). Used by BOTH the optimizer (drop at
build) and the runtime (never select), so a forbidden clip can never be mapped
to a step, chosen as a click reaction, or triggered by a status phase.

**Dedicated per-step animation state machine (REQ3, `character.js`).** Each of
the five deck steps resolves one dedicated clip from `STEP_CLIPS`/`selectStepClip`
(1 Talk_with_Hands_Open, 2 Agree_Gesture, 3 mage_soell_cast_3, 4 Gentlemans_Bow,
5 Idle_10; a dormant step-6 Victory_Cheer "curtain" is defined for a future
completion beat). The clip plays deterministically on entering/restoring that
step and loops. Applied on model-ready via the v0.1.15 `resolveReadyStep` path so
restore-before-ready and ready-before-restore both land on the correct step.

**Click reactions via raycast (REQ4).** A window-level `pointerdown` +
NDC-from-canvas-rect `Raycaster.intersectObject(model)` plays one random one-shot
from a curated `CLICK_POOL` (`pickClickReaction`, no immediate repeat), then
crossfades back to the current step's dedicated clip on the mixer `finished`
event. Guards: ignores clicks on UI controls (never steals a panel/button
click), respects `prefers-reduced-motion`, and ignores click-spam while a
reaction is active. No walking/running/knock-down/severe-damage in the pool.

**Status-phase reconciliation (REQ5).** The Step-1/2/3 prompt/success/failure
reactions (`onboarding:anim`) are transient overrides that always return to the
*current* step clip afterwards; a looping prompting override yields to a genuine
step change but not to a mere resize. Async auth/wallet/Routstr outcomes and the
character load order can no longer race or permanently overwrite step state.

Tests (offline, deterministic): parse the optimized GLB's JSON chunk to prove
skeleton/skin/mesh/material counts nonzero and every referenced step/click/status
clip name survives; assert no forbidden pattern is ever selectable; verify the
committed asset matches the manifest SHA + size budget (≤3 MB, ≥60% reduction);
cover every step mapping, restore ordering, status→current-step return, click
hit/no-hit + UI-guard + no-immediate-repeat + spam guard + crossfade return,
reduced motion, and final load-error. Verified target file green and the full
root vitest suite green; `npm run build` clean. **Code + draft PR only — preview
snapshot only, NOT wired into the production Continuum app and NOT deployed.**

## v0.2.35-alpha — ONBOARDING-STEP2/3: existing-wallet NWC connect + two-path Routstr setup

Onboarding preview bumped to **v0.1.16-preview** (`preview-assets/onboarding-v0.1.16/`).
Reworks Step 2 (Wallet) and Step 3 (Routstr) around real, secret-safe agent
flows, replacing the earlier local-wallet / LNbits mockup.

- **Step 2 — existing-wallet NWC connect (wallet-agnostic).** Operator pastes an
  NWC URI (password field, reveal opt-in, cleared on every outcome). The agent
  validates the URI, connects via NIP-47, calls `get_info`, and reports a
  capability matrix. A wallet missing optional caps is not rejected, but
  Routstr funding-by-payment stays gated on `pay_invoice` (`can_fund_routstr`).
- **Step 3 — Routstr, two paths.** Existing key: paste an `sk-…` key, agent
  verifies balance/models/info before ready. Fund a new session: quote a
  Lightning invoice → explicit confirm → pay via connected NWC → claim minted
  key. Routstr Lightning contract is source-grounded against `Routstr/routstr-core`
  (`CREATE /lightning/invoice`, `STATUS /lightning/invoice/{id}/status`,
  `RECOVER /lightning/recover`); a poll timeout returns a precise RECOVERABLE
  state carrying the bolt11 (sats never lost, UI offers Claim-key retry).
- **Security.** Provider adapter pinned to one https origin (`redirect:'error'`,
  no SSRF pivot, bounded timeout + body cap + bounded polling, fail closed,
  constant-safe key redaction). Secrets (NWC URI, `sk-…`) never touch
  storage/URL/logs/errors; submitted only over the authenticated same-origin API,
  stored encrypted at rest (AES-256-GCM, key from `session_secret`); only
  redacted shapes returned. Mutation/test/pay/recover routes admin-gated
  (`requireAdmin`) + rate-limited (`onboarding_per_min`, default 12). Pay refuses
  unless `confirm===true` AND the wallet advertises `pay_invoice`. No nsec on the
  server, no autonomous spending.

Tests: agent `node --test` **96/96** (secretstore, nwc, routstr-provider incl.
create/status/recover + topup-bearer + poll-timeout→recoverable +
expired-terminal + disabled-path-blocked, onboarding quote/pay/recover); root
vitest **223/223** (client quote/pay/recover, confirm boundary, no-persistence,
redaction, disabled-provider degrade); `npm run build` clean;
`npm audit --omit=dev` 0 vulnerabilities (root + agent). Code + PR (#32) only —
not deployed.

## v0.2.34-alpha — ONBOARDING: deterministic character↔deck step sync (Chiefmonkey after soft reload)

Onboarding preview bumped to **v0.1.15-preview** (`preview-assets/onboarding-v0.1.15/`).
Fixes the intermittent "Chiefmonkey stays absent after an ordinary `Cmd+R` soft
refresh" bug while Step 2 session restore still succeeds (a hard reload always
worked). A live browser diagnostic ruled out the assets — every file served 200,
the GLB parsed with all clips incl. `Idle_03`, canvas present at opacity 0 —
leaving startup ordering as the only variable.

**Root cause — a script/load-ordering race, not bad assets.** `character.js`
(ES module) and `deck.js` (classic script) execute in non-deterministic order
relative to each other and to the async GLB load. `deck.js` announced the
desired step (incl. restored Step 2) via an `onboarding:step` event; when that
fired *before* the GLB finished, the old `character.js` dropped it (empty
`actions` map) and then hard-applied `applyStep(1)` in `onLoaded` — reverting the
restored step and, because the intended ready-state was lost, leaving the stage
dark.

**Fix (client-only; no server/schema/validation-endpoint/asset change).** New
pure, injectable step-sync state machine in `onboarding-client.js`
(`createCharacterSync`/`recordStep`/`resolveReadyStep`/`markCharacterFailed`).
`character.js` records every `onboarding:step` (remembered, not dropped, before
readiness); on load `resolveReadyStep(sync, window.__toriiRestoredStep)` applies
the deck's resolved step, else the restored session step read at ready time, else
Step 1. The hard-coded `applyStep(1)` is gone; a step arriving after readiness
applies immediately — both paths order-independent. Explicit readiness/terminal
state + events: `window.__toriiCharacterReady` + `onboarding:model-loaded` on
success; `window.__toriiCharacterFailed` + `onboarding:model-error` on terminal
give-up. Preserved byte-for-byte: retry policy, no-`crossorigin` preload hints,
fail-closed restore, NIP-07/NIP-46 flow, signer wording, session shape, the three
auth-phase clips; `deck.js`/`index.html`/`shared.css`/assets/`three-libs/`
unchanged from v0.1.14.

Tests: root vitest preview suite **51/51** for v0.1.15 (both orderings, ordinary
reload/cache-hit → Step 1 no revert, out-of-range restore fail-safe, terminal
failure branch), v0.1.14 still 41/41; agent `node --test` 39/39; `npm run build`
clean (`preview-assets/` excluded from `dist/`). Root `npm audit` findings are
dev-tooling only (vite/vitest/esbuild dev-server advisory, fix needs breaking
vite@8, out of scope). Code + PR (#31) only — not deployed.

## v0.2.33-alpha — ONBOARDING: restore Step 2 on reload + Chiefmonkey reappears

Onboarding preview bumped to **v0.1.14-preview** (`preview-assets/onboarding-v0.1.14/`).
Live acceptance hotfix: after a successful NIP-07 sign the deck advances to
Step 2, but a plain page refresh dropped the operator back to Step 1 and left
Chiefmonkey invisible. Two independent refresh-path root causes, fixed together
— client-only, no server/schema/validation-endpoint change.

- **Root cause 1 — Step 2 → Step 1 on refresh.** `onboarding-client.js` wrote
  `localStorage['torii.session']` on success but nothing ever read it back on
  load, and `deck.js` always hard-started at Step 1. Fix: `restoreSession()`
  reads + validates the stored session at module load and, when valid, sets
  `window.__toriiRestoredStep`; `deck.js` opens directly on that step, with an
  `onboarding:advance` dispatch covering the reverse load order. Validation is
  fail-closed and adds no server surface — `isSessionValid()` enforces every
  non-secret invariant the agent's `verifySessionToken` enforces (exact
  `iat.exp.pubkey.sig` shape, numeric timestamps, unexpired, pubkey match);
  the HMAC secret is never needed in the browser. Invalid/expired/tampered
  sessions are removed and the operator restarts cleanly at Step 1.
- **Root cause 2 — Chiefmonkey invisible after refresh.** v0.1.11's watchdog
  retried the GLB once on an 8s stall, but a reload could make the preloaded
  same-origin fetch error outright, and the old `onErr` merely hid the canvas
  and cancelled the watchdog so the retry never ran. Fix: both stall and error
  route through the pure `nextLoadAttempt()` policy — first failure (either kind)
  → one cache-busting retry, second → give up (no loop). Preload hints untouched
  (v0.1.11 same-origin no-`crossorigin` fix preserved).

Preserved: v0.1.13 bodyless-challenge fix, NIP-07 primary + browser-client NIP-46
secondary (no server bunker-connect), signer wording, session shape, the three
auth-phase clips, no new CDN. Tests: focused preview/auth vitest **41 passed**
(incl. restore + loader-retry + no-crossorigin guardrails); agent `node --test`
**39 passed**; `npm run build` OK; `npm audit --omit=dev` 0 vulnerabilities
(root + agent). Code + PR (#30) only — not deployed.

## v0.2.32-alpha — ONBOARDING-STEP1-FIX: "agent challenge failed (400)" on Sign with Plebeian Signer

Onboarding preview bumped to **v0.1.13-preview** (`preview-assets/onboarding-v0.1.13/`).
Production bug: on the live onboarding preview (v0.1.12-preview / agent
v0.2.31-alpha) the operator clicked "Sign with Plebeian Signer"; Chiefmonkey
animated but no signer prompt opened and the panel reported exactly
`agent challenge failed (400)`.

**Root cause (client-only).** `onboarding-client.js`'s `postJson` helper
always set `Content-Type: application/json`, including on the **bodyless**
`POST /api/auth/challenge` call. The agent runs Fastify v5, whose JSON
content-type parser rejects an empty body carrying that header with
`400 FST_ERR_CTP_EMPTY_JSON_BODY`. So the very first step failed before any
signer was invoked — the NIP-07 `window.nostr` prompt only fires *after* a
challenge is fetched, which is why Chiefmonkey animated ("prompting") but no
extension prompt appeared. The agent route, schema, and validation were
correct; the mismatch was entirely in the client's request framing.

**Fix.** `postJson` now sets the JSON content-type and serialises a body only
when a body is actually provided. The challenge call goes out bodyless with no
content-type (→ 200); the verify call is unchanged. No server endpoint added,
no validation weakened, no new bunker-connect endpoint. NIP-07 stays primary,
browser-client NIP-46 secondary; `localStorage['torii.session']`, the exact
"Sign with Plebeian Signer" wording, and the three auth-phase clips
(`HandGesture_00` / `Idle_03` / `Confused_02`) are all preserved.

Tests: new offline vitest case asserts the challenge POST carries no body and
no JSON content-type while the verify POST still does; new agent
`fastify-v5-api` case pins the empty-body-400 vs bodyless-200 contract the fix
relies on. Verified root vitest, root build, agent `node --test`, agent
`npm audit --omit=dev`. Code + PR only — not deployed.

## v0.2.31-alpha — ONBOARDING-STEP1: live NIP-07/NIP-46 auth for the onboarding preview

Onboarding preview bumped to **v0.1.12-preview** (`preview-assets/onboarding-v0.1.12/`).
Step 1 ("Prove you're the operator") now performs a real login against the
same-origin agent API instead of advancing the deck on a bare click.

New self-contained `onboarding-client.js` (ES module, no build step, no
third-party CDN). Primary path is **NIP-07** via `window.nostr` (button:
"Sign with Plebeian Signer"): `POST /api/auth/challenge` → build + sign the
exact kind-22242 auth event the agent expects (`content == challenge`,
`['challenge', …]` + `['relay', origin]` tags, mirroring
`agent/core/auth.mjs`) → `POST /api/auth/verify` → persist the session to
exactly `localStorage['torii.session']`. Fails closed on malformed
challenge/verify responses, expired challenges, pubkey/challenge mismatch,
or an absent token. Secondary path is **NIP-46** with the browser as the
client (architecture per github.com/dsbaars/bunker46), revealed by "Use a
different signer": the operator pastes a `bunker://` string, the browser
parses it and asks the remote signer to sign the same event over the
bunker's relay. There is **no server bunker-connect endpoint**; no key or
connection secret ever reaches the agent, and it never silently falls back
to NIP-07. Session value shape: `{ token, expires_at, pubkey, method,
created_at }` — session token + public identity metadata only, no secrets.

Chiefmonkey reacts via the existing animation channel: `HandGesture_00`
while prompting/signing, `Idle_03` on success, `Confused_02` on failure —
each with an ordered fallback to a clip that exists in the shipped GLB (the
GLB ships neither `HandGesture_00` nor `Confused_02`), so a missing clip
keeps the current animation rather than freezing.

Preserves the desktop-only gate and every prior perf fix (self-hosted
Three.js/Draco, WebP scenes, Draco wasm preload, `renderer.compile`,
same-origin preload cache behaviour). 28 offline vitest cases cover NIP-07
success/failure, storage shape/key, API response validation, animation
selection, NIP-46 browser-client behaviour + no-server-bunker-endpoint, and
no forbidden UI terminology ("Wallet" on the signer button, "VPS") or CDN
regressions. Verified: root vitest 28/28, root build, agent `node --test`,
ops regressions, `npm audit --omit=dev` (agent). **Code + draft PR only —
not deployed.**

## v0.2.30-alpha — AGENT-SEC-OPT-TORII-PERMS: least-privilege fix for the shared /opt/torii parent

Production regression fix, found after the v0.2.29 deploy to the SHC VPS. The
installer created the **shared** parent `/opt/torii` with an unconditional
`install -d -m 0750 -o continuum -g continuum /opt/torii`. `install -d` re-applies
mode+owner on every run, so this clamped the directory that torii's *other* apps
live under (torii-base launcher, quest tooling) to `0750 continuum:continuum` and
stripped its world-execute (`o+x`) bit. nginx (`www-data`) could then no longer
traverse `/opt/torii` to reach `/opt/torii/launcher/index.html`, so `/` fell
through to a default nginx **404** (Quest under `/var/www` was unaffected).

Fix (`ops/install-agent.sh`): create `/opt/torii` **only if absent**, `root:root`
`0755`, and **never re-own or re-mode an existing** shared parent. The agent's own
subdir `/opt/torii/continuum-agent` stays locked `0750 continuum:continuum` — nginx
never serves from it (the agent is loopback-proxied on `127.0.0.1:8787`), so no
confidentiality is lost. No behaviour change for the agent; the only delta is that
the shared parent keeps the permissions its other tenants need.

Tests: new hermetic + anti-drift `ops/test/installer-shared-parent.test.sh` (10
assertions) — proves the installer no longer chowns the shared parent to the
service user, guards its creation with an existence check (non-destructive
re-run), creates it `root:root 0755`, keeps `$INSTALL_DIR` locked `0750`
`$SERVICE_USER`, and functionally that an existing parent's mode (incl. an
operator-chosen `0751`) survives a re-run while a fresh parent comes up
world-traversable and the agent subdir stays `0750`. Full ops suite green:
`installer-preflight` 18/18, `installer-signal` 9/9, `nginx-install` 13/13,
`installer-shared-parent` 10/10; all `ops/*.sh` pass `bash -n`.

Operator out-of-band unblock before redeploy, if needed:
`sudo chown root:root /opt/torii && sudo chmod 0755 /opt/torii` (restores `o+x`,
leaves the agent subdir untouched). The previously-planned **onboarding** work
moves to **v0.2.31-alpha**. Code + draft PR only — not yet deployed.

## v0.2.29-alpha — AGENT-SEC-CASHU-LTS-RUNTIME: enforce the Node 22 money-path floor

Security-relevant follow-up to v0.2.28. Two independent reviews of PR #26 reached
the same conclusion: the cashu-ts v3-lts migration is correct, minimal, and
well-evidenced, with exactly one blocking change — the runtime contract must be
aligned with cashu-ts 3.7.1's `engines.node >=22.4.0` so the wallet is not
deployed onto an unsupported runtime by default. This slice makes Node 22 LTS a
**hard, enforced deployment prerequisite**. The dependency version is unchanged
(**3.7.1 stays pinned**); all v0.2.28 compatibility fixtures are preserved.

Changes:
- **Agent engine floor.** `agent/package.json` (and the agent lockfile root
  entry) `engines.node` `>=20.0.0 → >=22.4.0`. The **root** `package.json` is
  deliberately left engine-free — it is static vite/vitest frontend tooling with
  no agent runtime, so falsely requiring Node 22 there was avoided.
- **Installer preflight (fail-closed, robust semver).** `ops/install-agent.sh`
  now sources a new `ops/lib/node-version.sh` and gates on
  `node_version_ok "$node_ver"`, a **major.minor.patch** comparison (NOT
  major-only — `22.0.x`–`22.3.x` are correctly rejected even though `22 ≥ 22`).
  On a sub-floor or unparseable version it `die`s with the explicit supported
  floor and **stops before touching any user, service, or file** (the gate sits
  in preflight, ahead of user creation).
- **Regression coverage.** New `ops/test/installer-preflight.test.sh` (18
  assertions) is host-Node-independent — it exercises the pure helper with fixed
  strings: the four required boundaries (20.x reject, 22.3.x reject, 22.4.0
  accept, later-major accept) plus edges (patch/minor above floor, high patch on
  low minor rejected, old LTS rejected, `v`-prefix, prerelease suffix, bare major
  rejected, unparseable → rc 2), a side-effect-free source check, and anti-drift
  that the installer still sources the lib and gates before state changes.
- **Test-runner portability.** `agent` `npm test` `node --test test/` →
  `node --test`. Node 22's directory-argument discovery regressed the `test/`
  form (reported a single failing pseudo-subtest); no-arg auto-discovery reports
  the true **38/38** on both Node 20 and Node 22.
- **Docs.** `ops/README` Prerequisites now state Node **22 LTS is a hard
  prerequisite** (installer refuses older, stops before touching anything) and
  that an `EBADENGINE` warning is not an acceptable production state for a
  wallet; the "run Node 22 at next convenience" framing is gone. Handoff / this
  log / todo updated; the progress live-vs-shipped version wording corrected
  (v0.2.26 live, v0.2.27 newest shipped).
- **Cosmetic + evaluated.** Stale `wallet.mjs` comment `// mintUrl → CashuWallet`
  → `Wallet`. The `ensureLoaded()` in-flight dedup was evaluated and **left
  as-is** (documented non-blocking in-code): `loadMint()` is idempotent, boot
  warm-up primes each mint, and the only un-deduped case fires duplicate
  idempotent fetches — never a double-spend — so introducing memoized state in
  the money path right before a gated deploy was not justified.

Verified under a **real Node 22.11.0 runtime** (fetched as a non-global tarball;
the sandbox default is Node 20.20.1 — supported-boot is **not** claimed from Node
20): `npm ci --omit=dev` clean with **no EBADENGINE**; `npm audit` + `--omit=dev`
**0 vulnerabilities**; agent `node --test` **38/38**; ops `installer-preflight`
**18/18**, `installer-signal` **9/9**, `nginx-install` **13/13**; all `ops/*.sh`
pass `bash -n`; root `npm ci` + `vite build` green; `vitest` (no frontend specs)
exit 0; and a real `node index.mjs` boot → `/api/health` **200**, version
`0.2.29-alpha`, with **no deprecation/EBADENGINE/experimental warnings**.

**Deploy prerequisite:** the VPS must move to the Node 22 LTS line before
`ops/install-agent.sh` will run — it now refuses Node 20. **NOT yet deployed** —
v0.2.26-alpha remains the live server; v0.2.27-alpha the newest shipped code.
This slice is code + PR only.

## v0.2.28-alpha — AGENT-SEC-CASHU-LTS: maintained money-path dependency

Security-relevant money-path slice. Executes the follow-up flagged in v0.2.27:
migrate the deprecated `@cashu/cashu-ts@2.5.3` off the unmaintained line onto
the maintained **v3-lts "security-fixes-only" LTS**. Dist-tag evidence at
implementation time: `npm view @cashu/cashu-ts dist-tags` → `v3-lts: 3.7.1`
(latest is `4.7.0`; we deliberately do **not** jump to v4). Pinned per repo
convention as `"@cashu/cashu-ts": "^3.7.1"` (caret, matching the other agent
deps); lockfile regenerated with registry integrity (sha512) — the 2.5.3
`deprecated` notice is gone from the tree.

API migration (v2.5.3 → v3.7.1), inventoried against the official bundled
`lib/types/index.d.ts` + compiled `lib/cashu-ts.es.js`, adapting code only where
required:
- **Class rename (breaking):** `CashuMint` → `Mint`, `CashuWallet` → `Wallet`.
  `agent/core/wallet.mjs` import + `new Wallet(new Mint(url))` updated. `Wallet`
  still accepts a `Mint` instance (also a bare URL string).
- **`getMintInfo()` (breaking):** was `Promise<MintInfo>` (async network fetch)
  in 2.5.3; in 3.7.1 it is a **synchronous cached getter** that throws if the
  wallet has not been loaded. The boot warm-up (`await wallet.getMintInfo()`)
  is replaced by `await wallet.loadMint()`, which performs the network fetch of
  mint info + keysets + keys.
- **Lazy-load semantics:** v3 `receive()`/`send()` require `loadMint()` first
  (v2 auto-loaded). Added an idempotent `ensureLoaded()` guard before each
  money-path op — verified in source that `loadMint()` skips both network
  fetches once cached (`keyChain.init`: `if (keysets>0 && !forceRefresh) return`),
  so this restores v2's lazy load-on-demand at **zero** extra traffic once warm.
- **Unchanged (no code change):** token codec `getEncodedToken`/`getDecodedToken`
  (both default to token-v4/`cashuB` in 2.5.3 **and** 3.7.1); the `Token`
  `{ mint, proofs, unit?, memo? }` and `Proof` `{ id, amount, secret, C, ... }`
  shapes; `SendResponse` `{ keep, send }`; the `receive() → Proof[]` return.

Serialized-state compatibility (the load-bearing safety proof): a token encoded
by the **real 2.5.3 library** decodes under 3.7.1 preserving mint/unit/memo and
every proof `id`/`amount`/`secret`/`C`, and 3.7.1 **re-encodes it to the
byte-identical wire string**. On-disk `memory/wallet/*.json` (`{ mint, proofs,
updated_at }` plain JSON) survives a JSON round-trip unchanged. No re-mint, no
conversion, no network mutation, no deletion of existing state.

Tests added (offline, deterministic, no live mint / no network / no secrets
logged) — `agent/test/cashu-migration.test.js`, 8 cases: v2-era `cashuB` token
decodes under v3-lts; every critical proof field preserved; mint/unit/memo
survive; **byte-identical re-encode** of the frozen 2.5.3 fixture; encode→decode
amount preservation; proof/pending memory JSON shape unchanged; malformed and
truncated tokens fail closed **without echoing secret material**. Existing
`agent/test/wallet.test.js` guard/codec suite still green under v3.

Verification: `npm audit --omit=dev` and full `npm audit` → **0 vulnerabilities**
(0 critical / 0 high / 0 moderate / 0 low), unchanged from v0.2.27; agent
`node --test` **38/38** (was 30 + 8 new); `scripts/smoke-rate-limit.mjs` all
pass; a real `node index.mjs` boot under Node 20.20.1 comes up clean with
**no new deprecation/warning** (`/api/health` 200, Fastify 5.10.0 intact); root
`vitest` (no frontend suites) + `vite build` green; ops `nginx-install` 13/13
and `installer-signal` 9/9; all `ops/*.sh` pass `bash -n`. Production dep tree
**shrank 71 → 68** transitive packages (the cashu package itself is larger on
disk); `@fastify/*` + `fastify@5.10.0` untouched.

Runtime gate carried into handoff and **resolved in v0.2.29-alpha**: cashu-ts
3.7.1 declares `engines.node >=22.4.0` across the whole v3-lts line. For a money
path this is treated as a **hard deployment prerequisite, not an advisory** — an
`EBADENGINE` warning during `npm ci` is not an acceptable production state for a
wallet. v0.2.29 raises the agent `engines.node` floor and the installer preflight
to Node 22 LTS (see the v0.2.29 entry above). The used API surface happens to run
on Node 20.20.1, but "works today" is not "supported"; the version choice
(3.7.1) stands, only the runtime is now gated.

**NOT yet deployed** — v0.2.26-alpha remains the **live/deployed** server version
and v0.2.27-alpha the newest **shipped** code until an operator re-runs
`ops/install-agent.sh` (which now requires a Node 22 LTS host). This slice is
code + PR only.

## v0.2.27-alpha — AGENT-SEC: production dependency remediation

Security-only slice. During the live v0.2.26-alpha deploy, `npm ci --omit=dev`
in `agent/` surfaced **5 HIGH** production advisories in the Fastify dependency
tree (and the informational `@cashu/cashu-ts@2.5.3` deprecation notice).

Root cause: the whole cluster traces to `fast-uri` and Fastify itself —
- `fast-uri` path traversal via percent-encoded dot segments (GHSA-q3j6-qgpj-74h6, CWE-22, CVSS 7.5)
- `fast-uri` host confusion via percent-encoded authority delimiters (GHSA-v39h-62p7-jpjc, CWE-436, CVSS 7.5)
- `@fastify/ajv-compiler`, `fast-json-stringify`, `@fastify/fast-json-stringify-compiler` all HIGH transitively via the vulnerable `fast-uri`
- `fastify` HIGH on its own account: Content-Type tab-char body-validation bypass (GHSA-jx2c-rxcm-jvmq, CWE-436, CVSS 7.5), **no v4 backport** — fixed only in `fastify@>=5.7.2`.

Because the Fastify advisory has no v4 fix, an override on `fast-uri` alone
could not reach zero HIGH; the safe complete remediation was the Fastify v5
line. Changes:
- `agent/package.json`: `fastify ^4.28.1 → ^5.10.0`, `@fastify/cors ^9.0.1 → ^11.0.0`, `@fastify/rate-limit ^9.1.0 → ^11.0.0`; lockfile regenerated (`fast-uri` now 3.1.3 / nested 4.1.0, both patched).
- `agent/index.mjs`: removed the explicit `disableRequestLogging: false`. Passing this top-level option **at all** — even the default `false` — trips Fastify v5's `FSTDEP023` deprecation warning: the constructor guard is `if (options.disableRequestLogging !== undefined)`, not a truthiness check (verified against installed `fastify@5.10.0` `lib/warnings.js` + `fastify.js`, and reproduced live under `node --trace-deprecation`). The warning text states the top-level option "will be removed in `fastify@6`". The value only restated the default, so dropping it is a pure no-op that silences the boot warning — request logging still emits `incoming request` / `request completed`. No other app code change — the v4→v5 migration was API-transparent for this daemon (trustProxy allow-list, CORS options, rate-limit `global:false` + per-route `config.rateLimit` + `errorResponseBuilder(req, ctx.ttl)` all unchanged in the v11 plugins).
- `@cashu/cashu-ts` **held at 2.5.3**: it carries **no published npm/GHSA advisory** (absent from `npm audit`), so it does not block this HIGH-clearing hotfix. It is **not** merely a spec/maintenance deprecation, though: the registry notice steers users to `@cashu/cashu-ts@v3-lts`, described upstream as the "security-fixes-only LTS" line — implying maintained fixes that 2.5.3 will not receive. A v3-lts (3.7.1) or v4 (4.7.0) migration touches proof/token handling in the wallet money path, so it is deferred to its own slice rather than folded into a security hotfix — but it is tracked as a **security-relevant** money-path follow-up to prioritise, not cosmetic cleanup.

Tests added (offline, no live mint / no network / no secrets logged):
- `agent/test/wallet.test.js` — wallet guard + failure paths (sub-sat send, insufficient balance, malformed token, non-whitelisted mint) and a `getEncodedToken`/`getDecodedToken` `{ mint, proofs }` round-trip regression against the new lockfile.
- `agent/test/fastify-v5-api.test.js` — CORS preflight (204 + echoed origin + credentials) and the rate-limit route-config contract (429 at N+1 + `Retry-After` + numeric `context.ttl`) under fastify 5 / plugins 11.

Verification: `npm audit --omit=dev` → **0 vulnerabilities** (from 5 HIGH);
agent `node --test` 30/30; `scripts/smoke-rate-limit.mjs` all pass; root
`vitest` (no frontend suites) + `vite build` green; ops regression
`nginx-install` 13/13 and `installer-signal` 9/9; all `ops/*.sh` pass
`bash -n`.

**Not deployed by this slice.** v0.2.26-alpha remains the currently deployed
server version; picking up v0.2.27 on the VPS is a separate operator step
(re-run `ops/install-agent.sh`, which runs `npm ci --omit=dev` against the new
lockfile).

## v0.2.26-alpha — SUITE-VPS-READY-2: agent deploy tooling + first-touch admin claim

Second slice of the suite VPS-install prep. Ships the tooling to run the
agent as a hardened standalone service and removes the last manual step in
bootstrapping an operator, so a fresh box is claimable by its owner on first
sign-in. **The agent is NOT deployed by this PR** — this lands the tooling;
actually running `install-agent.sh` on a server is a separate, operator-run
step.

New ops assets:
- `ops/systemd/torii-continuum-agent.service` — runs the agent as a locked,
  non-login `continuum` system user from `/opt/torii/continuum-agent` under
  `NODE_ENV=production`. Hardened: `NoNewPrivileges`, `ProtectSystem=strict`
  (whole FS read-only to the service except `memory/` + the single
  `config.yaml` file), `PrivateTmp`/`PrivateDevices`, kernel/proc/clock
  protections, `MemoryDenyWriteExecute`, `@system-service` syscall filter,
  empty capability set, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`.
  Safe restart with a `StartLimitBurst` cap so a bad config fails the unit
  instead of crash-looping.
- `ops/nginx/torii-api.conf` — server-scoped same-origin `location /api/`
  reverse proxy to `127.0.0.1:8787`, with edge `limit_req` (30 r/s, burst 60)
  as a second rate-limit layer above the in-process Fastify limiter. The
  `limit_req_zone` (http context) is documented + shipped separately to
  `/etc/nginx/conf.d/`. Correct client-IP passthrough (`X-Real-IP`) for the
  agent's bucket key.
- `ops/install-agent.sh` — idempotent, strict-mode installer: root check +
  dependency preflight, locked system user, `rsync --delete` of code that
  never clobbers `memory/`/`pending/`/`ciphertexts/`/`config.yaml`,
  `npm ci --omit=dev`, one-time `config.yaml` generation with a fresh
  `openssl rand -hex 32` `session_secret` (0600, never echoed), config
  validation before restart, systemd + nginx wiring (`nginx -t` before any
  reload, refuses to redeclare an existing zone), and a bounded
  `/api/health` liveness proof.
- `ops/README.md` — refreshed with an authoritative standalone-install
  runbook (prereqs, install/upgrade, config, nginx contexts, first-touch
  claim, service management, security model, rollback/uninstall,
  troubleshooting).

First-touch admin bootstrap (`agent/core/auth.mjs`, `agent/core/config.mjs`,
`agent/index.mjs`):
- If `admin_npub` is empty, the agent boots **unclaimed**. The first caller
  to pass a valid NIP-07 challenge/verify atomically claims admin: their
  npub is persisted to `config.yaml` (canonical `npub1…`, 0600) and every
  later non-matching caller is rejected. Configured-admin behaviour is
  unchanged.
- Race-safe (in-flight promise guard → exactly one of two concurrent first
  verifies wins, no double-persist) and **fails closed**: if the config
  write throws, no session token is issued and the box stays claimable.
- Persistence is injected (`deps.persistAdmin`) so `createAuth` stays a pure
  unit under test; `persistAdminNpub()` lives in `config.mjs`, does an
  in-place `0600` rewrite that preserves comments/other keys, re-parses the
  result as a YAML sanity check, and refuses a malformed npub (injection
  guard).
- Logging stays prefix-only — never full pubkeys/challenges/IPs, never the
  session secret. `/api/health` now reports `admin_claimed`.

Tests: 13 agent unit tests via `node --test` — first-touch success + single
persist, restart honours persisted admin (no re-persist), second/different
caller rejected, configured-admin matching/stranger/never-persist, bad
signature no claim, wrong-kind no claim, concurrent race one-winner,
persistence-failure fail-closed, no-persister fail-closed, plus four
`persistAdminNpub` temp-tree tests (replace empty/set/insert/refuse
malformed). Installer passes `bash -n`; `nginx -t`/`systemd-analyze` are
environment-gated (tools absent in CI) and validated by the installer at
deploy time.

## v0.2.25-alpha - onboarding preview v0.1.11-preview (fix reload stall)

Operator reported browser refresh left Chiefmonkey invisible.
Root cause: `<link rel=preload as=fetch crossorigin>` for same-origin
assets uses CORS credentials mode but GLTFLoader/DRACOLoader fetch
without CORS. On reload the cached preload could not be matched
to the actual request and stalled.

Fixes:
- Dropped `crossorigin` from same-origin preload hints (glb, wasm).
  Added `type` attributes for accurate matching.
- Removed modulepreload for GLTFLoader/DRACOLoader (bare `three`
  specifier probes before the importmap resolves, printing a
  harmless but noisy error).
- Added 8s load watchdog with cache-bust retry so a stalled load
  never leaves the user with an empty stage.

Local: first 1.29s, reload 1 270ms, reload 2 113ms, reload 3 60ms.

VERSION 0.1.11-preview. sha256 5b956052c915f45bdd8486bc721f92cb3e1dacac7663c51e5419ddfcedfee54b.

## v0.2.24-alpha - onboarding preview v0.1.10-preview (Draco wasm + shader precompile)

Operator reported Chiefmonkey still lagged ~10s after v0.1.9. Two more
culprits fixed:
1. Draco was configured `type: 'js'` - the slow pure-JS decoder.
   Switched to `wasm` and added `draco.preload()` so the wasm module
   is instantiated before the GLB arrives.
2. First render triggered synchronous shader compilation. Added
   `renderer.compile(scene, camera)` before the opacity fade so the
   pipelines are warm.
Fade shortened 900ms -> 400ms.

Local render 1.85s -> 1.31s. Bigger gain expected on slow networks
because wasm decode is 3-10x faster than JS decode.

VERSION 0.1.10-preview. sha256 db0f7cab6d3d73d74c256e9599853a126d25802229c343f1ae48e818ff2b6654.

## v0.2.23-alpha - onboarding preview v0.1.9-preview (fast load)

Operator reported the scene painted in 3 chunks and Chiefmonkey took
30s to appear. Two root causes fixed:

1. Scene PNGs 3MB x 5 = 14.5MB, progressive-decoded. Converted to WebP
   q82 -> 1.3MB total (91% smaller).
2. Character load was fully serial: three.module.js (1.3MB) -> GLTFLoader
   -> DRACOLoader -> draco_decoder.wasm -> chiefmonkey6.glb. Added
   `<link rel=preload>` (as=fetch) for glb + wasm and `modulepreload`
   for three.module + loaders + character.js so everything fetches in
   parallel with HTML parse.
3. Fontshare stylesheet moved to media="print" onload=media="all" swap
   so it doesn't block first paint.

Tarball dropped from 15MB to 2.7MB. Local render measures ~1.9s
(canvas opacity >0.5, i.e. character visible).

VERSION 0.1.9-preview. sha256 744ef4003e76f2df5cd763601eebec80601659d21249e16754b7b5c103df3305.

## v0.2.22-alpha - onboarding preview v0.1.8-preview (recenter character)

Operator felt Chiefmonkey was too far left after v0.1.7. Nudged
CHAR_X_DESKTOP from -0.9 to -0.5 so he lands in the left third with
breathing room to both sides.

VERSION 0.1.8-preview. sha256 bb36aa7928b176b859519ef6623305e714626df0cba4984e411a2367ec6e69d2.

## v0.2.21-alpha - onboarding preview v0.1.7-preview (canvas full viewport)

Operator flagged that Chiefmonkey's hand vanished off the right side of
the character during the step-1 stretch pose. Root cause: `#character`
canvas was `width: 50vw`, so any pose extending past 720px on a 1440px
viewport got clipped at the canvas boundary - looking like a hand
disappearing "behind the panel".

Fix:
- `#character` canvas widened to 100vw
- `CHAR_X_DESKTOP = -0.9` in character.js keeps him in the left third
- `.panel { z-index: 5 }` so a swinging arm is correctly occluded by UI,
  not by an invisible canvas edge
- `resize()` re-anchors the base x on orientation flips

VERSION 0.1.7-preview. sha256 bdf01ae2021648f2350f378fb03ca9cf12648fa784e7b5feb86c480e8dac7a9e.

## v0.2.20-alpha - onboarding preview v0.1.6-preview (main page opaque fix)

v0.1.5 patched only `/inspect/inspector.js`. Operator confirmed the main
`/onboarding-preview/` page still showed the broken character - that page
uses `character.js`, which had the same missing opaque-material patch.

Same 4-line fix now applied there:
- `material.transparent = false`
- `material.depthWrite = true`
- `material.alphaTest = 0`
- `mesh.frustumCulled = false`

VERSION 0.1.6-preview. sha256 09457399e0ea040390ebc9c73a877a50f0b856674ff10f933bdcb501b5a1f93a.

## v0.2.19-alpha - onboarding preview v0.1.5-preview (opaque materials fix)

Root cause found for the 19/19 flagged clips. Chiefmonkey6.glb ships with
`alphaMode:BLEND` on the skinned meshes. Torii Quest patches this on load
(`src/napNpc.js` v0.2.111): sets `transparent=false`, `depthWrite=true`,
`alphaTest=0` and `frustumCulled=false`. Without those overrides, the
transparent pipeline draws faces out of order and the mesh appears to
disintegrate - which is exactly what the operator saw on every clip.

The v0.1.4 inspector didn't have this patch. v0.1.5 adopts the exact same
block from `napNpc.js`. Character now renders opaque and intact across all
clips.

Onboarding preview `VERSION` bumped to `0.1.5-preview`. Tarball at
`preview-assets/releases/torii-continuum-onboarding-preview-v0.1.5.tar.gz`
(sha256 `b3e3a084ef6630bab5199acfec0bb8d688b789eb9309a9388ef30cba84e6ce12`).

QA: Playwright at 1440x900, Hit_Reaction_to_Waist clip - character renders
whole, no arm shredding, no floating cuffs, tail visible, hands connect to
wrists.

Next: operator re-audits the 19 clips against the corrected renderer to see
which (if any) clips still have real animation issues vs. the material bug.

## v0.2.18-alpha - onboarding preview v0.1.4-preview (clip inspector)

New `/inspect/` diagnostic page for auditing all 19 GLB animation clips one by
one. First step of fixing the glitching + limb-through-body issues observed on
Chiefmonkey during onboarding. Rather than guess, we look.

Inspector delta:

- New page at `/onboarding-preview/inspect/` with an ordered list of every clip
  discovered in `chiefmonkey6.glb` (uses `gltf.animations` directly, no
  hard-coded names to drift)
- Neutral scene: grid floor at y=0, 3-light setup (ambient + key + fill), pink
  cone marker on +Z axis so orientation is unambiguous
- Camera: distance / height / orbit yaw sliders, plus mouse-drag orbit and
  wheel zoom (sliders update on drag, drag updates on sliders)
- Playback speed 0.1x to 2.0x (`AnimationAction.setEffectiveTimeScale`)
- Per-clip verdict: Keep / Flag, icon shown next to clip name, persisted in
  `localStorage['continuum.clipVerdicts.v1']`
- Copy report button dumps markdown to clipboard: KEEP / FLAG / Not audited
- Desktop-only (reuses the v0.1.3 mobile gate)
- Reuses parent `three-libs/` via `..` importmap paths - no dependency
  duplication

Onboarding preview `VERSION` bumped to `0.1.4-preview`. Repo tarball at
`preview-assets/releases/torii-continuum-onboarding-preview-v0.1.4.tar.gz`
(sha256 `9d221744a21986d510f17a7df01354170b8fbcd167b47ac186ca4ba077116b30`,
~15 MB).

QA:

- Playwright at 1440x900: page loads, all 19 clips enumerated correctly
  (Crouch_Walk..., FunnyDancing_02, Hit_Reaction_to_Waist, Idle_03,
  Jump_Over_Obstacle_1/2, Knock_Down, Run_and_Shoot, Running_Reload_inplace,
  Running, Shot_and_Blown_Back, Standard_Forward_Charge_inplace,
  Stylish_Walk_inplace, Walk_Backward_inplace, Walk_Left_with_Gun_inplace,
  Walk_Turn_Left/Right, Walking, idle_to_push_up).
- Character renders full-body at default distance/height, +Z marker visible,
  Keep click updates flag icon to ok green, Flag click updates to red.
- Copy report generates a well-formed KEEP/FLAG/Not-audited markdown block.

Next: user audits the 19 clips, then we apply Three.js-side workarounds
(bone masking, clip range cropping, weight cleanup) for the flagged ones.

## v0.2.17-alpha - onboarding preview v0.1.3-preview (desktop-only gate)

Continuum onboarding is a desktop-only flow (Torii VPS setup + a desktop-only game
launch). Rather than fight iOS WebGL quirks for a use case that does not exist,
small screens and coarse-pointer devices are now blocked at the door with a
friendly notice pointing them at a laptop.

Onboarding preview delta:

- Added desktop-only gate: `matchMedia('(max-width: 899px)')` or
  `matchMedia('(pointer: coarse)')` sets `data-desktop-only="blocked"` on
  `<html>` before any scripts load. Three.js, GLTFLoader, DRACOLoader, and the
  Chiefmonkey GLB are never fetched on mobile - respects data allowance,
  battery, and iOS WebGL cost.
- Splash copy: "Continuum onboarding is desktop-only. Setting up your Torii and
  stepping into the world both need a keyboard and a bigger screen. Open this
  link on a laptop or desktop to begin."
- Reverted the v0.1.2 in-browser diagnostic overlay experiment; character.js
  is back to the clean v0.1.1 baseline.
- Self-hosted Three.js retained from v0.1.1 (privacy standing rule).
- Onboarding preview `VERSION` bumped to `0.1.3-preview` (0.1.2 was diagnostic
  only, never deployed).
- Repo tarball at `preview-assets/releases/torii-continuum-onboarding-preview-v0.1.3.tar.gz`
  (sha256 `29fe758120308cdc7d32ca6487e1a97152e4f90667a518e6ba9e5e9e73306872`).

VPS deploy from tarball -> new dated release dir under
`/var/www/torii/onboarding-preview-releases/` -> atomic symlink flip on
`/var/www/torii/onboarding-preview`. Registry `version` bumped to
`0.1.3-preview`. No nginx reload needed (fragment points at the symlink).

QA:

- Playwright at 390x844 mobile viewport: gate splash renders, ZERO requests
  to `three-libs/*`, `character.js`, `deck.js`, or the GLB. Confirmed via
  request interceptor.
- Playwright at 1440x900 desktop viewport: full onboarding still renders,
  panel-current at step 1, painterly backdrop + frosted panel + amber CTA
  all intact.

## v0.2.14-alpha — SUITE-VPS-READY-1 (Continuum PR slice): rate-limit auth surface + bounded challenges Map + structured [auth] logs

First code slice of the suite v0.6.0-alpha VPS-install prep. Hardens the two public endpoints that a scanner will hit first — `/api/auth/challenge` and `/api/auth/verify` — without touching the admin surface. Also swaps the previously-unbounded in-memory challenges Map for a hard-capped, LRU-by-expiry structure so a challenge flood can no longer OOM the agent.

- `agent/package.json` — added `@fastify/rate-limit: ^9.1.0` (v9 major matches the pinned `fastify@^4.28.1`). No other deps touched. Version 0.2.13-alpha → 0.2.14-alpha. Root `package.json` bumped in lockstep.
- `agent/core/auth.mjs` — rewritten around a bounded `Map` with a resolved `MAX_CHALLENGES` (default 1000, source `cfg.rate_limit.max_challenges`). New signature is `createAuth(cfg, deps)` where `deps.log` is Fastify's pino instance; falls back to a console shim if omitted so tests can drive it without a full app. Overshoot eviction sweeps the oldest N entries by `expiresAt` and emits a single `auth.challenge.evicted` warning line. Expired-challenge and admin-not-matched paths now emit `auth.verify.fail` with a stable `reason` enum (`expired|notfound|badsig|notadmin|malformed_event|wrong_kind`). Success path emits `auth.verify.success`. All log objects carry `ip_prefix` (12 chars), `pubkey_prefix`/`challenge_prefix` (8 chars) only — never the full value. Adds `_challenges`, `_maxChallenges`, `_adminHex` on the returned object as read-only test hooks.
- `agent/index.mjs` — registers `@fastify/rate-limit` with `global: false` (routes opt in) and a `keyGenerator` that pins the bucket to `req.ip`. Two route-scoped configs: `/api/auth/challenge` at `auth_challenge_per_min` (default 10) and `/api/auth/verify` at `auth_verify_per_min` (default 20). Both use a custom `errorResponseBuilder` that (a) emits `auth.ratelimited` with route + ip_prefix + max + remaining_ms and (b) returns `{ ok:false, reason:"rate_limited", retry_after_sec }` alongside the standard `Retry-After` header. `cfg.rate_limit.enabled: false` skips the plugin registration and the per-route configs become inert (dev only). The old ad-hoc `[auth]` log-string warnings on the routes are gone — the structured events live inside `auth.mjs` now, single source of truth.
- `agent/core/config.mjs` — optional-defaults block now populates `cfg.rate_limit` when absent (`enabled: true`, `auth_challenge_per_min: 10`, `auth_verify_per_min: 20`, `max_challenges: 1000`). Existing v0.5.0-alpha installs pick up the defaults without editing `config.yaml`.
- `agent/config.example.yaml` — new `rate_limit:` block with commented defaults, log-taxonomy reference, and the dev-only disable path.
- `agent/README.md` §10 — stamp bumped to v0.2.14-alpha, `POST /api/auth/challenge|verify` rows now note the rate limit, response shape + `Retry-After` shown, structured log taxonomy documented, and the tune/disable snippet included.
- `agent/scripts/smoke-rate-limit.mjs` — new. Boots a Fastify instance in-process against `auth.mjs` and drives 5 test scenarios: (T1) `/challenge` ×10 all 200, #11 = 429 with `Retry-After`, `auth.ratelimited` logs emitted; (T2) `/verify` ×20 no 429, #21 = 429; (T3) 10 issues against a `max_challenges: 5` cap leaves the Map at 5 and emits `auth.challenge.evicted` logs; (T4) `rate_limit.enabled: false` accepts 15/15; (T5) `auth.challenge.issued` and `auth.verify.fail` structured lines present with no full pubkey/challenge in the log body. All 5 pass.
- Follow-up (separate suite PR, tracked in `torii-suite-v0.6-plan.md` items G–P): systemd unit, nginx `/mp` fragment, arena-ws install stage, MP smoke, `nginx configtest` guardrail, Ubuntu 26 INFO note.

Security posture: pubkeys, challenges, and IPs are never logged in full; only prefixes reach the journal. The rate-limit plugin's default in-memory store is local-only (no Redis, no cross-node leakage). Under v0.6.0-alpha's single-VPS install this is the right shape; if we ever go multi-agent we'd add a Redis store or a shared-nothing sharding strategy.

## v0.2.13-alpha — CONT-HEALTH-1: dashboard provider reachability card

First real feature slice after the v0.2.7 → v0.2.12 docs sweep. Wires the previously-inert "provider ready" area of the dashboard to the live `/api/health/models` endpoint.

- `src/views/dashboard.js` — new `ProviderCard()` renders under the KPI strip. Polls `/api/health/models` every 20s while `#/dashboard` is mounted; a self-removing `hashchange` listener + `isConnected` guards on every tick guarantee no timer leaks after navigation. Client-side round-trip latency (`performance.now()` bracket) is shown alongside the strategy and agent version so slow responses are visible.
- Three states per provider: `Enabled` (Routstr — no server-side reachability probe yet, so we show enablement honestly rather than fake a green light), `Reachable`/`Unreachable` (Ollama — endpoint probes actual reachability), `Disabled` (not enabled in config). Uses the existing `.pill.ok`/`.pill.danger`/`.pill` classes from `theme.css`.
- Two graceful-degradation states: `VITE_AGENT_URL` empty (demo build) shows an explainer instead of hammering a URL that doesn't exist; logged-out user sees a sign-in prompt because the endpoint is admin-gated.
- `src/data/agent.js` — added `healthModels()` client (single-line wrapper over the shared `req()` helper; inherits offline / 401 / network-fail envelopes).
- `src/styles/pages.css` — six new rules for the card layout, all scoped to `.provider-card*` and `.provider-row` so nothing else can regress. Uses the same token palette (`--border`, `--muted-foreground`, `--font-mono`, `--foreground`) already in use across the app.

Bonus fixes on the way through (all three killed stale `0.2.6-alpha` markers):
- `agent/index.mjs` — both `/api/health` and `/api/health/models` were reporting a hardcoded `0.2.6-alpha` version string that had been stale since v0.2.6. Replaced with a boot-time read of `agent/package.json`. Now every release surfaces the correct version through the health endpoints without another manual bump.
- `src/views/landing.js` + `vite.config.js` — the landing-page eyebrow said `Torii Continuum · v0.2.6-alpha`. Now baked in at build time via a Vite `define` (`__APP_VERSION__` read from `package.json`), so the eyebrow always matches the shipped release.
- `ops/README.md` — the example `/api/health` response payload also carried the stale hardcoded version. Reworded to describe the field generically (`<agent-version>`) so no future release is ever wrong here.

Doc-plus-tiny-feature. `npm run build` clean. No third-party dependencies added. Bundle grew from 57.63 kB to 60.01 kB (+2.4 kB ≈ the new ProviderCard + CSS).

## v0.2.12-alpha — finish Space-scoped file naming migration

Rename the last two docs to match the Space convention.

- `strategy.md` → `torii-continuum-strategy.md`.
- `continuum-todo.md` → `torii-continuum-todo.md`.
- New: `torii-continuum-progress.md` (this file).
- Updated in-file cross-references in strategy, todo, handoff, and any code that mentioned the old paths.

The v0.2.9 rename covered `HANDOVER.md → torii-continuum-handoff.md`. This slice finishes the migration so all four Space-scoped source-of-truth files are named consistently.

Doc-only change. `npm run build` clean, unchanged bundle.

## v0.2.11-alpha — refresh `torii-continuum-handoff.md`

Handoff drifted through v0.2.7 → v0.2.10 without a substantive edit. Refreshed:

- Version header v0.2.9 → v0.2.11 + new "Active focus" paragraph.
- "Recent commits" block rewritten to cover the v0.2.1 → v0.2.10 arc.
- "Space context" section rewritten to reference the four Space-scoped source-of-truth files instead of Quest artifacts (`NOSTR_ARENA_MASTER_TODO.md`, `Strategy-&-Next-Steps.md`) that had leaked in — a standing-rule-#1 (never cross-name) violation hiding in the onboarding doc.
- "Next likely tasks" rewritten to reflect the post-agent / post-base-path / post-Ollama-fallback backlog rather than the v0.1.0-era items.
- Fixed a stale `v0.2.9-alpha` marker at `agent/README.md §10`.

Doc-only. Build clean, 57.63 kB main chunk unchanged.

## v0.2.10-alpha — scrub local-machine class mentions from docs

Docs contained references to specific local machine classes. Standing rule #4 forbids publishing device names, hostnames, or local machine identifiers to GitHub. Removed.

## v0.2.9-alpha — rename `HANDOVER.md` → `torii-continuum-handoff.md`

Matched the Space convention for source-of-truth files (`torii-continuum-{strategy,todo,progress,handoff}.md`).

## v0.2.8-alpha — cross-name audit

Cleaned up stale Torii Quest references that had leaked into Continuum docs during the pre-split period. Standing rule #1: each Torii app lives in a fully separate repo; files carry ONLY that repo's project name.

## v0.2.7-alpha — mirror standing operating rules into handoff

Codified the four standing rules (separate repos, bump every change, PR to main, no personal identifiers) plus the privacy-before-efficiency-before-80/20 priority hierarchy directly into the handoff so a resuming session sees them without having to reload memory.

## v0.2.6-alpha — CONT-INSTALLER-1 + CONT-AGENT-1b

- Base-path awareness in `vite.config.js` (`base: "./"`) so Continuum works both standalone at `continuum-torii.pplx.app` and mounted at `/continuum` by torii-base.
- Ollama fallback ladder in `agent/core/model-router.mjs` — strategies `routstr-first` (default), `ollama-first`, `ollama-only`, `routstr-only`. `provider` field on every return.

## v0.2.5-alpha — panic key: make kind 30097 explicitly optional

The panic-key event kind is optional and the client must not require it.

## v0.2.4-alpha — CONT-CHARACTER-1

Sealed character + memory infrastructure.

## v0.2.3-alpha — ornate Myōjin torii SVG

Custom SVG logo replacing the placeholder.

## v0.2.2-alpha — new H1 "The Gateway Project."

Landing page copy update.

## v0.2.1-alpha — dark default + security hardening

Made dark the canonical theme (never ship a light-default build). Session cookie `__Host-` prefix requirement documented.

## v0.2.0-alpha — CONT-AGENT-1 invariants + landing

First agent scaffold: `agent/` Fastify daemon, NIP-07 challenge/verify, HMAC-signed session tokens, Cashu wallet on VPS (`@cashu/cashu-ts` v2), Routstr chat client, first `chat` skill. Frontend integrations: landing page at `#/`, sidebar Login button, chat dock routes through `/api/chat` when signed in.

See `torii-continuum-v0.2.0-cont-agent-1-report.md` for the full slice narration.

## v0.1.0 (pre-split)

- Split planning: Continuum owns its own strategy and todo files (separate from Quest).
- Amber/gold torii favicon on warm bronze tile.
- Bronze/amber aesthetic to match continuum.pplx.app.
- Continuum app builder MVP.

---

## v0.2.15-alpha - Onboarding preview v0.1.0 landed

Five-panel graphic-novel onboarding sequence added under
`preview-assets/onboarding-v0.1.0/`. Painterly backdrops, live
Three.js Chiefmonkey render with per-step camera framing and
animation cross-fade, frosted-glass bottom-sheet on mobile.

Self-hosted Draco decoder at `three-libs/draco/` (756 KB) so the
character render has zero third-party runtime CDN dependency.

Tarball + sha256 attached under `preview-assets/releases/` for scp
deploy to your gateway host under `/var/www/torii/continuum/onboarding-preview/`.

Design review only - not built into the production app. Real
integration lands in v0.9.0-alpha.
