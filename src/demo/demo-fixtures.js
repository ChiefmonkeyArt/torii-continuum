/**
 * Demo-mode fixtures (v0.2.85-alpha).
 *
 * Signed-out visitors can browse a demo mockup of the app at /demo/*. Every
 * value here is OBVIOUSLY fake — human-facing strings all carry the word "DEMO"
 * or "Sample" so a demo screen can never be mistaken for real operator data.
 *
 * The exported `demoStore` mirrors the subset of src/data/store.js that the
 * demo-capable views call, so those views switch data source with a single
 * `const S = demo ? demoStore : store` selection instead of forking the view.
 * It is READ-ONLY: there is no persistence and mutation entry points are absent
 * (demo views route every mutating action to the login page instead).
 */

// A fixed clock so timeAgo() renders stable relative times in tests.
const NOW = 1_700_000_000; // 2023-11-14T…Z, unix seconds
const DAY = 86_400;

// Obviously-fake Routstr balance the brief calls for.
export const DEMO_BALANCE_SATS = 21042;

function project(slug, name, description, tags) {
  return {
    id: `demo-${slug}`,
    kind: 30078,
    created_at: NOW - 2 * DAY,
    content: { slug, name, description, source: 'demo', sourceUrl: null, status: 'active', tags },
  };
}

export const DEMO_PROJECTS = [
  project('demo-acme', 'Acme Demo Project', 'This is a demo. Sign in to see your real data.', ['demo', 'sample']),
  project('sample-kiosk', 'Sample Kiosk', 'Sample storefront for the DEMO. Sign in to see your real data.', ['sample', 'demo']),
  project('demo-storefront', 'DEMO Storefront', 'This is a demo. Sign in to see your real data.', ['demo']),
];

const MILESTONES = {
  'demo-acme': [
    { index: 1, title: 'Sample milestone — kickoff', status: 'done', note: 'DEMO data only' },
    { index: 2, title: 'DEMO milestone — build', status: 'active', note: 'Sample note' },
    { index: 3, title: 'Sample milestone — launch', status: 'pending', note: 'DEMO data only' },
  ],
  'sample-kiosk': [
    { index: 1, title: 'Sample milestone — design', status: 'done', note: 'DEMO data only' },
    { index: 2, title: 'DEMO milestone — wire up', status: 'pending', note: 'Sample note' },
  ],
  'demo-storefront': [
    { index: 1, title: 'DEMO milestone — catalog', status: 'active', note: 'Sample note' },
  ],
};

const TODOS = {
  'demo-acme': [
    { text: 'DEMO todo — connect a signer', done: true },
    { text: 'Sample todo — add a project', done: false },
    { text: 'DEMO todo — publish a milestone', done: false },
  ],
  'sample-kiosk': [
    { text: 'Sample todo — pick a template', done: true },
    { text: 'DEMO todo — invite an operator', done: false },
  ],
  'demo-storefront': [
    { text: 'Sample todo — import a repo', done: false },
  ],
};

const SESSIONS = {
  'demo-acme': [
    { title: 'Sample session — planning', durationSec: 2 * 3600, startedAt: NOW - 1 * DAY },
    { title: 'DEMO session — build pass', durationSec: 3 * 3600, startedAt: NOW - 2 * DAY },
  ],
  'sample-kiosk': [
    { title: 'DEMO session — kickoff', durationSec: 1 * 3600, startedAt: NOW - 3 * DAY },
  ],
  'demo-storefront': [],
};

const FILES = {
  'demo-acme': [
    { kind: 'js', path: 'src/demo/sample-widget.js', size: 4200 },
    { kind: 'md', path: 'DEMO_README.md', size: 900 },
  ],
  'sample-kiosk': [
    { kind: 'js', path: 'src/sample/demo-kiosk.js', size: 3100 },
  ],
  'demo-storefront': [],
};

