/**
 * NIP-07 login flow — signs a challenge event with Plebeian Signer
 * (or any NIP-07 extension) and hands it to the agent for verification.
 *
 * Flow:
 *   1. Check window.nostr exists (Plebeian Signer or equivalent).
 *   2. POST /api/auth/challenge → get { challenge, expires_in }.
 *   3. Ask window.nostr.signEvent({ kind: 22242, content: challenge, tags: [...] }).
 *   4. POST /api/auth/verify { event } → get { token, expires_at }.
 *   5. Token stored in localStorage; UI switches to logged-in state.
 *
 * This module is UI-agnostic — the header renders a Login button that calls
 * startLogin(), and the modal dialog inside surfaces status / errors.
 */

import { h, openModal } from './views/util.js';
import { requestChallenge, verifyChallenge, isLoggedIn, logout as clearSession, isAgentConfigured } from './data/agent.js';

const NIP42_KIND = 22242;

let loginModalHandle = null;

function hasSigner() {
  return typeof window !== 'undefined' && window.nostr && typeof window.nostr.signEvent === 'function';
}

export function isSessionLive() { return isLoggedIn(); }

export function endSession() {
  clearSession();
  document.dispatchEvent(new CustomEvent('continuum:session-changed'));
}

/**
 * Open the login modal. Wraps the whole flow so the user sees a single
 * dialog with status transitions.
 */
export async function startLogin() {
  if (loginModalHandle) return; // already open

  // If we're on the demo build with no agent, explain up front.
  if (!isAgentConfigured()) {
    openModal({
      title: 'Login unavailable in demo',
      subtitle: 'This build of Continuum runs without an agent backend. Live login (chat, wallet, Routstr) is available when you self-host the agent.',
      body: h('div', {}, [
        h('p', { class: 'muted', text: 'See agent/README.md in the repo for VPS bring-up. Once your agent is reachable, this button will connect via NIP-07 (browser signer).' }),
        h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [
          h('button', { class: 'primary', onClick: () => loginModalHandle?.close() }, ['OK']),
        ]),
      ]),
      onClose: () => { loginModalHandle = null; },
    });
    loginModalHandle = { close: () => document.querySelector('.modal-backdrop')?.remove() };
    return;
  }

  if (!hasSigner()) {
    openModal({
      title: 'NIP-07 signer not found',
      subtitle: 'Continuum uses a NIP-07 browser extension to sign the login challenge. No key material touches the agent — you sign in your browser, the agent verifies the signature.',
      body: h('div', {}, [
        h('p', { class: 'muted' }, [
          'Install a signer: ',
          h('a', { href: 'https://chromewebstore.google.com/detail/plebeian-signer-nostr-ide/ijbiankmnehjephbkfdgphckcdgbgoho', target: '_blank', rel: 'noopener' }, ['Plebeian Signer (Chrome)']),
          ' · ',
          h('a', { href: 'https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/', target: '_blank', rel: 'noopener' }, ['nos2x-fox (Firefox)']),
          ' · ',
          h('a', { href: 'https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/', target: '_blank', rel: 'noopener' }, ['Plebeian Signer (Firefox)']),
        ]),
        h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [
          h('button', { class: 'primary', onClick: () => loginModalHandle?.close() }, ['OK']),
        ]),
      ]),
      onClose: () => { loginModalHandle = null; },
    });
    loginModalHandle = { close: () => document.querySelector('.modal-backdrop')?.remove() };
    return;
  }

  const status = h('div', { class: 'muted', text: 'Requesting challenge from your agent…' });
  const spinner = h('div', { class: 'login-spinner' });
  const actions = h('div', { style: 'display:flex; gap: 8px; justify-content: flex-end; margin-top: 12px;' }, [
    h('button', { onClick: () => loginModalHandle?.close() }, ['Cancel']),
  ]);
  const body = h('div', {}, [spinner, status, actions]);

  loginModalHandle = openModal({
    title: 'Login with Nostr',
    subtitle: 'Your agent will send a challenge; your NIP-07 signer will sign it in your browser. Your nsec never leaves the extension.',
    body,
    onClose: () => { loginModalHandle = null; },
  });

  const setStatus = (msg, isError = false) => {
    status.textContent = msg;
    status.className = isError ? 'muted' : 'muted';
    status.style.color = isError ? 'hsl(var(--destructive))' : '';
  };

  // 1. Challenge
  const chal = await requestChallenge();
  if (!chal.ok) {
    spinner.remove();
    setStatus(`Could not reach agent: ${chal.reason}`, true);
    return;
  }
  const { challenge } = chal.data;

  // 2. Sign in browser
  setStatus('Waiting for signer to sign the challenge…');
  let signed;
  try {
    signed = await window.nostr.signEvent({
      kind: NIP42_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: challenge,
      tags: [
        ['challenge', challenge],
        ['relay', window.location.origin],
      ],
    });
  } catch (e) {
    spinner.remove();
    setStatus(`Signer refused: ${e.message || e}`, true);
    return;
  }

  // 3. Verify
  setStatus('Verifying signature…');
  const verified = await verifyChallenge(signed);
  if (!verified.ok) {
    spinner.remove();
    setStatus(`Agent rejected signature: ${verified.reason}`, true);
    return;
  }

  spinner.remove();
  setStatus('Logged in. Reloading…');
  document.dispatchEvent(new CustomEvent('continuum:session-changed'));
  setTimeout(() => { loginModalHandle?.close(); loginModalHandle = null; }, 400);
}
