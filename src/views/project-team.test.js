// docs/adr-project-team-chat.md: every project has its team chat, on its Team tab.
import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { toNpub } from '../lib/npub.js';

const hex = (c) => c.repeat(64);
const OWNER = hex('a');
const BOB = hex('b');
const BOT = hex('c');
const ORIGIN = 'https://teams.example.org';
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };
let dom;

const roster = {
  roster: {
    slug: 'studio', owner: OWNER, created_at: 2_000_000_000,
    members: [{ pubkey: OWNER, role: 'owner' }, { pubkey: BOB, role: 'maintainer' }, { pubkey: BOT, role: 'agent', of: BOB }],
  },
  teams: { chat: { group_id: 'g1', claimed: false }, ready: [OWNER, BOB], added: [] },
};

async function boot({ me = { owner: true, pubkey: OWNER, teams_app_url: `${ORIGIN}/` }, data = roster, signer, put, fresh = false } = {}) {
  vi.resetModules();
  vi.doMock('../data/store.js', () => ({ getProject: (slug) => (slug === 'studio' ? { content: { slug, name: 'Studio' } } : null) }));
  vi.doMock('../chat.js', () => ({ setChatContext: vi.fn() }));
  vi.doMock('../shell.js', () => ({ renderSidebar: vi.fn() }));
  dom = new JSDOM('<main id="main-content"></main>', { url: 'https://test.invalid/continuum/#/projects/studio/team' });
  for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent', 'MutationObserver']) vi.stubGlobal(key, dom.window[key]);
  localStorage.setItem('continuum.session.meta.v1', JSON.stringify({ npub: toNpub(OWNER), connected_at: 1 }));
  let stored = data;
  const api = {
    teamMe: vi.fn(async () => ({ ok: true, data: me })),
    teamHandoff: vi.fn(async () => ({ ok: true, data: { pubkey: OWNER, token: 't', expires_at: 9 } })),
    projectRoster: vi.fn(async () => ({ ok: true, data: stored })),
    putProjectRoster: put || vi.fn(async (_slug, event) => {
      stored = { roster: { slug: 'studio', owner: OWNER, created_at: event.created_at, members: [{ pubkey: OWNER, role: 'owner' }] }, teams: { chat: null, ready: [], added: [] } };
      return { ok: true, data: stored };
    }),
    teamProfiles: vi.fn(async () => ({ ok: true, data: { profiles: {} } })),
    teamAvatarBlob: vi.fn(async () => null),
  };
  const go = vi.fn();
  const nav = await import('../lib/team-nav.js');
  if (fresh) nav.markNewProject('studio');
  const { renderProjectTeam } = await import('./project-team.js');
  const mount = document.querySelector('main');
  // The route renders again while the project hydrates (main.js).
  if (fresh) renderProjectTeam(mount, 'studio', { api, go, signer: () => signer });
  renderProjectTeam(mount, 'studio', { api, go, signer: () => signer });
  await tick();
  return { api, go, mount };
}

const text = () => document.querySelector('main').textContent;
const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);

afterEach(async () => {
  const { _resetTeamsFrame } = await import('../lib/teams-frame.js');
  _resetTeamsFrame();
  vi.unstubAllGlobals();
  vi.doUnmock('../data/store.js');
  vi.doUnmock('../chat.js');
  vi.doUnmock('../shell.js');
});

test('Team tab: the project chat docked full width, people count, Add people and full window', async () => {
  const { go } = await boot();
  const tabs = [...document.querySelectorAll('.view-tabs a')].map((a) => a.textContent);
  expect(tabs).toEqual(['Workspace', 'Team', 'Overview', 'Board']);
  expect(document.querySelector('.view-tabs a[aria-current="page"]').textContent).toBe('Team');
  expect(text()).toContain('2 people · 1 not joined yet'); // the agent is not counted
  const frames = document.querySelectorAll('iframe.team-chat-frame');
  expect(frames.length).toBe(1);
  expect(frames[0].getAttribute('src')).toBe(`${ORIGIN}/chat/p/studio?embed=1`);
  expect(frames[0].style.position).toBe('fixed');
  const full = document.querySelector('a.team-chat-open');
  expect(full.hidden).toBe(false);
  expect(full.getAttribute('href')).toBe(`${ORIGIN}/chat/p/studio`);
  expect(full.getAttribute('rel')).toBe('noopener noreferrer');
  button('Add people').click();
  expect(sessionStorage.getItem('continuum.teamChatProject')).toBe('studio');
  expect(go).toHaveBeenCalledWith('/team');
  // Leaving the tab hides the frame but keeps it running (ADR 0010 §2).
  document.querySelector('main').textContent = '';
  await tick();
  expect(document.querySelectorAll('iframe').length).toBe(1);
  expect(frames[0].style.visibility).toBe('hidden');
});

test('new project: the owner-only member list is signed at once and the chat opens', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: OWNER }));
  const { api } = await boot({ data: { roster: null, teams: { chat: null, ready: [], added: [] } }, signer: { signEvent }, fresh: true });
  expect(signEvent).toHaveBeenCalledTimes(1);
  const ev = signEvent.mock.calls[0][0];
  expect(ev.kind).toBe(30098);
  expect(ev.tags.filter((t) => t[0] === 'p')).toHaveLength(0); // just the owner
  expect(api.putProjectRoster).toHaveBeenCalledTimes(1);
  await tick();
  expect(text()).toContain('1 person');
  expect(document.querySelector('iframe.team-chat-frame')).not.toBeNull();
});

test('existing project without a group: nothing signed until Start team chat', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, id: 'i'.repeat(64), sig: 's'.repeat(128), pubkey: OWNER }));
  const { api } = await boot({ data: { roster: null, teams: { chat: null, ready: [], added: [] } }, signer: { signEvent } });
  expect(signEvent).not.toHaveBeenCalled();
  expect(document.querySelector('iframe')).toBeNull();
  expect(text()).toContain('no team chat yet');
  const fired = vi.fn();
  window.addEventListener('continuum:roster-changed', (e) => fired(e.detail.slug));
  button('Start team chat').click();
  await tick();
  expect(signEvent).toHaveBeenCalledTimes(1);
  expect(api.putProjectRoster).toHaveBeenCalledTimes(1);
  expect(fired).toHaveBeenCalledWith('studio');
});

test('signing refused: the project stays, with Start team chat and the reason', async () => {
  const signEvent = vi.fn(async () => { throw new Error('denied'); });
  const { api } = await boot({ data: { roster: null, teams: null }, signer: { signEvent }, fresh: true });
  expect(api.putProjectRoster).not.toHaveBeenCalled();
  expect(button('Start team chat')).toBeTruthy();
  expect(text()).toContain('Signing cancelled or failed: denied');
});

test('no Teams on this node: one line, no frame and no signing', async () => {
  const signEvent = vi.fn();
  const { api } = await boot({ me: { owner: true, pubkey: OWNER, teams_app_url: null }, signer: { signEvent }, fresh: true });
  expect(text()).toContain("Torii Teams isn't installed on this node");
  expect(api.projectRoster).not.toHaveBeenCalled();
  expect(signEvent).not.toHaveBeenCalled();
  expect(document.querySelector('iframe')).toBeNull();
});

test('the assistant bar is hidden on the Team tab only', () => {
  const css = readFileSync(new URL('../styles/workspace.css', import.meta.url), 'utf8');
  expect(css).toContain('body:has(.project-team-page) .chat-dock { display: none; }');
});
