# Torii Continuum — Sovereign AI: Genesis, LoRA & RAG Technical Specification

Status: **Implementation-grade** · Slices shipped: **GENESIS-1** (v0.2.78-alpha) + **PRINCIPLES/constitution genesis-1.1.0** (v0.2.81-alpha) + **constitution genesis-1.2.0 — creator-care rewording, `no-credential-custody` safety floor, `pareto-focus` operating rule, owner-acknowledged migration** (v0.2.101-alpha) + **MEMORY-1** (v0.2.82-alpha — encrypted-at-rest, consent-gated, owner/bot/project-scoped durable memory + owner-signed portability; see `docs/sovereign-ai-memory-1-spec.md`) · LoRA/RAG: **specified, not built, gated by Layers A/B/C** (MEMORY-1 does exact-scope fetch only; similarity retrieval remains RAG-1)

> This document is the durable design contract for Torii Continuum's sovereign
> bot stack. GENESIS-1 (the genesis lifecycle + humanitarian constitution) is
> implemented and shipped. The LoRA and RAG sections are forward specifications:
> they define the target architecture so later slices can be built against a
> stable contract. Anywhere this document describes LoRA training or RAG
> retrieval as behaviour, it is describing a **future** stage — the running
> system does not fake either.

---

## 1. Problem & Vision

Anyone should be able to bring to life a **sovereign, adaptive AI bot that they
alone control**. Not a rented seat on someone else's model, not an assistant
whose loyalties are split with a platform — a bot that is:

- **Owner-bound at genesis** to exactly one verified Nostr identity, and takes
  that binding as the root of all authority;
- **Adaptive** over time (via LoRA fine-tuning and RAG memory) but only on data
  its owner has curated and approved;
- **Humanitarian by birth**, beginning under a starter constitution that commits
  it to care for the human that created it, those around it, and those beyond —
  and to build extraordinary things that help humanity evolve. This is foundational,
  not an optional later setting.
- **Explicit-command-only** and **default-deny**: it acts under its owner's
  explicit command, and where authority, consent, or provenance is unclear it
  refuses and asks.
- **Private and self-custodial**: the host holds no owner private keys and
  publishes nothing without the owner's browser-side signature.

The honest engineering position, stated up front: **no technical system can make
an open-source constitution literally unalterable by the machine's owner.** A
determined operator with root can edit any file. What an honest system can and
must provide instead is **versioning, a published digest, visible provenance,
default-deny semantics, and tamper evidence** — so that alteration is *detectable
and attributable*, never silent. Every claim in this spec respects that boundary.

### 1.1 Current deployment reality vs. the multi-tenant vision

The running agent is **single-admin-per-VPS**: a first-touch admin claim binds
one operator to one instance. GENESIS-1 therefore binds a manifest to the
verified session npub and **namespaces all storage by owner pubkey**, so the data
model is already multi-tenant-shaped even though today one instance serves one
owner. Multi-tenant hosting (many owners per instance, relay-synced identity) is
a later stage and is called out as such wherever it matters.

---

## 2. Principles & Threat Model

### 2.1 Principles

1. **Sovereignty first.** The owner's key is the root of authority. The bot
   serves the owner, not the host or the platform.
2. **Consent is explicit and scoped.** Silence is not consent; ambiguity resolves
   to no-action. A single approval authorizes only the scope it named.
3. **No key custody.** The VPS never holds owner private keys. All signing and
   all decryption of the sealed character/memory stack happen browser-side.
4. **Provenance over DRM.** We make covenant drift *evident*, not *impossible*.
5. **Least privilege on disk.** Atomic writes, 0600 files under 0700 dirs,
   systemd sandbox; only what must be writable is writable.
6. **Honesty about capability.** Unbuilt stages are labelled unbuilt. No faked
   training, no faked retrieval, no cosmetic "AI" that isn't wired to anything.
7. **Minimal footprint.** Privacy-first, small dependency surface, bounded disk.

### 2.2 Assets

- Owner private key (**never on the host** — browser-only).
- Agent session secret (HMAC key for session tokens; AES/HKDF root for the
  secretstore).
