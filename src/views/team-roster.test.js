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

const profiles = { [BOB]: { name: 'bob', display_name: 'Bob Builder', nip05: 'bob@example.com', avatar: true } };

async function boot({ data = stored, signer, put, demo = false, people, inv } = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/team' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'MutationObserver']) vi.stubGlobal(key, dom.window[key]);
  const api = {
    peopleSearch: vi.fn(async () => ({ ok: true, data: { results: people || [] } })),
    teamProfiles: vi.fn(async (list) => ({ ok: true, data: { profiles: Object.fromEntries(list.map((x) => [x, profiles[x] || { name: '', display_name: '', nip05: '', avatar: false }])) } })),
    teamAvatarBlob: vi.fn(async () => null),
    projectRoster: vi.fn(async () => ({ ok: true, data })),
    putProjectRoster: put || vi.fn(async (_slug, event) => ({ ok: true, data: { roster: { ...stored.roster, created_at: event.created_at } } })),
    ...(inv || {}),
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
  const dispatched = [];
  const { api } = await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, people: [{ pubkey: NEW, name: 'dan', display_name: 'Dan', nip05: '', avatar: false }] });
  window.addEventListener('continuum:roster-changed', (e) => dispatched.push(e.detail));
  button('Add person').click();
  const search = document.querySelector('.people-picker input');
  search.value = 'dan';
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await tick();
  expect(api.peopleSearch).toHaveBeenCalledWith('dan');
  const hit = document.querySelector('.people-result');
  expect(hit.textContent).toContain('Dan');
  hit.click();
  await tick();
  expect(document.querySelectorAll('.team-roster-row').length).toBe(3);
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
  expect(dispatched).toEqual([{ slug: 'studio' }]);
});

test('rows show display name, NIP-05 and avatar initials, never a raw npub input', async () => {
  await boot({ signer: null });
  const row = document.querySelector('.team-roster-row');
  expect(row.querySelector('input')).toBeNull();
  expect(row.querySelector('.person-name').textContent).toBe('Bob Builder');
  expect(row.textContent).toContain('bob@example.com');
  expect(row.querySelector('.person-avatar').textContent).toBe('B');
  // Unnamed people fall back to a short npub, not the full key.
  const bot = document.querySelectorAll('.team-roster-row')[1];
  expect(bot.querySelector('.person-name').textContent).toMatch(/^npub1.+…/);
});

test('people search excludes the owner and people already listed', async () => {
  await boot({ signer: null, people: [
    { pubkey: OWNER, name: 'me' }, { pubkey: BOB, name: 'bob' }, { pubkey: NEW, name: 'dan', avatar: false },
  ] });
  button('Add person').click();
  const search = document.querySelector('.people-picker input');
  search.value = 'x';
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await tick();
  expect(document.querySelectorAll('.people-result').length).toBe(0, 'one character does not search');
  search.value = 'any';
  search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  await tick();
  expect([...document.querySelectorAll('.people-result')].map((b) => b.textContent)).toEqual([expect.stringContaining('dan')]);
});

