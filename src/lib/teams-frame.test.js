// torii-teams ADR 0010: one Teams frame per Continuum page load.
import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

const PK = 'a'.repeat(64);
const ORIGIN = 'https://teams.test.invalid';
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1)); };
let mod;
let dom;

async function boot() {
  vi.resetModules();
  dom = new JSDOM('<main><div id="slot"></div></main>', { url: 'https://continuum.test.invalid/#/team' });
  for (const key of ['window', 'document', 'CustomEvent']) vi.stubGlobal(key, dom.window[key]);
  mod = await import('./teams-frame.js');
  return mod;
}

const me = (over = {}) => ({ ok: true, data: { owner: true, pubkey: PK, teams_app_url: `${ORIGIN}/`, ...over } });
const api = (over = {}) => ({
  teamMe: vi.fn(async () => me()),
  teamHandoff: vi.fn(async () => ({ ok: true, data: { pubkey: PK, token: 'tok', expires_at: 9 } })),
  ...over,
});
const frameOf = () => dom.window.document.querySelector('iframe.team-chat-frame');
function spyPost(frame) {
  const post = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post }, configurable: true });
  return post;
}
function ask(frame, data, origin = ORIGIN, source = frame.contentWindow) {
  const ev = new dom.window.MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  dom.window.dispatchEvent(ev);
}

afterEach(() => { mod?._resetTeamsFrame(); vi.unstubAllGlobals(); });

test('safeAppOrigin keeps https or loopback http only, without credentials', async () => {
  const { safeAppOrigin } = await boot();
  expect(safeAppOrigin('https://teams.x/chat')).toBe('https://teams.x');
  expect(safeAppOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
  expect(safeAppOrigin('http://teams.x/')).toBeNull();
  expect(safeAppOrigin('https://u:p@teams.x/')).toBeNull();
  expect(safeAppOrigin('javascript:alert(1)')).toBeNull();
  expect(safeAppOrigin(7)).toBeNull();
});

test('chatPath allows the list or one well-formed project slug', async () => {
  const { chatPath } = await boot();
  expect(chatPath('studio-2')).toBe('/chat/p/studio-2');
  for (const bad of [null, '', 'Studio', '-a', 'a/b', '../x', 'a'.repeat(49)]) expect(chatPath(bad)).toBe('/chat');
});

test('starts once, hidden and inert, for the owner of a node with Teams', async () => {
  const { startTeamsFrame, teamsOrigin } = await boot();
  const a = api();
  const [one, two] = await Promise.all([startTeamsFrame(a, { doc: dom.window.document, win: dom.window }), startTeamsFrame(a, { doc: dom.window.document, win: dom.window })]);
  expect(one && two).toBe(true);
  expect(a.teamMe).toHaveBeenCalledTimes(1);
  expect(dom.window.document.querySelectorAll('iframe').length).toBe(1);
  const f = frameOf();
  expect(f.getAttribute('src')).toBe(`${ORIGIN}/chat?embed=1`);
  expect(f.getAttribute('aria-hidden')).toBe('true');
  expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(f.inert).toBe(true);
  expect(f.style.visibility).toBe('hidden');
  expect(teamsOrigin()).toBe(ORIGIN);
});

test('no Teams or not the owner: no frame, and teamMe is not asked again', async () => {
  const { startTeamsFrame } = await boot();
  const a = api({ teamMe: vi.fn(async () => me({ owner: false })) });
  expect(await startTeamsFrame(a, { doc: dom.window.document, win: dom.window })).toBe(false);
  expect(await startTeamsFrame(a, { doc: dom.window.document, win: dom.window })).toBe(false);
  expect(a.teamMe).toHaveBeenCalledTimes(1);
  expect(frameOf()).toBeNull();
});

test('a failed teamMe is not cached, so a later start retries', async () => {
  const { startTeamsFrame } = await boot();
  const a = api({ teamMe: vi.fn(async () => ({ ok: false })) });
  expect(await startTeamsFrame(a, { doc: dom.window.document, win: dom.window })).toBe(false);
  await startTeamsFrame(a, { doc: dom.window.document, win: dom.window });
  expect(a.teamMe).toHaveBeenCalledTimes(2);
});

test('session handoff answers only the frame, at its origin, for the same pubkey', async () => {
  const { startTeamsFrame } = await boot();
  const a = api();
  await startTeamsFrame(a, { doc: dom.window.document, win: dom.window });
  const f = frameOf();
  const post = spyPost(f);
  ask(f, { type: 'torii:session-request', pubkey: PK }, 'https://evil.invalid');
  ask(f, { type: 'torii:session-request', pubkey: PK }, ORIGIN, {});
  ask(f, { type: 'torii:session-request', pubkey: 'b'.repeat(64) });
  ask(f, { type: 'other', pubkey: PK });
  await tick();
  expect(a.teamHandoff).not.toHaveBeenCalled();
  ask(f, { type: 'torii:session-request', pubkey: PK });
  await tick();
  expect(a.teamHandoff).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ type: 'torii:session', token: 'tok', expires_at: 9, pubkey: PK }, ORIGIN);
});