export const DEMO_MARKET_TASKS = [
  { id: 'demo_mkt_01', title: 'Sample bounty — wire the DEMO checkout', repo: 'acme-demo/sample-repo', bounty: 21000, complexity: 'M', status: 'open', ours: true, postedAt: NOW - 1 * DAY },
  { id: 'demo_mkt_02', title: 'DEMO bounty — sample relay query', repo: 'sample-org/demo-relay', bounty: 12000, complexity: 'S', status: 'open', ours: true, postedAt: NOW - 2 * DAY },
  { id: 'demo_mkt_03', title: 'Sample bounty — DEMO auction shell', repo: 'demo-labs/sample-market', bounty: 33000, complexity: 'L', status: 'open', ours: false, postedAt: NOW - 3 * DAY },
];

export const DEMO_MEMBERS = [
  { npub: 'npub1demo00000000000000000000000000000000000000000000000000demo', label: 'Sample Operator', role: 'operator', addedAt: NOW - 5 * DAY },
  { npub: 'npub1sample000000000000000000000000000000000000000000000sample', label: 'DEMO Reviewer', role: 'operator', addedAt: NOW - 6 * DAY },
];

export const DEMO_ROUTSTR = {
  id: 'demo-routstr',
  kind: 30091,
  created_at: NOW - 1 * DAY,
  content: {
    connected: true,
    endpoint: 'https://api.routstr.com',
    selectedModel: 'deepseek-chat',
    cashuBalanceSats: DEMO_BALANCE_SATS,
    usage: { requests24h: 42, tokensIn: 21000, tokensOut: 8400, satsSpent: 210, monthlyBudget: 25000 },
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (Sample)', pricePer1kSats: 6, tier: 'default', badge: 'DEMO' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini (Sample)', pricePer1kSats: 18, tier: 'balanced' },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Sample)', pricePer1kSats: 48, tier: 'flagship' },
    ],
  },
};

function wrapMilestones(slug) {
  return (MILESTONES[slug] || []).map((m, i) => ({ id: `demo-m-${slug}-${i}`, kind: 30079, created_at: NOW, content: { projectSlug: slug, ...m } }));
}
function wrapTodos(slug) {
  return (TODOS[slug] || []).map((t, i) => ({ id: `demo-t-${slug}-${i}`, kind: 30080, created_at: NOW - i * 3600, content: { projectSlug: slug, order: i, ...t } }));
}
function wrapSessions(slug) {
  return (SESSIONS[slug] || []).map((s, i) => ({ id: `demo-s-${slug}-${i}`, kind: 30081, created_at: NOW, content: { projectSlug: slug, ...s } }));
}
function wrapFiles(slug) {
  return (FILES[slug] || []).map((f, i) => ({ id: `demo-f-${slug}-${i}`, kind: 30082, created_at: NOW, content: { projectSlug: slug, ...f } }));
}
function wrapMarketTasks() {
  return DEMO_MARKET_TASKS.map((t) => ({ id: t.id, kind: 30085, created_at: t.postedAt, content: { ...t } }));
}
function wrapMembers() {
  return DEMO_MEMBERS.map((m) => ({ id: `demo-member-${m.npub.slice(0, 12)}`, kind: 30093, created_at: m.addedAt, content: { ...m } }));
}

function boardStatsFor(slug) {
  // Derive coarse board stats from the fixture todos so the dashboard shows a
  // non-zero, obviously-demo progress bar without a real board.
  const todos = TODOS[slug] || [];
  const done = todos.filter((t) => t.done).length;
  const total = todos.length;
  return { total, backlog: 0, todo: total - done, doing: 0, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Read-only store facade over the fixtures. Method names + return shapes match
 * src/data/store.js so a demo-capable view selects its data source with one
 * `const S = demo ? demoStore : store` line. subscribe() is a no-op (fixtures
 * never change), returning an unsubscribe function so callers can treat it
 * exactly like the real store.
 */
export const demoStore = Object.freeze({
  listProjects: () => DEMO_PROJECTS.slice(),
  getProject: (slug) => DEMO_PROJECTS.find((p) => p && p.content && p.content.slug === slug) || null,
  milestonesFor: wrapMilestones,
  todosFor: wrapTodos,
  sessionsFor: wrapSessions,
  filesFor: wrapFiles,
  boardStatsFor,
  listMarketTasks: wrapMarketTasks,
  listMembers: wrapMembers,
  getRoutstr: () => DEMO_ROUTSTR,
  subscribe: () => () => {},
});
