# Memory inventory consolidation (audit A09)

**Status:** Accepted — read-path, write-path collapse, and export boundary all landed (v0.2.150 + v0.2.151).
**Scope:** `torii-continuum` agent memory storage lifecycles.

## Context

The agent has two memory storage backends that have drifted apart, and their
read paths disagree — the audit finding **A09** ("legacy and scoped memory have
incompatible read/export lifecycles").

1. **Flat kind directories** (`agent/memory/{character,semantic,procedural,intents,panic}/`,
   routed by `dirForKind` in `agent/lib/events.mjs`). Written by the operator's
   browser-signed `POST /api/memory/store`, and read by `GET /api/memory/ciphertexts`
   → browser decrypt → `POST /api/memory/activate` → `memoryCache.unlock()`.

2. **Scoped memstore** (`agent/lib/memstore.mjs`, layout
   `owners/<hex>/bots/<bot>/projects/<project>/<class>/`). Written by the
   consent flow (`propose → approve → memstore.put`) and read by portability
   export/import and the items list UI.

The two disagree: approving a memory into the scoped store makes it **absent**
from the activation enumeration, and identity files are **absent** from scoped
export. User-visible memory can therefore appear missing.

There is **no legacy data to preserve** (fresh build), so the audit's
"migration adapters" are moot — this is a consolidation, not a migration.

## Decision

- **The scoped store is the single durable source of truth** for memory
  classes: `semantic` (kind 30094), `procedural` (30095), `conversation`,
  `episodic`, and `project`.
- **Identity, destructive intents, and the panic key stay flat and owner-level**:
  - `character_root` (30092) — single-writer identity, hash-verified against
    `CHARACTER.md`. Not "memory to export"; it is identity/provenance.
  - `destructive_intent` (30096) — double-signature safety authorizations with
    cooldown.
  - `emergency_wipe` / panic key (30097) — published once from a cold device,
    kept offline; collapses destructive intent to single-sig on an emergency
    wipe.
  These have no bot or project, so the scoped store's `owner → bot → project →
  class` hierarchy is the wrong shape for them, and they must not inherit the
  scoped store's quota/retention/dedupe behavior (a retention reap must never
  be able to delete the panic key or identity).

## Privacy invariants (unchanged)

Memory is **ciphertext at rest**. The agent never sees plaintext except during
an unlocked session, when the browser NIP-44-decrypts each blob and posts the
plaintext `{kind, d_tag, content}` entries to `activate`/`unlock`. AI-generated
durable memory always requires explicit operator approval against the reviewed
payload hash. Identity/intents/panic remain owner-private, mode 0600.

## Change (implemented)

`GET /api/memory/ciphertexts` (the activation enumeration) now returns a single
unified list:

- **scoped store** items for every class (`memstore.listAllForOwner`) — this is
  the missing half: approved scoped memory now appears for unlock; and
- **flat** identity/intents/panic directories (`character`, `intents`, `panic`)
  only — the flat `semantic`/`procedural` dirs are no longer read, because new
  facts/skills now land in the scoped store.

Each entry carries the shape the browser's `decryptEntries` expects:
`{ kind, d_tag, ciphertext }` (scoped entries additionally carry `class`,
`scope`, `sha256`, `integrity_ok`).

`POST /api/memory/store` now routes facts (`30094`) and skills (`30095`) into
the scoped store (`memstore.put`, `_global` project, genesis `bot_id`), so new
facts/skills land in exactly one place; identity root (`30092`), destructive
intents (`30096`) and the panic key (`30097`) stay flat.

Portability `buildBundle` now returns an `excluded` list naming identity,
intents, and panic as **intentionally** not portable, rather than silently
omitting them.

## Remaining follow-up

**Scope-aware unlock cache.** The RAM cache keys `${kind}:${dTag}` (flat). If
an operator later stores the same kind+d-tag under two projects, the flat
prompt cache would shadow one. Resolve by making the unlock key scope-aware
(`${kind}:${project}:${dTag}`) when the scoped store is the only source —
deferred because the operator's own agent is flat in practice today.

## Regression requirements

A09's proofs: legacy fact + approved scoped fact, restart, activation,
export/import, per-item deletion, full inventory reconciliation — with
intentional exclusions (identity/intents from export) named explicitly.