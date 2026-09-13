# Hermes Web Dashboard — subdomain + basic_auth runbook (HERMES-DASHBOARD-2)

Serve Nous Research's first-party **Hermes Web Dashboard** (`hermes dashboard`)
for the owner brain on its own subdomain (e.g. `hermes.chiefmonkey.art`), gated
by Hermes's **own password auth**. This supersedes the earlier `/hermes/`
path-mount design (HERMES-DASHBOARD-1), which is unworkable — see
[Why not `/hermes/`](#why-not-hermes) and `docs/hermes-dashboard-auth.md`.

## What ships where

| File | Target on VPS |
|---|---|
| `ops/nginx/hermes.conf` | `/etc/nginx/sites-available/<hostname>.conf` (+ symlink into `sites-enabled/`) |
| `ops/systemd/torii-hermes-dashboard.service` | `/etc/systemd/system/torii-hermes-dashboard.service` |

## Prerequisite you must do yourself

A **DNS record** for the subdomain, pointing at the VPS. The install cannot
create it (it lives at your registrar / DNS provider) and fails with a clear
message if it doesn't resolve:

```
hermes.chiefmonkey.art   A   <VPS-IP>
```

## Apply (via the workflow)

```bash
gh workflow run install-hermes-dashboard.yml \
  -f ref=v0.2.135-alpha \
  -f hostname=hermes.chiefmonkey.art
```

The workflow is **idempotent**: re-running re-installs the same files and
reuses the existing credential and signing secret — it never rotates them. It
configures Hermes through `hermes config set` (dot-notation keys), not by
hand-editing YAML, so it survives Hermes changing its config-file layout.

On first run it generates a random login password and writes it (0600, never to
logs) to `/home/hermes-owner/.hermes/dashboard-password`. Read it there:

```bash
sudo cat /home/hermes-owner/.hermes/dashboard-password
```

## Verify (against the live box, not docs)

1. **Unit up, loopback only.** `systemctl status torii-hermes-dashboard.service`
   shows `active`; the journal prints `HERMES_DASHBOARD_READY port=9119`. The
   service must never bind `0.0.0.0`.
2. **Auth engaged.** `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/`
   returns `302` (redirect to `/login`) — not `200`. A `200` without auth means
   `dashboard.public_url` didn't engage the gate.
3. **Login.** Browse `https://hermes.chiefmonkey.art/`, sign in with the username
   and the password from step above. The dashboard opens; the footer shows
   `<user> / via basic`.
4. **Chat WebSocket.** Open the Chat tab and send a message. The embedded TUI
   should accept it (not stay blank). Root mount means no asset 404s.

## Security invariants (do not break)

- **Loopback is load-bearing.** The dashboard binds `127.0.0.1:9119`; nginx is a
  plain reverse proxy (it forwards, it does not auth). If the binary ignores
  `--host`, block non-loopback 9119 at the firewall.
- **Hermes's own auth is the door.** `dashboard.public_url` is set to the
  subdomain, so Hermes requires `dashboard.basic_auth`. There is no unauth
  public-dashboard mode since the June-2026 hardening.
- **No Continuum-session gating on the subdomain.** The `__Host-torii_session`
  cookie is host-locked to the apex and is never sent to a subdomain, so
  `auth_request` against it would always 401. Hermes auth is the sole gate here
  — by design, not by omission.
- **NPC never exposed.** Only `hermes-owner` runs a dashboard. `hermes-npc`
  stays loopback-only, reachable solely via the NAP-BRIDGE DM path.

## Update-resilience notes

- Config is written via `hermes config set` with dot-notation keys
  (`dashboard.public_url`, `dashboard.basic_auth.username`,
  `dashboard.basic_auth.password`), and read via `hermes config get` /
  `hermes config path` / `hermes config env-path`. No hardcoded file paths, no
  importing Hermes's internal `hash_password` module.
- `dashboard.basic_auth.password` is stored as plaintext and hashed in-memory by
  Hermes (its documented alternative to precomputing `password_hash`). It sits
  in `config.yaml` (0600). If you prefer no plaintext at rest, replace it with a
  `password_hash` using Hermes's hasher — but that relies on an internal module
  path that could move on update.
- Before relying on a fresh Hermes release, run `hermes config migrate` to pick
  up renamed/retired settings, and re-check the `Verify` items above.

## Changing / resetting the password

```bash
sudo -u hermes-owner bash -lc 'hermes config set dashboard.basic_auth.password "new-password"'
sudo systemctl restart torii-hermes-dashboard.service
```

## Why not `/hermes/`

Hermes's web SPA (v0.21.x) is built for a **root** mount. Its login form posts
to `/auth/password-login` and it lazy-loads chunks from `/assets/` — both
root-relative URLs that **ignore** `X-Forwarded-Prefix` and the `public_url`
path. A path-prefix mount therefore 404s on login and breaks the Chat tab. A
subdomain (root) is the only clean form. Full reasoning in
`docs/hermes-dashboard-auth.md`.

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
gh workflow run install-hermes-dashboard.yml -f ref=v0.2.135-alpha
```