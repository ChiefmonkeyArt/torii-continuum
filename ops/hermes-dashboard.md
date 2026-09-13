# Hermes Web Dashboard — loopback + Nostr gateway (passwordless)

Serve Nous Research's first-party **Hermes Web Dashboard** (`hermes dashboard`)
for the owner brain, mounted at `/hermes/` on the Continuum apex and gated by
the operator's **existing Continuum Nostr session**. There is **no password, no
subdomain, and no SSH** for the user. This supersedes the subdomain +
`basic_auth` design (HERMES-DASHBOARD-2), which was withdrawn — see
`docs/hermes-dashboard-auth.md`.

## What ships where

| File | Target on VPS |
|---|---|
| `ops/nginx/hermes.conf` | `/opt/torii/nginx-fragments/hermes.conf` (included by the torii-base gateway) |
| `ops/systemd/torii-hermes-dashboard.service` | `/etc/systemd/system/torii-hermes-dashboard.service` |

## What the user does

Nothing new. They sign in to Continuum with their **Nostr signer** (the same
identity they already use), then open Hermes from within Continuum — it appears
at `/hermes/` already authorised. The **most a regular user ever does** is add a
few DNS A records for the VPS itself; installing the dashboard requires no
second credential and no terminal access.

## Apply (via the workflow)

```bash
gh workflow run install-hermes-dashboard.yml -f ref=v0.2.137-alpha
```

The workflow is **idempotent**: re-running re-installs the same files and
reuses the pinned session token — it never rotates it. It un-keys
`dashboard.public_url` and `dashboard.basic_auth` (restoring passwordless
loopback mode) and pins `HERMES_DASHBOARD_SESSION_TOKEN`, so no plaintext
credential ever lands on disk.

## Verify (against the live box, not docs)

1. **Unit up, loopback only.** `systemctl status torii-hermes-dashboard.service`
   shows `active`; the journal prints `HERMES_DASHBOARD_READY port=9119`. The
   service must never bind `0.0.0.0`.
2. **Passwordless loopback.** `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/`
   returns `200` — not a redirect. A `302` to `/login` means `public_url` /
   `basic_auth` is still set and the gate is still on.
3. **Gated through the gateway.** `curl -sS -o /dev/null -w '%{http_code}' https://<apex>/hermes/`
   returns `302` (to `/continuum/`) when unauthenticated, and the dashboard
   opens only with a valid Continuum session.
4. **Chat WebSocket.** Open the Chat tab and send a message. The embedded TUI
   should accept it. This exercises the `/hermes/` WS hand-off (loopback Host,
   stripped Origin, `?token=`), the one part worth checking after any Hermes
   upgrade.

## Security invariants (do not break)

- **Loopback is load-bearing.** The dashboard binds `127.0.0.1:9119`; the
  gateway is the only route in, and it authenticates before proxying. If the
  binary ignores `--host`, block non-loopback 9119 at the firewall.
- **Nostr session is the sole authority.** The nginx `auth_request` target
  forwards the `__Host-torii_session` cookie to the Continuum agent's
  `GET /api/auth/session`; 200 allows, 401 redirects to `/continuum/`. There is
  no Hermes username/password.
- **Session token must be URL-safe.** `HERMES_DASHBOARD_SESSION_TOKEN` must be
  **hex** (or base64url). A standard base64 value containing `+` breaks the
  `?token=` comparison — the query string decodes `+` to a space, yielding
  `token_mismatch` and a dead Chat tab.
- **NPC never exposed.** Only `hermes-owner` runs a dashboard. `hermes-npc`
  stays loopback-only, reachable solely via the NAP-BRIDGE DM path.

## Update-resilience notes

- Config is cleared via `hermes config unset dashboard.public_url` and
  `hermes config unset dashboard.basic_auth`, and read via `hermes config get`
  / `hermes config path` / `hermes config env-path`. No hardcoded file paths.
- The session token lives in Hermes's `.env` (`hermes config env-path`), read as
  `HERMES_DASHBOARD_SESSION_TOKEN`. It must stay present — if removed Hermes
  falls back to a random per-process token and the browser's cached `/hermes/`
  SPA loses its WS auth until reload.
- `X-Forwarded-Prefix: /hermes` is what makes Hermes rewrite its `/assets/`,
  `/fonts/` and `/favicon.ico` URLs to the prefix (it injects
  `window.__HERMES_BASE_PATH__`). The gateway fragment sends it; do not drop it
  or the SPA 404s on its own assets.
- Before relying on a fresh Hermes release, run `hermes config migrate` and
  re-check the four `Verify` items above (especially the Chat WebSocket).

## Rotating the session token

```bash
sudo -u hermes-owner bash -c "sed -i 's|^HERMES_DASHBOARD_SESSION_TOKEN=.*|HERMES_DASHBOARD_SESSION_TOKEN='$(openssl rand -hex 32)'|' $(hermes config env-path)"
sudo systemctl restart torii-hermes-dashboard.service
```

Re-running the install later will not rotate it (the workflow keeps an existing
token idempotently).

## Repair — restore the missing Hermes venv (when `hermes` won't launch)

Symptom (seen live): the unit fails with

```
/home/hermes-owner/.local/bin/hermes: line 4:
  /home/hermes-owner/.hermes/hermes-agent/venv/bin/python: No such file or directory
```

The `hermes` wrapper exists (so `command -v hermes` still resolves, and the
idempotent installer would wrongly skip) but its venv is gone. The valuable
state — the `owner` profile — lives separately at
`/home/hermes-owner/.hermes/profiles/owner/`, so repairing the runtime does not
touch the brain's config.

```bash
# ── 0. Diagnose (confirm the layout before touching anything) ────────────
sudo -u hermes-owner ls -la /home/hermes-owner/.hermes/
sudo -u hermes-owner cat /home/hermes-owner/.local/bin/hermes

# ── 1. Back up the profile state (never the venv — that is the broken part) ──
sudo tar -czf /root/hermes-owner-backup-$(date +%s).tar.gz \
  -C /home/hermes-owner/.hermes profiles config.yaml 2>/dev/null || true

# ── 2. Remove ONLY the broken runtime; KEEP profiles/owner ───────────────
sudo -u hermes-owner rm -rf /home/hermes-owner/.hermes/hermes-agent
sudo -u hermes-owner rm -f  /home/hermes-owner/.local/bin/hermes

# ── 3. Reinstall vanilla Hermes (recreates venv + wrapper) ───────────────
sudo -u hermes-owner bash -c 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'

# ── 4. Verify hermes launches and the owner profile is intact ────────────
sudo -u hermes-owner bash -lc 'command -v hermes && hermes --version'
sudo -u hermes-owner bash -lc 'hermes profile list'   # must still show 'owner'
```

Step 2 uses `rm -rf` — deliberately scoped to `hermes-agent/` + the wrapper only,
never `profiles/`. Step 1's backup is the safety net. If step 0 shows anything
unexpected, stop and reassess rather than deleting.

After repair, re-run the install workflow to re-apply config + nginx + start:

```bash
gh workflow run install-hermes-dashboard.yml -f ref=v0.2.137-alpha
```