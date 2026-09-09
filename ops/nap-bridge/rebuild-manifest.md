# NAP-BRIDGE-1 — rebuild manifest

What `ops/install-nap-bridge.sh` does, what it writes, and how to verify it.

## What it provisions

1. **NIP-46 client key** — `agent/scripts/npc-connect.mjs` mints the gateway's
   client keypair and a `nostrconnect://` URI (perms scoped to `sign_event:13`,
   `nip44_encrypt`, `nip44_decrypt`, `get_public_key` — nothing else). This is
   NOT the greeter nsec.
2. **One-time human approval** — the operator approves the `nostrconnect://`
   URI in their bunker once. After that the URI's `secret` is no longer
   needed; the gateway reconnects on every restart using only its client key
   + the operator's bunker pubkey.
3. **`/home/hermes-npc/.nap-bridge/.env`** (0700 dir, `0600` file) — the
   gateway env: client secret, bunker pubkey, relays, allowlist, local Ollama
   URL/model, SOUL path. `NPC_ENABLED=1`.
4. **`torii-nap-bridge.service`** — runs `agent/npc-gateway.mjs` as
   `hermes-npc`, read-only filesystem, read-only home (SOUL.md readable only),
   outbound `AF_INET`/`AF_INET6`/`AF_UNIX` (no listener).

## Exactly one secret on disk (and it is burnable)

The only secret is the NIP-46 **client** key in the `0600` `.env`. It is a
delegation, not the greeter nsec:

- It cannot spend, export, or reveal the greeter key.
- Its reach is bounded by the perms in the connect URI (kind-13 seal sign +
  NIP-44 encrypt/decrypt + `get_public_key`).
- If it leaks, revoke the connection in the bunker and re-run
  `--generate`; the greeter identity itself is unaffected.

The **greeter nsec never appears** on the VPS in any form — not in the env,
not in memory, not in any file.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `NPC_BUNKER_PUBKEY` | yes | operator's bunker pubkey/npub holding the greeter nsec |
| `NPC_RELAYS` | yes | comma-separated relay URLs (NIP-46 channel + DM sub) |
| `NPC_ALLOWLIST` | yes | comma-separated allowed sender npubs/hex (fail-closed) |
| `NPC_CLIENT_SECRET` | no (generated) | reuse an existing client key; otherwise minted |
| `NPC_MODEL` | no (default `qwen3:4b`) | local inference model |
| `NPC_OLLAMA_URL` | no (default `http://127.0.0.1:11434/v1`) | local Ollama `/v1` |
| `NPC_SOUL_FILE` | no (default `/home/hermes-npc/.hermes/profiles/npc/SOUL.md`) | greeter persona |
| `NAP_BRIDGE_USER` | no (default `hermes-npc`) | unix user for the service |
| `AGENT_DIR` | no (default `/opt/torii/continuum-agent`) | dir holding `npc-gateway.mjs` + `node_modules` |

## Verification (run-on-VPS acceptance)

- **No nsec** — `grep -Ri nsec /home/hermes-npc/.nap-bridge/` finds nothing
  but the client secret; `find /home/hermes-npc -name '*nsec*'` is empty.
- **Unit hardening** — `systemd-analyze security torii-nap-bridge.service`
  shows `ProtectSystem=strict`, `ProtectHome=read-only`,
  `NoNewPrivileges`; no `ReadWritePaths`.
- **Idempotent reconnect** — after a restart, `journalctl -u torii-nap-bridge`
  shows `greeter pubkey … (via NIP-46 bunker)` with the same prefix.
- **Fail-closed allowlist** — with `NPC_ALLOWLIST` unset the gateway refuses
  to start (`FATAL`); with a non-matching sender, the unwrap still happens (the
  cost of sender anonymity) but no inference/reply is ever produced.
- **Bunker down => silent** — stop the bunker; the greeter stops replying
  (it never falls back to any other signer). It recovers when the bunker is
  back, with no key change.

## Non-goals (later slices)

Sats receipt / gating; multi-sender routing beyond the static allowlist; an
in-band admin surface to edit the allowlist without a redeploy.