test('Teams status: in the chat, being added, or not opened yet', async () => {
  const { teamsStatus } = await import('./team-roster.js');
  const teams = { chat: { group_id: 'g', claimed: false }, ready: [BOB, NEW], added: [BOB] };
  expect(teamsStatus(teams, BOB).label).toBe('In the chat');
  expect(teamsStatus(teams, NEW).label).toBe('Opened Teams, being added');
  expect(teamsStatus(teams, BOT).label).toBe('Hasn\u2019t opened Teams yet');
  expect(teamsStatus({ chat: null, ready: [NEW], added: [] }, NEW).label).toBe('Opened Teams');
  expect(teamsStatus(null, BOB)).toBeNull();
  await boot({ signer: null, data: { ...stored, teams } });
  expect(document.querySelector('.team-roster-row .team-status').textContent).toBe('In the chat');
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

test('team chat: embedded only for an https origin, with a full-window fallback', async () => {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/team' });
  for (const key of ['window', 'document']) vi.stubGlobal(key, dom.window[key]);
  const { renderTeamChatLink, safeAppOrigin } = await import('./team-roster.js');
  const shown = renderTeamChatLink({ teamMe: async () => ({ ok: true, data: { teams_app_url: 'https://teams.example.org' } }) });
  const none = renderTeamChatLink({ teamMe: async () => ({ ok: true, data: { teams_app_url: null } }) });
  const evil = renderTeamChatLink({ teamMe: async () => ({ ok: true, data: { teams_app_url: 'javascript:alert(1)' } }) });
  const down = renderTeamChatLink({ teamMe: async () => ({ ok: false, offline: true }) });
  const threw = renderTeamChatLink({ teamMe: async () => { throw new Error('x'); } });
  await tick();
  const f = shown.querySelector('iframe');
  expect(f.getAttribute('src')).toBe('https://teams.example.org/chat?embed=1');
  expect(f.getAttribute('allow')).toBe('clipboard-write');
  expect(f.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
  const a = shown.querySelector('a');
  expect(a.textContent).toBe('Open in full window');
  expect(a.getAttribute('href')).toBe('https://teams.example.org/chat');
  expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  expect(a.getAttribute('target')).toBe('_blank');
  for (const el of [none, evil, down, threw]) { expect(el.querySelector('a')).toBeNull(); expect(el.querySelector('iframe')).toBeNull(); }
  expect(safeAppOrigin('http://teams.example.org')).toBeNull();
  expect(safeAppOrigin('https://u:p@teams.example.org')).toBeNull();
});

test('team chat: opens a project chat on request and forwards roster changes to the exact Teams origin', async () => {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/team' });
  for (const key of ['window', 'document', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
  const { renderTeamChatLink } = await import('./team-roster.js');
  const slot = renderTeamChatLink({ teamMe: async () => ({ ok: true, data: { teams_app_url: 'https://teams.example.org' } }) }, { projectSlug: 'studio' });
  const bad = renderTeamChatLink({ teamMe: async () => ({ ok: true, data: { teams_app_url: 'https://teams.example.org' } }) }, { projectSlug: '../x' });
  document.querySelector('main').append(slot, bad);
  await tick();
  const f = slot.querySelector('iframe');
  expect(f.getAttribute('src')).toBe('https://teams.example.org/chat/p/studio?embed=1');
  expect(slot.querySelector('a').getAttribute('href')).toBe('https://teams.example.org/chat/p/studio');
  expect(bad.querySelector('iframe').getAttribute('src')).toBe('https://teams.example.org/chat?embed=1');
  const post = vi.fn();
  Object.defineProperty(f, 'contentWindow', { value: { postMessage: post } });
  window.dispatchEvent(new CustomEvent('continuum:roster-changed', { detail: { slug: 'studio' } }));
  expect(post).toHaveBeenCalledWith({ type: 'torii:roster-changed', slug: 'studio' }, 'https://teams.example.org');
});

test('team chat: hands the owner session only to the exact Teams frame, origin and pubkey', async () => {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/team' });
  for (const key of ['window', 'document', 'CustomEvent', 'MessageEvent']) vi.stubGlobal(key, dom.window[key]);
  const { renderTeamChatLink } = await import('./team-roster.js');
  const teamHandoff = vi.fn(async () => ({ ok: true, data: { token: 'm2.t', expires_at: 9, pubkey: OWNER } }));
  const me = (owner) => async () => ({ ok: true, data: { teams_app_url: 'https://teams.example.org', pubkey: OWNER, owner } });
  const slot = renderTeamChatLink({ teamMe: me(true), teamHandoff });
  const member = renderTeamChatLink({ teamMe: me(false), teamHandoff });
  document.querySelector('main').append(slot, member);
  await tick();
  const post = vi.fn();
  const win = { postMessage: post };
  Object.defineProperty(slot.querySelector('iframe'), 'contentWindow', { value: win });
  Object.defineProperty(member.querySelector('iframe'), 'contentWindow', { value: { postMessage: vi.fn() } });
  const ask = (data, origin, source) => window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin, source }));
  const req = { type: 'torii:session-request', pubkey: OWNER };
  ask(req, 'https://evil.example', win);
  ask(req, 'https://teams.example.org', window);
  ask({ ...req, pubkey: BOB }, 'https://teams.example.org', win);
  ask({ type: 'other', pubkey: OWNER }, 'https://teams.example.org', win);
  await tick();
  expect(teamHandoff).not.toHaveBeenCalled();
  ask(req, 'https://teams.example.org', win);
  await tick();
  expect(teamHandoff).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ type: 'torii:session', token: 'm2.t', expires_at: 9, pubkey: OWNER }, 'https://teams.example.org');
  // The member view's frame never triggers a handoff.
  ask(req, 'https://teams.example.org', member.querySelector('iframe').contentWindow);
  await tick();
  expect(teamHandoff).toHaveBeenCalledTimes(1);
});

// ── invite links (Teams ADR 0009) ───────────────────────────────────────

