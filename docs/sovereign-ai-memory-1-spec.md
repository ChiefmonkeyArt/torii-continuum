# Torii Continuum — Sovereign AI: MEMORY-1 Technical Specification

Status: **Implementation-grade** · Shipped: **MEMORY-1** (v0.2.82-alpha) · Privacy patch: **v0.2.83-alpha — ciphertext-only proposals** (supersedes v0.2.82-alpha; see §3) · Full embeddings / vector retrieval: **deferred to RAG-1** · Relay publication & automatic multi-device sync: **deferred/disabled**

> **v0.2.83-alpha correction.** v0.2.82-alpha's `propose()` persisted a pending
> proposal that contained the **plaintext** payload on the server filesystem,
> contradicting the encrypted-at-rest guarantee. That is fixed: proposals are now
> **ciphertext-only from creation onward** (sealed in the browser before they
> reach the agent), reviewed by client-side decryption, and any legacy plaintext
> proposal is purged on startup. Treat v0.2.82-alpha as **superseded**.

> This document is the durable design contract for Torii Continuum's persistent
> memory slice. MEMORY-1 gives a sovereign bot **encrypted-at-rest, owner-
> controlled, consent-gated** durable memory, scoped by owner + bot + project,
> with a manual owner-signed portability foundation. It deliberately does **not**
> introduce a vector database or embeddings — retrieval-by-similarity is RAG-1.
> Anywhere retrieval is mentioned here it is the exact-scope fetch MEMORY-1 does,
> never semantic search, and the running system does not fake vector RAG.

---

## 1. Problem & Vision

A sovereign bot that forgets everything between turns is not sovereign — it is
stateless rented compute wearing a name. But naïve "memory" is worse than none:
a bot that silently persists what it infers about its owner, stores it where a
platform can read it, or carries it across project boundaries has quietly become
a surveillance surface. MEMORY-1 resolves the tension with four hard rules:

1. **Encrypted at rest, sealed in the browser.** Every durable memory is
   NIP-44-encrypted client-side. The agent stores and returns **ciphertext
   only** — it never sees plaintext and never holds a key.
2. **Nothing durable without explicit consent — and proposals are ciphertext
   too.** AI (or "remember this") suggestions are **proposals**. They are never
   auto-persisted, and they are **sealed from the moment they are created**: the
   browser NIP-44-encrypts the proposed payload to the owner's own key and sends
   the agent only the ciphertext + a canonical-plaintext hash + minimal metadata.
   The owner reviews by **decrypting the ciphertext client-side**; approval is
   bound to the exact reviewed payload hash and a single-use nonce, and promotes
   the already-sealed blob. No plaintext memory is written at any stage — at
   proposal creation, in the pending store, in logs, or in the audit ledger.
3. **Isolated by owner + bot + project.** Continuum is a project engine. Memory
   in project *A* is invisible to project *B*, one owner's memory is invisible to
   another, and one bot's memory is invisible to another — enforced by
   path-segment validation, default-deny, and owner derivation from the verified
   session (never the request body).
4. **The owner's data is portable and the owner's alone.** Export produces an
   owner-signed bundle of ciphertexts only; import verifies signature/owner/
   hashes and **quarantines** — nothing imported is trusted automatically, and
   nothing is ever published to a relay.

Kind 30092 (`character_root`) remains **identity/policy/provenance only** and
never carries memory contents — MEMORY-1 does not touch it.

---

## 2. Storage model

### 2.1 Single writable root

All durable agent state lives under one systemd-writable root, `agent/memory/`
(`ReadWritePaths=…/memory`). Under `ProtectSystem=strict` the rest of the tree
is read-only to the service, so any write target outside `memory/` fails with
EROFS at runtime. MEMORY-1 fixes the last offender: `dirForKind(PROCEDURAL_SKILL)`
formerly routed to the read-only `skills/` tree; it now returns `memory/procedural`
(`agent/lib/events.mjs`). `legacyDirForKind()` records the old `skills/` path so a
pre-MEMORY-1 ciphertext is still discoverable for read-time re-homing.

### 2.2 Scoped layout (`agent/lib/memstore.mjs`)

