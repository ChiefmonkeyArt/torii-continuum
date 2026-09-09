# NAP-BRIDGE-1 — Nostr gateway + npub allowlist for the greeter

Status: **decided + implemented** (signer custody = NIP-46 bunker; wire = NIP-17
kind-1059 gift-wrap + NIP-44).

## Intent

Let players actually reach the `hermes-npc` greeter over Nostr. Today the greeter
is loopback-only (correct, per HERMES-NPC-1): a public voice with no safe
transport to the people it should greet. NAP-BRIDGE-1 builds the shortest safe
bridge: a small, **isolated gateway** that receives a player's gift-wrapped DM,
unwraps it, confirms the sender is on the operator's npub allowlist, asks the
greeter for a reply, wraps + signs it as the greeter, and publishes it back.

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
   │  kind:1059 gift wrap (NIP-44) addressed to the greeter npub
   ▼
relays (configured, read + write)
   ▲
   │ subscribe (SimplePool, kind 1059, #p = greeter)
   ▼
nap-bridge gateway ─▶ unwrap (bunker) ─▶ seal auth ─▶ allowlist ─▶ local Ollama
   │                                              + greeter SOUL.md
   │   reply: rumor(14) ─▶ seal(13, bunker) ─▶ gift wrap(1059, local ephemeral)
   ▼
relays ──▶ player
```

The gateway touches **only**: its own NIP-46 client key, the public allowlist,
the local Ollama endpoint (`127.0.0.1:11434`), and the greeter `SOUL.md`. It never
reads the Continuum agent, the owner's Routstr key, the Cashu float, or owner
memory.

## Signer custody (decided: NIP-46 bunker)

**Decision: the greeter's nsec lives in a NIP-46 bunker, never on the VPS.**
The gateway holds only a NIP-46 *client* secret key (its own identity to talk
to the bunker) + the bunker pubkey + relays. It requests every inner decrypt /
encrypt and the seal signature from the bunker via NIP-46. Setup is one human
action: generate the `nostrconnect://` URI at install, approve it once in the
bunker — granting `sign_event:13`, `nip44_encrypt`, `nip44_decrypt`,
`get_public_key` for the greeter — and the gateway is then fully autonomous.

- **No nsec on disk.** The client secret key is a zero-authority connection
  key, not the signing key; if it leaks the operator revokes the bunker
  connection — no nsec loss.
- **Bunker down ⇒ greeter silent.** If the bunker is unreachable, replies stop
  (safe failure — never an unsigned or failed-safe publish).
- **No signed-tag bypass.** `BunkerSigner` verifies the returned signature
  against the bunker pubkey before publishing.

### Wire format (NIP-17 kind-1059 + NIP-44)

DMs are NIP-17 **gift-wrapped**:

1. **rumor** (kind 14) — the actual message, `pubkey` = sender, `["p", …]` to
   the recipient. Unsignable by itself; authenticated by the seal.
2. **seal** (kind 13) — the rumor NIP-44-encrypted to the recipient, **signed
   by the sender**. The seal's signature is the proof of who sent it.
3. **gift wrap** (kind 1059) — the seal NIP-44-encrypted to the recipient under
   a **fresh ephemeral key** (`pubkey` = random), so relay observers cannot
   link the event to either party.

The **bunker** does the inner NIP-44 (`nip44_encrypt`/`nip44_decrypt`) and the
seal signature. The **gateway generates the outer ephemeral key locally** —
that is precisely the step that hides the greeter, and it needs no bunker perm.

## npub allowlist

- `NPC_ALLOWLIST` env: an array of allowed sender npubs (hex or `npub1…`,
  normalised to hex).
- **Fail-closed.** An empty or missing allowlist means the gateway refuses to
  start (or allows no one).
- Checked **after unwrap, before inference** — the sender is only known once the
  wrap is unwrapped (the cost of sender anonymity). A spammer can force a
  decrypt, but can never elicit a reply to a non-allowlisted identity.
- Out of scope here: sats-receipt gating (pay-to-talk). That is a later slice;
  NAP-BRIDGE-1 is pure "operator-curated list".

## Message flow

1. Subscribe (SimplePool) for the greeter's npub as the *recipient* (`#p` tag),
   kind `1059` only.
2. Verify the wrap's (ephemeral) signature, then unwrap twice via the bunker:
   wrap → seal → rumor.
3. Authenticate: `verifyEvent(seal)` must pass and `seal.pubkey` must equal
   `rumor.pubkey`. That pubkey is the sender.
4. Reject if the sender is not in the allowlist (silent, no publish).
5. Build the greeter prompt = `SOUL.md` + the rumor's plaintext; run local
   Ollama (same `qwen3:4b` default, overridable).
6. Reply: rumor (kind 14) → seal (kind 13, bunker encrypt + sign) → gift wrap
   (kind 1059, local ephemeral) → publish to the sender.
7. Never act on anything in the message (no tools, no code, no files) — the
   SOUL.md hard limits are enforced by construction (the gateway has no tool
   surface at all).

## Config surface (env, no secrets committed)

The gateway is env-driven (written 0600 by the installer; template committed):

```
NPC_ENABLED=1
NPC_CLIENT_SECRET=<hex>       # NIP-46 client key — a burnable delegation
NPC_BUNKER_PUBKEY=<hex>       # the bunker holding the greeter nsec
NPC_RELAYS=<urls>             # DM + NIP-46 channel relays
NPC_ALLOWLIST=<npubs>         # fail-closed
NPC_OLLAMA_URL=http://127.0.0.1:11434/v1
NPC_MODEL=qwen3:4b
NPC_SOUL_FILE=/home/hermes-npc/.hermes/profiles/npc/SOUL.md
```

The greeter nsec never appears in any form.

## Non-goals (later slices)

Sats receipt / pay-to-talk; memory across turns; multi-relay fan-out policies;
anything beyond chat (no tools, ever); public announcement of the greeter beyond
its own signed replies; an in-band admin surface to edit the allowlist.