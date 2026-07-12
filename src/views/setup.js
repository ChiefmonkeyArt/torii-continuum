/**
 * Setup Wizard — first-run key generation.
 *
 * Shows when agent is in setup_mode. Four steps:
 *   1. Enter setup token (from Ansible deploy output)
 *   2. Generate key in browser (Web Crypto)
 *   3. Save backup (nsec + instructions)
 *   4. Register with agent → logged in
 */

import { h, openModal } from './util.js';
import { KeyVault, installNip07Shim } from '../lib/keyVault.js';
import { setStoredToken, isAgentConfigured } from '../data/agent.js';

function agentUrl() {
  if (typeof window !== 'undefined' && window.__CONTINUUM_AGENT_URL__) {
    return String(window.__CONTINUUM_AGENT_URL__).replace(/\/$/, '');
  }
  try {
    if (import.meta.env?.VITE_AGENT_URL) {
      return String(import.meta.env.VITE_AGENT_URL).replace(/\/$/, '');
    }
  } catch (_e) {}
  return '';
}

async function api(method, path, body) {
  const base = agentUrl();
  if (!base) throw new Error('Agent URL not configured');
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${base}${path}`, opts);
  return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => ({})) };
}

export function renderSetup(container) {
  // Hide sidebar + chat during setup
  const app = document.getElementById('app');
  if (app) app.classList.add('landing-mode');

  container.innerHTML = '';
  const card = h('div', { class: 'setup-card' }, []);
  container.appendChild(card);

  // Start at step 1
  showStepToken(card);
}

// ─── Step 1: Token ───────────────────────────────────

function showStepToken(card) {
  const input = h('input', {
    type: 'text',
    placeholder: 'Paste your setup token here...',
    class: 'setup-input',
    spellcheck: 'false',
    autocomplete: 'off',
  });

  const status = h('div', { class: 'setup-status muted' }, []);
  const verifyBtn = h('button', {
    class: 'primary',
    onClick: async () => {
      const token = input.value.trim();
      if (!token) { status.textContent = 'Enter the token from your deployment output.'; return; }
      verifyBtn.disabled = true;
      status.textContent = 'Verifying...';
      try {
        const r = await api('POST', '/api/setup/verify', { token });
        if (r.ok) {
          showStepGenerate(card, token);
        } else {
          status.textContent = r.data?.error || 'Invalid token.';
          status.style.color = 'hsl(var(--destructive))';
        }
      } catch (e) {
        status.textContent = `Connection error: ${e.message}`;
        status.style.color = 'hsl(var(--destructive))';
      }
      verifyBtn.disabled = false;
    },
  }, ['Verify Token']);

  card.innerHTML = '';
  card.appendChild(h('div', { class: 'setup-content' }, [
    h('div', { class: 'setup-logo' }, ['⛩']),
    h('h1', {}, ['Welcome to Continuum']),
    h('p', { class: 'muted' }, [
      'Your instance is ready. Enter the setup token from your deployment to claim it.',
    ]),
    input,
    h('div', { class: 'setup-actions' }, [verifyBtn]),
    status,
  ]));
}

// ─── Step 2: Generate Key ────────────────────────────

function showStepGenerate(card, token) {
  card.innerHTML = '';
  card.appendChild(h('div', { class: 'setup-content' }, [
    h('div', { class: 'setup-logo' }, ['⛩']),
    h('h1', {}, ['Generate Your Key']),
    h('p', { class: 'muted' }, [
      'Continuum will generate a Nostr identity for you right in your browser. ',
      'Your private key never leaves this device.',
    ]),
    h('div', { class: 'setup-step' }, [
      h('label', {}, ['Choose a password to protect your key locally:']),
      h('input', {
        type: 'password',
        id: 'setup-password',
        class: 'setup-input',
        placeholder: 'Min 8 characters',
        autocomplete: 'new-password',
      }),
    ]),
    h('div', { class: 'setup-actions' }, [
      h('button', {
        class: 'primary',
        onClick: async (e) => {
          const pw = document.getElementById('setup-password')?.value || '';
          if (pw.length < 8) {
            const err = document.getElementById('setup-gen-error');
            if (err) err.textContent = 'Password must be at least 8 characters.';
            return;
          }
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Generating...';
          try {
            const vault = await KeyVault.generate(pw);
            showStepBackup(card, token, vault, pw);
          } catch (err) {
            const errEl = document.getElementById('setup-gen-error');
            if (errEl) errEl.textContent = `Error: ${err.message}`;
            btn.disabled = false;
            btn.textContent = 'Generate My Key';
          }
        },
      }, ['Generate My Key']),
    ]),
    h('div', { id: 'setup-gen-error', class: 'setup-status muted' }, []),
  ]));
}

// ─── Step 3: Backup ──────────────────────────────────

function showStepBackup(card, token, vault, password) {
  const nsec = vault.getNsec();
  const npub = vault.getNpub();

  const nsecInput = h('input', {
    type: 'text',
    class: 'setup-mono',
    value: nsec,
    readonly: 'true',
    spellcheck: 'false',
  });

  const npubInput = h('input', {
    type: 'text',
    class: 'setup-mono',
    value: npub,
    readonly: 'true',
    spellcheck: 'false',
  });

  const checkbox = h('input', { type: 'checkbox', id: 'setup-saved' });

  card.innerHTML = '';
  card.appendChild(h('div', { class: 'setup-content' }, [
    h('div', { class: 'setup-logo' }, ['⛩']),
    h('h1', {}, ['Save Your Backup']),
    h('div', { class: 'setup-warning' }, [
      h('p', {}, [
        h('strong', {}, ['⚠️ Important: ']),
        'Save this private key somewhere safe. If you lose access to this browser, ',
        'you will need this key to recover your account.',
      ]),
    ]),
    h('div', { class: 'setup-step' }, [
      h('label', {}, ['Your private key (nsec):']),
      h('div', { class: 'setup-copy-row' }, [
        nsecInput,
        h('button', {
          class: 'setup-copy-btn',
          onClick: () => {
            nsecInput.select();
            document.execCommand('copy');
          },
        }, ['Copy']),
      ]),
    ]),
    h('div', { class: 'setup-step' }, [
      h('label', {}, ['Your public key (npub):']),
      h('div', { class: 'setup-copy-row' }, [
        npubInput,
        h('button', {
          class: 'setup-copy-btn',
          onClick: () => {
            npubInput.select();
            document.execCommand('copy');
          },
        }, ['Copy']),
      ]),
    ]),
    h('div', { class: 'setup-checkbox-row' }, [
      checkbox,
      h('label', { for: 'setup-saved' }, ['I\'ve saved my private key in a safe place']),
    ]),
    h('div', { class: 'setup-actions' }, [
      h('button', {
        class: 'primary',
        onClick: async (e) => {
          if (!checkbox.checked) return;
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = 'Registering...';
          await showStepRegister(card, token, vault, password);
        },
      }, ['Continue → Setup Instance']),
    ]),
  ]));
}

// ─── Step 4: Register + Login ────────────────────────

async function showStepRegister(card, token, vault, password) {
  const statusEl = h('div', { class: 'setup-status muted' }, ['Creating your account...']);
  card.innerHTML = '';
  card.appendChild(h('div', { class: 'setup-content' }, [
    h('div', { class: 'setup-logo' }, ['⛩']),
    h('h1', {}, ['Setting Up...']),
    statusEl,
  ]));

  try {
    // Install NIP-07 shim so auth.js can use our key
    await installNip07Shim(vault);

    // Sign a kind 22242 event with the browser-generated key
    const challenge = 'setup-registration-' + crypto.randomUUID();
    const unsignedEvent = {
      kind: 22242,
      content: challenge,
      tags: [['challenge', challenge]],
      created_at: Math.floor(Date.now() / 1000),
    };
    const signedEvent = await vault.signEvent(unsignedEvent);

    statusEl.textContent = 'Registering with agent...';

    // Register with agent
    const r = await api('POST', '/api/setup/register', {
      token,
      signed_event: signedEvent,
    });

    if (r.ok && r.data.token) {
      setStoredToken(r.data.token);
      statusEl.textContent = '✓ Setup complete! Redirecting...';
      // Reload to re-boot the SPA in normal mode
      setTimeout(() => { window.location.hash = '#/'; window.location.reload(); }, 1500);
    } else {
      statusEl.textContent = `Error: ${r.data?.error || 'Registration failed'}`;
      statusEl.style.color = 'hsl(var(--destructive))';
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.style.color = 'hsl(var(--destructive))';
  }
}
