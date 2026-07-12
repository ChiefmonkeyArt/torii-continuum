# Continuum — Deployment Guide

This guide covers deploying Torii Continuum to a VPS from scratch,
including DNS setup, the one-click installer, and post-install steps.

## Prerequisites

### 1. A VPS

- **OS:** Ubuntu 22.04+ or Debian 12+
- **RAM:** 1GB minimum (2GB recommended)
- **Disk:** 10GB minimum
- **Access:** SSH key-based login as root or a sudo-enabled user

### 2. A Domain with DNS Access

You need two subdomains pointing at your VPS:

| Subdomain | Purpose |
|-----------|---------|
| `agent.<your-domain>` | Agent API (Fastify backend) |
| `continuum.<your-domain>` | Frontend (Vite SPA) |

**DNS records to create:**

```
A    agent.torii.example.com    → 203.0.113.42
A    continuum.torii.example.com → 203.0.113.42
```

Or a wildcard:

```
A    *.torii.example.com    → 203.0.113.42
```

### 3. A Nostr Identity (npub)

You need your Nostr **npub** (public key) before deploying. This becomes
the admin identity — only this npub can access admin controls.

Install [Plebeian Signer](https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/)
(Firefox) or the [Chrome equivalent](https://chromewebstore.google.com/detail/ijbiankmnehjephbkfdgphckcdgbgoho),
create or import a key, and copy your npub. It looks like:

```
npub1vasdjx8jt53dwjat9klrunnk5wfcst4gye229pghqntplf7tn6rseyz3nh
```

### 4. Ansible on Your Local Machine

```bash
# Debian/Ubuntu
sudo apt-get install -y ansible python3-pip

# macOS
brew install ansible

# pip
pip install ansible
```

The installer will auto-install Ansible if it's missing.

---

## Option A: One-Click Installer (Recommended)

```bash
git clone https://github.com/c03rad0r/torii-continuum.git
cd torii-continuum
chmod +x scripts/install.sh

./scripts/install.sh torii.example.com 203.0.113.42
```

The installer will:

1. Prompt for your Nostr npub (or pass it via env var)
2. Validate the npub format
3. Run the full Ansible playbook (system, identity, agent, frontend, Caddy)
4. Start the agent as a systemd service
5. Print the live URLs

### Passing the npub non-interactively (CI/CD)

```bash
export CONTINUUM_ADMIN_NPUB="npub1your..."
./scripts/install.sh torii.example.com 203.0.113.42
```

### Full argument list

```bash
./scripts/install.sh <domain> <vps-ip> [ssh-user] [ssh-key-path]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `domain` | (required) | Base domain for subdomain derivation |
| `vps-ip` | (required) | VPS IP address |
| `ssh-user` | `root` | SSH user on the VPS |
| `ssh-key` | `~/.ssh/id_ed25519` | Path to SSH private key |

---

## Option B: Manual Ansible

### Step 1: Clone the repo

```bash
git clone https://github.com/c03rad0r/torii-continuum.git
cd torii-continuum
```

### Step 2: Set environment variables

```bash
export CONTINUUM_VPS_IP="203.0.113.42"
export CONTINUUM_VPS_USER="root"          # or your sudo user
export CONTINUUM_SSH_KEY="~/.ssh/id_ed25519"

export BASE_DOMAIN="torii.example.com"
export CONTINUUM_DOMAIN="continuum.torii.example.com"
export CONTINUUM_AGENT_DOMAIN="agent.torii.example.com"
export ACME_EMAIL="admin@torii.example.com"

export CONTINUUM_ADMIN_NPUB="npub1your..."
```

### Step 3: Run the playbook

```bash
ansible-playbook ansible/playbooks/deploy.yml \
    -i ansible/inventory/hosts.yml
```

Or run individual playbooks for debugging:

```bash
ansible-playbook ansible/playbooks/01-system.yml -i ansible/inventory/hosts.yml
ansible-playbook ansible/playbooks/02-identity.yml -i ansible/inventory/hosts.yml
ansible-playbook ansible/playbooks/03-continuum-agent.yml -i ansible/inventory/hosts.yml
ansible-playbook ansible/playbooks/04-frontend.yml -i ansible/inventory/hosts.yml
ansible-playbook ansible/playbooks/05-caddy.yml -i ansible/inventory/hosts.yml
```

---

## What Gets Installed

| Component | Location | Port | Purpose |
|-----------|----------|------|---------|
| Agent (Fastify) | `/home/continuum/agent/repo/agent/` | 127.0.0.1:8787 | Backend API, auth, wallet |
| Frontend (static) | `/home/continuum/agent/frontend/dist/` | served by Caddy | Vite SPA |
| Caddy | `/usr/bin/caddy` + `/etc/caddy/Caddyfile` | 80, 443 | TLS termination, reverse proxy |
| Admin npub | `/home/continuum/agent/identity/admin.npub` | — | Public key only (0644) |
| Session secret | `/home/continuum/agent/identity/session_secret` | — | HMAC key (0600) |
| Cashu wallet | `/home/continuum/agent/repo/agent/memory/wallet/` | — | On-VPS sats float |
| Config | `/home/continuum/agent/repo/agent/config.yaml` | — | Rendered from Ansible template |

### Security Properties

- **No nsec on the VPS.** The agent stores only the admin's public npub.
  All signing happens in the browser via Plebeian Signer.
- **Admin locked at install time.** The npub is in config.yaml before the
  agent starts. No race condition, no unclaimed window.
- **Session secret auto-generated.** Internal HMAC key for session cookies,
  64 hex chars, never exposed to the browser.

---

## Post-Install

### 1. Verify the agent is healthy

```bash
curl https://agent.torii.example.com/api/health
# Expected: {"ok":true}
```

### 2. Log in

1. Visit `https://continuum.torii.example.com`
2. Click "Login with Nostr"
3. Approve the signature request in Plebeian Signer
4. You should see admin controls (project import, wallet, settings)

### 3. Top up the Cashu wallet

1. Open the Routstr tab
2. Paste a Cashu token from a whitelisted mint
3. Click "Redeem to agent"

---

## Management

### Service controls

```bash
# Check status
ssh root@<VPS_IP> systemctl status continuum-agent
ssh root@<VPS_IP> systemctl status caddy

# Restart
ssh root@<VPS_IP> systemctl restart continuum-agent
ssh root@<VPS_IP> systemctl restart caddy

# View logs
ssh root@<VPS_IP> journalctl -u continuum-agent -f
ssh root@<VPS_IP> journalctl -u caddy -f
```

### Change admin npub

```bash
ssh root@<VPS_IP>
# Edit the config
nano /home/continuum/agent/repo/agent/config.yaml
# Change admin_npub to the new npub
# Restart
systemctl restart continuum-agent
```

### Change Cashu mints

Edit `ansible/inventory/group_vars/all.yml`:

```yaml
continuum_cashu_mints:
  - "https://your-mint.example.com"
```

Then re-run the playbook or manually edit `config.yaml` on the VPS.

### Change Routstr models

Edit the same `all.yml`:

```yaml
continuum_routstr_models:
  chat: "llama-3.1-70b-instruct"
  coding: "qwen-2.5-coder-32b"
```

### Enable Ollama local fallback (v0.2.6-alpha)

Ollama provides free local LLM inference as a fallback when the Cashu wallet
is empty or Routstr is unreachable. Disabled by default.

1. Install Ollama on the VPS:
```bash
ssh root@<VPS_IP> 'curl -fsSL https://ollama.com/install.sh | sh'
ssh root@<VPS_IP> 'systemctl edit ollama.service'
# Add: [Service] Environment="OLLAMA_HOST=127.0.0.1:11434"
ssh root@<VPS_IP> 'ollama pull llama3.2:3b'
```

2. Enable in ansible group_vars and re-deploy:
```yaml
continuum_ollama_enabled: true
continuum_model_router_strategy: "routstr_first"  # or ollama_first, ollama_only
```

---

## Backup

The Cashu wallet at `/home/continuum/agent/repo/agent/memory/wallet/`
holds real sats. Back it up regularly:

```bash
ssh root@<VPS_IP> tar czf - /home/continuum/agent/repo/agent/memory/wallet/ > wallet-backup.tar.gz
```

---

## Uninstall

```bash
ssh root@<VPS_IP> << 'EOF'
systemctl disable --now continuum-agent caddy
rm /etc/systemd/system/continuum-agent.service
rm /etc/systemd/system/caddy.service
systemctl daemon-reload
rm -rf /home/continuum
userdel -r continuum 2>/dev/null || true
userdel caddy 2>/dev/null || true
rm -rf /etc/caddy /var/lib/caddy
EOF
```

---

## Troubleshooting

### Agent won't start

```bash
ssh root@<VPS_IP> journalctl -u continuum-agent -n 50 --no-pager
```

Common causes:
- Missing `CONTINUUM_ADMIN_NPUB` (check config.yaml has admin_npub set)
- Node.js version < 20 (run `node --version`)
- npm install failed (check the ansible output)

### Caddy won't start

```bash
ssh root@<VPS_IP> caddy validate --config /etc/caddy/Caddyfile
ssh root@<VPS_IP> journalctl -u caddy -n 50 --no-pager
```

Common causes:
- DNS not pointing at the VPS yet (Caddy can't get TLS cert)
- Port 80/443 blocked by firewall
- Another web server already running (nginx, apache)

### Login fails

**Most common cause: npub mismatch.** The npub in `config.yaml` MUST match the key in your Plebeian Signer. If you deployed with someone else's npub, only they can log in.

```bash
# Check what npub the agent expects:
ssh root@<VPS_IP> grep admin_npub /home/continuum/agent/repo/agent/config.yaml
```

If it doesn't match your Plebeian Signer key, fix it:
```bash
ssh root@<VPS_IP>
nano /home/continuum/agent/repo/agent/config.yaml
# Change admin_npub to YOUR npub (from Plebeian Signer)
systemctl restart continuum-agent
```

Other causes:
- Plebeian Signer not installed or no key configured
- Check the browser console for NIP-07 errors
- Verify the agent is running: `curl https://agent.<domain>/api/health`
- Verify CORS: the agent config must list the frontend domain

### Frontend loads but API calls fail

- Check `VITE_AGENT_URL` was set correctly during build (it's baked into the SPA)
- Verify DNS for `agent.<domain>` points at the VPS
- Check Caddy reverse proxy is forwarding to 127.0.0.1:8787

---

## Architecture

```
Browser (Plebeian Signer — NIP-07)
    │
    ├──HTTPS──▶ Caddy ──▶ Continuum Frontend (static SPA)
    │           (TLS)      (built with VITE_AGENT_URL=https://agent.<domain>)
    │
    └──HTTPS──▶ Caddy ──▶ Continuum Agent (Fastify :8787)
                (TLS)      ├── NIP-07 challenge/verify (admin-only)
                           ├── admin_npub check → reject non-admin keys
                           ├── Cashu wallet float
                           └── Routstr proxy (api.routstr.com)
```

The agent NEVER holds an nsec. It never signs anything. All signing happens
in the browser via Plebeian Signer. The agent stores only:

- `admin_npub` — the public npub that has admin access. Only this key
  can log in. Non-admin keys are rejected (no multi-user system yet).
- `session_secret` — internal HMAC key for session cookies. Not user-facing.

**Note:** The agent currently supports **single-admin auth only**. There
is no role system — only the npub in `admin_npub` can log in. See
[docs/ADMIN-AUTH-DESIGN.md](ADMIN-AUTH-DESIGN.md) for a multi-role
design proposal that would require code changes to implement.
