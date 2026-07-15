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

import { h, clear, svg } from './util.js';
import { navigate } from '../router.js';
import { startLogin, isSessionLive } from '../auth.js';
import { isAgentConfigured } from '../data/agent.js';

/**
 * Ornate Myōjin-style torii, built as inline SVG.
 *
 * Anatomy top → bottom (traditional names):
 *   kasagi   — top lintel, sweeps upward at the ends (Myōjin curve)
 *   shimaki  — secondary lintel directly under kasagi
 *   gakuzuka — central strut with a small plaque (shingaku), stamped with 鳥居
 *   nuki     — straight tie beam that protrudes through both pillars
 *   kusabi   — decorative wedges at the nuki-hashira joints
 *   daiwa   — decorative ring where the pillars meet the shimaki
 *   hashira  — pillars, with a subtle inward incline (uchikorobi)
 *   nemaki   — dark bands at the base of each pillar
 *
 * Colours pulled from the site's amber ↔ deep-bronze token palette. All
 * shading is done with linear gradients + a warm drop-shadow filter so the
 * mark stays readable at both 32px (favicon) and hero size.
 */
export function toriiSvg() {
  const root = svg('svg', {
    class: 'landing-torii-svg',
    viewBox: '0 0 220 260',
    width: '220',
    height: '260',
    role: 'img',
    'aria-label': 'Continuum torii gate',
    xmlns: 'http://www.w3.org/2000/svg',
  });

  // ---- defs: gradients + soft warm glow ---------------------------------
  const defs = svg('defs', {}, [
    svg('linearGradient', { id: 'toriiAmber', x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0%', 'stop-color': 'hsl(42 96% 66%)' }),
      svg('stop', { offset: '52%', 'stop-color': 'hsl(38 92% 58%)' }),
      svg('stop', { offset: '100%', 'stop-color': 'hsl(24 80% 42%)' }),
    ]),
    svg('linearGradient', { id: 'toriiAmberFlat', x1: '0', y1: '0', x2: '1', y2: '0' }, [
      svg('stop', { offset: '0%', 'stop-color': 'hsl(30 82% 46%)' }),
      svg('stop', { offset: '50%', 'stop-color': 'hsl(38 92% 58%)' }),
      svg('stop', { offset: '100%', 'stop-color': 'hsl(30 82% 46%)' }),
    ]),
    svg('linearGradient', { id: 'toriiDark', x1: '0', y1: '0', x2: '0', y2: '1' }, [
      svg('stop', { offset: '0%', 'stop-color': 'hsl(24 60% 22%)' }),
      svg('stop', { offset: '100%', 'stop-color': 'hsl(20 55% 14%)' }),
    ]),
    svg('filter', { id: 'toriiGlow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, [
      svg('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: '3', result: 'blur' }),
      svg('feFlood', { 'flood-color': 'hsl(38 92% 58%)', 'flood-opacity': '0.35', result: 'colour' }),
      svg('feComposite', { in: 'colour', in2: 'blur', operator: 'in', result: 'shadow' }),
      svg('feMerge', {}, [
        svg('feMergeNode', { in: 'shadow' }),
        svg('feMergeNode', { in: 'SourceGraphic' }),
      ]),
    ]),
  ]);
  root.appendChild(defs);

  // Everything ornamental hangs off one group so the glow filter applies once.
  const g = svg('g', { filter: 'url(#toriiGlow)' });

  // ---- kasagi (top lintel, curved Myōjin sweep) -------------------------
  // Slight upward curl at both ends. Pentagonal cross-section suggested by
  // the darker cap on top. Path is symmetric around x=110.
  const kasagi = svg('path', {
    d: 'M 6 26 Q 12 6 30 10 L 190 10 Q 208 6 214 26 L 210 34 L 10 34 Z',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)',
    'stroke-width': '0.6',
  });
  // Highlight strip on top of kasagi — reads as the pentagonal ridge.
  const kasagiRidge = svg('path', {
    d: 'M 14 16 Q 26 10 40 14 L 180 14 Q 194 10 206 16',
    fill: 'none',
    stroke: 'hsl(46 98% 76%)',
    'stroke-width': '1.2',
    'stroke-linecap': 'round',
    opacity: '0.55',
  });
  g.appendChild(kasagi);
  g.appendChild(kasagiRidge);

  // ---- shimaki (under-lintel, upside-down trapezoid) --------------------
  const shimaki = svg('path', {
    d: 'M 18 34 L 202 34 L 194 50 L 26 50 Z',
    fill: 'url(#toriiAmberFlat)',
    stroke: 'hsl(24 80% 32%)',
    'stroke-width': '0.6',
  });
  g.appendChild(shimaki);

  // ---- gakuzuka (central strut) + plaque --------------------------------
  const gakuzuka = svg('rect', {
    x: '102', y: '50', width: '16', height: '38',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.4',
  });
  const plaque = svg('rect', {
    x: '92', y: '56', width: '36', height: '26', rx: '2',
    fill: 'url(#toriiDark)',
    stroke: 'hsl(38 92% 58%)', 'stroke-width': '0.8',
  });
  // Tiny torii glyph on the plaque — a stylised gate mark.
  const glyph = svg('g', { transform: 'translate(102 62)', fill: 'hsl(42 96% 66%)' }, [
    svg('rect', { x: '0', y: '0', width: '16', height: '2.4', rx: '0.6' }),
    svg('rect', { x: '1', y: '2.8', width: '14', height: '1.4', rx: '0.4' }),
    svg('rect', { x: '2.6', y: '4.4', width: '1.8', height: '10', rx: '0.4' }),
    svg('rect', { x: '11.6', y: '4.4', width: '1.8', height: '10', rx: '0.4' }),
    svg('rect', { x: '1.2', y: '8', width: '13.6', height: '1.2', rx: '0.3' }),
  ]);
  g.appendChild(gakuzuka);
  g.appendChild(plaque);
  g.appendChild(glyph);

  // ---- nuki (tie beam, straight, protrudes both sides) ------------------
  const nuki = svg('rect', {
    x: '4', y: '88', width: '212', height: '14',
    fill: 'url(#toriiAmberFlat)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.5',
  });
  // Subtle top highlight on the nuki.
  const nukiHi = svg('rect', {
    x: '6', y: '89.5', width: '208', height: '1.4',
    fill: 'hsl(46 98% 76%)', opacity: '0.4',
  });
  g.appendChild(nuki);
  g.appendChild(nukiHi);

  // ---- kusabi (ornamental wedges at the nuki-hashira joints) ------------
  // Four small trapezoidal wedges above and below the nuki where it meets
  // each pillar. Kept small so they read as ornament, not clutter.
  const wedgeCoords = [
    // above-left, above-right, below-left, below-right
    'M 34 84 L 46 84 L 44 88 L 36 88 Z',
    'M 174 84 L 186 84 L 184 88 L 176 88 Z',
    'M 36 102 L 44 102 L 46 106 L 34 106 Z',
    'M 176 102 L 184 102 L 186 106 L 174 106 Z',
  ];
  for (const d of wedgeCoords) {
    g.appendChild(svg('path', {
      d,
      fill: 'hsl(28 88% 48%)',
      stroke: 'hsl(24 80% 28%)',
      'stroke-width': '0.4',
    }));
  }

  // ---- daiwa (decorative rings where pillars meet the shimaki) ---------
  const daiwaLeft = svg('rect', {
    x: '28', y: '50', width: '24', height: '6',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.4',
  });
  const daiwaRight = svg('rect', {
    x: '168', y: '50', width: '24', height: '6',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.4',
  });
  g.appendChild(daiwaLeft);
  g.appendChild(daiwaRight);

  // ---- hashira (pillars, uchikorobi = subtle inward lean) --------------
  // Left pillar leans right; right pillar leans left. Trapezoidal path so
  // the top is slightly narrower than the base — reads as classical.
  const leftPillar = svg('path', {
    d: 'M 32 56 L 48 56 L 50 246 L 30 246 Z',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.6',
  });
  const rightPillar = svg('path', {
    d: 'M 172 56 L 188 56 L 190 246 L 170 246 Z',
    fill: 'url(#toriiAmber)',
    stroke: 'hsl(24 80% 32%)', 'stroke-width': '0.6',
  });
  g.appendChild(leftPillar);
  g.appendChild(rightPillar);

  // Vertical wood-grain highlights on each pillar.
  const grainLeft = svg('line', {
    x1: '38', y1: '58', x2: '39.5', y2: '244',
    stroke: 'hsl(46 98% 76%)', 'stroke-width': '0.6', opacity: '0.35',
  });
  const grainRight = svg('line', {
    x1: '178', y1: '58', x2: '179.5', y2: '244',
    stroke: 'hsl(46 98% 76%)', 'stroke-width': '0.6', opacity: '0.35',
  });
  g.appendChild(grainLeft);
  g.appendChild(grainRight);

  // ---- nemaki (dark bands at pillar bases) ------------------------------
  const nemakiLeft = svg('rect', {
    x: '28', y: '232', width: '24', height: '14', rx: '1',
    fill: 'url(#toriiDark)',
  });
  const nemakiRight = svg('rect', {
    x: '168', y: '232', width: '24', height: '14', rx: '1',
    fill: 'url(#toriiDark)',
  });
  g.appendChild(nemakiLeft);
  g.appendChild(nemakiRight);

  root.appendChild(g);
  return root;
}

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
    h('div', { class: 'landing-torii', 'aria-hidden': 'true' }, [
      toriiSvg(),
    ]),
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
      h('a', { href: 'https://torii-quest.pplx.app', target: '_blank', rel: 'noopener' }, ['Torii Quest (the game)']),
    ]),
    h('div', { style: 'margin-top: 6px;' }, [
      'Built for one operator, right now. Multi-tenant is not a promise.',
    ]),
  ]);
  mount.appendChild(foot);
}
