/**
 * Login view — the application root when there is no live session.
 *
 * This is a dedicated, branded Continuum login surface: NOT the sales/marketing
 * page (that lives at `#/about`). It offers the existing NIP-07 login flow
 * (Plebeian Signer via startLogin) and nothing else that touches key material —
 * the operator signs a challenge in their extension and the agent verifies the
 * signature. No password auth, no secrets in the DOM.
 *
 * Visual: a full-viewport blurred "Vermilion Dawn" torii backdrop with a
 * centered glass modal. The auth gate is unchanged — this renders full-bleed
 * inside `landing-mode` only when there is no live session (see main.js).
 */

import { h, clear } from './util.js';
import { navigate } from '../router.js';
import { startLogin } from '../auth.js';
import { isAgentConfigured } from '../data/agent.js';
import { toriiSvg } from './landing.js';

export function renderLogin(mount) {
  clear(mount);

  const agentReachable = isAgentConfigured();
  const version = `Torii Continuum · v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}`;

  // Decorative full-viewport backdrop. Image + blur + tint live in CSS; this
  // element only carries the class so nothing loads from the DOM layer.
  const bg = h('div', { class: 'login-bg', 'aria-hidden': 'true' });

  const card = h('section', { class: 'login-card glass' }, [
    h('div', { class: 'login-mark', 'aria-hidden': 'true' }, [toriiSvg()]),

    h('div', { class: 'login-wordmark' }, [
      h('h1', { class: 'login-brand', text: 'Continuum' }),
      h('div', { class: 'login-rule', 'aria-hidden': 'true' }),
      h('div', { class: 'login-subtitle', text: 'PROJECT ENGINE' }),
    ]),

    h('p', { class: 'login-lede muted' }, [
      'Sign in with your Nostr key through Plebeian Signer (NIP-07). ',
      'You sign the challenge in your browser — your nsec never touches the agent.',
    ]),

    h('div', { class: 'login-cta' }, [
      h('button', {
        class: 'primary login-btn',
        onClick: startLogin,
        'aria-label': agentReachable ? 'Sign in with nostr extension' : 'Sign in requires a self-hosted agent',
        title: agentReachable ? 'Sign in with Plebeian Signer' : 'Requires a self-hosted agent',
      }, [agentReachable ? 'Sign in with nostr extension' : 'Login (requires self-hosted agent)']),
    ]),

    h('div', { class: 'login-status muted' }, [
      h('span', { class: 'pill' }, [agentReachable ? 'agent reachable' : 'demo mode']),
      ' · No account. No email. No cookie wall.',
    ]),

    h('div', { class: 'login-links' }, [
      h('a', { href: '#/about', class: 'login-link' }, ['About Continuum']),
      h('span', { class: 'login-links-sep', 'aria-hidden': 'true' }, ['·']),
      h('a', {
        href: '#/projects',
        class: 'login-link',
        onClick: (e) => { e.preventDefault(); navigate('/projects'); },
      }, ['Explore the demo']),
    ]),

    h('div', { class: 'login-foot muted', text: version }),
  ]);

  const wrap = h('div', { class: 'login-scene' }, [bg, card]);
  mount.appendChild(wrap);
}
