/**
 * About / Discover view — the sales/marketing surface, isolated behind the
 * explicit `#/about` route.
 *
 * Continuum is application-first: the root (`/continuum/`) renders the login
 * page (logged out) or the dashboard (logged in), never this page. This
 * content is reachable only from a small non-primary "About" link on the
 * login and settings surfaces, and is never used as onboarding completion or
 * as the app root.
 *
 * Voice: nostr-native, sovereignty-first, quietly confident. No hero-video
 * theatrics; no crypto-bro shouting. Torii amber on warm bronze, matching
 * the app itself.
 */

import { h, clear } from './util.js';
import { navigate } from '../router.js';
import { startLogin, isSessionLive } from '../auth.js';
import { isAgentConfigured } from '../data/agent.js';
import continuumLogo from '../assets/continuum-logo.webp';

const PROMISES = [
  { title: 'Local-first', body: 'Your projects live in your browser and on your Torii. Your Torii, your gateway. No SaaS in the middle. No account required to try it.' },
  { title: 'Nostr-native', body: 'Projects, sessions, milestones and marketplace tasks all shaped as nostr events (kinds 30078–30091). Portable between clients, signable, yours.' },
  { title: 'Pay per request', body: 'Model calls route through Routstr and settle in Cashu — one request, one token, no monthly bill and no API key custody.' },
  { title: 'Human-in-the-loop', body: 'The agent drafts. You sign. Every publish is an explicit click through Plebeian Signer. No autonomous writes to Nostr.' },
];

const PILLARS = [
  { k: 'Identity', v: 'npub via NIP-07', note: 'Plebeian Signer for now, NIP-46 later.' },
  { k: 'Value',    v: 'Cashu + Routstr',  note: 'Per-request payment. Small float on your Torii.' },
  { k: 'Coord',    v: 'Nostr events',      note: 'Projects, todos, marketplace on relays.' },
  { k: 'Compute',  v: 'DeepSeek default',  note: 'Local Ollama fallback (next slice).' },
];

const STATUS = [
  { s: 'ok',      t: 'App shell + Console mockup live' },
  { s: 'ok',      t: 'Agent daemon scaffold (Node 20, Fastify)' },
  { s: 'ok',      t: 'NIP-07 login flow (Plebeian Signer)' },
  { s: 'ok',      t: 'Cashu wallet on your Torii (@cashu/cashu-ts)' },
  { s: 'ok',      t: 'Routstr chat wired to DeepSeek by default' },
  { s: 'next',    t: 'Local Ollama fallback (CONT-AGENT-1b)' },
  { s: 'next',    t: 'brain.write, todo.patch, nostr.draft skills' },
  { s: 'later',   t: 'NIP-34 repo announcement (post-PoC)' },
];

export function renderAbout(mount) {
  clear(mount);

  const loggedIn = isSessionLive();
  const agentReachable = isAgentConfigured();

  // ── Hero ───────────────────────────────────────────────
  const hero = h('section', { class: 'landing-hero' }, [
    h('img', {
      class: 'landing-logo', src: continuumLogo, alt: '', 'aria-hidden': 'true',
      width: '440', height: '278', decoding: 'async', draggable: 'false',
    }),
    h('div', { class: 'landing-copy' }, [
      // Version string baked in at build time by vite.config.js `define`.
      // Falls back to a dash so a stray build never surfaces a stale number.
      h('div', { class: 'landing-eyebrow', text: `Torii Continuum · v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'}` }),
      h('h1', { class: 'landing-title', text: 'The Gateway Project.' }),
      h('p', { class: 'landing-lede' }, [
        'Continuum is where your projects live as nostr events, pay in Cashu, and answer to no platform. Assistant included. Custody not.',
      ]),
      h('div', { class: 'landing-cta' }, [
        h('button', {
          class: 'primary landing-btn',
          onClick: () => navigate('/projects'),
        }, ['Open the demo →']),
        loggedIn
          ? h('button', { class: 'landing-btn ghost', onClick: () => navigate('/dashboard') }, ['Go to your dashboard'])
          : h('button', {
              class: 'landing-btn ghost',
              onClick: startLogin,
              title: agentReachable ? 'Sign in with Plebeian Signer' : 'Requires a self-hosted agent',
            }, [agentReachable ? 'Login with Nostr' : 'Login (requires self-hosted agent)']),
      ]),
      h('div', { class: 'landing-microcopy muted' }, [
        h('span', { class: 'pill' }, [agentReachable ? 'agent reachable' : 'demo mode']),
        ' · ',
        'No account. No email. No cookie wall.',
      ]),
    ]),
  ]);
  mount.appendChild(hero);

  // ── Promises row ───────────────────────────────────────
  const promises = h('section', { class: 'landing-promises' }, [
    h('div', { class: 'landing-section-eyebrow', text: 'The bargain' }),
    h('div', { class: 'landing-grid' },
      PROMISES.map((p) =>
        h('div', { class: 'landing-promise card' }, [
          h('h3', { class: 'landing-promise-title', text: p.title }),
          h('p', { class: 'muted', text: p.body }),
        ])
      )
    ),
  ]);
  mount.appendChild(promises);

  // ── Freedom-tech pillars ───────────────────────────────
  const pillars = h('section', { class: 'landing-pillars' }, [
    h('div', { class: 'landing-section-eyebrow', text: 'What Continuum stands on' }),
    h('div', { class: 'landing-pillar-grid' },
      PILLARS.map((p) =>
        h('div', { class: 'landing-pillar' }, [
          h('div', { class: 'landing-pillar-k', text: p.k }),
          h('div', { class: 'landing-pillar-v', text: p.v }),
          h('div', { class: 'landing-pillar-note muted', text: p.note }),
        ])
      )
    ),
  ]);
  mount.appendChild(pillars);

  // ── Status ─────────────────────────────────────────────
  const status = h('section', { class: 'landing-status' }, [
    h('div', { class: 'landing-section-eyebrow', text: 'What ships today · what ships next' }),
    h('ul', { class: 'landing-status-list' },
      STATUS.map((s) =>
        h('li', { class: `landing-status-item status-${s.s}` }, [
          h('span', { class: 'landing-status-dot', 'aria-hidden': 'true' }),
          h('span', { text: s.t }),
        ])
      )
    ),
  ]);
  mount.appendChild(status);

  // ── Footer / links ─────────────────────────────────────
  const foot = h('footer', { class: 'landing-foot muted' }, [
    h('div', {}, [
      'Continuum is open source · ',
      h('a', { href: 'https://github.com/ChiefmonkeyArt/torii-continuum', target: '_blank', rel: 'noopener' }, ['github/ChiefmonkeyArt/torii-continuum']),
      ' · ',
      h('a', { href: 'https://chiefmonkey.art', target: '_blank', rel: 'noopener' }, ['Torii Quest (the game)']),
    ]),
    h('div', { style: 'margin-top: 6px;' }, [
      'Built for one operator, right now. Multi-tenant is not a promise.',
    ]),
  ]);
  mount.appendChild(foot);
}
