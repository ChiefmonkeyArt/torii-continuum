# Torii Continuum — Strategy & Next Steps

Living document. This will change as we learn.

Source-of-truth split (per the `Torii` Space instructions, one set per project): this file (`torii-continuum-strategy.md`) owns Continuum's vision, core principles, decision rules, and architecture direction. `torii-continuum-todo.md` owns the active task queue. `torii-continuum-progress.md` is the release log. `torii-continuum-handoff.md` and `README.md` are the developer entry points.

Continuum is a **separate app** from Torii Quest. Quest is the game; Continuum is the sovereign dashboard, project engine, and personal AI layer. They share a Space Brain (Perplexity Space `Torii`) and a namespace (`torii-*`), but they are two repos, two versioning cadences, two live surfaces:

- Continuum production (sovereign self-hosted): `https://chiefmonkey.art` — **v0.2.63-alpha shipped live** via the one-time `ops/torii-final-cutover.sh` cutover (launcher HTTP 200; nginx + torii-base sidecar + continuum-agent active; unattended `torii-continuum-deploy.timer` enabled and active). This is the sovereign target the whole cutover series was building toward.
- Continuum preview: `https://continuum-torii.pplx.app`
- Quest live: `https://torii-quest.pplx.app`

## What We Are Building

Torii Continuum is a sovereign, Nostr-native personal AI and project engine. It exists to give the Chiefmonkey / Plebeian / Torii ecosystem a **single privacy-first surface** for:

- Reading and writing the Space Brain (the curated knowledge wiki used by all Torii projects).
- Editing project todo files and strategy docs through safe assistant-editable pipelines.
- Drafting Nostr events (chat, project cards, todos, marketplace tasks) as encrypted envelopes for the user to approve and sign.
- Coordinating between Torii apps (Quest, Plebeian.Market integrations, Nostr Arena archive) without acting as a central operator.
- Eventually — through the Continuum agent roadmap (CONT-AGENT-1..N) — becoming a self-hostable "always-on second brain" that runs on a VPS with no key material, drafts everything, publishes nothing without a browser click.

Continuum is not a game. It is not a shooter, a world builder, or a chat client. It is the **oversight, memory, and coordination layer** that makes the rest of the ecosystem sovereign in practice, not just in theory.

## Vision

Long-term, Continuum is the piece that makes "self-sovereign AI + self-sovereign identity + self-sovereign value" a real daily-driver experience rather than three separate demos.

- **Personal AI without a platform.** No cloud vendor holds the memory. No SaaS holds the account. The agent runs where the user runs it (VPS, later Linux/Mac clients), signs nothing on its own, and treats every publish as human-approved.
- **Project engine on Nostr.** Projects (kind-30078), todos (kind-30081), Kanban boards (columns kind-30083 / cards kind-30084, shipped v0.2.45-alpha), and later marketplace tasks (kind-30090) become first-class citizens the agent can read, draft, and — with explicit user approval — write. The board is per-project, local-first, and Nostr-shaped like everything else — no external service, ready to flip to signed relay events with zero re-shaping.
- **Privacy-first by construction.** All Nostr writes are gift-wrapped (NIP-17) by default. The plaintext code path is absent, not disabled. Local storage stays under `chmod 700`. Prompt bodies do not appear in logs.
- **Bitcoin-native model layer.** Model inference is paid per-request in Cashu via Routstr — no API-key custody, no monthly SaaS bill, no lock-in to a single provider.
- **The gateway to Torii.** Continuum is the piece that gives Quest, Plebeian.Market, and future Torii apps a shared memory, a shared agent, and a shared privacy posture.

Where Quest is the playful spatial front end, Continuum is the quiet infrastructure that makes the whole stack usable long-term.

## Sovereign Bot Stack (GENESIS-1 shipped v0.2.78-alpha; principle architecture + constitution genesis-1.1.0 shipped v0.2.81-alpha; MEMORY-1 shipped v0.2.82-alpha; first-run activation MEMORY-ACTIVATION-1 shipped v0.2.87-alpha; LoRA/RAG gated)

