# Continuum — Session Handover

**Current version:** v0.2.9-alpha

Paste this whole block at the start of a new Perplexity Computer session to resume work seamlessly.

---

## Standing operating rules (project-wide, across all Torii repos)

1. Each Torii app lives in a fully separate GitHub repo (`torii-quest`, `torii-continuum`, `torii-de`, `torii-base`, `torii-suite`); files carry ONLY that repo's project name — Continuum files say "continuum", Quest files say "quest", DE files say "de". Never cross-name.
2. Bump the version on EVERY change without exception — including doc-only changes, comment tweaks, filename renames, and typo fixes. There is no "too small to bump" change.
3. Push everything to GitHub immediately via a PR that lands on `main`. No local-only work.
4. Never publish device names, hostnames, or local machine identifiers to GitHub (commits, PR titles, PR bodies, code, docs). Use generic terms like "your local machine".

---

## Project

- **Name:** Continuum — a local-first project engine + marketplace shell for Torii Quest and related nostr-shaped work.
- **Repo:** `ChiefmonkeyArt/torii-continuum` on the Perplexity git proxy.
- **Local workspace path:** `/home/user/workspace/torii-continuum`
- **Live URL:** https://continuum-torii.pplx.app
- **Publish site_id:** `00acfee3-6cd6-477f-8d0f-36f84a6f6963`  ← ALWAYS pass this on publish updates
- **Publish app_slug:** `continuum-torii`
- **App asset_id (Perplexity preview):** `c82245ab-ac3c-4283-847b-f0e604adde1d`
- **Visibility settings URL:** https://www.perplexity.ai/computer/a/c82245ab-ac3c-4283-847b-f0e604adde1d?open-publish=true
- **Old (legacy) URL still up separately:** https://continuum.pplx.app — read-only oversight surface from earlier build, unrelated to this app's publish chain.

## Stack

- **Frontend:** Vite (dev + build), Vitest (tests). Vanilla JS SPA + hash router. Static bundle. LocalStorage for theme + nostr-shaped events + session token.
- **Agent (`agent/`, v0.2.0-alpha+):** Node 20 + Fastify (`fastify@^4.28.1`), `nostr-tools@^2.7.2` for NIP-07 verify, `@cashu/cashu-ts@^2.1.0` for the Cashu wallet, `yaml@^2.5.1` for config. Runs as a systemd service on the operator's VPS. Frontend points at it via `VITE_AGENT_URL` (build-time) or `window.__CONTINUUM_AGENT_URL__` (runtime). Demo build on pplx.app intentionally omits this so it stays offline/mock.
- Auth: NIP-07 challenge (kind 22242) verified server-side, session token is `iat.exp.pk.hmacSig` HMAC-SHA256, 24h TTL.

## Design system (matches https://continuum.pplx.app aesthetic)

- **Palette (dark, HSL space-separated so alpha ops work):**
  - `--background: 30 12% 8%`
  - `--foreground: 40 16% 93%`
  - `--card: 32 10% 12%` / `--card-border: 32 10% 20%`
  - `--primary: 38 92% 58%` (amber)
  - `--muted-foreground: 38 8% 62%`
  - `--sidebar: 30 12% 10%` / `--sidebar-accent: 32 10% 18%`
- **Palette (light):**
  - `--background: 40 33% 97%`
  - `--foreground: 36 14% 13%`
  - `--primary: 36 92% 46%` (deeper amber)
- **Fonts (loaded in `index.html`):**
  - Display: Cabinet Grotesk (Fontshare)
  - Body: Satoshi (Fontshare)
  - Mono: JetBrains Mono (Google Fonts)
- **Radius:** `0.75rem`
- **Theme toggle:** sun/moon SVG in sidebar; respects `prefers-color-scheme`.

## File map

- `index.html` — Fontshare + Google Fonts preconnect + stylesheets, `theme-color="#1a1613"`.
- `src/main.js` — bootstrap.
- `src/shell.js` — sidebar, theme toggle, footer note ("Local-first…").
- `src/router.js` — hash router.
- `src/views/projects.js` — Projects list.
- `src/views/projectHome.js` — single project page (milestones + todos).
- `src/views/marketplace.js` — bounty rows, "ours" highlighting.
- `src/views/dashboard.js` — oversight cards + by-project progress.
- `src/views/routstr.js` — Routstr AI model picker + Cashu wallet mock.
- `src/data/{schema,store,seed}.js` — mock nostr-shaped event store.
- `src/styles/theme.css` — HSL tokens, both themes.
- `src/styles/layout.css` — sidebar + page-header (amber eyebrow + display title).
- `src/styles/pages.css` — cards, milestones, todos, marketplace rows.
- `src/styles/chat.css` — bottom chat dock (mock).

