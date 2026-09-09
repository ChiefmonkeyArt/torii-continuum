# Hermes two-voice architecture (HERMES-OWNER-1 + HERMES-NPC-1)

Status: **decided** (owner wired v0.2.108-alpha; NPC wired v0.2.109-alpha).

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

## `hermes-npc` — the isolated public greeter (HERMES-NPC-1)

The second voice is provisioned by `ops/install-hermes-npc.sh` as its own
`hermes-npc` user + an `npc` profile. It differs from the owner brain in three
load-bearing ways:

- **Local Ollama only.** `model.provider: custom` → `127.0.0.1:11434/v1`, no
  `api_key_env`, no `fallback_providers`, and no reference to the router's
  `127.0.0.1:8787/v1` surface. The greeter therefore has *no paid path* and
  cannot spend the owner's Cashu float.
- **No secrets on disk.** Local Ollama needs no API key, so the npc profile has
  no `.env` and no bearer — there is nothing to exfiltrate.
- **Greeter persona via `SOUL.md`.** The profile writes a warm, concise greeter
  identity whose hard limits are explicit: no tools, local-only, never read or
  infer secrets/owner data, loopback-only, honest about what it cannot do.

The shared Ollama backend is the one deliberately-shared surface (stateless
inference). Memory, keys, tools, and project access remain fully separate.

## Public transport (NAP-BRIDGE-1)

`hermes-npc` is reachable over Nostr via the isolated `nap-bridge` gateway
(`agent/npc-gateway.mjs` + `ops/install-nap-bridge.sh`). It signs as the
greeter using a NIP-46 bunker (no nsec on the VPS), enforces a fail-closed npub
allowlist, and infers locally. Wire format is NIP-17 kind-1059 gift-wrap +
NIP-44. See `docs/nap-bridge-1.md` for the signer-custody ADR and the wrap flow.

## Non-goals (later slices)

Sats receipt / gating; encrypted-at-rest MEMORY-1 bridge; any public network
exposure beyond the allowlisted DM path.