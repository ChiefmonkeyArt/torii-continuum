# Torii Continuum — Master TODO

> Torii Continuum is a **separate app** from Torii Quest. Continuum is the sovereign dashboard / project engine / personal AI. Quest is the game.

> This file is the **active task list and source of truth for Torii Continuum**. Update it whenever Continuum tasks are added, changed, completed, removed, or reprioritised.

> Continuum docs (this repo): `strategy.md`, `continuum-todo.md`, `torii-continuum-handoff.md`, `README.md`.
> Quest tasks live in the `torii-quest` repo (`quest-todo.md`), not here. Do not merge queues.

> Older reports (`torii-v-*.md`, Nostr Arena docs, legacy snapshots) that still live in the Quest repo are **archival only**. Do not use them as task queues.

### Active tasks

- Keep Continuum as the separate oversight app and do not merge its task queue back into Quest.
- Prepare Continuum to use the same safe assistant-editable .md pipeline as quest-todo.md so Continuum todo updates can be made without manual copy-editing. **BUILT v0.2.259** — `continuum-todo.md` is now in the `mdPatch` whitelist (full append/replace/note/list); `npm run md:patch -- note continuum-todo.md "..."` appends a timestamped note under "Active tasks".
- Keep Continuum work read-only / mockup-first unless a live admin action is explicitly required and approved.
- **CONT-AGENT-1 — Self-Learning Continuum v1 (VPS agent skeleton, drafts-only, no key material).** **PARTIAL v0.2.0-alpha** — invariants scaffold shipped: `agent/` Fastify daemon with NIP-07 challenge/verify, HMAC-signed session tokens, Cashu wallet on VPS (`@cashu/cashu-ts` v2, per-mint proofs at `memory/wallet/`, mode 0600), Routstr chat client (OpenAI-compat, DeepSeek-Chat default, DeepSeek-Coder-V2 for coding, fallback ladder, per-request Cashu payment, `memory/costs.jsonl`), first `chat` skill. Frontend integrations: landing page at `#/`, sidebar Login button (Plebeian Signer), chat dock routes through `/api/chat` when signed in, Routstr Connect opens real Cashu-token top-up modal. Docs: `agent/README.md`, `agent/PRIVACY.md`, slice report `torii-continuum-v0.2.0-cont-agent-1-report.md`. **Deferred**: `brain.read`/`brain.write`/`todo.patch`/`nostr.draft` skills (CONT-AGENT-2/3), local Ollama fallback (CONT-AGENT-1b), Cashu refund tracking, `pending/` drafts panel in Console. Turn Continuum from a read-only mockup dashboard into a sovereign personal AI + project engine. **VPS-only in v1** — Linux/Mac clients come later as thin frontends. **No nsec on the VPS**: signing lives in the browser via **Plebeian Signer** (NIP-07). **No plaintext Nostr write path**: `nostr.draft` skill only produces NIP-17 gift-wrapped envelopes; the plaintext code path is absent, not disabled. **Model layer = Routstr**: pay-per-request in Cashu against pinned providers, OpenAI-compatible client, per-skill model pinning + fallback ladder present-but-off. **Human-in-the-loop by construction**: agent drafts to `agent/pending/*.json`; Continuum Console renders; user approves; Plebeian Signer signs; browser publishes.

  **Scope (v1 surface intentionally small)**:
  1. **Repo layout** — new `agent/` folder under `torii-continuum` with `core/` (model client + skill runtime + memory), `cli/` (`torii ask "..."`), `console/` (HTTPS endpoint the Continuum Console page calls), `nostr/` (NIP-17 listener, read-only in v1), `skills/`, `memory/`, `pending/`, `config.yaml`. Dedicated `continuum` user on the VPS, `/home/continuum/agent/` chmod 700.
  2. **Four skills, only these**:
     - `brain.read` — read-only under `projects/torii-*/knowledge/`, `memory/knowledge/`, `memory/notes/`.
     - `brain.write` — write only under `learnings/YYYY-MM-DD.md` (new) and `changelog.md` (append). Refuses elsewhere.
     - `todo.patch` — wraps existing `tools/mdPatch.mjs` (Quest repo). Permitted files + capability map inherited from mdPatch-2.
     - `nostr.draft` — builds NIP-17 gift-wrapped envelopes only (inner kinds 14 / 30078 / 30081); writes to `agent/pending/`; never signs, never publishes.
  3. **Model routing** — Routstr as default, cheap fast model for skill work, small conversational model for chat; per-skill pins encoded in `config.yaml`. Cost log at `agent/memory/costs.jsonl` — `{skill, model, tokens_in, tokens_out, sats_spent, at}`. No prompt bodies logged.
  4. **Cashu float** — single Cashu wallet on VPS, ~5k sats initial float, refill from Plebeian Signer's built-in Cashu wallet.
  5. **Continuum Console wiring** — wire the previously-inert Console page to the VPS agent HTTPS endpoint. Show live chat + a "pending drafts" panel that renders `agent/pending/*.json`; each draft has an Approve button that hands the payload to `window.nostr.signEvent` (Plebeian Signer) and publishes via the existing relay pool. Preserves the current read-only default — the Approve button is the only live action.
  6. **Memory** — grep-able markdown/JSONL under `agent/memory/`. Naive keyword retrieval in v1 (no embeddings). `sessions/YYYY-MM-DD.md` for transcripts, `notes/*.md` for durable facts, `index.md` auto-maintained catalog.
  7. **Success criteria** (blocking merge): agent runs on VPS + restarts cleanly + chmod 700; `torii ask "summarise today's Brain changelog"` returns a grounded cited answer; `torii ask "add a slice for X to Quest todo"` produces a valid `md:patch note` command, executes it, appends matching learning to today's `learnings/YYYY-MM-DD.md`; Console page shows agent state + drafts + Plebeian Signer approves and publishes; cost log accumulates realistic sats spend with no runaway calls; **zero nsec anywhere on the VPS**; **zero plaintext Nostr writes** — both are structural (code paths absent), not policy.

  **Explicitly NOT in v1**: autonomous signing / publishing; NIP-46 bunker (deferred to v2 pending Plebeian Signer NIP-46 support); local Ollama fallback; Quest NPC bridge (`quest.npc.talk`, v2); dev-help watcher (v2); marketplace worker skill (v2); embedding-based retrieval (v2); own relay / own Cashu mint (v2).

  **Docs**: create `agent/README.md` (install / VPS bring-up / Plebeian Signer pairing / Cashu topup / Routstr provider pinning) and `agent/PRIVACY.md` (encryption invariants, points at `concepts/privacy-first-nostr.md` in the Brain). Slice report `torii-continuum-vX.Y.Z-cont-agent-1-report.md` in the Continuum repo; do NOT bump Quest version. Continuum picks up its own versioning cadence with this slice.

  **Risk**: medium — introduces a new runtime surface. Mitigations: v1 has no autonomous publish path, no signing, no key material on the VPS, `chmod 700` filesystem, no plaintext prompts in logs. Every publish requires a browser click. Kill-switch: `systemctl stop continuum-agent` on the VPS.

  **Reference**: Space Brain — `projects/self-learning-continuum.md` (architecture + skill definitions + success criteria), `concepts/privacy-first-nostr.md` (encryption invariants), `entities/routstr.md` (model layer), `entities/plebeian-market.md` (signer).