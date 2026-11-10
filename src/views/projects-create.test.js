// docs/adr-project-team-chat.md §1: a new project opens its Team tab when Teams is on.
import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1)); };

async function create(me) {
  vi.resetModules();
  const dom = new JSDOM('<main></main>', { url: 'https://test.invalid/#/projects' });
  for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
  const navigate = vi.fn();
  vi.doMock('../router.js', () => ({ navigate }));
  vi.doMock('../chat.js', () => ({ setChatContext: vi.fn() }));
  vi.doMock('../shell.js', () => ({ renderSidebar: vi.fn() }));
  vi.doMock('../data/agent.js', () => ({ teamMe: vi.fn(async () => me) }));
  vi.doMock('../data/store.js', () => ({
    listProjects: () => [],
    createProject: ({ name }) => ({ content: { slug: name.toLowerCase(), name } }),
  }));
  const { renderProjects } = await import('./projects.js');
  renderProjects(document.querySelector('main'));
  [...document.querySelectorAll('button')].find((b) => b.textContent === '+ New project').click();
  document.querySelector('.modal input[type="text"]').value = 'Studio';
  [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Create project').click();
  await tick();
  const { takeNewProject } = await import('../lib/team-nav.js');
  return { navigate, fresh: takeNewProject('studio') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const m of ['../router.js', '../chat.js', '../shell.js', '../data/agent.js', '../data/store.js']) vi.doUnmock(m);
});

test('owner with Teams: the new project opens on its Team tab, marked new', async () => {
  const { navigate, fresh } = await create({ ok: true, data: { owner: true, teams_app_url: 'https://teams.example.org/' } });
  expect(navigate).toHaveBeenCalledWith('/projects/studio/team');
  expect(fresh).toBe(true);
});

test('no Teams on the node: the new project opens as before, not marked', async () => {
  const { navigate, fresh } = await create({ ok: true, data: { owner: true, teams_app_url: null } });
  expect(navigate).toHaveBeenCalledWith('/projects/studio');
  expect(fresh).toBe(false);
});

test('agent offline: the new project still opens', async () => {
  const { navigate } = await create(null);
  expect(navigate).toHaveBeenCalledWith('/projects/studio');
});
