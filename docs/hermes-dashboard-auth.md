# Decision: Hermes dashboard uses its own auth on a subdomain

- **Status:** Accepted
- **Date:** 2026-09-13
- **Supersedes:** the `/hermes/` same-origin path mount (HERMES-DASHBOARD-1)
- **Decision drivers:** Hermes v0.21.x's June-2026 dashboard hardening

## Context

We wanted the Hermes Web Dashboard (owner brain) reachable through the Torii
gateway, gated on the existing Continuum admin session, with no second login.
The original design bound the dashboard loopback-only and mounted it at
`/hermes/` on the apex origin, with `nginx auth_request` against
`GET /api/auth/session` as the single gate.

Two facts surfaced while verifying that design against the real build:

1. **A path prefix cannot work.** Hermes's web SPA is built for a root mount.
   Its login form posts to `/auth/password-login` and it lazy-loads chunks from
   `/assets/` — both root-relative URLs that ignore the `X-Forwarded-Prefix`
   header and the `dashboard.public_url` path. Under `/hermes/` those requests
   fall out of the prefix and 404, so login never completes and the Chat tab
   never loads.

2. **Any non-loopback exposure requires Hermes's own auth.** Since the June-2026
   hardening, `dashboard.public_url` set to a non-loopback host engages an auth
   gate that cannot be disabled. `hermes dashboard --insecure` is a no-op; the
   help text states a public bind "always requires an auth provider (password or
   OAuth)".

The second fact also rules out the original "drop the Continuum cookie onto the
same origin" idea on a subdomain: the session cookie is `__Host-torii_session`,
host-locked to the apex, so it is never sent to a subdomain and `auth_request`
against it would always 401.

## Decision

Serve the dashboard at the **root of a dedicated subdomain**
(`hermes.chiefmonkey.art`), gated by **Hermes's own `dashboard.basic_auth`**
(password form login, ~30-day session). The dashboard process stays
loopback-only (`127.0.0.1:9119`); nginx is a plain reverse proxy that forwards
and does not authenticate.

Consequences we accept:

- **A human password is now in the auth path.** The operator signs in once with
  a username + password; the session cookie lasts ~30 days. This is a *second*
  credential, but the alternative — no dashboard, or a broken path mount — is
  worse. The password is generated once at install (persisted 0600, never
  logged) and configurable afterwards.
- **The Continuum session does not gate the dashboard.** It cannot transit to a
  subdomain (host-locked cookie). Hermes's own auth is the sole door on this
  host, by design.
- **Loopback bind remains the security boundary.** Hermes is never directly
  internet-reachable; nginx is the only ingress to `9119`.

## Resilience to Hermes updates

Configuration is applied through `hermes config set` / `hermes config get` using
dot-notation keys (`dashboard.public_url`, `dashboard.basic_auth.username`,
`dashboard.basic_auth.password`), and file locations resolved via
`hermes config path` / `hermes config env-path`. We do **not** hand-edit
`config.yaml` or import Hermes's internal `hash_password` module, either of
which could break when Hermes changes its layout. The `password` key is stored
plaintext and hashed in-memory by Hermes (its documented alternative to a
precomputed `password_hash`); op-security is preserved by `config.yaml` being
`0600`. A stable `HERMES_DASHBOARD_BASIC_AUTH_SECRET` keeps login sessions alive
across restarts.

## Rejected alternatives

- **Same-origin `/hermes/` path mount** — broken by the SPA's root-relative URLs
  (login 404s, assets 404), confirmed against the live build.
- **Path mount + upgrading the Continuum cookie to Domain-scoped** — weakens a
  deliberate security boundary (a wider, non-`__Host-` credential) to save a
  prefix, and still doesn't fix the SPA's root-relative URLs.
- **Rebuilding Hermes's web UI with a prefix base** — forks a third-party
  artifact and creates an ongoing rebuild burden on every Hermes release.
- **nginx-injected Authorization header** — Hermes `basic_auth` is a form/cookie
  flow (`POST /auth/password-login`), not HTTP Basic; there is no header to
  inject.