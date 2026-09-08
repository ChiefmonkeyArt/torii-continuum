# Hermes two-voice architecture (HERMES-OWNER-1 + HERMES-NPC-1)

Status: **decided** (owner wiring confirmed; NPC is a later slice).

## Intent

Torii Continuum returns to its intended two-voice shape: one **private owner
brain** (the project engine) and one **isolated public greeter**. The healthy
Fastify Routstr/Ollama router is *not yet either voice* — it is the shared
inference spine both voices sit behind. The voices are separate **vanilla Nous
Research Hermes** installs, not a fork of the router.

## Isolation boundary: Unix users, not containers

`hermes-owner` and `hermes-npc` are separate **unprivileged** system users with
separate homes (`0700`, `umask 077`). The OS user is the primary trust
boundary. Docker, if added later, is hardening only — never the identity
boundary. Memory, keys, tools, and project access are never shared between the
two voices. Public prompts (NPC) must be structurally unable to reach owner
secrets.

## The two voices

| | hermes-owner | hermes-npc |
|---|---|---|
| Role | private project engine; full tool access | public greeter / Kami mode / in-world NPC |
| Inference | Continuum router (`/v1`) primary → local `qwen3:4b` fallback | local Ollama only |
| Tools | yes (project engine, todos, sessions) | none — chat + receive sats only |
| Secrets | own profile `.env` (`0600`) | own, separate — never reads owner |
| Net | loopback only | loopback only |

## `/v1` — the OpenAI-compatible surface (this slice)

The Continuum router consumes OpenAI-compatible endpoints (Routstr discovery +
Ollama) but does not **serve** one. Vanilla Hermes needs a
`model.provider: custom` + `base_url` target, so the router gains a thin
adapter that speaks OpenAI protocol over its existing `model-router`:

- `GET  /v1/models` — the discoverable model catalog (Routstr discovery +
  local Ollama model).
- `POST /v1/chat/completions` — OpenAI-compatible, **streaming** SSE,
  delegating to `model-router.chat()` (Routstr-first → local fallback, the
  same healthy chain the console uses).

### Boundary rules

- **Loopback only** — bound to `127.0.0.1`, same as the rest of the agent.
- **Local token auth** — a static bearer token (agent config + hermes-owner's
  profile `.env`, both `0600`) so *any local process cannot* spend the Cashu
  float. This is a distinct surface from the console's `requireAdmin` NIP-07
  session; it never grants the `/api/*` admin routes.
- **No persona** — the adapter returns the router's raw completion. The
  Continuum "you are Continuum…" character is applied only by `chat.mjs` for
  the console; hermes-owner brings its own Nous `owner` persona.
- **No credential custody** — the token is a capability, not a user secret;
  keys/nsecs are never written, logged, or echoed.

## Fallback config (correct shape)

Hermes fallback is a **top-level `fallback_providers` list** (canonical in
current Hermes); `fallback_model` (singular) is the legacy key. The redirect
wiring keeps local `qwen3:4b` as the degraded fallback only — the router is the
normal route, so the 4b model is resilience, not the interactive path.

The installer must write fallback into the path Hermes actually reads (profile
vs main config) — verified against the installed Hermes build, not assumed.

## Non-goals (later slices)

`hermes-npc` build (HERMES-NPC-1); Nostr/NIP-07 gateway + npub allowlist
(NAP-BRIDGE-1); encrypted-at-rest MEMORY-1 bridge; any public network exposure.