# HERMES-NPC-1 — rebuild manifest

What `ops/install-hermes-npc.sh` does, what it writes, and how to verify it.

## What it provisions

1. **Reuses the shared Ollama backend** — if the `ollama` user/service/model
   are already present (provisioned by `install-hermes-owner.sh`), every step
   reports "already …; skipping". If absent, it installs local-only Ollama
   bound to `127.0.0.1:11434` (with `OLLAMA_KEEP_ALIVE=5m`) and pulls
   `qwen3:4b`. Both voices share this one backend.
2. **`hermes-npc`** user (no sudo, HOME `0700`, `umask 077`) + vanilla Nous
   Research Hermes with an **`npc`** profile (`--description` records the
   greeter role for the kanban orchestrator).
3. **Provider wiring** — local Ollama only:
   `model.provider: custom`, `default: qwen3:4b`, `base_url: http://127.0.0.1:11434/v1`.
   **No Continuum router, no `api_key_env`, no `fallback_providers`** — the
   greeter has no paid path and cannot spend the owner's Cashu float.
4. **Greeter persona** — writes `SOUL.md` into the profile dir (the Hermes
   "slot #1" identity) with a warm, concise, honest greeter character plus
   hard limits: no tools, local-only, never reads owner/secrets, loopback-only.

## No secrets on disk

Local Ollama needs no API key, so the npc profile has **no `.env`, no bearer,
no token**. There is nothing to exfiltrate from the greeter.

## What it records

`~/.hermes-npc-rebuild-manifest.txt` (owner-readable) pins deterministic-rebuild
versions. **No secrets are ever written** (there are none):

```
generated:                 UTC timestamp
ollama:                    binary version
hermes:                    binary version
ollama_model:              qwen3:4b (or OLLAMA_MODEL)
ollama_model_digest:       content digest reported by `ollama show`
ollama_base_url:           http://127.0.0.1:11434/v1
hermes_profile:            npc
continuum_router:          none (isolated local-only voice)
secrets_on_disk:           none (local Ollama needs no API key)
```

## Environment

| Var | Required | Meaning |
|---|---|---|
| `OLLAMA_MODEL` | no (default `qwen3:4b`) | local inference model |
| `OLLAMA_BASE_URL` | no (default `http://127.0.0.1:11434/v1`) | local Ollama `/v1` base URL |
| `NPC_DESCRIPTION` | no | one-line role description for `hermes profile create` |

## Verification (run-on-VPS acceptance)

- **Idempotency** — re-run the installer; every step reports "already …; skipping".
- **Model** — `ollama list` shows `qwen3:4b`; `curl -s 127.0.0.1:11434/v1/models`
  returns it; nothing listens on `0.0.0.0:11434`.
- **Config** — `config.yaml` has `provider: custom`, no `api_key_env`, no
  `fallback_providers`, no router URL, no token.
- **Smoke** — `sudo -u hermes-npc hermes -p npc` answers via local Ollama.
- **Isolation** — `hermes-npc` HOME `0700`, `umask 077`; the npc user cannot
  read `/home/hermes-owner`, its `.env`, or the agent's `openai_adapter`
  config (verify: `sudo -u hermes-npc cat /home/hermes-owner/.hermes/...` fails
  with permission denied). `hermes-npc` holds no sudo.
- **No paid leakage** — the npc profile points only at `127.0.0.1:11434`; there
  is no path to `127.0.0.1:8787` (the Continuum router `/v1`).

## Non-goals (later slices)

Nostr/NIP-07 gateway + npub allowlist (NAP-BRIDGE-1); sats receipt; any public
network exposure; encrypted-at-rest MEMORY-1 bridge.