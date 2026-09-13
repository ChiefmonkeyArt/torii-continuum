# Decision: Hermes runs passwordless behind the Continuum Nostr gateway

- **Status:** Accepted (replaces the withdrawn subdomain + `basic_auth` design)
- **Date:** 2026-09-13
- **Supersedes:** HERMES-DASHBOARD-2 (subdomain + Hermes `basic_auth` username/password)
- **Decision driver:** identity is Nostr, and a regular user must never SSH or
  maintain a second credential.

## Context

We ship Hermes's Web Dashboard for the owner brain. The first attempt mounted it
at `/hermes/` on the Continuum apex (HERMES-DASHBOARD-1); the second moved it to
a subdomain gated by Hermes's own `basic_auth` (HERMES-DASHBOARD-2). Both were
wrong in the same way: Hermes was given its *own* identity layer instead of
inheriting the one the operator already has.

The product rule is now fixed: **a user authenticates once with their Nostr
signer and that identity is their authority everywhere.** A username/password
for Hermes violates that — it is a second credential, set and recovered over
SSH, neither of which a regular user should be asked to do.

## Decision

**Hermes is a loopback-only, passwordless local backend. Continuum is the sole
front door, and the Nostr-signed session is the sole authority. Launching Hermes
from within Continuum means the Continuum gateway proxies Hermes's UI and
WebSocket for an already-Nostr-authenticated browser — there is no Hermes
username or password at all.**

Specifically:

1. **Hermes binds `127.0.0.1:9119` and declares no auth provider** — Hermes's
   native "unauthenticated loopback mode." It is never directly internet- or
   even VPS-WAN-reachable; only the loopback gateway can reach it.
2. **Continuum's agent is the gateway.** Continuum already authenticates with
   the Nostr signer (NIP-07 `window.nostr` → sign a `kind: 22242` challenge → the
   agent verifies against a relay → issues an HMAC session bound to the user's
   **npub**). That npub-bearing session is the only credential that opens
   Hermes.
3. **No second login, no password, no SSH.** The user's Continuum session *is*
   their authorization. The `dashboard-password` bootstrap file and the
   `basic_auth` config are removed.

## Why the username/password only ever appeared

Hermes wires "declare a public hostname" and "require auth" together on purpose.
Setting a non-loopback `dashboard.public_url` populates the Host/Origin trust
set, but that same declaration engages Hermes's auth gate, which then demands an
auth provider (password or OAuth) — otherwise the loopback SPA session token
would become remotely reachable. `HERMES_DASHBOARD-2` set `public_url` and
therefore had no choice but to add `basic_auth`. Dropping `public_url` restores
passwordless loopback mode; the auth responsibility moves to the gateway that
already understands Nostr.

## What carries the identity across the boundary

The carrier is the **same-origin path mount** — Hermes is served at `/hermes/`
on the Continuum apex, where the `__Host-torii_session` cookie already works and
there is no cross-origin hop. Hermes natively supports this: behind
`X-Forwarded-Prefix: /hermes` it rewrites its root-relative `/assets/*` and
`/fonts/*` URLs and injects `window.__HERMES_BASE_PATH__`, so the SPA loads at
the prefix without a rebuild. The earlier `/hermes/` mount (HERMES-DASHBOARD-1)
broke only because nginx was not sending that header; it was never a Hermes
limitation.

Either way the *authority* is unchanged: the Nostr-bound npub, verified by the
agent.

## Rejected alternatives

- **Hermes `basic_auth` (HERMES-DASHBOARD-2)** — a second credential, set and
  recovered over SSH; withdrawn.
- **`HERMES_DESKTOP=1` loopback exemption** — Hermes's own allowance for a
  "Desktop-owned loopback backend behind a proxy," but the flag drags in
  desktop-specific behavior (cron ownership, GPU, per-profile routing) that is
  wrong for a headless VPS backend.
- **Third-party OAuth** — reintroduces an external identity provider and
  contradicts "Nostr is the identity."
- **Forking Hermes's UI to add a base path** — ongoing rebuild burden.

## Spike result (validated live 2026-09-13)

The spike proved the full path on the live VPS:

- **Passwordless loopback** — unsetting `dashboard.public_url` and `basic_auth`
  makes Hermes serve the dashboard with no login (loopback root returns `200`, no
  redirect).
- **`X-Forwarded-Prefix` asset rewrite** — confirmed: behind
  `X-Forwarded-Prefix: /hermes`, Hermes rewrites `/assets/*`, `/fonts/*` and
  `/favicon.ico` to the `/hermes/` prefix and injects
  `window.__HERMES_BASE_PATH__="/hermes"` and the session token.
- **WebSocket hand-off** — the trio is solved:
  - **Host** must be rewritten to loopback (`127.0.0.1:9119`); loopback mode
    accepts only loopback Hosts.
  - **Origin** must be stripped — CORS is locked to a `localhost`/`127.0.0.1`
    regex, and the loopback host guard rejects a cross-origin `https://…` Origin.
  - **Peer** stays loopback because nginx does NOT forward `X-Forwarded-For`.
  - **Token (`?token=`)** is the pinned `HERMES_DASHBOARD_SESSION_TOKEN` — and it
    must be **URL-safe (hex)**: a base64 token containing `+` breaks, because the
    query string decodes `+` to a space and the comparison yields `token_mismatch`.
  Result: `/api/ws` and `/api/pty` return `101 Switching Protocols` through nginx
  with a `chiefmonkey.art` Host/Origin and the correct token, and `403` without it.

The subdomain (`hermes.chiefmonkey.art`), its cert, `basic_auth`, the
`dashboard-password` bootstrap file, and `HERMES_DASHBOARD_BASIC_AUTH_SECRET` are
all removed. The `hermes.chiefmonkey.art` DNS A record is no longer needed.