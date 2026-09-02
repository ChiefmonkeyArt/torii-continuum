# HERMES-OWNER-1 — rebuild manifest

What `ops/install-hermes-owner.sh` does, what it writes, and how to verify it.

## What it provisions

1. **`ollama`** system user (via the official Ollama installer) + local-only
   Ollama bound to `127.0.0.1:11434`, with `OLLAMA_KEEP_ALIVE=5m` so the model
   unloads from RAM when idle (headroom on the 8.9 GiB / no-swap VPS). Pulls
   `qwen3:4b`.
2. **`hermes-owner`** user (no sudo, HOME `0700`, `umask 077`) + vanilla Nous
   Research Hermes (`hermes-agent.nousresearch.com`) with an `owner` profile.
3. **Provider wiring** — Routstr as primary (custom OpenAI-compatible endpoint)
   when `ROUTSTR_BASE_URL` + `ROUTSTR_MODEL` are supplied, with native
   `fallback_providers` → local Ollama `qwen3:4b`. Otherwise local Ollama is
   the primary until the operator runs `hermes model`.

## What it records

`~/.hermes-owner-rebuild-manifest.txt` (owner-readable) pins the versions for a
deterministic rebuild:

```
generated:            UTC timestamp
ollama:               binary version
hermes:               binary version
ollama_model:         qwen3:4b (or OLLAMA_MODEL)
ollama_model_digest:  content digest reported by `ollama show`
routstr_base_url:     <url> or <unset>
routstr_model:        <model> or <unset>
```

No secrets are ever written to this manifest.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `OLLAMA_MODEL` | no (default `qwen3:4b`) | local model served by the shared Ollama |
| `ROUTSTR_BASE_URL` | only for Routstr-first | OpenAI-compatible primary base URL (`https://host/v1`) |
| `ROUTSTR_MODEL` | only for Routstr-first | primary model name at that endpoint |
| `ROUTSTR_API_KEY` | optional | primary key, written to profile `.env` (0600), never logged |

## Verification (run-on-VPS acceptance)

- **Idempotency** — re-run the installer; every step reports "already … ; skipping".
- **Model** — `ollama list` shows `qwen3:4b`; `curl -s 127.0.0.1:11434/v1/models`
  returns it; nothing listens on `0.0.0.0:11434`.
- **Smoke** — `sudo -u hermes-owner hermes -p owner` answers via the primary.
- **Failover** — point `ROUTSTR_BASE_URL` at a dead/429 endpoint and confirm the
  brain still answers via `qwen3:4b`.
- **Security** — `hermes-owner` HOME `0700`; profile `config.yaml`/`.env` `0600`;
  no key in `git grep` or logs; `hermes-owner` holds no sudo.

## Non-goals (later slices)

Nostr/NIP-07 gateway + npub allowlist (NAP-BRIDGE-1); encrypted-at-rest
MEMORY-1 bridge; `hermes-npc` (HERMES-NPC-1); Docker-as-terminal-backend;
any public network exposure.