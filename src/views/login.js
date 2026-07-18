/**
 * Login view — the application root when there is no live session.
 *
 * This is a dedicated, branded Continuum login surface: NOT the sales/marketing
 * page (that lives at `#/about`). It offers the direct NIP-07 login flow
 * (Plebeian Signer via startLogin) and nothing else that touches key material —
 * the operator signs a challenge in their extension and the agent verifies the
 * signature. No password auth, no secrets in the DOM.
 *
 * AUTH-DIRECT-1: clicking the button invokes the signer directly (no modal).
 * Status/errors render INLINE in `.login-inline-status`, so a cancel/denial/
 * timeout leaves the operator on this card with a concise message.
 *
 * VERSION-UPDATE-1: before login we show the current version and, when known,
 * the latest available release — NON-interactively (no unauthenticated update).
 */

import { h, clear } from './util.js';
import { navigate } from '../router.js';
import { startLogin } from '../auth.js';
import { isAgentConfigured, versionInfo } from '../data/agent.js';
import { describeVersionState } from '../data/release.js';
import { toriiSvg } from './landing.js';

export function renderLogin(mount) {
  clear(mount);

  const agentReachable = isAgentConfigured();
  const version = `Torii Continuum · v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}`;

  // Decorative full-viewport backdrop. Image + blur + tint live in CSS; this
  // element only carries the class so nothing loads from the DOM layer.
  const bg = h('div', { class: 'login-bg', 'aria-hidden': 'true' });

  // Inline status area — the ONLY place login progress/errors appear (no modal).
  const inlineStatus = h('div', {
    class: 'login-inline-status',
    role: 'status',
    'aria-live': 'polite',
  });

  // Version row — current always; latest when the agent can tell us.
  const versionRow = h('div', { class: 'login-version muted' }, [
    h('span', { class: 'login-version-current', text: version }),
  ]);

  const onStatus = (s) => renderInlineStatus(inlineStatus, s);

  const loginBtn = h('button', {
    class: 'primary login-btn',
    onClick: () => startLogin({ onStatus }),
    'aria-label': agentReachable ? 'Sign in with nostr extension' : 'Sign in requires a self-hosted agent',
    title: agentReachable ? 'Sign in with Plebeian Signer' : 'Requires a self-hosted agent',
  }, [agentReachable ? 'Sign in with nostr extension' : 'Login (requires self-hosted agent)']);

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

    h('div', { class: 'login-cta' }, [loginBtn]),

    inlineStatus,

    h('div', { class: 'login-status muted' }, [
      h('span', { class: 'pill' }, [agentReachable ? 'agent reachable' : 'demo mode']),
      ' · No account. No email. No cookie wall.',
    ]),

    versionRow,

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

  // Fetch the version summary (non-blocking; never gates login). Only when an
  // agent is configured — the demo build has no /api/version.
  if (agentReachable) {
    versionInfo().then((r) => {
      if (!r || !r.ok) return;
      const state = describeVersionState(r.data);
      renderVersionRow(versionRow, state, version);
    }).catch(() => {});
  }
}

// Render the current + latest version line non-interactively.
function renderVersionRow(el, state, currentStamp) {
  clear(el);
  el.appendChild(h('span', { class: 'login-version-current', text: currentStamp }));
  if (state.state === 'newer' && state.latest) {
    el.appendChild(h('span', {
      class: 'login-version-badge newer',
      text: `Latest ${state.latest}`,
      title: 'A newer release is available. Sign in to update.',
    }));
  } else if (state.state === 'current') {
    el.appendChild(h('span', { class: 'login-version-badge current', text: 'Up to date' }));
  }
}

// Render inline login status/errors. Signer-missing adds install links.
function renderInlineStatus(el, s) {
  clear(el);
  if (!s || !s.message) { el.className = 'login-inline-status'; return; }
  el.className = `login-inline-status${s.error ? ' error' : ''}${s.done ? ' done' : ''}`;
  el.appendChild(h('span', { class: 'login-inline-msg', text: s.message }));
  if (s.signerMissing) {
    el.appendChild(h('div', { class: 'login-inline-links' }, [
      h('a', { href: 'https://chromewebstore.google.com/detail/plebeian-signer-nostr-ide/ijbiankmnehjephbkfdgphckcdgbgoho', target: '_blank', rel: 'noopener' }, ['Chrome']),
      h('span', { class: 'login-links-sep', 'aria-hidden': 'true' }, [' · ']),
      h('a', { href: 'https://addons.mozilla.org/en-US/firefox/addon/plebeian-signer/', target: '_blank', rel: 'noopener' }, ['Firefox']),
    ]));
  }
}
