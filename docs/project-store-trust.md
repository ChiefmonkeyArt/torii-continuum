# ADR — Project store trust model (OWNER-UI-2)

**Status:** Accepted (2026-09-13) · **Scope:** the owner's project document — projects, milestones, todos, board columns/cards, files, market tasks, the Routstr profile, and the operator roster.

## Decision

The project store moves from browser `localStorage` (`src/data/store.js`) to a single server-resident document on the operator's VPS, **encrypted at rest with AES-256-GCM** keyed by `session_secret` via HKDF (`agent/lib/secretstore.mjs`), served over `GET`/`PUT /api/store` behind the existing admin session gate.

The store is **server-side-encrypted, not client-sealed**. The agent holds the plaintext in RAM and can read *and* write it itself. This is deliberately different from the two adjacent stores:

| Store | Trust model | Why |
|---|---|---|
| Memory (`memstore`) | Client-sealed — browser NIP-44 to owner npub; agent holds no key | Agent only ever relays it; may hold secrets |
| Sessions (`sessions`) | Client-sealed — browser NIP-44; agent holds no key | Private owner chat; agent never persists plaintext |
| **Project store** | **Server-side encrypted at rest; agent can read/write** | **Agent must mutate it (OWNER-UI-3 write bridge) with no browser in the loop** |

## Why not client-seal

OWNER-UI-3 requires the owner AI to create/update milestones and todos itself. A client-sealed store would make that impossible — the agent cannot decrypt NIP-44-to-owner ciphertext, only relay it. The project store is the one class of data the agent *legitimately* needs plaintext access to, which is exactly the case `secretstore.mjs` was built for (the same reason an NWC URI and a Routstr key are server-side-encrypted rather than NIP-44-sealed).

## Security posture

- **At rest:** the on-disk blob is AES-256-GCM ciphertext (mode `0600`), key derived from `session_secret` with domain-separated HKDF info (`torii-continuum/secretstore/v1/project_store`). Rotating `session_secret` renders it undecryptable — fail closed.
- **In transit / authorization:** `GET`/`PUT /api/store` are `requireAdmin`-gated. The public NPC is a separate, sealed-out process (`hermes-owner` vs the NPC user home) and never reaches this route.
- **Never relay-published:** format ("Nostr-shaped", signed, addressable) and location are separate decisions. This document is private owner state; nothing is broadcast to a relay without an explicit, separate owner opt-in.
- **Privilege boundary unchanged:** the two-voice split (`docs/hermes-two-voice.md`) is untouched — this only changes where the *owner's* project data lives.

## Consequences

- **Accepted:** single-writer, last-write-wins. A single-operator tool does not need multi-writer coordination beyond the admin gate. If a second live writer ever appears, that becomes an explicit revision/merge decision, not an accidental overwrite.
- **Accepted:** one document (whole-state replace), a faithful port of the single `continuum.v1` localStorage key. Granular server-side mutators (the agent's OWNER-UI-3 write path) layer onto this document in-process, not as new routes.
- **Accepted:** the UI keeps a localStorage copy as the instant, in-browser cache (and the demo build's only store); the server is authoritative and hydrated on boot + sign-in.
- **Extends, does not replace, the no-key invariant:** "no key material on the box" remains true for memory and sessions. The project store is the one named exception, and it is an exception because the agent must *act* on the data, not merely relay it.