Continuum now has a foundation for its most ambitious layer: **anyone can bring to life a sovereign, adaptive AI bot they alone control.** The bot is owner-bound at genesis to one verified Nostr identity, acts only under explicit owner command (default-deny where authority/consent/provenance is unclear), and is born under a **humanitarian starter constitution** — care for those who gave it life, those around it, those beyond, and build extraordinary things that help humanity evolve. This is foundational, not an optional setting.

**The honesty boundary is a design principle, not a caveat.** No technical system can make an open-source constitution literally unalterable by the machine's owner — a root operator can edit any file. So instead of dishonest immutability/DRM claims, the stack provides **versioning, a published stable digest, visible provenance, default-deny semantics, and tamper evidence** (a hash-chained audit ledger; manifests that pin the constitution digest they were born under; digest-mismatch surfaced in the UI). Alteration is made *detectable and attributable*, never silent.

**GENESIS-1 (shipped)** is the first secure vertical slice: the deterministic versioned constitution (`agent/lib/constitution.mjs`, digest `178ad323…`), the hash-chained audit ledger (`agent/lib/audit.mjs`), and the owner-bound genesis manifest (`agent/core/genesis.mjs`) — one-time, idempotent, default-deny cross-owner, atomic + restrictive-permission storage, no key material — plus routes, a client, and a minimal `/genesis` UI. It runs single-owner-per-VPS today but is namespaced by owner pubkey so the data model is already multi-tenant-shaped.

**Three-layer principle architecture (SOVEREIGN-COP-1, shipped v0.2.81-alpha).** Before any adaptive stage ships, the founding intent is codified honestly as three separate, versioned layers so that contested doctrine is never asserted as machine-enforced fact:

- **Layer A — Constitution** (`agent/lib/constitution.mjs`): minimal machine-readable invariants (enforceable floors/defaults), evolved to **`genesis-1.1.0`** via a mint-new-never-edit **version registry**. `genesis-1.0.0` is preserved byte-identical (digest `178ad323…`); `genesis-1.1.0` (digest `4761094b…`) adds three sovereignty invariants — selective-revelation (privacy by selective disclosure), verify-don't-trust, and four-freedoms/forkability. Economic and philosophical *preferences are deliberately kept out of the hashed Layer-A body*; only cryptographic/sovereignty floors live here. Manifests born under an earlier valid version verify against that version's frozen body and are surfaced as honest provenance (`constitution_is_current:false`), never as tampering — birth covenants are pinned, never rewritten.
- **Layer B — Code of Practice** (`docs/sovereign-ai-code-of-practice.md`, `cop-1.0.0`): human-readable, versioned, auditable, amendable operational rules mapping each principle → engineering/agent behaviour + acceptance tests, with an explicit **normative hierarchy** for conflict resolution (law/safety + hard refusal-of-clear-harm > owner authority > consent/privacy > humanitarian care > operational preferences > advisory references) and the **RAG-1 / LoRA gates** that adaptive stages must satisfy before shipping.
- **Layer C — Reference Canon** (`docs/sovereign-ai-reference-canon.md`, `canon-1.0.0`): non-binding, exactly-attributed influences (Cypherpunk/Bitcoin/Austrian/FOSS/open-governance + humanitarian baseline) with primary-source URLs and cautions; contested economic/political doctrine is flagged as *attributed viewpoint*, never neutral fact, and no book/author/org is ever elevated to unquestionable authority.

The layers + normative hierarchy are exposed via `GET /api/constitution` and surfaced (text-only, no external navigation / XSS surface) in the `/genesis` UI for visible provenance.