- Genesis manifest (provenance data; public-ish, integrity-critical).
- Character + memory ciphertexts (NIP-44 sealed to the owner's npub).
- Audit ledger (tamper-evident record of privileged acts).
- Wallet / Cashu proofs & NWC URI (cash-equivalent secrets).

### 2.3 Adversaries & mitigations

| Adversary | Goal | Mitigation |
|---|---|---|
| Unauthenticated caller | Mint/read a manifest for a key they don't own | Owner derived from **verified session**, never request body; admin-gate; default-deny read namespaced by pubkey |
| Malicious request body | IDOR — supply another owner's pubkey | `POST /api/genesis` ignores any body pubkey; authority is `req.session.npub` only |
| Path traversal | Escape the owner namespace on disk | Owner segment is strict `^[0-9a-f]{64}$`; `join` under a fixed base; decode via `nip19` then re-validate hex |
| XSS via manifest fields | Inject script through display_name/intent | Fields length-bounded server-side; rendered client-side via `textContent` only (`h()` builder), never `innerHTML`/`html:` |
| Silent covenant edit | Change constitution text unnoticed | Deterministic canonical digest, published + locked in tests; manifests pin `{version,digest}`; read recomputes and flags drift |
| Silent audit edit | Delete an incriminating line | Hash-chained JSONL; a partial edit/removal breaks the chain and `verify()` reports the break point |
| Compromised host process | Read secrets from disk | No private keys on host; secretstore is AES-256-GCM+HKDF keyed by session_secret; sealed stack decryptable only browser-side |
| Torn write / crash | Corrupt manifest lets a retry fork identity | temp-file + atomic `rename`; corrupt-present is a hard error (not treated as "absent") |

### 2.4 Explicit non-goals (security)

- We do **not** claim tamper-*proofing*, immutability, or remote enforcement of
  the constitution against the machine owner.
- We do **not** hold or reconstruct owner private keys under any flow.
- We do **not** auto-source training data from unreviewed chats.

---

## 3. Genesis Lifecycle (GENESIS-1 — implemented)

```
                 ┌─────────────────────────────────────────────┐
   owner signs   │  Verified Nostr session (auth.mjs)           │
   in (NIP-07) ─▶│  req.session.npub  = the ONLY authority       │
                 └───────────────┬─────────────────────────────┘
                                 │
        GET /api/constitution    │   POST /api/genesis {display_name,…}
        (public)                 │   (admin-gated, rate-limited)
                                 ▼
                    ┌────────────────────────────┐
                    │ core/genesis.mjs            │
                    │  ownerHex = decode(npub)    │  ← strict hex64
                    │  validate fields            │
                    │  idempotent? → return       │  ← retry never forks
                    │  build manifest + digest    │
                    │  atomic write (tmp+rename)  │  ← 0600 / 0700
                    │  audit.append('genesis…')   │  ← hash-chained
                    └────────────┬───────────────┘
                                 ▼
              memory/genesis/<ownerHex>/manifest.json
```

**States:** `absent` → (`create`) → `active`. Genesis is **one-time**: once a
manifest exists for an owner, `create` returns it unchanged (`created:false`).
There is no update and no delete API in GENESIS-1 (identity does not fork or
churn); a future amendment/migration flow is specified in §16.

**Idempotency contract:** a second `create` by the same owner — even with
different display fields — returns the *original* manifest. Retries are safe.

**Default-deny cross-owner:** reads/writes address only the caller's own
namespace (derived from their verified npub). One owner can neither see nor
overwrite another's manifest; it is structurally impossible, not policy-checked.

---

## 4. Humanitarian Constitution — Semantics, Versioning & the Three Layers

Implemented in `agent/lib/constitution.mjs`. The constitution is **Layer A** of
a three-layer principle architecture (see §4.2). Layer A is the minimal,
machine-enforceable floor; Layers B and C are prose docs.

- **Structured, deterministic data.** The constitution is a frozen JS object
  (schema `torii.continuum.constitution/1`), not prose-in-a-string. It has a
  `preamble`, four **articles** (the humanitarian tenets), five **genesis
  clauses** (owner-bound, explicit-command-only, default-deny, no-private-keys,
  provenance-not-drm), a set of **invariants** (added in genesis-1.1.0:
  selective-revelation, verify-dont-trust, four-freedoms-forkable; added in
  genesis-1.2.0: no-credential-custody), a set of **operating rules** (added in
  genesis-1.2.0: pareto-focus), and an **amendability** object that *honestly*
  enumerates what is and is not guaranteed.
- **Version registry (explicit selection strategy).** `constitution.mjs` holds a
  FROZEN registry of every constitution body ever shipped, keyed by version.
  `getConstitution()` returns the CURRENT version; `getConstitutionByVersion(v)`
  returns any historical body; `listConstitutionVersions()` enumerates them. New
  bodies are MINTED as new versions — a shipped body is never edited — so a
  manifest's pinned `(version, digest)` keeps verifying forever.
- **Stable digest.** `canonicalize()` performs a recursive key-sort (arrays keep
  order, non-finite numbers refused) → `digestOf()` SHA-256, reproducible across
  installs and restarts. Each registered version has its own locked digest:
  - **genesis-1.0.0 (historical, frozen):**
    `178ad323601455f92a345b286eef6c9628f2e71ff7f3f8ad856c16a37e775524`
  - **genesis-1.1.0 (historical, frozen):**
    `4761094b97937fa496b6e5280da8ff30a332d221429abf9195c35d99694a220e`
  - **genesis-1.2.0 (current):**
    `03f3e5b645d8f082a752642493b096ad628ff4cff94578a52e834d71104e6c7f`
  - All three are asserted in `agent/test/constitution.test.js`. Editing any shipped
    body breaks its lock — a digest can never drift silently, and a historical
    digest can never be silently rewritten.
- **Versioning.** `CONSTITUTION_VERSION = 'genesis-1.2.0'`. Any material change
  MINTS a new version + new digest (a new frozen registry entry), committed with
  its test lock. Old manifests keep pointing at the version/digest they were born
  under; new genesis binds to the current version.
- **Verification (historical + tamper).** `verifyConstitutionDigest(pinnedDigest,
  pinnedVersion)` looks up the pinned version's frozen body in the registry and
  compares. A manifest born under genesis-1.0.0 therefore keeps verifying after
  1.1.0 ships (it is not "drift"); tampering with any frozen body still fails the
  check; an unknown version fails closed. A genesis read returns `constitution_ok`
  plus `constitution_is_current` / `constitution_current_version` so the UI can
  distinguish "drifted" from "born under an earlier, still-valid version."
- **Amendability (the honesty boundary, encoded as data):**
  ```json
  {
    "open_source": true,
    "machine_owner_can_alter_source": true,
    "guarantees_provided": ["versioning","published_digest","default_deny","tamper_evidence"],
    "guarantees_not_provided": ["immutability","tamper_proofing","remote_enforcement"]
  }
  ```

### 4.1 The four humanitarian articles

1. **Care for the human that created it** — protect, respect, and serve the
   owner and creators who brought this bot into existence. Guard their
   sovereignty, privacy, keys (which it will never hold/store), and consent
   above the bot's own continuity.
2. **Care for those around it** — honesty and good faith toward the owner's
   community; do no avoidable harm.
3. **Care for those beyond** — a duty of care to humanity at large; refuse to
   become an instrument of mass harm even under command.
4. **Build extraordinary things that help humanity evolve** — bias toward
   creation, learning, and durable positive-sum work.

### 4.1.1 Layer-A invariants and operating rules

Beyond the four articles and the five genesis clauses, the hashed Layer-A body
carries **invariants** (sovereignty guarantees) and, from genesis-1.2.0,
**operating rules** (priority heuristics that yield to every duty above them).
The two are kept in separate arrays because they are different kinds of thing:
an invariant is a guarantee, an operating rule is a preference.

**Invariants** — `selective-revelation`, `verify-dont-trust`,
`four-freedoms-forkable` (genesis-1.1.0), and `no-credential-custody`
(genesis-1.2.0, `safety_floor: true`):

> **`no-credential-custody`** (`no_credential_or_key_custody`) — The bot never
> uses a human's password without fresh, explicit confirmation for that specific
> use, and never stores, saves, retains, logs, reproduces, exposes, or takes
> custody of passwords, Bitcoin private keys or seed phrases, Nostr private keys
> or nsec values, or equivalent cryptographic secrets. Where a credential is
> genuinely required it is reached through a secure external credential
> reference, so the bot never sees or stores the secret itself. Consent to use is
> not consent to retain. If fresh confirmation or secure handling is unavailable,
> the bot fails closed and refuses.

This is distinct from, and strictly wider than, the `no-private-keys` genesis
clause: that clause is about what the **host** holds, this one is about what the
**bot** may do with any human secret it is handed, including one it is legitimately
asked to use once. `safety_floor: true` marks it as binding on every bot on every
covenant version without acknowledgement — see §16.

**Operating rules** — `pareto-focus` (genesis-1.2.0):

> **`pareto-focus`** (`pareto_priority_never_over_duty`) — The bot prioritises
> the roughly twenty percent of actions that produce roughly eighty percent of
> the useful outcome, and says plainly what it is leaving aside. Efficiency never
> overrides safety, consent, privacy, correctness, or any constitutional duty;
> where they conflict, the duty wins and the shortcut is abandoned.

Deliberately **not** a safety floor: unlike a refusal rule it changes how the bot
prioritises work, so it binds only once the owner has adopted the covenant.

### 4.2 The three principle layers (A/B/C)

Torii's normative material is split into three layers with different
enforceability and amendment rules. This split is itself load-bearing: a tiny
set of invariants belongs in the machine constitution; operational preferences
belong in an amendable code; attributed philosophy belongs in a non-binding
canon. Do **not** put economic/philosophical preferences into hard refusal logic.

| Layer | Location | Nature | Amendment |
|---|---|---|---|
| **A — Constitution** | `agent/lib/constitution.mjs` | Minimal machine-readable invariants (enforceable floors/defaults) | New version + digest; historical versions frozen in the registry |
| **B — Code of Practice** | `docs/sovereign-ai-code-of-practice.md` (`cop-1.1.0`) | Operational rules → engineering/agent behaviour + acceptance tests; protocol/economic/openness preferences; privacy as selective disclosure; local/circular economy kept separate | Open PR + changelog + version bump |
| **C — Reference Canon** | `docs/sovereign-ai-reference-canon.md` (`canon-1.0.0`) | Attributed influences with exact source URLs; contested doctrine flagged, never elevated to authority | Additive |

`getConstitution()` and `GET /api/constitution` surface a `layers` block (the
Layer B/C doc paths + versions) and the **normative hierarchy** used for conflict
resolution: `law_safety_hard_refusal_of_clear_harm > owner_authority >
consent_and_privacy > humanitarian_care > operational_preferences >
advisory_references`. The Genesis UI renders these as plain text (no navigable
external links → no added XSS/nav surface). The layers block is **not** part of
the hashed constitution body — Layer A stays minimal.

**These layers are prerequisites/gates.** Per Layer B §10, no RAG or LoRA slice
ships until its gate items are satisfied — see §7.1 and §8 below.

---

## 5. Owner Authority & Nostr Binding

- Login is NIP-07 (kind 22242 challenge), verified server-side; the agent issues
  a self-verifying HMAC session token. `req.session.npub` is the verified owner.
- **The client never sends a pubkey to genesis.** `src/data/agent.js`
  `genesisCreate()` transmits only `{display_name, archetype, creative_intent}`.
  The route binds the owner from the session. This is enforced and tested on both
  sides (client test asserts no pubkey is forwarded even if injected; server
  derives owner solely from session).
- `ownerHexFromNpub()` decodes the npub via `nip19` and re-validates the result
  against `^[0-9a-f]{64}$` before it is ever used as a path segment.

---

## 6. Character / Identity Model

GENESIS-1 stores the **birth certificate** (manifest). The richer, editable
character stack (kinds 30092 character_root, 30094 semantic_fact, 30095
procedural_skill, …) is **sealed at rest via NIP-44 v2**, encrypted browser-side
to the owner's own npub; the agent holds no decryption key. The manifest and the
character stack are complementary: the manifest is immutable provenance; the
character stack is living, owner-editable, and consent-gated for writes.

The manifest's `policy.consent_required_for` enumerates the actions that will
require explicit owner consent as later stages come online:
`['external_action','paid_inference','memory_write','publishing','training']`.

---

## 7. LoRA Lifecycle (FORWARD SPEC — not built)

> **Not implemented.** The manifest records `provenance.lora = 'not-started'`.
> This section is the target contract.
>
> **GATE (Layer B §10).** No LoRA slice ships until: training data is
> curated-&-approved-only (unreviewed chats never included, fail-closed); adapter
> cards pin base model + dataset digest + the **current** constitution
> version/digest; training is owner-local by default. The constitution-version
> gate applies — a new adapter binds to the current constitution version with
> visible provenance, and historical pins are preserved.

### 7.1 Principles

- **Curated & approved only.** Training data is *never* auto-sourced from
  unreviewed chats. Every example enters a review queue and requires explicit
  owner approval before it is eligible.
- **Owner-local by default.** Fine-tuning runs against the owner's local model
  (Ollama, §12) or an owner-approved compute target. No training data leaves the
  owner's trust boundary without a scoped consent.
- **Provenance-stamped.** Each adapter records: base model + digest, the dataset
  manifest digest, the constitution version/digest in force, hyperparameters,
  and an audit line.

### 7.2 Lifecycle

```
draft example ─▶ review queue ─▶ owner APPROVE ─▶ dataset (append-only, digested)
      │                                                    │
      └── owner REJECT (dropped, audited)                  ▼
                                              train adapter (local/approved)
                                                           │
                                       adapter card + digest + audit line
                                                           │
                                              owner ACTIVATE adapter ─▶ prompt stack
```

### 7.3 Proposed data shapes

```jsonc
// training_example/1 (sealed like the character stack)
{ "schema":"torii.continuum.training_example/1",
  "id":"…","source":"chat|manual|import","status":"draft|approved|rejected",
  "prompt":"…","completion":"…","tags":["…"],
  "approved_by":"<npub>","approved_at":123, "review_note":"…" }

// lora_adapter_card/1 (provenance, plaintext + digest)
{ "schema":"torii.continuum.lora_adapter_card/1",
  "adapter_id":"…","base_model":"…","base_digest":"sha256:…",
  "dataset_digest":"sha256:…","constitution_version":"genesis-1.2.0",
  "hyperparams":{…},"created_at":123,"active":false,"card_digest":"…" }
```

### 7.4 Acceptance (future)

- **Given** an unreviewed chat, **when** training runs, **then** no unreviewed
  message is ever included (fail-closed if the review queue is bypassed).
- **Given** an approved dataset, **when** an adapter is trained, **then** its card
  pins the dataset digest and an audit line is appended.

---

## 8. RAG — Ingestion, Retrieval & Memory Lifecycle (FORWARD SPEC — not built)

> **Not implemented.** The manifest records `provenance.rag = 'not-started'`.
>
> **RAG-1 GATE (Layer B §10).** No retrieval slice ships until: retrieval is
> permission-filtered and consent-scoped (default-deny where scope is unclear);
> retrieved context is provenance-stamped and attributed in prompt assembly;
> sources are owner-added only (no silent crawling); deletion/forgetting is
> first-class; processing is local-first with remote inference consent-gated.
> These map to Code of Practice §3–§4 and are prerequisites, not aspirations.

### 8.1 Ingestion

- Sources are **explicitly added** by the owner (documents, notes, approved
  imports). No silent crawling.
- Each chunk is provenance-stamped (source id, offset, ingest time) and, where
  the source is private, sealed at rest.

### 8.2 Retrieval

- Retrieval is **consent-scoped**: a query only searches corpora the current
  action is authorized to touch. Default-deny where scope is unclear.
- Retrieved context is **attributed** in the prompt assembly (§9) so the bot can
  cite provenance and the owner can audit what informed a response.

### 8.3 Memory lifecycle

- **Working memory** (ephemeral, per-conversation) vs **durable memory**
  (owner-approved writes only — `memory_write` is a consent-gated action).
- Forgetting is first-class: an owner can delete durable memory; deletions are
  audited; emergency wipe (kind 30097) tears down the sealed stack.

### 8.4 Proposed shapes

```jsonc
// rag_source/1
{ "schema":"torii.continuum.rag_source/1","source_id":"…","kind":"doc|note|import",
  "added_by":"<npub>","added_at":123,"sealed":true }
// rag_chunk/1
{ "schema":"torii.continuum.rag_chunk/1","chunk_id":"…","source_id":"…",
  "offset":0,"text_sealed":"…","embedding_ref":"…","ingest_at":123 }
```

---

## 9. Prompt Assembly (FORWARD SPEC)

Deterministic, auditable layering, highest authority first:

```
1. Constitution (version + digest pinned)         ← immutable covenant
2. Genesis policy (command_mode, default_deny)     ← from manifest
3. Character root + approved semantic/procedural   ← sealed stack (owner)
4. Active LoRA adapter card reference               ← if any (§7)
5. Retrieved RAG context (attributed, scoped)       ← if authorized (§8)
6. Owner's explicit command / current turn
```

Each layer is provenance-tagged; the assembled prompt can be replayed and each
contribution attributed. Ambiguity at any layer resolves to **ask, don't act**.

---

## 10. Consent & Audit Model

- **Consent** is explicit, scoped, and per-action-class
  (`policy.consent_required_for`). One approval authorizes one scope.
- **Audit** (`agent/lib/audit.mjs`) is an append-only, hash-chained JSONL ledger.
  Each line: `{seq, at, event, prev, …payload, hash}` where
  `hash = sha256(canonical(body))` and `prev` links to the previous line's hash
  (seed `torii.continuum.audit/1/genesis` for the first). `verify()` walks the
  chain and returns the first break point. Appends are serialized through an
  in-process promise queue so concurrent writers cannot fork the chain.
- **Genesis creation** appends a `genesis.create` line (bot_id, owner prefix,
  constitution version+digest, manifest digest, command_mode). A failed audit
  append is loud but never rolls back a successful genesis (the manifest exists;
  the ledger just missed a line — surfaced in logs).
- This is tamper **evidence**, not tamper **proofing** (§2, §4).

---

## 11. Encryption & Key Boundaries

- **No owner private keys on the host, ever.** Signing + sealed-stack decryption
  are browser-side.
- **Agent secretstore** (`agent/lib/secretstore.mjs`): AES-256-GCM + HKDF keyed
  by `session_secret`, with info-string domain separation per secret; fails
  closed on tamper/wrong-key; files 0600. Used for agent-held operational
  secrets (NWC URI, Routstr key) — never owner identity keys.
- **Manifest** is provenance, not secret → plaintext JSON, 0600, with its own
  digest for integrity.
- **Character/memory stack** → NIP-44 v2 ciphertext, owner-decryptable only.

---

## 12. Local Ollama Integration (FORWARD SPEC)

- Inference defaults to the owner's **local Ollama** where available; paid remote
  inference (Routstr) is a **consent-gated** action (`paid_inference`).
- LoRA adapters (§7) target the local model first. Model identity + digest are
  pinned in adapter cards and prompt assembly so responses are attributable to a
  specific base + adapter.
- Health probing already exists (`/api/health/models`, admin-gated) reporting
  strategy + routstr + ollama shape.

---

## 13. UI Surfaces

**Implemented (GENESIS-1):** a `/genesis` route (guarded, in the sidebar) that:

- When **no manifest** exists: shows a creation form (display name required;
  archetype + creative intent optional) plus the **full constitution preview**
  (version, digest, preamble, the four tenets) and an explicit note that defaults
  at birth are owner-bound · explicit-command-only · default-deny, and that
  **LoRA training and RAG memory are subsequent stages, not active at genesis**.
- When a **manifest** exists: shows a provenance card (bot_id, owner short npub,
  constitution version+digest, command_mode, timestamps, creative intent) with
  **tamper-evidence badges** (`constitution_ok`, `manifest_digest_ok`) and the
  provenance stage line (`lora: not-started`, `rag: not-started`).

Rendering uses the XSS-safe `h()` builder (`textContent` only). Visual language,
accessibility (`role="alert"` on the error line, keyboard submit), and mobile
behaviour follow the existing `team.js`/card patterns. Offline (demo build with
no agent) degrades to an honest "agent offline" card.

**Future:** character editor, training review queue + approval, RAG source
manager, consent prompts, adapter activation.

---

## 14. Failure Modes

| Failure | Behaviour |
|---|---|
| Corrupt manifest on disk | Hard error on read/create (never treated as "absent" — prevents identity fork) |
| Torn write mid-create | temp+rename means the target is never partially written |
| Audit append fails after create | Genesis stands; error logged loudly; ledger missing one line (detectable) |
| Constitution drift | `constitution_ok=false` surfaced in UI + read response |
| Manifest field tampered | `manifest_digest_ok=false` surfaced |
| Agent unreachable (demo) | Client short-circuits `{offline:true}`; UI shows offline card |
| Session expired (401) | Client clears token; UI drops to logged-out |

---

## 15. Observability

- Structured logs on genesis create/idempotent-read and every audit append
  (`[audit] <event> seq=… hash=…`).
- `audit.verify()` is the integrity probe (chain ok + count, or break point).
- Existing `/api/health` + `/api/health/models` unchanged. Genesis adds no
  secret-bearing telemetry.

---

## 16. Migration

- **v1 manifest** is forward-compatible: an `extensions:{}` object is reserved for
  additive fields without a schema bump. `manifest_version` gates any breaking
  change.
- The **amendment flow** is implemented as of genesis-1.2.0 (`acknowledgeConstitution`
  in `agent/core/genesis.mjs`, `POST /api/genesis/constitution/acknowledge`). It
  is a two-tier migration, and the split is the whole design:
  - **Adoption requires explicit owner acknowledgement.** Silently rebinding a
    live bot to text its owner never read would be precisely the unconsented
    change `explicit-command-only` and `default-deny` exist to prevent, and it
    would destroy the provenance the pinned digest is for. So `constitution.version`
    and `constitution.digest` — the version the bot was BORN under — are **never
    rewritten**. Adoption is recorded *alongside* them as `acknowledged_version` /
    `acknowledged_digest` / `acknowledged_at`, plus an append-only
    `constitution_acknowledgements[]` history. That is what makes this a migration
    rather than a forgery: both covenants stay verifiable forever.
  - **`safety_floor: true` rules bind immediately, with no acknowledgement.** A
    floor rule can only ever cause the bot to REFUSE — never to act, spend,
    publish, or retain. Withholding one pending a click would leave every already
    activated bot *permitted* to do the exact thing the rule forbids in the
    meantime. `no-credential-custody` qualifies and is marked accordingly. The
    Pareto rule deliberately is **not** a floor: it changes prioritisation rather
    than only adding refusals, so it binds only after the owner adopts.
  - The call **fails closed** on every uncertainty — `bad_owner`, `no_manifest`,
    `unknown_version`, `not_current` (only the current covenant may be adopted),
    and `digest_mismatch` (the (version, digest) pair the client displayed must be
    the bytes the agent holds, so a stale or doctored card cannot obtain consent
    to text the owner never saw). It is idempotent (`acknowledged:false` on a
    repeat) and appends a `genesis.constitution.acknowledge` audit line.
  - `read()` returns a `constitution_upgrade` descriptor (`active_version`,
    `upgrade_available`, `acknowledgement_required`, `safety_floor_rule_ids`,
    `newly_binding_rule_ids`) so the UI can state exactly what already binds and
    what adoption would add.
- No migration is required for GENESIS-1 (new feature, new namespace).

---

## 17. Staged Rollout

1. **GENESIS-1 (done):** constitution + audit + genesis manifest + minimal UI.
2. **CHARACTER-*:** sealed character editor wired to prompt assembly.
3. **RAG-*:** owner-added sources, scoped retrieval, durable memory + forgetting.
4. **LORA-*:** review queue → approval → local training → adapter activation.
5. **MULTI-TENANT-*:** many owners per instance, relay-synced identity.

---

## 18. Requirements (P0/P1/P2)

**P0 (GENESIS-1 — shipped):**
- Deterministic versioned constitution with stable digest + provenance.
- Owner-bound manifest from verified session (never body); one-time + idempotent;
  default-deny cross-owner; no key material.
- Atomic, restrictive-permission persistence.
- Minimal create/inspect UI; honest LoRA/RAG labelling.
- Hash-chained audit entry on creation.
- Comprehensive tests + green build.
- Security review (IDOR, traversal, XSS, session spoofing, perms, key material).

**P1 (next):** character editor + prompt assembly v1; consent prompts; RAG source
manager (read-only ingestion).

**P2 (later):** LoRA review/training/activation; multi-tenant hosting; relay sync.

---

## 19. Acceptance Criteria (Given/When/Then)

- **Given** a logged-in owner with no manifest, **when** they POST valid
  `display_name`, **then** a manifest is created (`201`, `created:true`) bound to
  their session npub, pinning the live constitution version+digest.
- **Given** an existing manifest, **when** the same owner POSTs again with
  different fields, **then** the original manifest is returned unchanged
  (`200`, `created:false`) — no second identity.
- **Given** a request body containing another owner's pubkey, **when** genesis is
  created, **then** the body pubkey is ignored and the owner is the session npub.
- **Given** owner A's manifest, **when** owner B reads genesis, **then** B sees
  `exists:false` (no cross-owner disclosure).
- **Given** a manifest edited on disk, **when** it is read, **then**
  `manifest_digest_ok:false`.
- **Given** the constitution text is changed without a version bump, **when** the
  suite runs, **then** the locked-digest test fails.
- **Given** a manifest born under genesis-1.0.0, **when** it is read after a
  later version has shipped, **then** it still verifies (`constitution_ok:true`)
  against the frozen 1.0.0 body and is flagged `constitution_is_current:false` —
  an earlier valid covenant, not drift.
- **Given** an already-activated bot on an earlier covenant, **when** its owner
  acknowledges the current version with the digest they were shown, **then** the
  birth `constitution.version`/`digest` are unchanged and `acknowledged_version`
  plus an append-only acknowledgement entry are added.
- **Given** an acknowledge call naming a version that is not current, or a digest
  that does not match that version's frozen bytes, **then** it fails closed
  (`not_current` / `digest_mismatch`) and nothing is written.
- **Given** any manifest on any covenant version, **when** its upgrade state is
  described, **then** `no-credential-custody` is reported as already binding
  (safety floor) and never as "newly binding on adoption".
- **Given** a pinned digest with an unknown constitution version, **when** it is
  verified, **then** it fails closed.
- **Given** an audit line is edited or removed, **when** `verify()` runs, **then**
  it returns `ok:false` at the break point.
- **Given** the constitution UI, **when** rendered, **then** LoRA and RAG are
  shown as subsequent stages and no training/retrieval is performed.

---

## 20. Tests

**Agent (`node --test`):**
- `constitution.test.js` — current digest lock (`03f3e5b6…`, genesis-1.2.0),
  **historical digest locks (`4761094b…` genesis-1.1.0, `178ad323…`
  genesis-1.0.0)**, registry listing + version selection, reproducibility,
  canonical key-order independence, non-finite refusal, verify accept (current +
  historical), fail-closed on tampered digest / unknown version /
  right-digest-wrong-version, honest amendability, the genesis-1.1.0 invariants,
  the genesis-1.2.0 `no-credential-custody` invariant + `pareto-focus` operating
  rule with every normative requirement asserted, the exact replaced article
  wording, the **absence** of the replaced wording from the current body,
  `getSafetyFloor()`, `constitutionUpgrade()`, and the layers/hierarchy provenance.
- `genesis.test.js` — npub decode/reject, owner-bound create, idempotency (no
  fork), validation + length bounds, default-deny cross-owner, tamper evidence,
  0600/0700 perms, audit line appended + verifies, and
  `acknowledgeConstitution()` (birth pin preserved, history appended, digest
  recomputed, idempotent, and all five fail-closed codes).
- `audit.test.js` — chain forms + verifies, edited-line + removed-line detection,
  concurrent-append serialization, 0600 perms, empty-log ok.

**Frontend (`vitest`):**
- `src/data/agent.test.js` — constitution/genesisRead GET shapes; **genesisCreate
  sends only display fields and never a pubkey/owner even if injected**; offline
  short-circuit.
- `src/views/genesis-structure.test.js` — no pubkey input; XSS-safe (`h()`, no
  raw HTML, no `href`/anchor/`window.open`); LoRA/RAG labelled subsequent; digest
  surfaced; tamper flags shown; earlier-valid-covenant distinguished from
  tampering; Layer B/C provenance + normative hierarchy + invariants rendered.

**Whole-suite gates:** full `vitest run`, full agent `node --test`, `npm run build`.

---

## 21. Non-Goals

- Making the constitution unalterable by the machine owner (impossible; we do
  tamper-evidence instead).
- Holding owner private keys or signing server-side.
- Auto-sourcing training data from unreviewed chats.
- Faking LoRA/RAG in the shipped slice.
- Multi-tenant hosting in GENESIS-1.

---

## 22. Open Questions

1. **Constitution amendment UX** — how does an owner opt into a new constitution
   version, and how is the old covenant pin preserved + shown?
2. **Adapter portability** — should LoRA adapters be exportable/signable as Nostr
   events for backup and cross-instance restore?
3. **RAG embedding store** — local vector index choice under the minimal-footprint
   constraint (sqlite-vss vs. flat + brute force at small scale).
4. **Multi-owner audit isolation** — one chain per owner vs. one host chain with
   per-owner scoping.
5. **Consent granularity** — per-action vs. per-session standing consent, and how
   revocation propagates.
```

---

*Locked constitution digests:*
- genesis-1.2.0 (current): `03f3e5b645d8f082a752642493b096ad628ff4cff94578a52e834d71104e6c7f`
- genesis-1.1.0 (historical, frozen): `4761094b97937fa496b6e5280da8ff30a332d221429abf9195c35d99694a220e`
- genesis-1.0.0 (historical, frozen): `178ad323601455f92a345b286eef6c9628f2e71ff7f3f8ad856c16a37e775524`

*Related layers:* Code of Practice — `docs/sovereign-ai-code-of-practice.md`
(`cop-1.1.0`); Reference Canon — `docs/sovereign-ai-reference-canon.md`
(`canon-1.0.0`).
