/**
 * Seed data — Nostr-shaped events for first-run state.
 * Ships Quest + Continuum as the two starter projects, with
 * matching sessions, milestones, todos, and files so every
 * screen has meaningful content.
 */
import { KIND, makeEvent, nowSec } from './schema.js';

function ev(kind, d, content, extraTags = []) {
  return makeEvent({ kind, d, content, tags: extraTags });
}

export function seedProjects() {
  return [
    ev(KIND.PROJECT, 'torii-quest', {
      slug: 'torii-quest',
      name: 'Torii Quest',
      description: 'Open-world arena shooter built on Nostr + Bitcoin. Sats. Shots. Sovereignty.',
      source: 'github',
      sourceUrl: 'https://github.com/ChiefmonkeyArt/torii-quest',
      status: 'active',
      createdAt: nowSec() - 60 * 60 * 24 * 42,
      tagList: ['game', 'nostr', 'three-js'],
    }, [['t', 'continuum-project'], ['t', 'game']]),
    ev(KIND.PROJECT, 'continuum', {
      slug: 'continuum',
      name: 'Continuum',
      description: 'The app builder itself — project engine and marketplace for bot work.',
      source: 'github',
      sourceUrl: 'https://github.com/ChiefmonkeyArt/torii-continuum',
      status: 'active',
      createdAt: nowSec() - 60 * 60 * 24 * 3,
      tagList: ['tools', 'nostr', 'meta'],
    }, [['t', 'continuum-project'], ['t', 'meta']]),
  ];
}

export function seedSessions() {
  const now = nowSec();
  const H = 60 * 60;
  const s = (slug, offset, hours, title) => ev(KIND.SESSION, `${slug}:${offset}`, {
    projectSlug: slug,
    title,
    startedAt: now - offset,
    durationSec: hours * H,
    summary: title,
  });
  return [
    s('torii-quest', 60 * 60 * 6, 2, 'Zone-safe route + host guard fix'),
    s('torii-quest', 60 * 60 * 26, 3, 'Travel gateway placement pass'),
    s('torii-quest', 60 * 60 * 52, 4, 'Enter-arena reset crash repair'),
    s('torii-quest', 60 * 60 * 96, 2, 'MVP playtest results template'),
    s('continuum', 60 * 60 * 2, 1, 'App shell + left menu scaffold'),
    s('continuum', 60 * 60 * 24, 2, 'Nostr-shaped project schema draft'),
  ];
}

export function seedMilestones() {
  const m = (slug, index, title, status, note) => ev(KIND.MILESTONE, `${slug}:m${index}`, {
    projectSlug: slug, index, title, status, note,
  });
  return [
    m('torii-quest', 1, 'Gateway protocol foundation', 'done', 'M1 complete · draft manifest + validator'),
    m('torii-quest', 2, 'Local zone graph MVP', 'done', 'Five zone stubs travelable'),
    m('torii-quest', 3, 'Nostr discovery layer', 'active', 'Read-only relay discovery in progress'),
    m('torii-quest', 4, 'Commerce display layer', 'pending', 'Product / gallery / auction shells'),
    m('torii-quest', 5, 'MVP inter-zone connectivity', 'pending', 'End-to-end shop → gallery loop'),

    m('continuum', 1, 'App shell + navigation', 'active', 'Left menu, chat dock, page router'),
    m('continuum', 2, 'Projects + project home', 'pending', 'List, create, open project'),
    m('continuum', 3, 'Routstr + marketplace shells', 'pending', 'UI-only, mocked responses'),
    m('continuum', 4, 'Sign-in with Nostr (NIP-07)', 'pending', 'Wire real signer, publish events'),
    m('continuum', 5, 'Own relay + sync', 'pending', 'Local-first with own relay backup'),
  ];
}

export function seedTodos() {
  const t = (slug, order, text, done) => ev(KIND.TODO, `${slug}:seed-${order}`, {
    projectSlug: slug, order, text, done, createdAt: nowSec() - order * 3600,
  });
  return [
    t('torii-quest', 0, 'Ship zone-renderable safe route', true),
    t('torii-quest', 1, 'Land host-safe zone guard', true),
    t('torii-quest', 2, 'Fix enter-arena reset crash', true),
    t('torii-quest', 3, 'Discovery: read-only relay query', false),
    t('torii-quest', 4, 'Product display component contract', false),
    t('torii-quest', 5, 'Auction shell (read-only)', false),

    t('continuum', 0, 'Left menu shell + routing', true),
    t('continuum', 1, 'Projects list + New Project flow', false),
    t('continuum', 2, 'Project home: milestones/todos/files', false),
    t('continuum', 3, 'Routstr page — mock model picker', false),
    t('continuum', 4, 'Marketplace — highlight our tasks', false),
    t('continuum', 5, 'AI chat dock — mock responses', false),
    t('continuum', 6, 'Import repo from GitHub/ngit URL', false),
  ];
}

