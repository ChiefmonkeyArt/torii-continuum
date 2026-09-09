# NAP-BRIDGE-3 — rebuild manifest

What `ops/install-nap-bridge.sh` does, what it writes, and how to verify it.

## What it provisions

1. **Per-install greeter nsec** — `agent/scripts/npc-nsec.mjs` mints a
   throwaway greeter nsec (unless `NPC_NSEC` is already set), and the installer
   writes it into the gateway `.env`. This *is* the greeter nsec, but it is a
   fresh, funds-free identity — not the operator's key, and not any bunker's.
2. **`/home/hermes-npc/.nap-bridge/.env`** (0700 dir, `0600` file) — the
   gateway env: greeter nsec, relays, allowlist, local Ollama URL/model, SOUL
   path. `NPC_ENABLED=1`.
3. **`torii-nap-bridge.service`** — runs `agent/npc-gateway.mjs` as
   `hermes-npc`, read-only filesystem, read-only home (SOUL.md readable only),
   outbound `AF_INET`/`AF_INET6`/`AF_UNIX` (no listener).

There is no one-time human step: no `nostrconnect://` URI, no bunker approval.
A fresh install is a fresh greeter identity with zero operator config beyond
relays + allowlist.

## Exactly one secret on disk (and it is disposable)

The only secret is the greeter nsec in the `0600` `.env`. It is a throwaway
identity, not a custodied operator key:

- It holds no funds and carries no delegation — it can only sign as the
  greeter npub (kind-13 seals) and NIP-44-encrypt/decrypt its own DMs.
- If it leaks, the worst case is impersonation-as-greeter. No owner secret,
  no Routstr key, no Cashu float is reachable from this process.
- Rotation is trivial: `rm /home/hermes-npc/.nap-bridge/.env` and reinstall
  mints a new identity, or overwrite `NPC_NSEC` with a nsec the owner chose.

The nsec is deliberately **persistent-but-disposable**: it does not rotate or
expire on its own; it lives until the owner deletes it. "Ephemeral" means no
value attached and disposable on demand, not self-destructing.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `NPC_RELAYS` | yes | comma-separated relay URLs for NIP-17 DM delivery |
| `NPC_ALLOWLIST` | yes | comma-separated allowed sender npubs/hex (fail-closed) |
| `NPC_NSEC` | no (minted) | reuse an existing greeter nsec (64-hex or `nsec1`); otherwise minted |
| `NPC_MODEL` | no (default `qwen3:4b`) | local inference model |
| `NPC_OLLAMA_URL` | no (default `http://127.0.0.1:11434/v1`) | local Ollama `/v1` |
| `NPC_SOUL_FILE` | no (default `/home/hermes-npc/.hermes/profiles/npc/SOUL.md`) | greeter persona |
| `NAP_BRIDGE_USER` | no (default `hermes-npc`) | unix user for the service |
| `AGENT_DIR` | no (default `/opt/torii/continuum-agent`) | dir holding `npc-gateway.mjs` + `node_modules` |

## Verification (run-on-VPS acceptance)

- **One nsec only** — `grep -R "NPC_NSEC" /home/hermes-npc/.nap-bridge/` shows
  the single greeter nsec; no `NPC_CLIENT_SECRET` / `NPC_BUNKER_PUBKEY` remain.
- **Unit hardening** — `systemd-analyze security torii-nap-bridge.service`
  shows `ProtectSystem=strict`, `ProtectHome=read-only`,
  `NoNewPrivileges`; no `ReadWritePaths`.
- **Idempotent identity** — after a restart, `journalctl -u torii-nap-bridge`
  shows `greeter pubkey … (local ephemeral nsec)` with the same prefix (the
  nsec is reused, not reminted).
- **Fail-closed allowlist** — with `NPC_ALLOWLIST` unset the gateway refuses
  to start (`FATAL`); with a non-matching sender, the unwrap still happens (the
  cost of sender anonymity) but no inference/reply is ever produced.
- **Throwing signer stays silent** — a signer/decrypt error drops the message;
  the gateway never publishes an unsigned or failed-auth reply.

## Non-goals (later slices)

Sats receipt / gating; multi-sender routing beyond the static allowlist; an
in-band admin surface to edit the allowlist without a redeploy.