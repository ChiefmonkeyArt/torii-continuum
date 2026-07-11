# Continuum Agent — VPS bring-up

The Continuum agent is a small Fastify daemon that owns three invariants
for a single operator:

1. **NIP-07 login** — verifies challenge events signed in the operator's
   browser via Plebeian Signer. No nsec ever reaches the VPS.
2. **Cashu wallet** — holds a small float in `memory/wallet/` (mode 0600)
   using [`@cashu/cashu-ts`](https://github.com/cashubtc/cashu-ts).
3. **Routstr chat** — OpenAI-compatible client, DeepSeek-Chat by default,
   DeepSeek-Coder-V2 for the `code` skill, fallback ladder configurable,
   pays one Cashu token per request.

Everything is designed for **one admin npub, one VPS**. Multi-tenant is
explicitly not a promise.

As of v0.2.4-alpha (CONT-CHARACTER-1), the agent also owns a **sealed,
local-first character stack** — stable identity, values, and reflexes
that persist between sessions without ever leaking to Nostr by default.
See `CHARACTER.md`, `SOURCES.md`, and `PANIC_KEY_SETUP.md`.

### The character stack in one glance

- **`kind:30092` character_root** — signed hash of `CHARACTER.md` + `SOURCES.md`.
- **`kind:30094` semantic_fact** — one durable belief or preference per event.
- **`kind:30095` procedural_skill** — a reflex applied before the model speaks.
- **`kind:30096` destructive_intent** — proposal to wipe. 60s cooldown + double-signature.
- **`kind:30097` emergency_wipe_authority** — the panic key (**optional**). If registered, collapses cooldown to single-sig for wipes. Skip it and the normal double-signature flow still works.

All five kinds are NIP-44 v2 encrypted to the operator's own npub. The
agent stores only ciphertext. Plaintext lives in RAM only, populated
via `POST /api/memory/unlock` after the browser has NIP-44-decrypted
every `.enc` file. See the endpoint reference at the bottom of this file.

---

## 0. Prerequisites

- Ubuntu 22.04 LTS (or any distro with systemd)
- Node 20 LTS (`nvm install 20 && nvm alias default 20`)
- Domain pointed at your VPS (e.g. `agent.yourdomain.tld`)
- Plebeian Signer installed in your browser (or any NIP-07 signer)
- A Cashu wallet you control with a small float (~5,000 sats to start)

## 1. Create a dedicated user

```bash
sudo adduser --system --group --home /home/continuum continuum
sudo -u continuum -H bash -c 'mkdir -p ~/agent && chmod 700 ~'
```

## 2. Clone + install

```bash
sudo -u continuum -H bash <<'EOF'
cd ~/agent
git clone https://github.com/ChiefmonkeyArt/torii-continuum.git repo
cd repo/agent
npm install --omit=dev
EOF
```

## 3. Configure

```bash
sudo -u continuum -H bash <<'EOF'
cd ~/agent/repo/agent
cp config.example.yaml config.yaml
chmod 600 config.yaml
EOF
```

Then edit `config.yaml`:

- `auth.admin_npub` — **your own npub1…** (decoded to hex at boot; fail-fast if invalid)
- `auth.session_secret` — 64 hex chars, generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `server.cors_origins` — add `https://continuum-torii.pplx.app` and any
  self-hosted origin you use
- `cashu.mints` — the mints you trust. Anything not in this list is
  **rejected** by `POST /api/wallet/receive`.
- `routstr.api_key` — your Routstr key if the endpoint requires one;
  leave blank for the public Cashu-paid path

## 4. systemd unit

```bash
sudo tee /etc/systemd/system/continuum-agent.service >/dev/null <<'EOF'
[Unit]
Description=Continuum Agent (Fastify)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=continuum
Group=continuum
WorkingDirectory=/home/continuum/agent/repo/agent
Environment=NODE_ENV=production
ExecStart=/usr/bin/env node index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=/home/continuum/agent/repo/agent
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now continuum-agent
sudo systemctl status continuum-agent --no-pager
```

Health check:

```bash
curl -s http://127.0.0.1:8787/api/health | jq
```

## 5. nginx + Let's Encrypt

```nginx
# /etc/nginx/sites-available/agent.yourdomain.tld
server {
  server_name agent.yourdomain.tld;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 512k;
  }

  listen 80;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/agent.yourdomain.tld /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d agent.yourdomain.tld
```

## 6. Point the frontend at your agent

Set a build-time env var when building `torii-continuum`:

```bash
VITE_AGENT_URL=https://agent.yourdomain.tld npm run build
```

or drop this into `window` at runtime (e.g. via a small `agent-config.js`
served alongside the site):

```html
<script>window.__CONTINUUM_AGENT_URL__ = 'https://agent.yourdomain.tld';</script>
```

The demo build at `continuum-torii.pplx.app` intentionally omits
`VITE_AGENT_URL` so it stays in offline/mock mode.

## 7. Top up the wallet

1. Open your Cashu wallet, mint or receive a small amount (e.g. 5,000 sats).
2. Emit an encoded token (`cashuAeyJ0b2tlbi…`) from a whitelisted mint.
3. Open your Continuum site → **Routstr** → **Connect Cashu wallet** →
   paste the token → **Redeem to agent**.
4. Balance shows in the header. Requests debit from it in real time.
5. Watch `~/agent/repo/agent/memory/costs.jsonl` for a per-request cost log.

## 8. Rotating things

- **Session secret**: change `auth.session_secret` and restart. All
  existing session tokens are invalidated immediately.
- **Admin npub**: change `auth.admin_npub` and restart.
- **Wallet**: proofs live in `memory/wallet/<mint-slug>.json`. Back them
  up (mode 0600); losing this file loses the sats.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `admin_npub invalid` on boot | Check the npub decodes cleanly (`npub1…`, 63 chars) |
| `session_secret too short` | Must be exactly 64 hex chars |
| Frontend "Login" says demo mode | `VITE_AGENT_URL` not set at build time, or `window.__CONTINUUM_AGENT_URL__` not injected |
| 403 from Plebeian Signer | Check you signed with the admin npub, not a secondary key |
| `mint not whitelisted` on redeem | Add the mint URL to `cashu.mints` and restart |
| Balance not updating | Check `memory/wallet/` permissions (should be `700`), then `systemctl restart continuum-agent` |

## 9b. Local models with Ollama (optional, CONT-AGENT-1b)

The agent can fall back to a local Ollama daemon when Routstr returns 402
(Cashu float empty) or is unreachable. This keeps chat working offline
and free, while preserving Routstr as the primary provider for frontier
quality.

### Install on the VPS

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl edit ollama.service
#   [Service]
#   Environment="OLLAMA_HOST=127.0.0.1:11434"
sudo systemctl restart ollama
ollama pull llama3.2:3b
```

The Ansible installer (`ops/ansible/`, role `ollama`) automates all of
that plus binds Ollama to loopback and pulls the models listed in
`group_vars/all.yml`.

### Enable in `agent/config.yaml`

```yaml
ollama:
  enabled: true
  endpoint: "http://127.0.0.1:11434"
  model: "llama3.2:3b"
  models:
    chat:    "llama3.2:3b"
    reflect: "qwen2.5:7b"
  temperature: 0.4
  timeout_ms: 60000

model_router:
  strategy: "routstr_first"   # or ollama_first | ollama_only | routstr_only
```

Restart the agent, then hit `GET /api/health/models` (admin-gated) to
confirm both providers are reachable.

### Model tier guide (Q4_K_M quant, CPU-only)

| Model                  | Disk  | RAM    | 2 vCPU  | 4 vCPU  | Use case               |
| ---------------------- | ----- | ------ | ------- | ------- | ---------------------- |
| `llama3.2:3b`          | 2 GB  | 3 GB   | ~15 t/s | ~30 t/s | Starter chat, reflection |
| `qwen2.5:7b`           | 5 GB  | 6 GB   | ~4 t/s  | ~7 t/s  | Reflection, thoughtful chat |
| `llama3.1:8b`          | 5 GB  | 6 GB   | ~3 t/s  | ~5 t/s  | Chat when you want more |
| `qwen2.5:14b`          | 9 GB  | 10 GB  | ~1 t/s  | ~2 t/s  | Reflection only (too slow for live chat) |

For live chat on 8B+ models comfortably, use a GPU box.

### Router strategies

- `routstr_first` — **recommended.** Routstr for every turn; Ollama picks
  up automatically when Routstr returns 402/payment or a network error.
- `ollama_first` — Ollama first (free); Routstr as fallback.
- `ollama_only` — never touch Routstr. Fully offline mode.
- `routstr_only` — never touch Ollama. Original behaviour (pre-1b).

Every successful chat response now carries a `provider` field (`routstr`
or `ollama`) so the Console can surface which model actually answered.

---

## 10. HTTP API reference (v0.2.14-alpha)

All endpoints under `/api/` except the auth pair are admin-gated. Send
`Authorization: Bearer <session-token>` obtained from `/api/auth/verify`.

**Public:**
- `GET /api/health`
- `POST /api/auth/challenge` — rate-limited (default 10 req/min/IP)
- `POST /api/auth/verify` — rate-limited (default 20 req/min/IP)

Rate limits are per client IP (nginx passes `X-Forwarded-For` to the
loopback-bound agent). Tune or disable in `config.yaml` §`rate_limit`:
```yaml
rate_limit:
  enabled: true              # false to skip the plugin entirely (dev only)
  auth_challenge_per_min: 10
  auth_verify_per_min: 20
  max_challenges: 1000       # hard cap on pending challenges Map
```

429 response shape:
```json
{ "statusCode": 429, "error": "Too Many Requests",
  "ok": false, "reason": "rate_limited", "retry_after_sec": 60 }
```
The response also carries a `Retry-After` header.

Structured `[auth]` log lines (one JSON per line, in `journalctl -u torii-continuum-agent.service`):
- `auth.challenge.issued` — `ip_prefix`, `challenge_prefix`, `pending`
- `auth.challenge.evicted` — `count`, `remaining`, `max` (fires when the challenges Map overflows)
- `auth.verify.success` — `ip_prefix`, `pubkey_prefix`
- `auth.verify.fail` — `ip_prefix`, `reason` (`expired` / `notfound` / `badsig` / `notadmin` / `malformed_event` / `wrong_kind`)
- `auth.ratelimited` — `ip_prefix`, `route`, `max`, `remaining_ms`

Only prefixes are logged; never full pubkeys, full challenges, or full IPs.

**Wallet + chat (admin):**
- `GET /api/wallet/balance`
- `POST /api/wallet/receive`
- `POST /api/chat` — response now includes `provider: "routstr" | "ollama"`
- `GET /api/health/models` — provider reachability + configured models

**Character (admin):**
- `GET /api/character` — CHARACTER.md text + hash + signed-root verification

**Memory (admin):**
- `GET /api/memory` — non-sensitive status snapshot
- `GET /api/memory/ciphertexts` — dump all `.enc` files for browser to decrypt
- `POST /api/memory/unlock` — accepts decrypted plaintext bundle from browser
- `POST /api/memory/lock` — wipe RAM cache
- `POST /api/memory/store` — write one ciphertext blob (validated as NIP-44 v2)

**Reflection + drafts (admin):**
- `POST /api/reflect` — offline pass over episodic, drops drafts into `pending/`
- `GET /api/pending` — list draft events awaiting signature
- `GET /api/pending/:file` — fetch one draft for signing
- `DELETE /api/pending/:file` — discard a draft

The agent NEVER signs, NEVER publishes, NEVER holds an nsec. Signing
happens in the operator's browser via Plebeian Signer, one click at a time.

---

## 11. Seeding the initial character stack

```bash
cd ~/agent/repo/agent
node scripts/seed-drafts.mjs
```

Writes unsigned `.draft.json` files into `agent/pending/` for:
- the 30092 character_root (anchors CHARACTER.md + SOURCES.md hashes)
- ~10 seed 30094 semantic facts (pseudonym-only, ancap-agorist stance, etc.)
- ~13 seed 30095 procedural skills (right-speech-filter, refusal-with-law, etc.)

The operator then reviews each draft in the console, signs via Plebeian
Signer (which also NIP-44-encrypts `content` to the operator's own npub),
and POSTs the encrypted ciphertext to `/api/memory/store`. Each stored
event replaces its predecessor by `(kind, d_tag)`.

---

## 12. Uninstall

```bash
sudo systemctl disable --now continuum-agent
sudo rm /etc/systemd/system/continuum-agent.service
sudo rm /etc/nginx/sites-enabled/agent.yourdomain.tld
sudo systemctl reload nginx
sudo deluser --remove-home continuum
```
