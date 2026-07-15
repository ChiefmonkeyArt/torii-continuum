/**
 * Login view — the application root when there is no live session.
 *
 * This is a dedicated, branded Continuum Amber login surface: NOT the
 * sales/marketing page (that lives at `#/about`). It offers the existing
 * NIP-07 login flow (Plebeian Signer via startLogin) and nothing else that
 * touches key material — the operator signs a challenge in their extension and
 * the agent verifies the signature. No password auth, no secrets in the DOM.
 *
 * Rendered full-bleed inside `landing-mode` (sidebar + chat dock hidden). A
 * small non-primary link leads to `#/about`; a second links to the read-only
 * demo shell. Neither is the primary action.
 */

import { h, clear } from './util.js';
import { navigate } from '../router.js';
import { startLogin } from '../auth.js';
import { isAgentConfigured } from '../data/agent.js';
import { toriiSvg } from './landing.js';

export function renderLogin(mount) {
  clear(mount);

  const agentReachable = isAgentConfigured();

  const card = h('section', { class: 'login-card card' }, [
    h('div', { class: 'login-mark', 'aria-hidden': 'true' }, [toriiSvg()]),

    h('div', { class: 'login-eyebrow', text: `Torii Continuum · v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}` }),
    h('h1', { class: 'login-title', text: 'Sign in to Continuum' }),
    h('p', { class: 'login-lede muted' }, [
      'Continuum authenticates with your Nostr key through Plebeian Signer (NIP-07). ',
      'You sign the challenge in your browser — your nsec never touches the agent.',
    ]),

    h('div', { class: 'login-cta' }, [
      h('button', {
        class: 'primary login-btn',
        onClick: startLogin,
        title: agentReachable ? 'Sign in with Plebeian Signer' : 'Requires a self-hosted agent',
      }, [agentReachable ? 'Login with Nostr' : 'Login (requires self-hosted agent)']),
    ]),

    h('div', { class: 'login-status muted' }, [
      h('span', { class: 'pill' }, [agentReachable ? 'agent reachable' : 'demo mode']),
      ' · No account. No email. No cookie wall.',
    ]),

    h('div', { class: 'login-links muted' }, [
      h('a', { href: '#/about', class: 'login-link' }, ['About Continuum']),
      ' · ',
      h('a', {
        href: '#/projects',
        class: 'login-link',
        onClick: (e) => { e.preventDefault(); navigate('/projects'); },
      }, ['Explore the demo']),
    ]),
  ]);

  const wrap = h('div', { class: 'login-wrap' }, [card]);
  mount.appendChild(wrap);
}
