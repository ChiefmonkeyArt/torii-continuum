import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { toNpub } from '../lib/npub.js';

const hex = (c) => c.repeat(64);
const OWNER = hex('a');
const BOB = hex('b');
let dom;
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1)); };
const button = (name) => [...document.querySelectorAll('button')].find((el) => el.textContent === name);
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function boot({ signer, put } = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/projects' });
  for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
  const api = {
    putProjectRoster: put || vi.fn(async (_s, event) => ({ ok: true, data: { roster: { members: [], created_at: event.created_at } } })),
    peopleSearch: vi.fn(async () => ({ ok: true, data: { results: [{ pubkey: BOB, name: 'bob', display_name: 'Bob', nip05: '', avatar: false }] } })),
  };
  const navigate = vi.fn();
  const { openTeamChatSetup, TEAM_CHAT_PROJECT_KEY } = await import('./team-chat-setup.js');
  openTeamChatSetup({ project: { slug: 'studio', name: 'Studio' }, api, navigate, signer: () => signer, now: () => 1_900_000_000, ownerNpub: () => toNpub(OWNER) });
  return { api, navigate, KEY: TEAM_CHAT_PROJECT_KEY };
}

test('new project: invite a teammate, sign the roster, open the project chat', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { api, navigate, KEY } = await boot({ signer: { signEvent } });
  expect(document.querySelector('.modal h3').textContent).toBe('Team chat for Studio');
  const input = document.querySelector('.people-picker input');
  input.value = 'bob';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await tick();
  document.querySelector('.people-result').click();
  expect(document.querySelector('.team-setup-picked').textContent).toContain('Bob');
  button('Create chat').click();
  await tick();
  expect(signEvent.mock.calls[0][0].tags).toEqual([['d', 'studio'], ['p', BOB, 'contributor']]);
  expect(api.putProjectRoster).toHaveBeenCalled();
  expect(sessionStorage.getItem(KEY)).toBe('studio');
  expect(navigate).toHaveBeenCalledWith('/team');
  expect(document.querySelector('.modal')).toBeNull();
});

test('new project: Create chat with nobody picked signs an owner-only roster; Skip changes nothing', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { navigate } = await boot({ signer: { signEvent } });
  button('Create chat').click();
  await tick();
  expect(signEvent.mock.calls[0][0].tags).toEqual([['d', 'studio']]);
  expect(navigate).toHaveBeenCalledWith('/team');

  const second = await boot({ signer: { signEvent: vi.fn() } });
  button('Skip for now').click();
  expect(second.api.putProjectRoster).not.toHaveBeenCalled();
  expect(second.navigate).not.toHaveBeenCalled();
  expect(document.querySelector('.modal')).toBeNull();
});

test('new project: no signer or an existing roster keeps the dialog open with a reason', async () => {
  await boot({ signer: null });
  button('Create chat').click();
  await tick();
  expect(document.body.textContent).toContain('No Nostr signer found');
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { navigate } = await boot({ signer: { signEvent }, put: vi.fn(async () => ({ ok: false, status: 409 })) });
  button('Create chat').click();
  await tick();
  expect(document.body.textContent).toContain('already has members');
  expect(navigate).not.toHaveBeenCalled();
});
