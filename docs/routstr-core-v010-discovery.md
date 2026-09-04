# ADR — Routstr Core v0.1.0 provider discovery (v0.2.105-alpha)

**Status:** Accepted.

## Context

The agent's Routstr client hard-coded a single endpoint (`https://api.routstr.com`)
and a pinned model id (`deepseek-v3.2`). In August 2026 Routstr shipped Core
v0.1.0 and decommissioned the old central API: `api.routstr.com` now returns 404
for every route, and the pinned model no longer exists. Chat broke first with
`http 404` (model not found), then — after an emergency flip to the local
`ollama_first` strategy — with `http 504` (the CPU-only `qwen2.5:0.5b` burned the
entire 100s turn budget and never produced a token on the 2-vCPU VPS).

The local model is a dead end for interactive chat on this hardware, so the only
viable path is a correct integration with the new Routstr network.

## Decision

Routstr Core v0.1.0 providers are **discovered, not configured**:

- **Discovery (RIP-02/RIP-03).** Nodes announce themselves as Nostr kind-38421
  events; the base URL lives in the `"u"` tag and the name/npub in the event.
  `core/routstr-discovery.mjs` queries the configured relays (default
  `wss://relay.routstr.com`, `wss://nos.lol`, `wss://relay.damus.io`) and merges
  the result with a deterministic operator-pinned bootstrap list.
- **Model catalog.** Each reachable provider replies to `GET /v1/models` with its
  models and `sats_pricing`. The agent builds a runtime catalog refreshed every
  `refresh_minutes` (default 10) so model churn never hard-codes us.
- **Routing + failover.** A requested model id resolves to every provider serving
  it, ordered cheapest-first by the provider's declared cost. A primary failure
  fails over to the next provider within the turn budget.
- **Cost-degrade.** A config-pinned model no reachable provider serves (stale
  config) degrades — loudly — to the cheapest available model rather than
  dead-ending chat.
- **Payment unchanged.** The stateless `X-Cashu` per-request header (see RIP-01)
  remains correct; the change comes back in the `X-Cashu` response header. The
  best-effort reclaim path moved from the deprecated `/v1/wallet/refund` to
  `/v1/balance/refund`.

## Consequences

- The agent now self-heals when the Routstr network churns: no operator action is
  needed to pick up new providers or retire dead models.
- `routstr.endpoint` is retained only as an offline single-provider fallback; the
  hard validation of `endpoint` + `models.chat/.coding` is relaxed (missing pins
  default to `auto`).
- Config gains an optional `routstr.discovery` block (relays, bootstrap endpoints,
  refresh cadence) and an explicit `routstr.providers` list.
- The old model-level fallback ladder (`routstr.fallback`) is superseded by
  provider-level failover and no longer drives routing.