## Build + deploy commands

```bash
# Local dev
cd /home/user/workspace/torii-continuum
npm ci
npm run dev            # vite dev server
npm test               # vitest

# Production build
npm run build          # outputs to /home/user/workspace/torii-continuum/dist

# Preview deploy (thread-attached app card)
pplx-tool deploy_website <<'JSON'
{
  "project_path": "/home/user/workspace/torii-continuum/dist",
  "site_name": "Continuum",
  "entry_point": "index.html",
  "should_validate": true
}
JSON
# api_credentials=["pplx-tool:deploy_website"]

# Publish update to live URL (ALWAYS pass site_id — no subdomain picker)
pplx-tool publish_website <<'JSON'
{
  "project_path": "/home/user/workspace/torii-continuum",
  "dist_path": "/home/user/workspace/torii-continuum/dist",
  "app_name": "Continuum",
  "site_id": "00acfee3-6cd6-477f-8d0f-36f84a6f6963"
}
JSON
# api_credentials=["pplx-tool:publish_website"]

# Commit + push
cd /home/user/workspace/torii-continuum && \
  git add -A && \
  git -c user.email=chiefmonkey@hodlr.rocks -c user.name="Chiefmonkey" \
    commit -m "…" && \
  git push origin main
# api_credentials=["github"]
```

## Publishing rules to remember

- **Preview vs publish:** `deploy_website` is the thread-attached preview (safe, unlimited). `publish_website` updates the live `continuum-torii.pplx.app` URL — do it only when the user asks.
- **Always pass `site_id`** on updates. Without it, the tool shows a subdomain picker and can create a duplicate site.
- **Order matters:** `deploy_website` must be called first with the same `dist_path` before `publish_website` in the same session.
- **Security review required before every publish:** run a subagent with `/home/user/workspace/skills/website-building/website-publishing/security_subagent_prompt.md` and pass BLOCK findings back to the user.
- **Published-site limits:** no `api_credentials`, no LLM APIs, no external tool connectors at runtime. This app is static-only so unaffected.
- **Do not use `publish_website` to unpublish.** If user asks to unpublish, direct them to the app card's Unpublish button.

## Git state (as of handover)

- Branch: `main`
- Remote: `https://git-agent-proxy.perplexity.ai/ChiefmonkeyArt/torii-continuum.git`
- Recent commits:
  - `56107da` feat(design): match continuum.pplx.app bronze/amber aesthetic
  - `480b891` feat(design): adopt original Torii Continuum oversight aesthetic + light theme
  - `5969c41` fix(build): relative base so assets resolve under proxy prefixes
  - `0baf451` feat(v0.1.0): Continuum app builder MVP
  - `2e1664a` Initial commit

## Related projects (for cross-linking)

- `ChiefmonkeyArt/torii-quest` — the Three.js/Rapier arena shooter. Live at `torii-quest.pplx.app`. Separate repo, separate publish chain, separate release cadence.
- `torii-quest`'s dashboard source module (renamed to `toriiQuestDashboardData.js` in Quest v0.2.351) — the legacy source of the bronze/amber aesthetic that was ported here.

## Space context

- Perplexity Space: **Torii** (canonical URL `https://www.perplexity.ai/spaces/torii-8qN21IWsQ7.yuEGH9oNihw`).
- Space instructions: use `NOSTR_ARENA_MASTER_TODO.md` as truth for tasks and `Strategy-&-Next-Steps.md` for strategy. Always optimize for efficiency, security, size, speed.

## Next likely tasks (from prior turns)

- Wire NIP-07 signer + publish events to a real nostr relay.
- Replace mock chat responses with a real LLM route (Routstr / Cashu).
- Add project creation flow (blank / GitHub / ngit).
- Persist store to IndexedDB (currently in-memory + localStorage seed).
- User's stated intent: self-host eventually; use `continuum-torii.pplx.app` until then.

## User preferences (confirmed)

- Loves the bronze/amber aesthetic of `continuum.pplx.app` — this app must match it.
- Wants both light AND dark themes.
- Local-first + nostr from day one.
- Optimize for efficiency, security, file size, and speed.
- Terminology: never say "scrape/crawl"; prefer "collect/gather/read".
- Uses ZorinOS + Comet on their primary local machine; a secondary local machine is available in `<devices>` for browser tasks.

## Resume checklist for the new session

1. Confirm the URL is still live: `curl -sI https://continuum-torii.pplx.app | head -1`
2. Pull latest: `cd /home/user/workspace/torii-continuum && git pull origin main`
3. Read this file first, then check `src/data/store.js` and `src/router.js` for structure.
4. For any publish, use `site_id: "00acfee3-6cd6-477f-8d0f-36f84a6f6963"`.
