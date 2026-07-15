# Continuum

An app builder, project engine and marketplace for bot work — a gateway into the Torii ecosystem.

Continuum treats every project like a nostr identity: portable, signable, yours. Projects, sessions, milestones, todos, and files are all shaped as nostr events (addressable kinds 30078–30082). MVP stores them in `localStorage`; the same objects flip to signed relay events without re-shaping.

## What's here (v0.2.0-alpha)

**Frontend (`src/`)**

- **Application-first root** at `#/` — logged out, root renders a dedicated branded Amber **login page** in place (NIP-07 / Plebeian Signer, no password auth, no secrets in the DOM); logged in (valid `continuum.session.v1`, or a safely-adopted onboarding session), root routes straight to `#/dashboard`. Routing/auth decisions live in the pure `src/nav-guard.js`; `#/dashboard` is guarded and expired/invalid sessions return to login without a loop.
- **About / Discover** at `#/about` — the marketing surface (sovereignty story, torii-arch hero, promises grid, freedom-tech pillars, live status roadmap) now isolated behind an explicit route, reachable from small non-primary links on the login page. Never the app root or an onboarding completion target.
- **Projects** — list, create, open. Import from GitHub or ngit. Cascades to sessions/milestones/todos/files.
- **Project home** — milestones ladder, session log, live todo list, files created. A per-project **Overview · Board** view switcher lives in the header.
- **Kanban board** — every project ships a board (default columns **Todo · Doing · Done**) at `#/projects/:slug/board`. Add/rename/reorder/delete custom columns (deleting a non-empty column forces a card move — cards are never lost), create/edit/delete cards (title, description, optional assignee + due date), and move cards by drag **or** accessible arrow controls for keyboard/touch. State is per-project, persisted, and Nostr-shaped (kinds 30083/30084).
- **Marketplace** — open AI-work tasks. Yours highlighted amber.
- **Routstr** — real Cashu wallet top-up when an agent is configured; mock behaviour on demo builds. Default coding model: DeepSeek-Coder-V2. Default chat model: DeepSeek Chat.
- **Dashboard** — cross-project oversight rundown.
- **AI chat dock** — routes through your agent (POST /api/chat) when signed in; falls back to mock replies otherwise.
- **NIP-07 login** — sidebar button opens a Plebeian Signer flow, signs a kind 22242 challenge, and stores the returned session token locally.

**Agent (`agent/`, Node 22 LTS >= 22.4.0 + Fastify)**

A small daemon designed for one operator, one VPS, one npub. Owns:

- NIP-07 login verification (no nsec ever touches the VPS)
- Cashu wallet float on disk (`memory/wallet/`, mode 0600)
- Routstr chat calls (OpenAI-compat, DeepSeek-Chat by default, DeepSeek-Coder-V2 for coding, configurable fallback ladder, one Cashu token per request)

See `agent/README.md` for the VPS bring-up runbook and `agent/PRIVACY.md` for the invariants.

## Data shape (draft, not a NIP)

| Kind    | Purpose                          | `d` tag                    |
| ------- | -------------------------------- | -------------------------- |
| 30078   | Project                          | `<slug>`                   |
| 30079   | Session                          | `<slug>:<session-id>`      |
| 30080   | Milestone                        | `<slug>:m<index>`          |
| 30081   | Todo                             | `<slug>:<todo-id>`         |
| 30082   | File reference                   | `<slug>:<path>`            |
| 30083   | Board column                     | `<slug>:col:<column-id>`   |
| 30084   | Board card                       | `<slug>:card:<card-id>`    |
| 30090   | Marketplace task listing         | task id                    |
| 30091   | Routstr wallet + prefs           | `default`                  |

## Dev

```bash
npm install
npm run dev       # http://127.0.0.1:5180
npm run build     # → dist/
npm run preview   # serve dist/
```

## Roadmap

- M1 ✅ App shell + navigation
- M2 ✅ Projects + project home
- M3 ✅ Routstr + marketplace shells
- M4 ✅ NIP-07 signer, agent scaffold, landing page (v0.2.0-alpha)
- M5  Local Ollama fallback, brain.write + todo.patch skills
- M6  Nostr event publishing (gift-wrap-only), own relay + sync

## Related

- [Torii Quest](https://torii-quest.pplx.app) — the open-world arena shooter and Continuum's first surface.
