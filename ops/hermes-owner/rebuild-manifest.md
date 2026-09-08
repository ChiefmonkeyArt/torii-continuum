# HERMES-OWNER-1 — rebuild manifest

What `ops/install-hermes-owner.sh` does, what it writes, and how to verify it.

## What it provisions

1. **`ollama`** system user (via the official Ollama installer) + local-only
   Ollama bound to `127.0.0.1:11434`, with `OLLAMA_KEEP_ALIVE=5m` so the model
   unloads from RAM when idle (headroom on the 8.9 GiB / no-swap VPS). Pulls
   `qwen3:4b`.
2. **`hermes-owner`** user (no sudo, HOME `0700`, `umask 077`) + vanilla Nous
   Research Hermes (`hermes-agent.nousresearch.com`) with an `owner` profile.
3. **Provider wiring** — primary points at the Continuum agent's OpenAI-
   compatible `/v1` surface (`http://127.0.0.1:8787/v1` by default). That
   surface delegates to the model-router (Routstr-first → local Ollama), so
   the owner brain reuses the console's healthy paid path. Hermes's native
   `fallback_providers` chain adds `qwen3:4b` on `127.0.0.1:11434/v1` as the
   local-only degrade path.

### Fallback lives in the MAIN Hermes config

As of the current Nous Hermes release, `fallback_providers` set in a *profile*
`config.yaml` is IGNORED by the CLI worker — only `~/.hermes/config.yaml` is
read for fallback. The installer therefore writes the fallback block into the
main config too, only if it isn't already present. Operator edits win.

## What it records

`~/.hermes-owner-rebuild-manifest.txt` (owner-readable) pins the versions for a
deterministic rebuild:

```
generated:                 UTC timestamp
ollama:                    binary version
hermes:                    binary version
ollama_fallback_model:     qwen3:4b (or OLLAMA_MODEL)
ollama_model_digest:       content digest reported by `ollama show`
continuum_router_url:      http://127.0.0.1:8787/v1 (or CONTINUUM_ROUTER_URL)
continuum_router_model:    chat (or CONTINUUM_ROUTER_MODEL)
continuum_router_token:    <in profile .env if set>
```

**No secrets are ever written to this manifest** — the router bearer is
recorded as "present in the profile .env" only.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `OLLAMA_MODEL` | no (default `qwen3:4b`) | local fallback model |
| `CONTINUUM_ROUTER_URL` | no (default `http://127.0.0.1:8787/v1`) | primary `/v1` base URL |
| `CONTINUUM_ROUTER_MODEL` | no (default `chat`) | model id the adapter advertises |
| `CONTINUUM_ROUTER_TOKEN` | recommended | bearer; matches `openai_adapter.local_token` in the agent config. Written to profile `.env` (0600), never logged. If unset, the installer warns and the operator must write it by hand. |

## Verification (run-on-VPS acceptance)

- **Idempotency** — re-run the installer; every step reports "already …; skipping".
- **Model** — `ollama list` shows `qwen3:4b`; `curl -s 127.0.0.1:11434/v1/models`
  returns it; nothing listens on `0.0.0.0:11434`.
- **Adapter** — as root or with the bearer in scope:
  `curl -s -H "Authorization: Bearer $CONTINUUM_ROUTER_TOKEN" http://127.0.0.1:8787/v1/models`
  returns `{"object":"list","data":[{"id":"chat"…}]}`. Without the header:
  HTTP 401. With the agent config's `openai_adapter.local_token` empty: HTTP 503.
- **Smoke** — `sudo -u hermes-owner hermes -p owner` answers via the primary
  (the Continuum router path, which itself uses Routstr first).
- **Failover** — stop the Continuum agent (`systemctl stop continuum-agent`) or
  set `openai_adapter.local_token=""` in the agent config and restart it; the
  brain must still answer via `qwen3:4b` from the main config's fallback block.
- **Security** — `hermes-owner` HOME `0700`; profile `config.yaml`/`.env` `0600`;
  no key in `git grep` or logs; `hermes-owner` holds no sudo; the agent's `/v1`
  surface binds only to `127.0.0.1`.

## Non-goals (later slices)

`hermes-npc` (HERMES-NPC-1); Nostr/NIP-07 gateway + npub allowlist
(NAP-BRIDGE-1); encrypted-at-rest MEMORY-1 bridge; Docker-as-terminal-backend;
any public network exposure.
