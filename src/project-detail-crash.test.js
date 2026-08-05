/**
 * CONT-PROJDETAIL-1 — clicking any project on the Projects screen threw the
 * fail-closed panel ("This screen failed to load … Route /projects/:slug").
 *
 * Root cause: `src/views/projectHome.js` called the bare identifier
 * `sessionsFor(slug)` in the Overview strip's "Sessions" stat card. The file
 * never imports a top-level `sessionsFor` — it resolves the demo-aware data
 * source into a local `S` and calls `S.sessionsFor(slug)` everywhere else
 * (see the Sessions card body a few lines below). The bare call threw
 * `ReferenceError: sessionsFor is not defined` the instant the Overview route
 * handler ran, which router.js's fail-closed sink (CONT-AUTHUI-1) caught and
 * turned into the generic "This screen failed to load" panel — for EVERY
 * project, because every project's Overview page renders that stat card.
 *
 * These tests reproduce production end-to-end: real app boot (main.js), the
 * deployed base path `/continuum/`, hash routing, an authenticated session
 * rehydrated from storage (not asserted directly — exercised through the real
 * guard), and a realistic, occasionally malformed `continuum.v1` store seed.
 * They must fail against the v0.2.101-alpha `sessionsFor(slug)` regression
 * and pass with `S.sessionsFor(slug)`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const TOKEN_KEY = 'continuum.session.v1';
const EXPIRY_KEY = 'continuum.session.exp.v1';
const MARKER_KEY = 'continuum.session.meta.v1';
const STORE_KEY = 'continuum.v1';
const PUBKEY = 'a'.repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (exp) => `1000.${exp}.${PUBKEY}.1000.sig`;

const GLOBALS = [
  'window', 'document', 'localStorage', 'CustomEvent', 'Event', 'StorageEvent',
  'navigator', 'HTMLElement', 'getComputedStyle', 'fetch',
];

let dom;
const sameTurn = async (n = 80) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/**
 * A realistic production `continuum.v1` payload:
 *   - a normal, fully-populated project (the common case);
 *   - a project with several optional fields missing entirely (description,
 *     source, sourceUrl, tagList) — a record from before those fields existed;
 *   - a project whose slug is unusual (mixed case, embedded space, unicode,
 *     Cyrillic) — the kind of hand-entered or legacy `d`-tag a strict kebab
 *     slugify() would never produce but storage does not forbid;
 *   - one truly malformed project event with NO `content` object at all,
 *     simulating a corrupted write or a future/foreign schema this build
 *     cannot interpret — this must not take down the rest of the list;
 *   - milestones/todos/sessions/files attached only to the first project, so
 *     the Overview stat cards for the OTHER projects render from empty lists
 *     (todosFor/sessionsFor/milestonesFor/filesFor on a slug with no rows).
 */
function realisticStoreSeed() {
  const projects = [
    {
      kind: 30078, pubkey: PUBKEY, created_at: nowSec() - 1000, id: 'p'.repeat(64), sig: 's'.repeat(128),
      content: {
        slug: 'torii-bazaar', name: 'Torii Bazaar', description: 'Marketplace for clankers.',
        source: 'github', sourceUrl: 'https://github.com/ChiefmonkeyArt/torii-bazaar',
        status: 'active', createdAt: nowSec() - 1000, tagList: ['marketplace'],
      },
      tags: [['d', 'torii-bazaar']],
    },
    {
      kind: 30078, pubkey: PUBKEY, created_at: nowSec() - 500, id: 'q'.repeat(64), sig: 's'.repeat(128),
      content: { slug: 'ghost-project', name: 'Ghost Project' }, // no description/source/sourceUrl/tagList
      tags: [['d', 'ghost-project']],
    },
    {
      kind: 30078, pubkey: PUBKEY, created_at: nowSec() - 200, id: 'r'.repeat(64), sig: 's'.repeat(128),
      content: {
        slug: 'Torii Ünïcode Проект', name: 'Torii Ünïcode Проект',
        description: null, source: 'local', sourceUrl: null, status: 'active',
        createdAt: nowSec() - 200, tagList: null,
      },
      tags: [['d', 'unicode']],
    },
    {
      // Malformed: no `content` at all.
      kind: 30078, pubkey: PUBKEY, created_at: nowSec() - 100, id: 't'.repeat(64), sig: 's'.repeat(128),
    },
  ];
  const milestones = [
    { kind: 30080, id: 'm1'.padEnd(64, '0'), created_at: nowSec(), content: { projectSlug: 'torii-bazaar', index: 0, title: 'MVP', status: 'active' } },
  ];
  const todos = [
    { kind: 30081, id: 'td1'.padEnd(64, '0'), created_at: nowSec(), content: { projectSlug: 'torii-bazaar', text: 'Ship it', done: false, order: 0 } },
  ];
  const sessions = [
    { kind: 30079, id: 'se1'.padEnd(64, '0'), created_at: nowSec(), content: { projectSlug: 'torii-bazaar', title: 'Build session', startedAt: nowSec() - 3600, durationSec: 3600 } },
  ];
  const files = [
    { kind: 30082, id: 'f1'.padEnd(64, '0'), created_at: nowSec(), content: { projectSlug: 'torii-bazaar', kind: 'code', path: 'src/index.js', size: 1024 } },
  ];
  return JSON.stringify({
    projects, sessions, milestones, todos, files,
    columns: [], cards: [], marketTasks: [], routstr: null, members: [],
  });
}