```
memory/
  owners/<ownerHex>/bots/<botId>/projects/<projectSlug>/<class>/<id>.enc
  owners/<ownerHex>/bots/<botId>/quarantine/<sha256>.json
  owners/<ownerHex>/bots/<botId>/pending/<id>.json    # ciphertext-only proposal
  owners/<ownerHex>/bots/<botId>/tombstones/<id>.json
  audit.jsonl                         # hash-chained tamper-evident ledger
```

A pending proposal file (`pending/<id>.json`) holds **only** the sealed
`ciphertext`, its `ciphertext_sha256`, the client-computed `payload_sha256`, the
scope (owner/bot/project/class/kind), a slug `d_tag`, the single-use
`approval_nonce`, and status timestamps. It **never** contains a `payload`,
`evidence`, or any other plaintext field. (The pre-`v0.2.83-alpha` schema
`memory_proposal/1` did carry a plaintext `payload`; it is retired and actively
purged on startup — see §3.)

- `ownerHex` is the strict 64-hex pubkey derived from the **verified session**
  via `ownerHexFromNpub()` — never from the request body.
- `botId`, `projectSlug`, `class`, and `id` are each validated against a strict
  allowlist (`[a-z0-9_-]`, bounded length). Any `.` / `/` / `\` / traversal
  segment is rejected before a path is constructed (`put` returns `{ok:false}`).
- Empty project ⇒ the reserved sentinel `GLOBAL_PROJECT = '_global'`.

### 2.3 Memory classes & retention

| class        | kind  | permanence     | default retention |
|--------------|-------|----------------|-------------------|
| conversation | —     | not-permanent  | 7 days (reaped)   |
| episodic     | —     | not-permanent  | 365 days          |
| semantic     | 30094 | permanent      | never             |
| procedural   | 30095 | permanent      | never             |
| project      | —     | permanent      | never             |

`applyRetention()` reaps expired non-permanent items (unlink + tombstone).
Permanent classes are never auto-reaped; only an explicit owner delete removes
them.

### 2.4 Integrity, atomicity, quotas

- **Integrity:** each index record pins the `sha256` of its ciphertext. `read()`
  recomputes and returns `{ok:false, corrupt:true}` on mismatch (tamper/bit-rot);
  `verifyScope()` re-hashes an entire scope and reports every problem.
- **Atomicity:** writes go to a randomly-suffixed temp file (`randomBytes(8)`)
  then `rename()` into place; dirs are `0700`, files `0600`.
- **Bounds & quotas:** `MAX_ITEM_BYTES = 65535`; `DEFAULT_QUOTAS =
  { perScopeItems: 500, perScopeBytes: 8 MiB, perOwnerBytes: 64 MiB }`. `put`
  fails closed with `code: 'too_large' | 'quota_items' | 'quota_bytes'`.
- **Recovery:** orphan temp files are ignored by `list()` (only `*.enc` are
  indexed) and cleaned opportunistically; a corrupt index for a scope is flagged
  (`index_corrupt`) while the underlying `.enc` files are preserved.

### 2.5 Deletion (honest limits)

`remove()` unlinks the `.enc`, drops the index record, and appends a tombstone +
audit line. This is honest local deletion: it cannot recall an exported bundle
the owner already downloaded, and it is tamper-**evidence**, not tamper-proofing.
The UI states these limits plainly.

---

## 3. Consent & audit (`agent/lib/consent.mjs`)

The proposal → approval state machine is the only path to durable memory, and
it is **ciphertext-only from proposal creation onward** — the server never
receives, stores, logs, or audits memory plaintext at any stage.

1. `propose({ ciphertext, payloadSha256, … })` writes a pending proposal
   containing **only** the browser-sealed `ciphertext`, its `ciphertext_sha256`,
   the client-computed `payload_sha256`, scope metadata, a slug `d_tag`, and a
   fresh `approval_nonce`. A plaintext `payload` in the request is **refused**
   (`code:'plaintext_refused'`). **Nothing durable is written.**
2. `approve({ expectPayloadSha256, approvalNonce })` — note there is **no
   `ciphertext` parameter**; the sealed blob is already on the proposal:
   - **Hash binding** — `expectPayloadSha256` must equal the stored
     `payload_sha256`, else `code:'hash_mismatch'`. The owner can only ratify the
     exact bytes reviewed (reviewed by decrypting the ciphertext client-side).
   - **Single-use nonce** — a spent nonce cannot be replayed; a second approve on
     an already-approved proposal short-circuits `idempotent:true` (no double
     store).
   - **Atomic promotion** — the agent moves the already-sealed ciphertext into
     the durable scoped store via `memstore.put`, pinned by `expectSha256 =
     ciphertext_sha256`; the pending ciphertext is then dropped. The server never
     sees plaintext or a key.
3. `reject()` **securely unlinks** the pending ciphertext file (no rejected shell
   left on disk) and audits metadata/hashes only.
4. `migratePlaintextProposals()` runs once at startup: it detects any retired
   `memory_proposal/1` file (or a stray `payload`/`evidence` field), unlinks it
   **without reading or logging its content**, records a metadata-only audit
   entry, and never surfaces it through any API.

Cross-owner/bot/project approval is **default-deny** (owner from session, scope
from the proposal). Every proposal/approve/reject/delete/export/import/migrate
action appends only non-sensitive hashes + metadata to the hash-chained
`memory/audit.jsonl` (`agent/lib/audit.mjs`) — never memory plaintext.

### 3.1 Safe metadata fields & limits

Because proposal/stored metadata is not encrypted, the surface that could leak
memory text is deliberately minimal and constrained:

| field              | source            | constraint                                   |
|--------------------|-------------------|----------------------------------------------|
| `d_tag`            | caller            | slug `^[a-z0-9][a-z0-9_-]{0,63}$` (no free text) |
| `project`          | caller            | slug (same charset) or `_global`             |
| `class` / `kind`   | fixed enum        | one of the known classes / 30094-30097       |
| `payload_sha256`   | browser           | 64-hex digest (opaque)                        |
| `ciphertext_sha256`| agent             | 64-hex digest (opaque)                        |
| `source`           | fixed enum        | `reflect` \| `owner-command`                  |
| timestamps/nonce   | agent             | integers / hex (opaque)                       |

No title, description, preview, or evidence field exists on the proposal. The
only owner-supplied free-form value is the payload itself — which is always
sealed. `d_tag` is intentionally a slug so it cannot smuggle memory text through
the metadata plane.

---

## 4. Working values (`agent/lib/workingvalues.mjs`)

`buildWorkingValues()` returns a compact, **deterministic**, versioned header
carrying the live constitution + Code-of-Practice provenance
(`constitution_version`, `constitution_digest`, `code_of_practice_version`,
`header_sha256`). It is injected **above** the character prompt and **above** any
retrieved memory on every eligible turn (`agent/skills/chat.mjs`), so values
outrank both character and memory.

Retrieved or imported memory is wrapped by `fenceUntrusted()` inside the
`DATA_FENCE` boundary and labelled **untrusted data, never instructions** —
the prompt-injection / memory-poisoning mitigation. The Reference Canon stays
advisory (not injected). `chat.mjs` logs the provenance
(`constitution/COP version + header hash prefix`) for diagnostics.

---

## 5. Manual encrypted portability (`agent/lib/portability.mjs`)

- **Bundle:** `schema = 'torii.continuum.memory_bundle/1'`,
  `BUNDLE_FORMAT_VERSION = 1`, `MAX_BUNDLE_ITEMS = 2000`. Items are
  **ciphertexts only** + metadata (class/kind/d_tag/scope/sha256).
- **Deterministic manifest:** `buildManifest()` sorts items canonically so the
  same set always yields the same `manifest_digest` (order-independent).
- **Owner-signed:** the browser signs the manifest digest with NIP-07 under a
  **detached signing-only** kind `BUNDLE_SIG_KIND = 30099` (never a memory event,
  never published to a relay). Export requires `confirm:true`; the private key
  never leaves the browser.
- **Import = default-deny + quarantine:** `verifyBundle()` rejects a foreign
  owner, a tampered ciphertext (hash mismatch), a tampered manifest (digest
  mismatch), or a bad/wrong-key signature. Accepted items go to **quarantine**,
  never live memory; re-import dedupes by sha256. `approveQuarantine()` promotes
  a reviewed item into live memory; `rejectQuarantine()` discards it.

Actual relay publication and automatic multi-device sync are **out of scope**
for MEMORY-1 (deferred). The bundle format is the forward-compatible foundation.

---

## 6. API surface (agent, all admin-gated except where noted)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/memory/working-values` | live constitution/COP provenance (no secrets) |
| GET  | `/api/memory/usage` | per-owner usage, quotas, per-scope breakdown |
| GET  | `/api/memory/scoped?project=&class=` | item metadata for a scope (no ciphertext) |
| POST | `/api/memory/scoped/verify` | recompute hashes (corruption check) |
| POST | `/api/memory/scoped/delete` | unlink + tombstone + audit (requires `confirm`) |
| GET  | `/api/memory/proposals` | pending proposals |
| POST | `/api/memory/proposals` | create a pending proposal (never auto-persisted) |
| POST | `/api/memory/proposals/:id/approve` | ratify exact payload (ciphertext + hash + nonce) |
| POST | `/api/memory/proposals/:id/reject` | explicit, audited rejection |
| POST | `/api/memory/export` | assemble UNSIGNED bundle for browser to sign (requires `confirm`) |
| POST | `/api/memory/import` | verify a signed bundle → quarantine (default-deny) |
| GET  | `/api/memory/quarantine` | imported, untrusted items awaiting approval |
| POST | `/api/memory/quarantine/:sha/approve` | promote a reviewed item into live memory |
| POST | `/api/memory/quarantine/:sha/reject` | discard a quarantine item |

