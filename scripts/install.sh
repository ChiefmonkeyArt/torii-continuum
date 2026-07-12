#!/bin/bash
set -euo pipefail

# Continuum — One-Click Installer
# Deploys the full stack (agent + frontend + Caddy) to a VPS via Ansible.
# Prompts for the admin Nostr npub before deployment begins.

set -u

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD} Torii Continuum — One-Click Installer   ${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

# ─── Parse arguments ───────────────────────────────────
DOMAIN="${1:-}"
VPS_IP="${2:-}"
SSH_USER="${3:-root}"
SSH_KEY="${4:-$HOME/.ssh/id_ed25519}"
ADMIN_NPUB="${CONTINUUM_ADMIN_NPUB:-}"

# ─── Validate required args ────────────────────────────
if [ -z "$DOMAIN" ] || [ -z "$VPS_IP" ]; then
    echo "Usage: $0 <domain> <vps-ip> [ssh-user] [ssh-key-path]"
    echo ""
    echo "Arguments:"
    echo "  domain      Base domain (e.g. torii.example.com)"
    echo "              Continuum will run at:   continuum.<domain>"
    echo "              Agent API will run at:   agent.<domain>"
    echo "  vps-ip      IP address of the target VPS"
    echo "  ssh-user    SSH user (default: root)"
    echo "  ssh-key     SSH private key path (default: ~/.ssh/id_ed25519)"
    echo ""
    echo "Environment variables:"
    echo "  CONTINUUM_ADMIN_NPUB  Skip the npub prompt (for CI/scripted deploys)"
    echo "  BASE_DOMAIN           Root domain (default: derived from <domain>)"
    echo "  ACME_EMAIL            Let's Encrypt email (default: admin@<domain>)"
    echo ""
    echo "Example:"
    echo "  $0 torii.example.com 203.0.113.42"
    echo "  $0 torii.example.com 203.0.113.42 debian ~/.ssh/custom_key"
    echo "  CONTINUUM_ADMIN_NPUB=npub1... $0 torii.example.com 203.0.113.42"
    echo ""
    echo "Prerequisites:"
    echo "  1. DNS: point agent.<domain> and continuum.<domain> at the VPS IP"
    echo "  2. SSH: key-based access to the VPS"
    echo "  3. Ansible: installed on this machine (will auto-install if missing)"
    echo "  4. Nostr npub: your public key from Plebeian Signer"
    exit 1
fi

# ─── Prompt for admin npub ─────────────────────────────
if [ -z "$ADMIN_NPUB" ]; then
    echo -e "${YELLOW}Admin npub required.${NC}"
    echo ""
    echo "Enter your Nostr npub — this identity will be the sole admin."
    echo "Get it from Plebeian Signer or any NIP-07 signer extension."
    echo "  Firefox: https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/"
    echo "  Chrome:  https://chromewebstore.google.com/detail/ijbiankmnehjephbkfdgphckcdgbgoho"
    echo ""
    read -r -p "Admin npub (npub1...): " ADMIN_NPUB
fi

# Validate npub format
if [[ ! "$ADMIN_NPUB" =~ ^npub1 ]]; then
    echo -e "${RED}ERROR: Invalid npub. Must start with 'npub1'.${NC}"
    echo "Got: $ADMIN_NPUB"
    exit 1
fi
if [ "${#ADMIN_NPUB}" -lt 60 ] || [ "${#ADMIN_NPUB}" -gt 65 ]; then
    echo -e "${RED}ERROR: npub should be 60-65 characters, got ${#ADMIN_NPUB}.${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}Admin npub: ${ADMIN_NPUB}${NC}"
echo ""

# ─── Set environment for Ansible ───────────────────────
export CONTINUUM_ADMIN_NPUB="$ADMIN_NPUB"
export CONTINUUM_VPS_IP="$VPS_IP"
export CONTINUUM_VPS_USER="$SSH_USER"
export CONTINUUM_SSH_KEY="$SSH_KEY"

# Derive subdomains from the domain argument
export BASE_DOMAIN="$DOMAIN"
export CONTINUUM_DOMAIN="continuum.${DOMAIN}"
export CONTINUUM_AGENT_DOMAIN="agent.${DOMAIN}"
export ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Summary ───────────────────────────────────────────
echo -e "${BOLD}Deployment Summary:${NC}"
echo "  Target:   ${SSH_USER}@${VPS_IP}"
echo "  Domain:   ${DOMAIN}"
echo "  Agent:    https://${CONTINUUM_AGENT_DOMAIN}"
echo "  Frontend: https://${CONTINUUM_DOMAIN}"
echo "  Admin:    ${ADMIN_NPUB}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to abort. Starting in 3 seconds...${NC}"
sleep 3

# ─── Ensure Ansible ────────────────────────────────────
if ! command -v ansible-playbook &>/dev/null; then
    echo "Installing Ansible..."
    sudo apt-get update -qq && sudo apt-get install -y -qq ansible python3-pip
fi

# ─── Run playbook ──────────────────────────────────────
echo ""
echo -e "${BOLD}Running Ansible playbook...${NC}"
echo ""

export ANSIBLE_CONFIG="${SCRIPT_DIR}/ansible/ansible.cfg"

ansible-playbook \
    -i "${SCRIPT_DIR}/ansible/inventory/hosts.yml" \
    "${SCRIPT_DIR}/ansible/playbooks/deploy.yml" \
    -c ssh \
    -e "ansible_host=${VPS_IP}" \
    -e "ansible_user=${SSH_USER}" \
    -e "ansible_ssh_private_key_file=${SSH_KEY}"

PLAYBOOK_EXIT=$?

if [ $PLAYBOOK_EXIT -ne 0 ]; then
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED} Deployment FAILED${NC}"
    echo -e "${RED}========================================${NC}"
    echo ""
    echo "Check the Ansible output above for errors."
    echo "Common issues:"
    echo "  - SSH key not authorized on the VPS"
    echo "  - DNS not pointing at the VPS yet"
    echo "  - VPS needs apt-get update first"
    exit $PLAYBOOK_EXIT
fi

# ─── Success ───────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BOLD}Your Continuum instance is live:${NC}"
echo "  Frontend: https://${CONTINUUM_DOMAIN}"
echo "  Agent:    https://${CONTINUUM_AGENT_DOMAIN}/api/health"
echo ""
echo -e "${BOLD}Admin:${NC}"
echo "  Log in with your Plebeian Signer at https://${CONTINUUM_DOMAIN}"
echo "  Your npub is recognized as admin automatically."
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo "  1. Visit https://${CONTINUUM_DOMAIN}"
echo "  2. Click 'Login with Nostr'"
echo "  3. Approve the signature in Plebeian Signer"
echo "  4. Top up the Cashu wallet via the Routstr tab"
echo ""
