# NAP-BRIDGE — Nostr gateway + npub allowlist for the greeter

Status: **decided + implemented** (signer custody = per-install ephemeral nsec,
superseding the earlier NIP-46 bunker decision in NAP-BRIDGE-1; wire = NIP-17
kind-1059 gift-wrap + NIP-44).

> Custody revision (NAP-BRIDGE-3). NAP-BRIDGE-1 held the greeter nsec in a
> NIP-46 bunker and required a one-time `nostrconnect://` approval. That was
> correct for a signer the operator already runs, but bunkers are too much
> ceremony for the average operator installing Torii on a VPS. We therefore
> replaced the bunker with a **local per-install ephemeral nsec**: the
> installer mints a throwaway greeter nsec into the `0600` `.env`, and the
> gateway signs with it directly. No bunker, no URI, no approval — a fresh
> install is a fresh, funds-free greeter identity with zero operator config
> beyond relays + allowlist.

## Intent

Let players actually reach the `hermes-npc` greeter over Nostr. Today the greeter
is loopback-only (correct, per HERMES-NPC-1): a public voice with no safe
transport to the people it should greet. NAP-BRIDGE builds the shortest safe
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
nap-bridge gateway ─▶ unwrap (local) ─▶ seal auth ─▶ allowlist ─▶ local Ollama
   │                                              + greeter SOUL.md
   │   reply: rumor(14) ─▶ seal(13, local) ─▶ gift wrap(1059, local ephemeral)
   ▼
relays ──▶ player
```

The gateway touches **only**: its own throwaway greeter nsec, the public
allowlist, the local Ollama endpoint (`127.0.0.1:11434`), and the greeter
`SOUL.md`. It never reads the Continuum agent, the owner's Routstr key, the
Cashu float, or owner memory.

## Signer custody (decided: per-install ephemeral nsec)

**Decision: the greeter nsec lives ON the VPS as a single `0600` file, minted
at install.** There is no NIP-46 bunker and no `nostrconnect://` approval. The
gateway signs kind-13 seals and NIP-44-encrypts/decrypts gift-wrapped DMs
in-process with that throwaway key.

- **Disposable, not custodied.** The nsec holds no funds, carries no
  delegation, and is unlinkable to the operator's admin/owner npub. Worst case
  on leak is impersonation-as-greeter (an attacker posts as the NPC), never
  theft or owner-secret exposure.
- **Persistent-but-disposable.** It does not rotate or expire on its own; it
  lives until the owner deletes it. "Ephemeral" means no value attached and
  disposable on demand, not self-destructing.
- **Owner override is a one-line edit.** Replace `NPC_NSEC` in the `.env` with
  a nsec the owner chose, or `rm` the `.env` and reinstall to mint a fresh one.
- **Fail-closed, no fallback.** If the signer throws (bad key, decrypt
  failure), the message is dropped — the gateway never publishes an unsigned or
  failed-auth reply, and never falls back to any other signer.

### Wire format (NIP-17 kind-1059 + NIP-44)

DMs are NIP-17 **gift-wrapped**:

1. **rumor** (kind 14) — the actual message, `pubkey` = sender, `["p", …]` to
   the recipient. Unsignable by itself; authenticated by the seal.
2. **seal** (kind 13) — the rumor NIP-44-encrypted to the recipient, **signed
   by the sender**. The seal's signature is the proof of who sent it.
3. **gift wrap** (kind 1059) — the seal NIP-44-encrypted to the recipient under
   a **fresh ephemeral key** (`pubkey` = random), so relay observers cannot
   link the event to either party.

The **local signer** does the inner NIP-44 (`nip44_encrypt`/`nip44_decrypt`) and
the seal signature. The **gateway generates the outer ephemeral key locally** —
that is precisely the step that hides the greeter.

## npub allowlist

- `NPC_ALLOWLIST` env: an array of allowed sender npubs (hex or `npub1…`,
  normalised to hex).
- **Fail-closed.** An empty or missing allowlist means the gateway refuses to
  start (or allows no one).
- Checked **after unwrap, before inference** — the sender is only known once the
  wrap is unwrapped (the cost of sender anonymity). A spammer can force a
  decrypt, but can never elicit a reply to a non-allowlisted identity.
- Out of scope here: sats-receipt gating (pay-to-talk). That is a later slice;
  NAP-BRIDGE is pure "operator-curated list".

## Message flow

1. Subscribe (SimplePool) for the greeter's npub as the *recipient* (`#p` tag),
   kind `1059` only.
2. Verify the wrap's (ephemeral) signature, then unwrap twice with the local
   signer: wrap → seal → rumor.
3. Authenticate: `verifyEvent(seal)` must pass and `seal.pubkey` must equal
   `rumor.pubkey`. That pubkey is the sender.
4. Reject if the sender is not in the allowlist (silent, no publish).
5. Build the greeter prompt = `SOUL.md` + the rumor's plaintext; run local
   Ollama (same `qwen3:4b` default, overridable).
6. Reply: rumor (kind 14) → seal (kind 13, local encrypt + sign) → gift wrap
   (kind 1059, local ephemeral) → publish to the sender.
7. Never act on anything in the message (no tools, no code, no files) — the
   SOUL.md hard limits are enforced by construction (the gateway has no tool
   surface at all).

## Config surface (env, no secrets committed)

The gateway is env-driven (written 0600 by the installer; template committed):

```
NPC_ENABLED=1
NPC_NSEC=<64-hex>             # greeter nsec — minted at install, disposable
NPC_RELAYS=<urls>             # NIP-17 DM relays
NPC_ALLOWLIST=<npubs>         # fail-closed
NPC_OLLAMA_URL=http://127.0.0.1:11434/v1
NPC_MODEL=qwen3:4b
NPC_SOUL_FILE=/home/hermes-npc/.hermes/profiles/npc/SOUL.md
```

`NPC_NSEC` is the one secret on disk; it is a throwaway greeter identity, not
the operator's key, and it is never echoed after install.

## Non-goals (later slices)

Sats receipt / pay-to-talk; memory across turns; multi-relay fan-out policies;
anything beyond chat (no tools, ever); public announcement of the greeter beyond
its own signed replies; an in-band admin surface to edit the allowlist.