function makeWindow(o = {}) {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `https://torii.test/continuum/${o.hash || ''}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const n = nowSec();
  if (o.authed !== false) {
    window.localStorage.setItem(TOKEN_KEY, tokenFor(n + 3600));
    window.localStorage.setItem(EXPIRY_KEY, String(n + 3600));
    window.localStorage.setItem(MARKER_KEY, JSON.stringify({ npub: PUBKEY, connected_at: n }));
  }
  window.localStorage.setItem(STORE_KEY, o.storeSeed ?? realisticStoreSeed());
  window.__CONTINUUM_AGENT_URL__ = '/continuum';

  for (const k of GLOBALS) {
    if (k === 'fetch' || k === 'getComputedStyle') continue;
    globalThis[k] = window[k] ?? window;
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
  return window;
}

const observe = (w) => ({
  hash: w.location.hash,
  routeError: !!w.document.querySelector('.route-error'),
  routeErrorText: w.document.querySelector('.route-error')?.textContent || '',
  pageTitle: w.document.querySelector('#main-content .page-title')?.textContent || '',
  empty: !!w.document.querySelector('#main-content .empty'),
  sessionsStat: [...w.document.querySelectorAll('#main-content .stat')]
    .find((s) => s.querySelector('.label')?.textContent === 'Sessions')
    ?.querySelector('.value')?.textContent,
});

async function boot(w) {
  await import('./main.js');
  await sameTurn();
  return observe(w);
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => {
  try { dom?.window?.close(); } catch (_e) {}
  for (const k of GLOBALS) delete globalThis[k];
  dom = undefined;
});

describe('project detail route (/projects/:slug) does not crash', () => {
  it('opens a normal project by clicking its card from the Projects list', async () => {
    const w = makeWindow({ hash: '#/projects' });
    await boot(w);
    const card = w.document.querySelector('.project-card:not(.add)');
    expect(card, 'at least one project card must render').toBeTruthy();
    card.dispatchEvent(new w.Event('click', { bubbles: true }));
    await sameTurn();

    const s = observe(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.hash).toMatch(/^#\/projects\//);
    expect(s.pageTitle.length).toBeGreaterThan(0);
  });

  it('renders the Sessions stat correctly instead of throwing (the exact regression)', async () => {
    const w = makeWindow({ hash: '#/projects/torii-bazaar' });
    const s = await boot(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.pageTitle).toBe('Torii Bazaar');
    expect(s.sessionsStat).toBe('1'); // one seeded session for this slug
  });

  it('opens a project whose optional fields (description/source/sourceUrl/tags) are missing', async () => {
    const w = makeWindow({ hash: '#/projects/ghost-project' });
    const s = await boot(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.pageTitle).toBe('Ghost Project');
    expect(s.sessionsStat).toBe('0'); // no sessions for this slug — must not throw
  });

  it('opens a project with an unusual (mixed-case/space/unicode) slug via direct hash navigation', async () => {
    const w = makeWindow({ hash: `#/projects/${encodeURIComponent('Torii Ünïcode Проект')}` });
    const s = await boot(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.pageTitle).toBe('Torii Ünïcode Проект');
  });

  it('shows a safe not-found state (not a crash) for a missing/deleted/invalid slug', async () => {
    const w = makeWindow({ hash: '#/projects/does-not-exist-anymore' });
    const s = await boot(w);
    expect(s.routeError, `should show empty-state, not the fail-closed panel: ${s.routeErrorText}`).toBe(false);
    expect(s.empty).toBe(true);
  });

  it('does not crash the Projects list when one stored project record is malformed (no content)', async () => {
    const w = makeWindow({ hash: '#/projects' });
    const s = await boot(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    // The three well-formed projects still render as cards.
    const cards = w.document.querySelectorAll('.project-card:not(.add)');
    expect(cards.length).toBe(3);
  });

  it('reopens the same project on a direct reload / deep link (not just via in-app click)', async () => {
    const w = makeWindow({ hash: '#/projects/torii-bazaar' });
    const s = await boot(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.pageTitle).toBe('Torii Bazaar');
  });

  it('opens the project board route for the same slug without crashing', async () => {
    const w = makeWindow({ hash: '#/projects/torii-bazaar/board' });
    await boot(w);
    const s = observe(w);
    expect(s.routeError, `unexpected route error: ${s.routeErrorText}`).toBe(false);
    expect(s.pageTitle).toBe('Board');
  });
});