const URL1 = 'https://teams.example.test/chat/join/AAAAAAAAAAAAAAAA#SSSSSSSSSSSSSSSSSSSSSS';
function inviteApi({ invites = [], create } = {}) {
  return {
    createInvite: create || vi.fn(async () => ({ ok: true, data: { id: 'AAAAAAAAAAAAAAAA', url: URL1, expires_at: 1_900_604_800 } })),
    listInvites: vi.fn(async () => ({ ok: true, data: { invites } })),
    revokeInvite: vi.fn(async () => ({ ok: true, data: { ok: true } })),
    decideInvite: vi.fn(async () => ({ ok: true, data: { ok: true } })),
    pendingInvites: vi.fn(async () => ({ ok: true, data: { pending: { studio: invites.reduce((n, i) => n + i.requests.length, 0) } } })),
  };
}

test('invites: Copy invite link makes an open link, copies it and shows it once', async () => {
  const inv = inviteApi();
  const writeText = vi.fn(async () => {});
  await boot({ signer: null, inv });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  button('Copy invite link').click();
  await tick();
  expect(inv.createInvite).toHaveBeenCalledWith('studio', { kind: 'open' });
  expect(writeText).toHaveBeenCalledWith(URL1);
  expect(document.querySelector('.team-invite-shown input').value).toBe(URL1);
  expect(document.body.textContent).toContain('Link copied');
  expect(document.body.textContent).toContain('Shown once');
  // Switching project forgets the shown link.
  document.querySelector('select[aria-label="Project"]').dispatchEvent(new dom.window.Event('change'));
  await tick();
  expect(document.querySelector('.team-invite-shown')).toBeNull();
});

test('invites: named link per listed person; friendly refusal when Teams is missing', async () => {
  const create = vi.fn(async () => ({ ok: false, status: 409, reason: 'x', data: { code: 'no_teams_app' } }));
  const inv = inviteApi({ create });
  await boot({ signer: null, inv });
  const rows = document.querySelectorAll('.team-roster-row');
  expect(rows[1].textContent).not.toContain('Copy link'); // agents get no link
  [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Copy link').click();
  await tick();
  expect(create).toHaveBeenCalledWith('studio', { kind: 'named', pubkey: BOB });
  expect(document.body.textContent).toContain('Install Torii Teams');
});

test('invites: Let in adds the person, signs the roster once, then approves', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const inv = inviteApi({ invites: [{ id: 'AAAAAAAAAAAAAAAA', kind: 'open', role: 'viewer', expires_at: 1_900_604_800, uses_left: 1, requests: [{ pubkey: NEW, at: 1 }] }] });
  const { api } = await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, inv });
  expect(document.querySelector('.team-invite-request').textContent).toContain('Wants to join');
  expect(document.querySelector('select[aria-label="Project"]').options[0].textContent).toBe('Studio (1 waiting)');
  [...document.querySelectorAll('.team-invite-request button')].find((b) => b.textContent === 'Let in').click();
  await tick();
  expect(signEvent).toHaveBeenCalledTimes(1);
  expect(signEvent.mock.calls[0][0].tags).toContainEqual(['p', NEW, 'viewer']);
  expect(api.putProjectRoster).toHaveBeenCalledTimes(1);
  expect(inv.decideInvite).toHaveBeenCalledWith('studio', 'AAAAAAAAAAAAAAAA', NEW, true);
  expect(api.putProjectRoster.mock.invocationCallOrder[0]).toBeLessThan(inv.decideInvite.mock.invocationCallOrder[0]);
});

test('invites: no approval when the roster signature fails; Decline and Stop need no signer', async () => {
  const signEvent = vi.fn(async () => { throw new Error('user rejected'); });
  const inv = inviteApi({ invites: [{ id: 'AAAAAAAAAAAAAAAA', kind: 'open', role: 'contributor', expires_at: 1_900_604_800, uses_left: 2, requests: [{ pubkey: NEW, at: 1 }] }] });
  await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, inv });
  const reqBtn = (name) => [...document.querySelectorAll('.team-invite-request button')].find((b) => b.textContent === name);
  reqBtn('Let in').click();
  await tick();
  expect(inv.decideInvite).not.toHaveBeenCalled();
  signEvent.mockClear();
  reqBtn('Decline').click();
  await tick();
  expect(inv.decideInvite).toHaveBeenCalledWith('studio', 'AAAAAAAAAAAAAAAA', NEW, false);
  expect(document.querySelector('.team-invite-live').textContent).toContain('2 people');
  [...document.querySelectorAll('.team-invite-live button')].find((b) => b.textContent === 'Stop').click();
  await tick();
  expect(inv.revokeInvite).toHaveBeenCalledWith('studio', 'AAAAAAAAAAAAAAAA');
  expect(signEvent).not.toHaveBeenCalled();
});

test('invites: hidden in demo mode', async () => {
  await boot({ demo: true, inv: inviteApi() });
  expect(document.querySelector('.team-invites')).toBeNull();
});
