# Continuum agent + greeter architecture (two voices)

Status: **updated** — the owner voice is consolidated into the Continuum agent
(OWNER-UI-1..5 + this slice); the separate `hermes-owner` brain and the `/v1`
OpenAI adapter are **retired** (removed v0.2.147-alpha). The isolated public
greeter (`hermes-npc`) is the remaining separate voice.

## Intent

Torii Continuum has two isolated agentic voices with a hard boundary between
them:

- **Owner voice** — the private project engine, with full tool access and the
  paid Routstr/Cashu spine. This is now the **Continuum agent itself**: the
  owner chats through the console's `POST /api/chat` → `chat.mjs` skill →
  `model-router` (Routstr-first → local Ollama fallback), with the character +
  memory stack applied in-process.
- **Public greeter** — `hermes-npc`, a separate vanilla Nous Research Hermes
  install that is chat-only, local-inference-only, and structurally unable to
  reach owner secrets, tools, or the paid path.

The two voices never share memory, keys, tools, or project access. Public
prompts must be structurally unable to reach owner secrets.

## History (what changed)

The owner voice was originally a **separate vanilla Hermes install**
(`hermes-owner`) that reached the Continuum router through a loopback
OpenAI-compatible `/v1` surface (`agent/core/openai-adapter.mjs`). OWNER-UI
folded the owner interface into Continuum's own console, which talks to the
agent directly — so `hermes-owner` and its `/v1` bridge became dead weight and
were removed. The owner voice is simply the Continuum agent's chat path now; no
second process, no second profile, no `/v1` loopback token.

This does **not** collapse the boundary: the owner voice kept the full-tool,
Routstr/Cashu spine inside the agent; the public greeter stays an isolated,
unprivileged, local-only process. The public greeter has always been, and
remains, unable to spend the owner's Cashu float or read owner state.

## Isolation boundary: Unix users, not containers

`hermes-npc` is a separate **unprivileged** system user (`hermes-npc`,
HOME `0700`, `umask 077`). The OS user is the primary trust boundary. Docker,
if added later, is hardening only — never the identity boundary. The owner
voice lives inside the Continuum agent's own process (`torii-continuum-agent`),
which the greeter cannot reach.

## The owner voice — the Continuum agent

- **Role** — private project engine; full tool access.
- **Inference** — `model-router` (Routstr-first → local Ollama fallback).
- **Tools** — sessions, project store, board, marketplace, wallet, etc.
- **Secrets** — the agent's own `session_secret`/NWC/Routstr records (encrypted
  at rest); never readable by the greeter.
- **Net** — loopback only.

## `hermes-npc` — the isolated public greeter

The second voice is provisioned by `ops/install-hermes-npc.sh` as its own
`hermes-npc` user + an `npc` profile. It differs from the owner voice in three
load-bearing ways:

- **Local Ollama only.** `model.provider: custom` → `127.0.0.1:11434/v1`, no
  `api_key_env`, no `fallback_providers`, and no reference to the agent. The
  greeter therefore has **no paid path** and cannot spend the owner's Cashu
  float.
- **No secrets on disk.** Local Ollama needs no API key, so the npc profile has
  no `.env` and no bearer — there is nothing to exfiltrate.
- **Greeter persona via `SOUL.md`.** The profile writes a warm, concise greeter
  identity whose hard limits are explicit: no tools, local-only, never read or
  infer secrets/owner data, loopback-only, honest about what it cannot do.

The shared Ollama backend is the one deliberately-shared surface (stateless
inference). Memory, keys, tools, and project access remain fully separate. The
npc installer provisions Ollama itself and no longer depends on any owner-brain
installer.

## Public transport (NAP-BRIDGE)

`hermes-npc` is reachable over Nostr via the isolated `nap-bridge` gateway
(`agent/npc-gateway.mjs` + `ops/install-nap-bridge.sh`). It signs as the
greeter with a **local per-install ephemeral nsec** — no NIP-46 bunker, no
`nostrconnect://` approval — enforces a fail-closed npub allowlist, and infers
locally. Wire format is NIP-17 kind-1059 gift-wrap + NIP-44. See
`docs/nap-bridge-1.md` for the signer-custody ADR and the wrap flow.

## Hermes Web Dashboard — RETIRED

The first-party Nous Hermes Web Dashboard (loopback `127.0.0.1:9119`, formerly
mounted at `/hermes/`) was a bolted-on third-party chat surface duplicating the
console. It is retired (OWNER-UI-4, v0.2.145-alpha) along with its nginx
fragment, systemd unit, and install workflow. See `docs/hermes-dashboard-auth.md`
(decision, now retired).

## Non-goals (later slices)

Sats receipt / gating; encrypted-at-rest MEMORY-1 bridge; any public network
exposure beyond the allowlisted DM path.