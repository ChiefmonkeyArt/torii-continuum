# ADR: Memory authority model (audit A17)

**Status:** Accepted · 2026-09-14 · Continuum v0.2.160-alpha

## Decision

The **verified admin session (Nostr-signer login) is the single authority** for the
plaintext memory cache and for bearing-authorized memory writes. There is exactly
one plaintext cache; `/api/memory/unlock` and the hardened `/api/memory/activate`
write the same cache. Activation is the first-run, owner-signed consent ceremony,
not a parallel memory protocol.

The plaintext RAM cache is **leased for `session_ttl_sec`** (default 24h) and is
auto-dropped when the lease lapses, on explicit lock/panic, and on shutdown. It is
not retained indefinitely after the originating session ends.

## Why (the non-coder audience)

The operator is a regular user who logs in with their Nostr signer and expects
"things just work." Requiring action/payload-bound signed consent for every memory
write would be unusable for that audience. The intent of "browser-signed write" is
already satisfied by NIP-44: the client encrypts ciphertext *to the operator's own
pubkey* in the browser, and the write is authorized by the signed session. The
`event_id` field is the browser's dedup reference, not a server-verified signature.

## NOT treated as a security boundary (and never claimed as one)

- A ciphertext `event_id` is metadata, not a verifiable proof of authorship.
- Dropping the RAM Map releases references to the (immutable) JS strings but does
  NOT guarantee cryptographic zeroization; the heap may retain copies until GC.

## Explicit model (what each path is)

| Path | Authority | Purpose |
| --- | --- | --- |
| `POST /api/memory/unlock` | verified session (bearer) | load decrypted plaintext into RAM |
| `POST /api/memory/activate` | verified session + fresh owner signature | first-run hardened consent ceremony |
| `POST /api/memory/store` | verified session (owner-bound via genesis manifest) + NIP-44 ciphertext | owner's own explicit durable write |
| AI-generated durable memory | `proposal → approve` (payload-bound) | consent binds the exact reviewed payload |

The safety distinction that matters is preserved: AI cannot write durable memory
through the direct store path — it must go through the proposal/approve flow, which
binds approval to the exact payload.