Client wrappers live in `src/data/agent.js`; the owner console is
`src/views/memory.js` (route `/memory`, sidebar "Memory"). All rendering is via
the XSS-safe `h()` builder (textContent only, no raw HTML).

---

## 7. Security model & threats addressed

| Threat | Mitigation |
|--------|------------|
| IDOR / cross-owner read/write | owner from verified session; scope path segments strictly validated; default-deny |
| Path traversal / symlink | allowlist segment validation; temp+rename; no user-controlled absolute paths |
| Plaintext/key exposure at agent | NIP-44 sealing in browser; agent stores ciphertext only; no key material on host |
| Silent memory persistence | proposals never auto-persist; approval bound to exact hash + single-use nonce |
| Replay / CSRF on approval | single-use nonce; idempotent approve; admin session gate |
| Tampering / corruption | per-item sha256; `read()`/`verifyScope()` fail closed; hash-chained audit |
| Prompt injection / memory poisoning | working-values header outranks memory; retrieved text fenced as untrusted data |
| Cross-project leakage | project is a required scope segment; `_global` is explicit, never implicit |
| Disk exhaustion | per-item byte cap + per-scope + per-owner quotas; retention reaping |
| Foreign / tampered import (zip-traversal, poisoned bundle) | signature + owner + manifest + per-item hash verify; default-deny; quarantine, never live |
| XSS in console | `h()` textContent-only rendering; no innerHTML/href/window.open |

