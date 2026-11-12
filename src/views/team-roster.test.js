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

async function boot({ data = stored, signer, put, demo = false, people, inv, frame } = {}) {
  vi.resetModules();
  vi.doUnmock('../lib/teams-frame.js');
  if (frame) vi.doMock('../lib/teams-frame.js', async (orig) => ({ ...(await orig()), ...frame }));
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
  expect(document.body.textContent).toContain('3 people on this project');
  expect(document.body.textContent).toContain('Members');
  expect(document.body.textContent).not.toMatch(/roster/i);
});

test('add person: one step adds, signs a newer kind-30098 and PUTs it', async () => {
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
  expect(signEvent).toHaveBeenCalledTimes(1); // picked → signed straight away
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

test('rows show display name, NIP-05 and the Teams avatar colour, never a raw npub input', async () => {
  await boot({ signer: null });
  const row = document.querySelector('.team-roster-row');
  expect(row.querySelector('input')).toBeNull();
  expect(row.querySelector('.person-name').textContent).toBe('Bob Builder');
  expect(row.textContent).toContain('bob@example.com');
  const face = row.querySelector('.person-avatar');
  expect(face.textContent).toBe('');
  expect(face.style.background).toMatch(/rgb\(187, 187, 187\)|#bbbbbb/); // Teams: #<first 6 hex>
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
  button('Save changes').click();
  await tick();
  expect(signEvent).not.toHaveBeenCalled();
  expect(api.putProjectRoster).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('agent-of must be a listed person');
});

test('no signer: says so and never calls the agent', async () => {
  const { api } = await boot({ signer: null });
  button('Save changes').click();
  await tick();
  expect(document.body.textContent).toContain('No Nostr signer found');
  expect(api.putProjectRoster).not.toHaveBeenCalled();
});

test('a 409 from the agent reloads the newer roster', async () => {
  const put = vi.fn(async () => ({ ok: false, status: 409, reason: 'stale' }));
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const { api } = await boot({ signer: { signEvent }, put });
  button('Save changes').click();
  await tick();
  expect(api.projectRoster).toHaveBeenCalledTimes(3); // load, re-read before signing, reload
  expect(document.body.textContent).toContain('The member list changed elsewhere');
});

test('demo mode never loads or signs; Save changes goes to login', async () => {
  const signEvent = vi.fn();
  const { api, onDemo } = await boot({ signer: { signEvent }, demo: true });
  expect(api.projectRoster).not.toHaveBeenCalled();
  button('Save changes').click();
  expect(onDemo).toHaveBeenCalled();
  expect(signEvent).not.toHaveBeenCalled();
});

test('Team page: no chat frame, and Open chat goes to the project Team tab', async () => {
  await boot();
  expect(document.querySelector('iframe')).toBeNull();
  const a = document.querySelector('a.team-open-chat');
  expect(a.textContent).toBe('Open chat');
  expect(a.getAttribute('href')).toBe('#/projects/studio/team');
});

test('demo Team page: no Open chat link', async () => {
  await boot({ demo: true });
  expect(document.querySelector('a.team-open-chat')).toBeNull();
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

test('invites: Copy group link (ask me first) fills the team, copies it and shows it once', async () => {
  const inv = inviteApi();
  const writeText = vi.fn(async () => {});
  await boot({ signer: null, inv });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  button('Copy group link').click();
  await tick();
  expect(inv.createInvite).toHaveBeenCalledWith('studio', { kind: 'open', uses: 10 }); // 12 minus owner and Bob (agents do not count)
  expect(writeText).toHaveBeenCalledWith(URL1);
  expect(document.querySelector('.team-invite-shown input').value).toBe(URL1);
  expect(document.body.textContent).toContain('Link copied');
  expect(document.body.textContent).toContain('Shown once');
  // A QR to scan with a phone (ADR 0012 §1), drawn on demand.
  button('Show QR').click();
  expect(document.querySelector('.team-invite-shown .invite-qr')).not.toBeNull();
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
  expect(rows[1].textContent).not.toContain('Copy invite link'); // agents get no link
  [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Copy invite link').click();
  await tick();
  expect(create).toHaveBeenCalledWith('studio', { kind: 'named', pubkey: BOB });
  expect(document.body.textContent).toContain('Install Torii Teams');
});

test('invites: Let in adds the person, signs the roster once, then approves', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const inv = inviteApi({ invites: [{ id: 'AAAAAAAAAAAAAAAA', kind: 'open', role: 'viewer', expires_at: 1_900_604_800, uses_left: 1, requests: [{ pubkey: NEW, at: 1 }] }] });
  const { api } = await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, inv });
  expect(document.querySelector('.team-invite-waiting').textContent).toContain('Someone wants to join');
  // Waiting requests sit above the member rows.
  const order = document.querySelector('.team-invite-waiting').compareDocumentPosition(document.querySelector('.team-roster-body'));
  expect(order & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  expect(document.querySelector('.team-invite-live').textContent).toContain('asks you first, 2 more people');
  [...document.querySelectorAll('.team-invite-live button')].find((b) => b.textContent === 'Stop').click();
  await tick();
  expect(inv.revokeInvite).toHaveBeenCalledWith('studio', 'AAAAAAAAAAAAAAAA');
  expect(signEvent).not.toHaveBeenCalled();
});

test('invites: hidden in demo mode', async () => {
  await boot({ demo: true, inv: inviteApi() });
  expect(document.querySelector('.team-invites')).toBeNull();
});

test('invites: a straight-in group link signs one grant for exactly that link', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const inv = inviteApi();
  await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, inv });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  const mode = document.querySelector('select[aria-label="When someone opens the link"]');
  mode.value = 'auto';
  mode.dispatchEvent(new dom.window.Event('change'));
  expect(document.querySelector('.team-invites').textContent).toContain('even if it is forwarded');
  button('Copy group link').click();
  await tick();
  expect(signEvent).toHaveBeenCalledTimes(1);
  const g = signEvent.mock.calls[0][0];
  expect(g.kind).toBe(27098);
  expect(g.content).toBe('');
  const tag = (n) => g.tags.find((t) => t[0] === n)?.[1];
  expect(tag('project')).toBe('studio');
  expect(tag('invite')).toMatch(/^[A-Za-z0-9_-]{16}$/);
  expect(tag('role')).toBe('contributor');
  expect(tag('uses')).toBe('10');
  expect(Number(tag('expiration'))).toBe(1_900_000_000 + 7 * 86400);
  expect(inv.createInvite).toHaveBeenCalledWith('studio', { kind: 'open', auto: true, grant: expect.objectContaining({ sig: 'e'.repeat(128) }) });
});

test('invites: no grant, no link when the signer refuses', async () => {
  const signEvent = vi.fn(async () => { throw new Error('nope'); });
  const inv = inviteApi();
  await boot({ signer: { signEvent }, inv });
  const mode = document.querySelector('select[aria-label="When someone opens the link"]');
  mode.value = 'auto';
  mode.dispatchEvent(new dom.window.Event('change'));
  button('Copy group link').click();
  await tick();
  expect(inv.createInvite).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Signing cancelled');
});

test('members: people a straight-in link admitted show as joined by link and stay at the next save', async () => {
  const LATE = hex('e');
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const withNew = { ...stored, roster: { ...stored.roster, members: [...stored.roster.members, { pubkey: NEW, role: 'contributor', via: 'invite' }] } };
  const { api } = await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, data: withNew });
  expect([...document.querySelectorAll('.team-roster-row')].some((r) => r.textContent.includes('Joined by link'))).toBe(true);
  // Someone else joins by link after the page loaded; the save keeps both.
  api.projectRoster.mockResolvedValue({ ok: true, data: { ...withNew, roster: { ...withNew.roster, members: [...withNew.roster.members, { pubkey: LATE, role: 'contributor', via: 'invite' }] } } });
  button('Save changes').click();
  await tick();
  const tags = signEvent.mock.calls[0][0].tags;
  expect(tags).toContainEqual(['p', NEW, 'contributor']);
  expect(tags).toContainEqual(['p', LATE, 'contributor']);
});

