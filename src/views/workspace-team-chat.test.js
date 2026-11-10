// docs/adr-project-team-chat.md §3: the project's Chats tab lists its team chat first.
import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

afterEach(() => {
  vi.unstubAllGlobals();
  for (const m of ['../data/store.js', '../router.js', '../chat.js', './connections.js', './projectHome.js']) vi.doUnmock(m);
});

test('Chats tab: "Team chat" first, linking to the project Team tab', async () => {
  vi.resetModules();
  const dom = new JSDOM('<main></main>', { url: 'https://test.invalid/#/projects/studio' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
  vi.doMock('./projectHome.js', () => ({ renderProjectTabs: () => document.createElement('nav'), renderMilestones: () => document.createElement('div'), renderFiles: () => document.createElement('div'), renderTodos: () => document.createElement('div') }));
  vi.doMock('../data/store.js', () => ({ getProject: () => ({ content: { slug: 'studio', name: 'Studio' } }), subscribe: () => () => {} }));
  vi.doMock('../router.js', () => ({ navigate: vi.fn() }));
  vi.doMock('../chat.js', () => ({
    attachChatWorkspace: vi.fn(), newConversation: vi.fn(), openConversation: vi.fn(), setChatContext: vi.fn(),
    historyTitle: (r) => r.title, sessionLibrary: { load: async () => {}, rows: () => [{ id: 's1', title: 'Plan', metadata: { project: 'studio' } }] },
  }));
  vi.doMock('./connections.js', () => ({ renderProjectRepositoryLink: () => document.createElement('div') }));
  const { renderWorkspace } = await import('./workspace.js');
  renderWorkspace(document.querySelector('main'), { project: 'studio' });
  [...document.querySelectorAll('.workspace-panel-tabs button')].find((b) => b.textContent === 'Chats').click();
  const links = [...document.querySelectorAll('.workspace-panel-body a.workspace-session-link')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/projects/studio/team', '#/sessions/s1']);
  expect(links[0].textContent).toContain('Team chat');
});
