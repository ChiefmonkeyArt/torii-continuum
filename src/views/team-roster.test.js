import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { toNpub } from '../lib/npub.js';
import { rosterRows, ROSTER_KIND } from '../lib/roster.js';

const hex = (c) => c.repeat(64);
const OWNER = hex('a');
const BOB = hex('b');
const BOT = hex('c');
const NEW = hex('d');
let dom;
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1)); };
const stored = {
  roster: {
    slug: 'studio', owner: OWNER, created_at: 2_000_000_000, id: 'x',
    members: [{ pubkey: OWNER, role: 'owner' }, { pubkey: BOB, role: 'maintainer' }, { pubkey: BOT, role: 'agent', of: BOB }],
  },
  event: null,
};

async function boot({ data = stored, signer, put, demo = false } = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/team' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'MutationObserver']) vi.stubGlobal(key, dom.window[key]);
  const api = {
    projectRoster: vi.fn(async () => ({ ok: true, data })),
    putProjectRoster: put || vi.fn(async (_slug, event) => ({ ok: true, data: { roster: { ...stored.roster, created_at: event.created_at } } })),
  };
  const onDemo = vi.fn();
  const { renderProjectRosters } = await import('./team-roster.js');
  const el = renderProjectRosters({
    api, demo, onDemo,
    projects: () => [{ content: { slug: 'studio', name: 'Studio' } }],
    signer: () => signer,
    now: () => 1_900_000_000,
    ownerNpub: () => toNpub(OWNER),
  });
  document.querySelector('main').appendChild(el);
  await tick();
  return { api, onDemo };
}
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const button = (name) => [...document.querySelectorAll('button')].find((el) => el.textContent === name);

test('rosterRows round-trips stored members to editable rows (owner implicit)', () => {
  expect(rosterRows(null)).toEqual([]);
  expect(rosterRows(stored.roster)).toEqual([
    { npub: toNpub(BOB), role: 'maintainer' },
    { npub: toNpub(BOT), role: 'agent', of: toNpub(BOB) },
  ]);
});

test('loads the roster and shows one row per non-owner member', async () => {
  const { api } = await boot({ signer: null });
  expect(api.projectRoster).toHaveBeenCalledWith('studio');
  expect(document.querySelectorAll('.team-roster-row').length).toBe(2);
  expect(document.body.textContent).toContain('3 on the team');
});

test('sign and save: adds a person, signs a newer kind-30098 and PUTs it', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { api } = await boot({ signer: { signEvent, getPublicKey: async () => OWNER } });
  button('Add person').click();
  const inputs = document.querySelectorAll('.team-roster-row input');
  const last = inputs[inputs.length - 1];
  last.value = toNpub(NEW);
  last.dispatchEvent(new dom.window.Event('input'));
  button('Sign and save').click();
  await tick();
  expect(signEvent).toHaveBeenCalledTimes(1);
  const built = signEvent.mock.calls[0][0];
  expect(built.kind).toBe(ROSTER_KIND);
  // Must be newer than the stored roster even if the clock is behind it.
  expect(built.created_at).toBe(stored.roster.created_at + 1);
  expect(built.tags).toContainEqual(['d', 'studio']);
  expect(built.tags).toContainEqual(['p', NEW, 'contributor']);
  expect(built.tags).toContainEqual(['p', BOT, 'agent', BOB]);
  expect(built.tags.some((t) => t[1] === OWNER)).toBe(false);
  expect(api.putProjectRoster).toHaveBeenCalledWith('studio', expect.objectContaining({ sig: 'e'.repeat(128) }));
  expect(document.body.textContent).toContain('Saved.');
});

test('removing a person drops them, and their agent fails before the signer prompt', async () => {
  const signEvent = vi.fn();
  const { api } = await boot({ signer: { signEvent } });
  document.querySelector('.team-roster-row button').click(); // remove Bob
  button('Sign and save').click();
  await tick();
  expect(signEvent).not.toHaveBeenCalled();
  expect(api.putProjectRoster).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('agent-of must be a listed person');
});

test('no signer: says so and never calls the agent', async () => {
  const { api } = await boot({ signer: null });
  button('Sign and save').click();
  await tick();
  expect(document.body.textContent).toContain('No Nostr signer found');
  expect(api.putProjectRoster).not.toHaveBeenCalled();
});

test('a 409 from the agent reloads the newer roster', async () => {
  const put = vi.fn(async () => ({ ok: false, status: 409, reason: 'stale' }));
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { api } = await boot({ signer: { signEvent }, put });
  button('Sign and save').click();
  await tick();
  expect(api.projectRoster).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('A newer roster was saved elsewhere');
});

test('demo mode never loads or signs; Sign and save goes to login', async () => {
  const signEvent = vi.fn();
  const { api, onDemo } = await boot({ signer: { signEvent }, demo: true });
  expect(api.projectRoster).not.toHaveBeenCalled();
  button('Sign and save').click();
  expect(onDemo).toHaveBeenCalled();
  expect(signEvent).not.toHaveBeenCalled();
});