**MEMORY-1 (shipped v0.2.82-alpha; privacy-corrected v0.2.83-alpha).** The first persistent-memory slice, and the first place the constitution + Code of Practice become *live working values* rather than documentation. Durable memory is **encrypted at rest (NIP-44, sealed in the browser — the agent never sees plaintext or a key)** and **isolated by owner + bot + project** under a single systemd-writable `memory/` root (`agent/lib/memstore.mjs`; strict segment validation defeats traversal/IDOR; per-item integrity hashes, atomic writes, bounded sizes, per-scope + per-owner quotas, class-based retention, audited delete). Consent is the only path to durable memory: AI/"remember this" suggestions are **proposals that never auto-persist** and are **ciphertext-only from the moment they are created** — the browser seals the proposal before it reaches the agent, which stores ciphertext + a canonical hash + minimal slug metadata (never plaintext, in the pending store, logs, or audit ledger). The owner reviews by **decrypting client-side**, and approval (bound to the reviewed payload hash + single-use nonce) promotes the already-sealed blob; reject securely unlinks it. Legacy plaintext proposals from v0.2.82-alpha are purged on startup (`agent/lib/consent.mjs`). A deterministic, versioned **working-values header** (`agent/lib/workingvalues.mjs`) is injected **above** character and **above** retrieved memory on every turn, and retrieved/imported text is fenced as **untrusted data, never instructions** (prompt-injection / memory-poisoning defence). Portability is **manual, encrypted, owner-signed** (`agent/lib/portability.mjs`): export bundles ciphertexts only with a deterministic manifest the browser signs via NIP-07 (detached kind 30099, never relay-published); import verifies signature/owner/hashes and **quarantines** (default-deny), so nothing foreign or tampered is ever trusted automatically. No vector DB / embeddings are introduced — similarity retrieval stays **deferred to RAG-1** (MEMORY-1 does exact-scope fetch only and does not fake vector RAG); relay publication and automatic multi-device sync remain deferred/disabled. Owner console at `/memory`; full contract in `docs/sovereign-ai-memory-1-spec.md`.