export function seedFiles() {
  const f = (slug, path, kind, size) => ev(KIND.FILE, `${slug}:${path}`, {
    projectSlug: slug, path, kind, size,
  });
  return [
    f('torii-quest', 'src/engine/dashboard/toriiQuestDashboardData.js', 'js', 62_400),
    f('torii-quest', 'src/world/zoneRuntime.js', 'js', 21_100),
    f('torii-quest', 'GATEWAY_PROTOCOL.md', 'md', 8_900),
    f('torii-quest', 'MVP_PLAYTEST_CHECKLIST.md', 'md', 12_300),
    f('torii-quest', 'tools/build-torii-quest-dashboard.mjs', 'mjs', 4_800),

    f('continuum', 'src/main.js', 'js', 1_800),
    f('continuum', 'src/data/schema.js', 'js', 1_900),
    f('continuum', 'src/data/store.js', 'js', 5_600),
    f('continuum', 'src/views/projects.js', 'js', 3_400),
    f('continuum', 'README.md', 'md', 900),
  ];
}

export function seedMarketTasks() {
  const t = (id, title, repo, bounty, complexity, status, ours = false) => ev(KIND.MARKET_TASK, id, {
    id, title, repo, bounty, complexity, status, ours,
    postedAt: nowSec() - Math.floor(Math.random() * 60 * 60 * 72),
  });
  return [
    // Ours
    t('mkt_tq_01', 'Nostr discovery: read-only relay query with allow-list', 'ChiefmonkeyArt/torii-quest', 24000, 'M', 'open', true),
    t('mkt_tq_02', 'Product display component contract (read-only)', 'ChiefmonkeyArt/torii-quest', 18000, 'M', 'open', true),
    t('mkt_tq_03', 'Auction shell — status + listing board (no bidding)', 'ChiefmonkeyArt/torii-quest', 15000, 'S', 'open', true),
    t('mkt_ct_01', 'Import repo from GitHub URL flow', 'ChiefmonkeyArt/torii-continuum', 12000, 'S', 'open', true),
    t('mkt_ct_02', 'Wire NIP-07 signer and publish events', 'ChiefmonkeyArt/torii-continuum', 28000, 'L', 'open', true),
    // Other people's
    t('mkt_ext_01', 'strfry: reduce cold-start memory footprint', 'hoytech/strfry', 42000, 'L', 'open'),
    t('mkt_ext_02', 'nostr-tools: fix relay pool reconnect race', 'nbd-wtf/nostr-tools', 22000, 'M', 'open'),
    t('mkt_ext_03', 'Rapier.js: web-only build slim script', 'dimforge/rapier.js', 33000, 'M', 'open'),
    t('mkt_ext_04', 'plebeian-market: NIP-15 event example', 'PlebeianTech/plebeian-market', 16000, 'S', 'open'),
    t('mkt_ext_05', 'cashu-ts: add mint-info caching layer', 'cashubtc/cashu-ts', 21000, 'M', 'open'),
    t('mkt_ext_06', 'ngit: cross-relay push retry policy', 'DanConwayDev/ngit-cli', 30000, 'L', 'open'),
    t('mkt_ext_07', 'Docs: NIP-60 wallet capability discovery', 'nostr-protocol/nips', 8000, 'S', 'open'),
  ];
}

export function seedRoutstr() {
  return ev(KIND.ROUTSTR, 'default', {
    connected: false,
    endpoint: 'https://api.routstr.com',
    selectedModel: 'deepseek-chat',
    cashuBalanceSats: 0,
    usage: {
      requests24h: 0,
      tokensIn: 0,
      tokensOut: 0,
      satsSpent: 0,
      monthlyBudget: 25000,
    },
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', pricePer1kSats: 6, tier: 'default', badge: 'Default' },
      { id: 'deepseek-coder', name: 'DeepSeek Coder',pricePer1kSats: 6, tier: 'default' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', pricePer1kSats: 18, tier: 'balanced' },
      { id: 'gpt-4o', name: 'GPT-4o', pricePer1kSats: 42, tier: 'flagship' },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', pricePer1kSats: 48, tier: 'flagship' },
      { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', pricePer1kSats: 12, tier: 'balanced' },
      { id: 'hermes-3-70b', name: 'Hermes 3 70B (NousResearch)', pricePer1kSats: 14, tier: 'balanced', badge: 'Nous' },
      { id: 'mixtral-8x22b', name: 'Mixtral 8x22B', pricePer1kSats: 16, tier: 'balanced' },
    ],
  });
}
