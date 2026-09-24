import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

let dom;
const pubkey = 'a'.repeat(64);
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 1)); };
const state = { projects: [{ id: 'p', content: { slug: 'studio', name: 'Studio', description: 'Build a useful site.' } }],
  milestones: [], todos: [], sessions: [], files: [], columns: [], cards: [], members: [], marketTasks: [] };
function initial() {
  return new Map([['session-one', {
    id: 'session-one', created_at: 1, updated_at: 1, sha256: 'first',
    ciphertext: JSON.stringify({ v: 1, threadKey: 'session-one', metadata: { title: 'Our private plan', pinned: false, project: 'studio' },
      messages: [{ who: 'user', text: 'Make a plan', at: 1 }, { who: 'ai', text: 'Start small.', at: 2 }] }),
  }]]);
}
async function boot(blobs, hash = '#/sessions/session-one') {
  vi.resetModules();
  dom = new JSDOM('<html><body><div id="app"></div></body></html>', { url: 'https://test.invalid/continuum/' + hash, pretendToBeVisual: true });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'navigator', 'HTMLElement', 'StorageEvent']) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  window.__CONTINUUM_AGENT_URL__ = '/agent';
  localStorage.setItem('continuum.session.v1', `1.${Math.floor(Date.now()/1000)+3600}.${pubkey}.1.sig`);
  localStorage.setItem('continuum.v1', JSON.stringify(state));
  window.nostr = { getPublicKey: async () => pubkey, nip44: { encrypt: async (_, t) => t, decrypt: async (_, t) => t } };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const path = String(url).replace(/^.*\/api\//, '/api/');
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/store') return reply({ ok: true, state });
    if (path === '/api/sessions' && opts.method === 'GET') return reply({ ok: true, sessions: [...blobs.values()].map(({ ciphertext, ...rec }) => rec) });
    if (path === '/api/sessions' && opts.method === 'POST') {
      const value = JSON.parse(opts.body), prior = blobs.get(value.id);
      if (value.expected_sha256 !== (prior?.sha256 ?? null)) return reply({ code: 'conflict' }, 409);
      const next = { ...prior, id: value.id, ciphertext: value.ciphertext, sha256: 'sha-' + Math.random(), updated_at: Date.now(), created_at: 1 };
      blobs.set(next.id, next);
      const { ciphertext, ...record } = next;
      return reply({ ok: true, ...record });
    }
    if (path.startsWith('/api/sessions/')) {
      const id = path.slice('/api/sessions/'.length), rec = blobs.get(id);
      if (opts.method === 'DELETE') { blobs.delete(id); return reply({ ok: true }); }
      return rec ? reply({ ok: true, ciphertext: rec.ciphertext, record: rec }) : reply({}, 404);
    }
    if (path === '/api/chat') return reply({ ok: true, reply: 'Here is a useful next step.' });
    return reply({}, 404);
  }));
  await import('./main.js');
  await tick();
}
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const button = name => [...document.querySelectorAll('button')].find(el => el.textContent === name);

test('a real route restores private messages and a pin survives a fresh browser', async () => {
  const blobs = initial();
  await boot(blobs);
  expect(document.querySelector('.route-error')).toBeNull();
  expect(document.querySelector('.workspace-context')).not.toBeNull();
  expect(document.querySelector('.chat-log').textContent).toContain('Start small.');
  button('Pin').click();
  await tick();
  expect(JSON.parse(blobs.get('session-one').ciphertext).metadata.pinned).toBe(true);
  expect(document.querySelector('[data-pinned-history]').textContent).toContain('Our private plan');
  dom.window.close();
  await boot(blobs);
  expect(button('Unpin')).toBeTruthy();
  expect(document.querySelector('.chat-log').textContent).toContain('Start small.');
  expect(localStorage.getItem('continuum.chat.threads')).toBeNull();
});

test('new project conversations have independent IDs and stay attached after reload', async () => {
  const blobs = initial();
  await boot(blobs, '#/projects/studio');
  button('New chat').click();
  await tick();
  const url = window.location.hash;
  expect(url).toMatch(/^#\/sessions\/session-/);
  document.querySelector('.chat-input').value = 'Create an invitation';
  document.querySelector('.chat-send').click();
  await tick();
  expect(blobs.size).toBe(2);
  const value = JSON.parse(blobs.get(url.split('/').pop()).ciphertext);
  expect(value.metadata.project).toBe('studio');
  expect(value.messages.some(m => m.text === 'Here is a useful next step.')).toBe(true);
  expect(value.messages.some(m => m.text === 'Make a plan')).toBe(false);
  dom.window.close();
  await boot(blobs, url);
  expect(document.querySelector('.workspace-header h1').textContent).toBe('Studio');
  expect(document.querySelector('.chat-log').textContent).toContain('Create an invitation');
});

test('settings stay in the upward profile menu and history searches private titles', async () => {
  const blobs = initial();
  await boot(blobs, '#/sessions');
  const profile = document.querySelector('.profile-menu');
  expect(profile.querySelector('[data-path="/routstr"]')).not.toBeNull();
  expect(document.querySelector('.workspace-nav-scroll [data-path="/routstr"]')).toBeNull();
  const search = document.querySelector('.history-search');
  search.value = 'missing'; search.dispatchEvent(new window.Event('input'));
  expect(document.querySelectorAll('.session-row')).toHaveLength(0);
  search.value = 'private'; search.dispatchEvent(new window.Event('input'));
  expect(document.querySelectorAll('.session-row')).toHaveLength(1);
  document.querySelector('.session-row a').click();
  await tick();
  expect(document.querySelector('.workspace-chat')).not.toBeNull();
});
