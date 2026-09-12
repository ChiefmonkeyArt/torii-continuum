# Hermes Web Dashboard — wiring runbook (HERMES-DASHBOARD-1)

Mount Nous Research's first-party Hermes Web Dashboard at `/hermes/` on the
gateway domain, gated behind the Continuum admin session. Referenced from
`docs/hermes-two-voice.md` → "Hermes Web Dashboard behind the admin session".

The Continuum side (session cookie + `GET /api/auth/session`) shipped in
[v0.2.125-alpha][v125]. This document is the **operator-side** wiring: one nginx
fragment + one systemd unit. Apply, verify, enable — in that order.

[v125]: https://github.com/ChiefmonkeyArt/torii-continuum/releases/tag/v0.2.125-alpha

## What ships where

| File | Target on VPS |
|---|---|
| `ops/nginx/hermes.conf` | `/etc/nginx/snippets/hermes.conf` |
| `ops/systemd/torii-hermes-dashboard.service` | `/etc/systemd/system/torii-hermes-dashboard.service` |

## Apply (operator step, manual by design)

The dispatcher must not be able to force this — the dashboard is a new public
surface behind an existing private AI.

```bash
# 1. Install the nginx fragment, then add the include inside your gateway server.
sudo install -m 0644 ops/nginx/hermes.conf /etc/nginx/snippets/hermes.conf
#   Inside the HTTPS `server { ... }` block that serves /continuum/:
#       include snippets/hermes.conf;
sudo nginx -t && sudo systemctl reload nginx

# 2. Install and enable the dashboard unit.
sudo install -m 0644 ops/systemd/torii-hermes-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now torii-hermes-dashboard.service
```

## Verify at implementation (against the installed build, not docs)

These are the items that cannot be confirmed from the repo and must be checked
on the live box before the dashboard is considered done. Each is a potential
blocker, not a nicety.

1. **Exact launch form.** `hermes dashboard` (machine dashboard) vs
   `hermes dashboard --isolated` (single profile). Confirm which shows the
   `owner` profile as intended, and lock the `ExecStart` to it. The difference
   is profile scope, not the UI.
2. **Sub-path mounting.** Confirm the SPA loads assets and calls its API under
   the `/hermes/` prefix (no 404s from root-absolute paths). The fragment sends
   `X-Forwarded-Prefix: /hermes`; if the build ignores it, find Hermes's
   base-url / prefix setting and set it to `/hermes/`.
3. **Chat-tab WebSocket.** Open the Chat tab and confirm the embedded TUI's
   `/api/pty` WebSocket connects and stays up through the proxy with the
   dashboard's own auth gate OFF.
4. **Cookie round-trip.** Sign in to the Continuum console and confirm the
   `__Host-torii_session` cookie is set; then reload `/hermes/` — it should
   load without a login loop. Sign out of Continuum and confirm `/hermes/`
   redirects to `/continuum/` (302) and, if forced, returns 401 when the
   auth_request is hit directly.

## Security invariants (do not break)

- **Single gate.** No Nous OAuth, no second Hermes login. The npub is the only
  credential; Hermes dashboard auth stays OFF (loopback bind).
- **Loopback is load-bearing.** The dashboard must never bind `0.0.0.0`. If the
  binary ignores `--host`, block non-loopback 9119 at the firewall.
- **NPC never exposed.** Only `hermes-owner` runs a dashboard. `hermes-npc`
  stays loopback-only, reachable solely via the NAP-BRIDGE DM path.
- **Bearer admin API unchanged.** `/api/*` still requires the `Authorization:
  Bearer` header; the cookie unlocks only the read-only `/api/auth/session`.

## Fallback — subdomain (do NOT use as-is)

A `hermes.chiefmonkey.art` subdomain will NOT work with the current cookie: the
`__Host-torii_session` cookie is host-locked to the apex origin and is never
sent to a subdomain, so `auth_request` there always sees no cookie and 401s.
Using a subdomain would require a Domain-scoped (non-`__Host-`) cookie — a
weaker, wider credential — which is explicitly out of scope.

## Repair — restore the missing Hermes venv (when `hermes` won't launch)

Symptom (seen live): the systemd unit fails with

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

After repair, re-run the install workflow to finish the nginx include + start:

```bash
gh workflow run install-hermes-dashboard.yml -f ref=v0.2.133-alpha
```