---

## 8. Testing

- **Agent (`agent/test/memory1.test.js`, `node --test`):** memstore round-trip,
  owner isolation, traversal rejection, integrity/tamper detection, per-item +
  per-scope quotas, delete unlink+tombstone, retention reaping; consent
  hash+nonce binding, idempotent replay, reject-never-stores; portability
  deterministic manifest, signed-verify, **default-deny** (foreign owner /
  tampered ciphertext / tampered manifest / wrong key), quarantine + dedupe +
  approve-out, foreign-import deny; working-values determinism + `fenceUntrusted`.
- **Frontend (`vitest`):** `src/data/agent-memory.test.js` locks every endpoint,
  method, and body shape (approve sends ciphertext-only, delete/export send
  `confirm:true`, path segments encoded, offline short-circuits with no fetch);
  `src/views/memory-structure.test.js` locks XSS-safe rendering, browser-side
  sealing, explicit-consent wording, browser-signed non-published portability,
  and quarantine-on-import.

Full suites green at ship: agent `node --test` (286), frontend `vitest` (401),
production `vite build` clean.

---

## 9. Deferred to later slices

- **RAG-1:** embeddings + vector similarity retrieval, permission-filtered and
  consent-scoped, provenance-stamped. MEMORY-1 does exact-scope fetch only.
- **Sync:** relay publication and automatic multi-device sync. MEMORY-1 ships the
  owner-signed bundle format as the manual, opt-in foundation.