test('members: removing someone who joined by link keeps them removed at save', async () => {
  const signEvent = vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) }));
  const withNew = { ...stored, roster: { ...stored.roster, members: [...stored.roster.members, { pubkey: NEW, role: 'contributor', via: 'invite' }] } };
  await boot({ signer: { signEvent, getPublicKey: async () => OWNER }, data: withNew });
  const row = [...document.querySelectorAll('.team-roster-row')].find((r) => r.textContent.includes('Joined by link'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
  button('Save changes').click();
  await tick();
  expect(signEvent.mock.calls[0][0].tags.some((t) => t[1] === NEW)).toBe(false);
});

// ADR 0015: after a removal, wait for the owner's own Teams to confirm.
const putFromTags = vi.fn(async (_slug, event) => ({ ok: true, data: { roster: { ...stored.roster, created_at: event.created_at, members: [{ pubkey: OWNER, role: 'owner' }, ...event.tags.filter((t) => t[0] === 'p').map((t) => ({ pubkey: t[1], role: t[2] }))] } } }));
const signer = () => ({ signEvent: vi.fn(async (e) => ({ ...e, pubkey: OWNER, id: 'f'.repeat(64), sig: 'e'.repeat(128) })), getPublicKey: async () => OWNER });
function removeBob() {
  const row = [...document.querySelectorAll('.team-roster-row')].find((r) => r.textContent.includes('Bob Builder'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
  button('Save changes').click();
}
const noBot = { ...stored, roster: { ...stored.roster, members: [{ pubkey: OWNER, role: 'owner' }, { pubkey: BOB, role: 'maintainer' }, { pubkey: NEW, role: 'contributor' }] } };
async function removal(answer, { running = true } = {}) {
  let resolve;
  const waitForRosterSynced = vi.fn(() => new Promise((r) => { resolve = r; }));
  await boot({ data: noBot, signer: signer(), put: putFromTags, frame: { teamsFrameRunning: () => running, waitForRosterSynced } });
  const order = [];
  window.addEventListener('continuum:roster-changed', () => order.push(waitForRosterSynced.mock.calls.length));
  const guards = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((t, fn, o) => { if (t === 'beforeunload') guards.push(fn); return add(t, fn, o); });
  removeBob();
  await tick();
  return { waitForRosterSynced, order, guards, finish: async () => { resolve?.(answer); await tick(); } };
}

test('removal: shows Taking out, then out of the chat when Teams answers left 0', async () => {
  const { waitForRosterSynced, order, guards, finish } = await removal({ left: 0, error: false });
  expect(waitForRosterSynced).toHaveBeenCalledWith('studio');
  expect(order).toEqual([1]); // waiting before the frame is told
  expect(document.body.textContent).toContain('Saved. Taking Bob Builder out of the chat\u2026');
  expect(guards.length).toBe(1);
  const ev = new dom.window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
  await finish();
  expect(document.body.textContent).toContain('Saved. Bob Builder is out of the chat.');
  const later = new dom.window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

for (const [name, answer] of [['still in', { left: 1, error: false }], ['an error', { left: 0, error: true }], ['no answer', null]]) {
  test(`removal: ${name} gives the fallback wording`, async () => {
    const { finish } = await removal(answer);
    await finish();
    expect(document.body.textContent).toContain('Saved. Bob Builder can\u2019t sign in any more. Teams finishes taking them out of the chat the next time you or a teammate opens it.');
  });
}

test('removal: two people are counted, not named', async () => {
  let resolve;
  const waitForRosterSynced = vi.fn(() => new Promise((r) => { resolve = r; }));
  await boot({ data: noBot, signer: signer(), put: putFromTags, frame: { teamsFrameRunning: () => true, waitForRosterSynced } });
  for (let i = 0; i < 2; i++) {
    const row = document.querySelector('.team-roster-row');
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
  }
  button('Save changes').click();
  await tick();
  expect(document.body.textContent).toContain('Saved. Taking 2 people out of the chat\u2026');
  resolve({ left: 0, error: false });
  await tick();
  expect(document.body.textContent).toContain('Saved. 2 people are out of the chat.');
});

test('removal: no frame running, or nobody removed, means no wait', async () => {
  const { waitForRosterSynced, guards } = await removal(null, { running: false });
  expect(waitForRosterSynced).not.toHaveBeenCalled();
  expect(guards.length).toBe(0);
  expect(document.body.textContent).toContain('Saved. 2 people on this project.');
});