test('a handoff for another pubkey is not forwarded', async () => {
  const { startTeamsFrame } = await boot();
  const a = api({ teamHandoff: vi.fn(async () => ({ ok: true, data: { pubkey: 'b'.repeat(64), token: 't' } })) });
  await startTeamsFrame(a, { doc: dom.window.document, win: dom.window });
  const f = frameOf();
  const post = spyPost(f);
  ask(f, { type: 'torii:session-request', pubkey: PK });
  await tick();
  expect(post).not.toHaveBeenCalled();
});

test('relays a saved member list and navigates once loaded', async () => {
  const { startTeamsFrame, navigateTeamsFrame, ROSTER_CHANGED_EVENT } = await boot();
  await startTeamsFrame(api(), { doc: dom.window.document, win: dom.window });
  const f = frameOf();
  // Before load: navigating sets the src instead of messaging.
  navigateTeamsFrame('studio');
  expect(f.getAttribute('src')).toBe(`${ORIGIN}/chat/p/studio?embed=1`);
  f.dispatchEvent(new dom.window.Event('load'));
  const post = spyPost(f);
  dom.window.dispatchEvent(new dom.window.CustomEvent(ROSTER_CHANGED_EVENT, { detail: { slug: 'studio' } }));
  expect(post).toHaveBeenCalledWith({ type: 'torii:roster-changed', slug: 'studio' }, ORIGIN);
  navigateTeamsFrame('Bad Slug');
  expect(post).toHaveBeenLastCalledWith({ type: 'torii:navigate', path: '/chat' }, ORIGIN);
  navigateTeamsFrame('studio');
  expect(post).toHaveBeenLastCalledWith({ type: 'torii:navigate', path: '/chat/p/studio' }, ORIGIN);
});

test('docks over the slot, then hides again when the slot leaves the page', async () => {
  const { startTeamsFrame, dockTeamsFrame } = await boot();
  const raf = [];
  dom.window.requestAnimationFrame = (fn) => { raf.push(fn); return raf.length; };
  dom.window.cancelAnimationFrame = () => {};
  await startTeamsFrame(api(), { doc: dom.window.document, win: dom.window });
  const f = frameOf();
  const slot = dom.window.document.getElementById('slot');
  expect(dockTeamsFrame(slot)).toBe(true);
  expect(f.inert).toBe(false);
  expect(f.hasAttribute('aria-hidden')).toBe(false);
  expect(f.style.position).toBe('fixed');
  expect(f.style.visibility).not.toBe('hidden');
  slot.remove();
  raf.shift()();
  expect(f.inert).toBe(true);
  expect(f.getAttribute('aria-hidden')).toBe('true');
  expect(f.style.visibility).toBe('hidden');
});

test('dock without a frame reports false; stop removes the frame and listeners', async () => {
  const { startTeamsFrame, dockTeamsFrame, stopTeamsFrame, teamsOrigin } = await boot();
  expect(dockTeamsFrame(dom.window.document.getElementById('slot'))).toBe(false);
  const a = api();
  await startTeamsFrame(a, { doc: dom.window.document, win: dom.window });
  const f = frameOf();
  stopTeamsFrame();
  expect(frameOf()).toBeNull();
  expect(teamsOrigin()).toBeNull();
  ask(f, { type: 'torii:session-request', pubkey: PK });
  await tick();
  expect(a.teamHandoff).not.toHaveBeenCalled();
});