**MEMORY-ACTIVATION-1 (shipped v0.2.87-alpha; feature merged as PR #98 / `a342eef`, cleanly re-versioned from the pre-consumed v0.2.84-alpha tag name).** Durable memory ships **locked** and the console previously offered no obvious way to turn it on. First-run activation is now unmistakable and guided: the Memory view gates on the **authoritative** per-owner signal (`GET /api/memory.data.unlocked_for_owner`) and, when locked, presents a dominant panel with a single primary CTA that walks a pure, DOM-free eight-state machine (`src/views/memory-activation.js`). The owner proves fresh consent by signing a **kind-22242** challenge in their own NIP-07 signer — the SAME authorization as login, not a parallel protocol — after which the browser NIP-44-decrypts the ciphertexts and the agent unlocks via `auth.verifyActionSignature()` (owner-bound, single-use → replay-safe) and the SAME `memoryCache.unlock()` path, appending a metadata-only `memory.activate` audit line. Consistent with the honesty boundary, "unlocked" is shown **only** after an authoritative `unlocked_for_owner:true` re-read, never optimistically; no plaintext or key ever leaves the browser.

**Forward stages (specified in `docs/sovereign-ai-genesis-lora-rag-spec.md`, not built, not faked — now GATED by Layer B §10):** CHARACTER-* (sealed character editor wired to a provenance-tagged prompt assembly), RAG-* (owner-added sources only/no silent crawling, permission-filtered + consent-scoped retrieval with default-deny, provenance-stamped attributed context, durable memory + first-class forgetting), LORA-* (curated + owner-approved training data only — never auto-sourced from unreviewed chats, fail-closed — local/approved fine-tuning with adapters that pin base model + dataset digest + constitution version/digest), MULTI-TENANT-*. The manifest stamps `lora`/`rag = 'not-started'` and the UI labels them subsequent stages so capability is never overstated.

## Core Principles

- **Privacy first.** Nostr-native does not mean publish-everything. Anything that ever gets posted to Nostr must be gift-wrapped in cryptography (NIP-17 by default). Local-first, encrypted-first.
- **Sovereignty first.** No nsec on the VPS, ever. Signing lives in the browser through a NIP-07 signer (Plebeian Signer). No custodial fallback.
- **Human in the loop by construction.** The agent drafts. The human approves. The browser signs. No autonomous publish path in v1.
- **Read-only until proven.** Every Continuum feature starts read-only or mockup-only. Live actions require an explicit slice, explicit gates, and explicit approval.
- **Local-first, encrypted-first.** Filesystem posture is `chmod 700`, dedicated OS user, no plaintext prompts in production logs.
- **No vendor lock-in.** Providers (Routstr endpoints, relays, mints) are pinned in config and swappable without rewrites. Every dependency has a documented fallback plan even if the fallback ships later.
- **Incremental, no big rewrites.** Same discipline as Quest. Every slice leaves the system cleaner, smaller, or better-indexed than it found it.
- **Trade-offs over fake certainty.** Every architectural choice is documented with its cost, not just its benefit.
- **Brain-aware.** Continuum reads and (in scoped ways) writes the Space Brain wiki. The Brain is a first-class runtime dependency, not decoration.

## Freedom-Tech Stack (Continuum's slice)

Continuum plugs into the broader freedom-tech stack the ecosystem is being built on:

- **Identity**: npub (Nostr public key). Signing via Plebeian Signer NIP-07 browser extension in v1; NIP-46 remote-signer support deferred to a later slice once Plebeian Signer ships it.
- **Value**: Bitcoin and Cashu. Model inference is paid per-request through Routstr; the VPS holds a small Cashu float (~5k sats) refilled from Plebeian Signer's built-in wallet.
- **Messaging**: Nostr gift-wrapped DMs (NIP-17) for agent-to-user drafts. Self-DM pattern for private-by-default project data.
- **Runtime**: VPS in v1 (single sovereign box). Linux and Mac clients arrive later as thin frontends over the same daemon.
- **Coordination (deferred)**: NIP-34 (`ngit`) will mirror both repos to Nostr and give code coordination — issues, patches, discovery — a Nostr-native path alongside GitHub. **Deferred until Continuum has a working proof of concept.** No mirror push, no repository announcement, no `kind:30617` event until after CONT-AGENT-1 lands and Continuum is worth announcing.

## Continuum Agent Roadmap (CONT-AGENT-1..N)

CONT-AGENT-1 is the current active slice. Later slices are named and reserved to keep scope honest.

### CONT-AGENT-1 — v1 skeleton (active)

Turn Continuum from a read-only mockup dashboard into a sovereign personal AI + project engine.

- **VPS-only.** Linux and Mac clients come later as thin frontends. No local-machine dependency in v1.
- **No key material on the VPS.** Signing lives in the browser via Plebeian Signer (NIP-07).
- **No plaintext Nostr write path.** The `nostr.draft` skill only emits NIP-17 gift-wrapped envelopes. The plaintext code path is absent, not disabled.
- **Model layer = Routstr.** OpenAI-compatible client paying per-request in Cashu against pinned providers. Per-skill model pinning; fallback ladder present but off by default.
- **Human-in-the-loop by construction.** Agent drafts to `agent/pending/*.json`; Continuum Console renders them; user clicks Approve; Plebeian Signer signs; browser publishes.
- **Four skills, only these:**
  - `brain.read` — read-only under `projects/torii-*/knowledge/`, `memory/knowledge/`, `memory/notes/`.
  - `brain.write` — write only under `learnings/YYYY-MM-DD.md` (new) and `changelog.md` (append).
  - `todo.patch` — wraps existing `tools/mdPatch.mjs` (Quest repo). Permitted files + capability map inherited from mdPatch-2.
  - `nostr.draft` — builds NIP-17 gift-wrapped envelopes only (inner kinds 14 / 30078 / 30081); writes to `agent/pending/`; never signs, never publishes.
- **Explicitly not in v1**: autonomous signing / publishing, NIP-46 bunker, local Ollama fallback, Quest NPC bridge, dev-help watcher, marketplace worker, embedding-based retrieval, own relay, own Cashu mint.

Full scope, success criteria, and non-goals live in `torii-continuum-todo.md` under CONT-AGENT-1 and in the Space Brain at `projects/self-learning-continuum.md`.

### CONT-CHARACTER-1 — character + memory infrastructure (active)

Adds a **sealed, local-first character stack** so the agent has a stable identity, values, and skills between sessions — without ever leaking to Nostr by default.

**Nostr event kinds (all NIP-44 v2 encrypted to operator's own npub; local-only unless explicit opt-in):**
- `kind:30092` — `character_root` — the operator-signed root of the character tree. One per operator. `d`-tag = `"root"`.
- `kind:30094` — `semantic_fact` — a single durable belief, preference, or fact. `d`-tag = stable slug (e.g. `pseudonym-only`, `ancap-agorist-stance`).
- `kind:30095` — `procedural_skill` — a reflex or reusable how-to that runs before the model speaks. `d`-tag = skill slug (e.g. `refusal-with-law`, `right-speech-filter`).
- `kind:30096` — `destructive_intent` — a *proposal* to wipe/rewrite memory. Requires cooldown + double-signature to enact.
- `kind:30097` — `emergency_wipe_authority` — the **panic key** (**OPTIONAL**, default off in config). Single event, published once and stored offline (password manager acceptable; hardware signer better); its presence in the memory cache collapses the 30096 double-sig requirement to single-sig so the operator can wipe under duress. Without one, wipes still work via the normal double-signature flow.

**Layers loaded at inference time** (from decrypted files in RAM, never disk plaintext):
1. **Character** — CHARACTER.md v2, the Three Laws, sovereignty/privacy stance, 13 reflexes.
2. **Semantic** — facts and preferences ("pseudonym-only", "proud maximalist", "communism was never a candidate").
3. **Procedural** — reflexes that run before the model speaks (right-speech filter, refusal-with-law, harae, disposability-confirm).
4. **Episodic (read-only at reflect time only)** — the agent *never* reads its own past chat log during a live turn. It only reads it during offline reflection to propose new semantic/procedural drafts into `agent/pending/`.

**Signing model:** the agent **never signs on its own**. All 30092/30094/30095/30096/30097 events are drafted as unsigned JSON in `agent/pending/*.draft.json` and signed via Plebeian Signer with an explicit human click.

**Storage default:** encrypted at rest (`<eventid>.enc`), NIP-44 v2 to `admin_npub`. Plaintext lives in tmpfs / RAM only. Never published unless the operator flips an explicit per-event `publish: true` at sign time.

**Files added this slice:**
- `agent/lib/crypto.mjs` — NIP-44 v2 wrap/unwrap via signer round-trip
- `agent/lib/events.mjs` — draft (never sign) helpers for 30092/30094/30095/30096/30097
- `agent/lib/memory.mjs` — decrypting loader (character + semantic + procedural, RAM only)
- `agent/lib/reflect.mjs` — offline pass that reads episodic and drops drafts into `pending/`
- `agent/PANIC_KEY_SETUP.md` — runbook for generating and cold-storing the 30097 event
- Seed drafts under `agent/memory/semantic/*.draft.json` and `agent/skills/*.draft.json`

**Endpoints added:** `/api/character`, `/api/memory`, `/api/reflect` (all admin-gated).

### Later slices (reserved, not scheduled)

- **CONT-AGENT-2** — Nostr write path via NIP-46 remote signer, once Plebeian Signer or an alternative ships it. Enables the agent to publish without a browser click for pre-approved skill outputs.
- **CONT-AGENT-3** — Quest NPC bridge (`quest.npc.talk`). Lets Continuum drive an in-game NPC in Quest.
- **CONT-AGENT-4** — Dev-help watcher. Watches for questions in specific channels/relays and drafts helpful replies for approval.
- **CONT-AGENT-5** — Marketplace worker skill (kind-30090). Drafts, tracks, and reconciles Plebeian.Market marketplace tasks.
- **CONT-AGENT-6** — Self-hosted relay and own Cashu mint, so no third-party rails sit in the critical path.
- **CONT-AGENT-7** — Embedding-based retrieval for the Brain and session history.

### Queued alongside the agent slices

- **NGIT-1 (deferred)** — Mirror `torii-continuum` to Nostr via NIP-34 (`ngit`). Publishes a `kind:30617` repository announcement + state (`kind:30618`) so the repo is cloneable and coordinatable from any NIP-34 client (`gitworkshop.dev`, `n34`, `gitplaza`, `kanbanstr.com`). Deferred until Continuum has a working proof of concept — no announcements until there is something worth announcing. Runbook to be written as `NGIT.md` when the slice is scheduled. Reference: Space Brain — `entities/gitworkshop-and-ngit.md`, `concepts/nip-34-git.md`.

## What Is Shipping vs Mocked

**One deadline per turn shipped v0.2.91-alpha** — the previous release gave the completion fetch a wall clock, which exposed the deeper problem: *several* correct-looking deadlines that were never reconciled with each other. Providers run sequentially, so 45s of Routstr plus 180s of Ollama is 225s under a 120s proxy bound, and the documented defaults could not all be honoured at once. Architecture decisions worth keeping: (a) **a deadline belongs to the turn, not to the call** — the router opens one budget and each provider gets `min(its own timeout, what's left)`, so a per-provider timeout is a *ceiling* rather than an allocation, and adding a third provider later cannot silently extend the turn; (b) **the layers form an ordered chain and the ordering is the invariant** — `provider slice ≤ agent budget < browser fetch ≤ nginx` is written down beside every one of those four values, because a number tuned in isolation is the bug, not the fix, and the client deliberately sits *between* the agent and the proxy so a slow-but-honest reply still lands while a wedged socket surfaces as the SPA's own error rather than a raw 504; (c) **refusing to start is a real answer** — `budget_exhausted` is non-retryable on purpose: a fallback that cannot finish before everyone upstream hangs up is worse than an honest failure, and it must not be dressed up as something worth retrying; (d) **the money check comes before the deadline check pays off** — Routstr evaluates the budget *before* `wallet.send`, because sats spent on a completion guaranteed to abort are simply lost; (e) **time must be injectable to be testable** — the budget takes a clock, so the whole thing is verified with deterministic assertions instead of sleeps, and "does the fallback get the shrunken slice" is a unit test rather than a stopwatch.

**Provider-failure honesty shipped v0.2.90-alpha** — the paid→free fallback only worked for the failures someone had thought to string-match, and the chat dock hid the rest behind a canned mock. Architecture decisions worth keeping: (a) a provider failure is a **structured value, not prose** — `{ code, reason, retryable }` from a single classifier (`agent/lib/provider-errors.mjs`), so the router branches on a stable token instead of pattern-matching English, and the SPA can render code-specific copy; (b) an upstream body is **evidence, never output** — it is inspected to classify and then discarded, because forwarding it leaked a Cloudflare error page (and anything it echoed) straight to the browser; HTML detection is independent of the status line because the edge serves error pages under any status, 200 included; (c) `retryable` is an explicit contract rather than an inference — transport and payment failures are worth the free local model, but a **malformed request must not fall back**, since a silent paid→free downgrade would hide a real bug behind a plausible answer; (d) every network call needs a wall-clock deadline — the completion fetch had none, and "hangs forever" is a worse failure than "fails fast", because only the latter can be retried elsewhere; (e) **a canned reply in a production build is a lie** — once an agent is configured, a failed turn reports an honest error and a fell-back turn discloses which model answered, because an operator who cannot distinguish their sovereign bot from demo prose has no sovereignty at all.

**Top-up poll robustness + pending-top-up recovery shipped v0.2.89-alpha** — a field bug (a Cashu top-up that reached the mint but never minted into the wallet, with zero server-side trace) forced a hard look at the top-up flow. Architecture decisions worth keeping: (a) the top-up poll interval no longer lives in a modal closure — it's a module-scope `topUpSessions` singleton keyed by quote id that self-cancels orphaned intervals, so a view re-render can never silently strand it; (b) the poll and `checkMintQuote` are now **instrumented** (client-side `console.info` gated on a debug flag; server-side `log.info` at entry + every terminal branch, always redacting BOLT11/preimages/proofs/npubs) — the guiding principle is *a silent failure is worse than a loud one*, so the fix is also a diagnostic; (c) a payment that reaches the mint is **recoverable** — quote markers persist with `minted:false`, the owner can list + resume them (idempotently) from a "Pending top-ups" card, and retention only ever auto-prunes **minted** markers (unminted are the user's money and are never reaped). A zero-dep sats-burst celebration and a same-mint self-transfer hint round out the release.

**Session durability, demo navigation, real anchors, NWC identity, and live usage shipped v0.2.88-alpha** — six UX/robustness items that harden the v0.2.85 demo/auth work and polish Routstr. Architecture decisions worth keeping: (a) session survival is a **non-secret marker** (`{npub,connected_at}` under `continuum.session.meta.v1`) rehydrated on mount + `pageshow.persisted`, with sign-out promoted to a cross-tab boundary via a `continuum.signout.v1` sentinel + synthetic in-tab `storage` fallback — the actual NIP-07 pubkey still lives elsewhere, so no secret is ever persisted; (b) in-app navigation is now **real `<a href="#/route">` anchors** (`src/components/nav-link.js`) that keep SPA transitions but honour ⌘/ctrl/middle-click for new-tab/download — accessibility + shareable URLs without a router rewrite; (c) demo links are made **`demoAware`** at construction so browsing never escapes the `/demo` subtree and every mutating CTA routes to login. NWC cards now surface a human wallet identity (alias + maker inferred from a fingerprint of alias + relay hosts **only**, never secrets), and usage stats refresh in place on a visibility-gated 5s poll. Ships forward-only as v0.2.88-alpha because the brief's v0.2.86/v0.2.87 tags were already published on the remote.

**Public demo surface shipped v0.2.85-alpha** — a signed-out visitor can browse a read-only mockup at `/demo/*` rendered from obviously-fake fixtures (every human-facing string carries DEMO/Sample). Architecture decision: demo mode is **not a view fork** — each demo route renders the SAME view as its real counterpart with `{ demo, fixtures }`, and views swap their data source through `demoSource()`. This keeps the demo and the real app from drifting apart (one code path, one set of tests) and lets `nav-guard`/`demoRedirect` treat `/demo/*` as public while a signed-in operator is bounced to real data. Demo makes zero agent/network calls by construction, and every CTA routes to login. Same release hardened sign-out into a cross-tab boundary (localStorage sentinel broadcast) and added quarantine pruning to the disk-retention sweep.

**Routstr QR top-up shipped v0.2.84-alpha** — the Routstr page funds the Cashu balance via a scannable Lightning-invoice QR (Cashu mint-quote or NWC-issued), with the paste-a-token flow kept as a fallback and an idempotent double-mint guard on the agent. Zero new deps (vendored MIT QR encoder).

**Live today (mockup / read-only):**
- Continuum Console page at `https://continuum-torii.pplx.app` — read-only dashboard mockup demonstrating the MVP loop (NAP zone status, gateway state, leaderboard preview, Plebeian product panel, GitHub update check).
- `mdPatch-2` pipeline shared with Quest — `torii-continuum-todo.md` in the whitelist, safe assistant-editable notes / appends / replaces.

**Building next (CONT-AGENT-1):**
- VPS agent skeleton under `agent/` in this repo.
- Four scoped skills (`brain.read`, `brain.write`, `todo.patch`, `nostr.draft`).
- Continuum Console wired to the agent HTTPS endpoint with a live "pending drafts" panel.
- Cost log at `agent/memory/costs.jsonl`.
- `agent/README.md` and `agent/PRIVACY.md`.

**Not building yet (explicit):**
- Anything that signs, publishes, or holds an nsec on the VPS.
- Any plaintext Nostr write path.
- Any autonomous action without a browser click.
- NGIT-1 / NIP-34 announcements — deferred until after PoC.

## Decision Rules

- If a slice needs an nsec on the VPS, it is not v1. Redesign until it does not.
- If a slice adds a plaintext Nostr write path, it is not v1. Redesign or delete the code path.
- If a slice adds an autonomous publish path (no browser click), it is not v1 and it is not v2. It waits until NIP-46 support lands and gets its own slice.
- If a skill wants to write outside its whitelist, refuse. Whitelist over allow-list-plus-exceptions.
- If a provider (model, relay, mint) is being pinned, document the fallback in the same commit even if the fallback ships later.
- If a feature can start read-only or mockup-only, it starts that way. Live actions require an explicit slice.
- If Continuum work and Quest work start bleeding into each other, stop and route the task to the correct repo. The two apps stay separate on purpose.
- If an ops tool deletes anything on the VPS, it fails closed: it acts only inside explicitly approved roots, canonicalises + re-checks every candidate (no symlink, exact-parent, protected-path denylist), refuses when deploy service state is unsafe, and treats "cannot prove it's safe" as "do not delete". Disk hygiene (OPS-RETENTION-1) reclaims only regenerable deploy/cutover artefacts after a verified-good deploy — live state, encrypted state, projects, certificates, model weights and audit logs are untouchable.
- If a slice lets the UI change what runs on the VPS (e.g. self-update), it stays **privilege-separated**: the unprivileged agent never execs and never writes root-owned files — it only records an admin-authenticated, confirmed, independently-validated *request*, and a root applier re-validates it (tag grammar mirrored byte-for-byte + allowlist) before touching the deploy pin, degrading fail-safe to the existing pin. No unauthenticated trigger, no secret exposed, no arbitrary command execution, and the "newer release" decision is server-side (cached/rate-limited, SSRF-pinned, prerelease-aware, same-channel) — the UI never trusts a client-supplied tag (AUTH-DIRECT-1 + VERSION-UPDATE-1).

## Open Questions

- **NIP-46 timing.** Plebeian Signer does not yet expose NIP-46. Continuum's autonomous-publish story stays deferred until it does (or until a bunker on a separate device becomes a credible fallback).
- **Cashu float sizing.** ~5k sats is a starting estimate. Real usage data from CONT-AGENT-1's cost log will drive the refill cadence.
- **Routstr provider set.** Which providers to pin per skill is an empirical question. First pass: cheap fast model for skill work, small conversational model for chat. Revisit after two weeks of real usage.
- **Console auth.** The Continuum Console currently ships as an unauthenticated read-only mockup. Once it wires to the agent HTTPS endpoint, npub-based auth becomes required. Model TBD in the CONT-AGENT-1 slice.
- **Repo boundary durability.** Some shared tooling (`tools/mdPatch.mjs`) lives in the Quest repo but serves both apps. If that pattern spreads, spin out a `torii-shared` repo. Not yet.

## Working Recommendation

Ship CONT-AGENT-1 as the next real slice. Keep everything else — NGIT-1, NIP-46 autonomous signing, Quest NPC bridge — parked in the roadmap and out of the active queue. Announce nothing on Nostr until Continuum has something worth announcing.
