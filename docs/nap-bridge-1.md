# NAP-BRIDGE-1 — Nostr gateway + npub allowlist for the greeter

Status: **decided** (signer custody = NIP-46 bunker; kind-4 MVP).

## Intent

Let players actually reach the `hermes-npc` greeter over Nostr. Today the greeter
is loopback-only (correct, per HERMES-NPC-1): a public voice with no safe
transport to the people it should greet. NAP-BRIDGE-1 builds the shortest safe
bridge: a small, **isolated gateway** that receives a player's signed DM,
confirms the sender is on the operator's npub allowlist, asks the greeter for a
reply, signs it as the greeter, and publishes it back.

This is the first component in Continuum that **signs Nostr events
autonomously**, so it is deliberately separate from the Continuum agent, which —
by design invariant — never signs and holds no nsec.

## Why not put it in the agent

The Continuum agent is the thing that holds owner secrets (the funded Routstr
key, the Cashu float, admin sessions) and is itself that privileged. The greeter
must be *structurally unable to reach owner secrets* — folding its gateway into
the agent would collapse that boundary. The gateway therefore runs as its own
isolated unit, mirroring how `hermes-npc` is its own Unix user.

## Gateway topology

```
player (Nostr client, npub in allowlist)
   │  kind:4 or kind:1059, gift-wrapped DM to the greeter npub
   ▼
relays (configured, read + write)
   ▲
   │ subscribe (SimplePool)
   ▼
nap-bridge gateway ──▶ allowlist check (npub) ──▶ local Ollama + greeter SOUL.md
   │                                              (same backend hermes-npc uses)
   │ sign reply with the greeter's dedicated key
   ▼
relays ──▶ player
```

The gateway touches **only**: its own key, the public allowlist, the local
Ollama endpoint (`127.0.0.1:11434`), and the greeter `SOUL.md`. It never reads
the Continuum agent, the owner's Routstr key, the Cashu float, or owner memory.

## Signer custody (decided: NIP-46 bunker)

**Decision: the greeter's nsec lives in a NIP-46 bunker, never on the VPS.**
The gateway holds only a NIP-46 *client* secret key (its own identity to talk
to the bunker) + the bunker pubkey + relays. It requests every decrypt,
infer-adjacent, encrypt, and sign operation from the bunker via NIP-46. Setup
is one human action: generate the `nostrconnect://` URI at install, approve it
once in the bunker (granting `sign_event`, `nip04_encrypt/decrypt`,
`get_public_key` for the greeter), and the gateway is then fully autonomous.

- **No nsec on disk.** The client secret key is a zero-authority connection
  key, not the signing key; if it leaks the operator revokes the bunker
  connection — no nsec loss.
- **Bunker down ⇒ greeter silent.** If the bunker is unreachable, replies stop
  (safe failure — never an unsigned or failed-safe publish).
- **No signed-tag bypass.** `BunkerSigner` verifies the returned signature
  against the bunker pubkey before publishing.

### Message kind (MVP)

Inbound/outbound use **NIP-04 kind-4 DMs** for the first cut: universally
supported by every Nostr client, and the bunker's `nip04Encrypt/Decrypt` handles
the shared-secret crypto. NIP-17 gift-wrap (kind `1059`) + NIP-44 is a fast
follow-up (the code path is isolated behind the decrypter/signer injection so
it slots in without redesign).

## npub allowlist

- `npc.allowlist` in the gateway config: an array of allowed sender npubs (hex
  or `npub1…`, normalised to hex).
- **Fail-closed.** An empty or missing allowlist means the gateway receives
  nothing (or allows no one — decided below) and publishes nothing.
- Whitelist-checked **before** any inference runs, so an unlicensed sender can
  never spend compute, and the reply is only ever addressed back to an allowed
  sender.
- Out of scope here: sats-receipt gating (pay-to-talk). That is a later slice;
  NAP-BRIDGE-1 is pure "operator-curated list".

## Message flow

1. Subscribe (SimplePool) for the greeter's npub as the *recipient* (`p` tag /
   kind-4 counterpart), kinds 4 and 1059 (gift-wrap).
2. Decrypt/unwrap to recover `(sender_pubkey, plaintext)`; verify the sender's
   signature.
3. Reject if sender is not in the allowlist (silent, no publish).
4. Build the greeter prompt = `SOUL.md` + the sender's plaintext; run local
   Ollama (same `qwen3:4b` default, overridable).
5. Sign the reply as the greeter npub and publish to the sender.
6. Never act on anything in the message (no tools, no code, no files) — the
   SOUL.md hard limits are enforced by construction (the gateway has no tool
   surface at all).

## Config surface (secret-free template committed)

```yaml
npc:
  enabled: false                 # off by default until the operator opts in
  pubkey: ""                     # greeter npub (hex) — identity only
  secret_key_env: NPC_NSEC       # the dedicated nsec comes from the env, 0600
  relays:                        # read+write
    - wss://relay.example.com
  ollama_url: http://127.0.0.1:11434/v1
  model: qwen3:4b
  allowlist: []                  # sender npubs (hex/npub1); fail-closed
  persona_file: <gateway>/SOUL.md   # same greeter SOUL.md text as hermes-npc
```

## Non-goals (later slices)

Sats receipt / pay-to-talk; memory across turns; multi-relay fan-out
policies; anything beyond chat (no tools, ever); public announcement of the
greeter beyond its own signed replies.