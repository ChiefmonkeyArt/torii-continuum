# Continuum ops

Everything you need to run Torii Continuum on your own VPS instead of on
`pplx.app`.

Two paths are supported:

- **Full box (Ansible)** — provisions a whole host: torii-base, the
  Continuum frontend + agent, TLS, and optionally Ollama. Start here for a
  fresh server.
- **Agent only (`install-agent.sh`)** — drops just the hardened agent +
  systemd unit + optional same-origin `/api/` proxy onto a host you already
  run. See [Standalone agent install](#standalone-agent-install-install-agentsh).

Contents:

- `ansible/` — full playbook that installs [torii-base](https://github.com/ChiefmonkeyArt/torii-base),
  Continuum (frontend + agent), and optionally Ollama.
- `install-agent.sh` — standalone, idempotent agent installer.
- `systemd/torii-continuum-agent.service` — hardened systemd unit for the
  standalone install.
- `nginx/torii-api.conf` — same-origin `/api/` reverse-proxy snippet for the
  standalone install.
- `nginx/continuum.conf.template` — annotated source for the nginx fragment
  the Ansible installer renders.

---

## Why a VPS?

The published `pplx.app` build of Continuum is static-only. It's great for
trying the UI, but three key pieces don't run in that sandbox:

- **Routstr chat** — needs a persistent Cashu float on-server.
- **Character memory** — encrypted at rest, decrypted at runtime.
- **Ollama local models** — needs a background daemon on the same host.

Running Continuum on a small VPS with `torii-base` gives you all three, on
a domain you control, sharing one nostr identity with the other Torii apps
mounted next to it (Plebeian, Quest).

---

## What the installer does

```
Ubuntu 22 / 24 host
├── torii-base
│   ├── nginx  (Let's Encrypt TLS)
│   ├── launcher at /
│   └── sidecar (127.0.0.1:8780)
├── continuum
│   ├── /continuum/ (static SPA, served from /home/continuum/app/dist)
│   ├── /continuum/api/ → 127.0.0.1:8787 (agent)
│   └── continuum-agent.service (systemd, hardened)
└── (optional) ollama
    └── 127.0.0.1:11434, models pulled per config
```

Everything runs as unprivileged users. The agent binds to loopback only —
external traffic never bypasses nginx.

---

## VPS sizing

Continuum agent alone is tiny (~100 MB RAM). Ollama is the dominant cost.

| Config                                        | RAM   | Disk  | vCPU | Rough £/mo (Hetzner) |
| --------------------------------------------- | ----- | ----- | ---- | -------------------- |
| Continuum + Quest, no Ollama                  | 2 GB  | 30 GB | 2    | £4–6                 |
| + Ollama 3B (llama3.2:3b)                     | 6 GB  | 50 GB | 2–3  | £8–10                |
| + Ollama 8B (llama3.1:8b) or 7B (qwen2.5:7b)  | 12 GB | 60 GB | 4    | £18–25               |
| + Ollama 14B (qwen2.5:14b, CPU-only)          | 16 GB | 80 GB | 4–6  | £30+                 |

Recommended starting point: **Hetzner CPX21** (3 vCPU, 8 GB, 80 GB) at
around £8/mo. Comfortably runs Continuum + Quest + Ollama 3B, with headroom
for one more small app.

Rough Ollama throughput on shared-CPU VPSes (Q4_K_M quant):

- 3B model: ~15 tok/s on 2 vCPU. Chat is fluid.
- 7B model: ~7 tok/s on 4 vCPU. Chat is tolerable, reflection is fine.
- 8B model: ~5 tok/s on 4 vCPU.
- 14B model: ~2 tok/s on 4 vCPU. Reflection only — don't use for chat.

For 8B+ chat on a live UI, get a GPU box (Hetzner GEX44 or a dedicated
Nvidia server); numbers above assume CPU-only.

---

## Quickstart (Ansible)

**On your workstation** (any OS with Ansible 2.14+):

```bash
git clone https://github.com/ChiefmonkeyArt/torii-continuum.git
cd torii-continuum/ops/ansible

cp inventory.yml.example inventory.yml
cp group_vars/all.yml.example group_vars/all.yml
cp group_vars/vault.yml.example group_vars/vault.yml

# Fill in inventory (your VPS IP/user), all.yml (your domain, models),
# and vault.yml (admin_npub, session_secret, cashu mints).

ansible-vault encrypt group_vars/vault.yml
ansible-playbook -i inventory.yml site.yml --ask-vault-pass
```

That's the whole installer. Re-running it is idempotent — the playbook is
safe to re-run to update Continuum, rotate config, or add Ollama later.

To enable Ollama on an existing deployment:

```bash
# edit group_vars/all.yml:  torii_enable_ollama: true
ansible-playbook -i inventory.yml site.yml --ask-vault-pass --tags ollama,continuum
```

---

## Standalone agent install (`install-agent.sh`)

The Ansible playbook above provisions a whole box. If you already have a
gateway host with nginx + TLS (your Torii, your gateway) and just want to
drop the **agent** onto it as a hardened service, use the standalone
installer instead. It touches only the agent, its systemd unit, and an
optional same-origin `/api/` nginx proxy — nothing else on the host.

### Prerequisites

- A Linux host you control with `node` (>= 20), `npm`, `rsync`, `openssl`,
  `systemctl`, and `getent` on `PATH`.
- Root (the installer creates a system user and writes to `/opt` and
  `/etc/systemd`).
- Optional: `nginx` (for the same-origin proxy) and `curl` (for the health
  proof). Both are auto-skipped if absent.

### Install / upgrade

From a checkout of this repo, as root:

```bash
sudo ./ops/install-agent.sh
```

To also wire the `/api/` proxy into an existing server block automatically:

```bash
sudo TORII_NGINX_SITE=/etc/nginx/sites-available/torii ./ops/install-agent.sh
```

Environment overrides (all optional):

| Variable            | Effect                                                          |
| ------------------- | -------------------------------------------------------------- |
| `TORII_NGINX_SITE`  | server-block file to auto-insert `include snippets/torii-api.conf;` |
| `SKIP_NGINX=1`      | install agent + systemd only, skip all nginx steps             |
| `SKIP_HEALTHCHECK=1` | skip the final `/api/health` probe (e.g. air-gapped test)     |

The same command upgrades an existing install: re-running is idempotent. It
re-syncs code (`rsync --delete`), re-asserts ownership + permissions,
re-runs `npm ci --omit=dev`, and restarts the service — but it **never**
touches persistent state (`memory/`, `pending/`, `ciphertexts/`) or an
existing `config.yaml`.

### What it lays down

```
/opt/torii/continuum-agent/            # 0750, owned by continuum:continuum
  index.mjs, core/, scripts/, ...      # agent code (read-only to the service)
  node_modules/                        # production deps (npm ci --omit=dev)
  config.yaml                          # 0600, generated once, never clobbered
  memory/  memory/wallet/              # 0700, persistent — Cashu float + logs
  pending/  ciphertexts/               # 0700, persistent

/etc/systemd/system/torii-continuum-agent.service
/etc/nginx/snippets/torii-api.conf                 # same-origin /api/ proxy
/etc/nginx/conf.d/torii-api-ratelimit.conf         # http-context rate-limit zone
```

The service account `continuum` is a locked, non-login system user
(`--shell /usr/sbin/nologin`, `passwd --lock`).

### Config generation

On a first install the script renders `config.yaml` from
`config.example.yaml`, injecting a fresh 32-byte hex `session_secret`
(`openssl rand -hex 32`) and leaving `admin_npub` empty. The secret is
written straight into a `0600` file and never echoed. If `config.yaml`
already exists it is preserved untouched. The generated config is then
parsed by the agent's own loader before the service is (re)started, so a
bad config fails the install instead of crash-looping the service.

### nginx: contexts matter

Two files, two contexts — this is deliberate and required by nginx:

- `snippets/torii-api.conf` holds the `location /api/ { ... }` block and
  **must be included inside a `server { ... }` block** — your gateway's
  HTTPS server for the Console's domain.
- `conf.d/torii-api-ratelimit.conf` holds the `limit_req_zone` directive,
  which is only valid in the **http context**. Debian/Ubuntu's stock
  `nginx.conf` auto-includes `conf.d/*.conf`, so it lands in the right
  place automatically.

The zone name (`torii_api_limit`) is deliberately specific so it won't
collide with a generic global zone. The installer refuses to write the zone
fragment if a zone of that name is already declared anywhere under
`/etc/nginx`, and always runs `nginx -t` before reloading — it never
reloads a broken config. If you wire the include yourself, add this inside
your server block:

```nginx
include snippets/torii-api.conf;
```

The agent listens on `127.0.0.1:8787` only; nothing reaches it except
through this proxy. nginx is the single hop in front, on the same host, so
`$remote_addr` is the real client and is passed as `X-Real-IP` — that is
the agent's rate-limit bucket key. Do not add another proxy in front
without revisiting that assumption.

### Rate limiting (defence in depth)

Two independent layers:

1. **In-process** — the agent rate-limits its auth surface with
   `@fastify/rate-limit` (since v0.2.14-alpha). This is the source of truth
   for per-route auth limits and `Retry-After`.
2. **At the edge** — the nginx `limit_req` (30 r/s, burst 60, `nodelay`)
   sheds a scripted flood before it reaches Node. Far above any human
   sign-in cadence.

### First-touch admin claim

A freshly installed agent boots with an empty `admin_npub` — **unclaimed**.
The first caller to complete a valid NIP-07 challenge/verify against
`/api/auth/verify` atomically claims admin: their npub is persisted into
`config.yaml` (canonical `npub1…` form, `0600`) and every later caller is
rejected unless their pubkey matches. So:

1. Install the agent, then immediately open the Console and sign in with
   your own NIP-07 signer — **you** become admin.
2. `/api/health` reports `"admin_claimed": true` once the claim lands.
3. The claim is race-safe (two simultaneous first verifies → exactly one
   wins) and **fails closed** — if the config write fails, no session token
   is issued and the box stays claimable rather than half-claimed.

To reset the admin (hand the box to a different signer), stop the service,
clear `admin_npub` back to `""` in `config.yaml`, and restart:

```bash
sudo systemctl stop torii-continuum-agent
sudo -u continuum sed -i 's/^admin_npub:.*/admin_npub: ""/' /opt/torii/continuum-agent/config.yaml
sudo systemctl start torii-continuum-agent
```

### Service management

```bash
sudo systemctl status  torii-continuum-agent
sudo systemctl restart torii-continuum-agent
sudo journalctl -u torii-continuum-agent -f          # follow logs
curl -sf http://127.0.0.1:8787/api/health            # local liveness
```

Logs are structured and privacy-preserving: pubkeys, challenges, and IPs
are only ever emitted as short prefixes, never in full; the session secret
is never logged.

### Security model

- Dedicated locked `continuum` system user; no shell, no login, no
  capabilities (`CapabilityBoundingSet=` empty).
- `ProtectSystem=strict` makes the entire filesystem read-only to the
  service **except** the paths in `ReadWritePaths`: the agent's `memory/`
  directory and the single `config.yaml` file (writable only so the
  one-time first-touch claim can persist your npub). Code and
  `node_modules` are read-only even to the service that runs them.
- `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectHome`,
  `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`,
  `ProtectClock`, `ProtectProc=invisible`, `RestrictNamespaces`,
  `MemoryDenyWriteExecute`, a `@system-service` syscall filter, and
  `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (the only families the
  runtime needs to reach loopback nginx and outbound Routstr/mints/Ollama).

### Upgrade / rollback / uninstall

- **Upgrade**: `git pull` the repo and re-run `sudo ./ops/install-agent.sh`.
  State is preserved; only code + deps are refreshed and the service
  restarts.
- **Rollback**: check out the previous tag and re-run the installer. Your
  `config.yaml` and `memory/` are untouched across the downgrade.
- **Uninstall**:

  ```bash
  sudo systemctl disable --now torii-continuum-agent
  sudo rm /etc/systemd/system/torii-continuum-agent.service
  sudo rm -f /etc/nginx/snippets/torii-api.conf /etc/nginx/conf.d/torii-api-ratelimit.conf
  sudo systemctl daemon-reload
  # remove the include line from your server block, then: sudo nginx -t && sudo systemctl reload nginx
  # Back up first if you want to keep the wallet/characters:
  sudo rm -rf /opt/torii/continuum-agent
  sudo userdel continuum   # optional
  ```

  Deleting `/opt/torii/continuum-agent` destroys the Cashu float in
  `memory/wallet/` and your encrypted characters in `ciphertexts/` — back
  those up first (see **Backups** above).

### Troubleshooting

- **Health probe fails at install end** — inspect
  `journalctl -u torii-continuum-agent -n 50 --no-pager`. Most often a
  config error; the installer validates config before restart, so this
  usually means a port clash or a missing dependency.
- **`nginx -t` fails after wiring** — a duplicate `limit_req_zone` name or
  the include landing outside a `server{}` block. The installer leaves a
  `.torii.bak` of your site file next to the original.
- **Can't claim admin** — confirm `/api/health` shows
  `"admin_claimed": false`; if it's already `true`, someone (or a previous
  session) claimed it. Reset as above.

---

## What lives where

```
/opt/torii/                              # torii-base state
  env                                    # admin token, domain
  registry.json                          # which apps are mounted where
  root_app.conf                          # nginx include for `/`
  launcher/                              # launcher static assets
  nginx-fragments/
    continuum.conf                       # dropped by the continuum role

/home/continuum/
  app/                                   # git checkout of torii-continuum
    dist/                                # vite build output (served by nginx)
    agent/
      config.yaml                        # rendered by ansible, chmod 600
      memory/
        wallet/                          # Cashu proofs (like cash — back it up)
        panic-key-nudge.json             # one-time console hint state
        costs.jsonl                      # per-request accounting (no PII)
        audit.jsonl                      # auth events (no PII)
      ciphertexts/                       # encrypted character/memory events
      pending/                           # draft nostr events awaiting your signature

/etc/systemd/system/
  torii-base-sidecar.service             # 127.0.0.1:8780 launcher API
  continuum-agent.service                # 127.0.0.1:8787 agent
  ollama.service.d/override.conf         # binds ollama to 127.0.0.1:11434 (optional)

/etc/nginx/sites-available/torii         # single server block; includes all fragments
```

---

## Backups

The two things you must back up:

1. `/home/continuum/app/agent/memory/wallet/` — the Cashu float. Losing
   this is losing sats.
2. `/home/continuum/app/agent/ciphertexts/` — encrypted character memory.
   Losing these means the agent forgets who you told it to be.

Everything else is regeneratable from the git repo + your nostr keys.
A weekly rsync of `/home/continuum/app/agent/{memory,ciphertexts}` to a
different host or backup service is plenty.

---

## Verifying the install

On the VPS:

```bash
sudo torii doctor
```

Should show all `ok`, with routstr and ollama either `ok` (if enabled) or
`warn` (if you skipped Ollama or Routstr is unreachable from your network).

From your laptop:

```bash
curl https://your-domain.com/                             # launcher (or your promoted app)
curl https://your-domain.com/continuum/                   # continuum SPA
curl https://your-domain.com/continuum/api/health          # agent
```

The last one returns `{"ok":true,"service":"torii-continuum-agent","version":"<agent-version>",...}` — the version string is read from `agent/package.json` at boot, so it always matches the shipped release.

Chat needs you to sign in via NIP-07 on the Console (`/continuum/`),
top up the Cashu wallet from your signer, and post a first message. See
`agent/README.md` for the full end-to-end walkthrough.

---

## Ollama fallback (CONT-AGENT-1b)

When `torii_enable_ollama: true`, the agent config gets:

```yaml
ollama:
  enabled: true
  endpoint: "http://127.0.0.1:11434"
  models:
    chat: "llama3.2:3b"
    reflect: "llama3.2:3b"

model_router:
  strategy: "routstr_first"
```

`routstr_first` (the recommended default) means:

1. Chat turns hit Routstr first — you get frontier models, paid in Cashu.
2. If Routstr returns 402 (float empty) or is unreachable, the agent
   falls back to Ollama automatically. Chat keeps working, offline and free.
3. When the wallet has sats again, the next turn goes back to Routstr.

Other strategies:

- `ollama_first` — Ollama first, Routstr as fallback. Cheap and slow by default.
- `ollama_only` — never call Routstr. Fully offline mode.
- `routstr_only` — never call Ollama. Original behaviour (pre-1b).

The Console's `/api/health/models` endpoint reports which providers are
enabled, reachable, and which models are loaded.

---

## License

MIT — matches Continuum.
