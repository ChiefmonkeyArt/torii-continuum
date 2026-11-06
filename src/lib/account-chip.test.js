// torii-teams ADR 0010: the account menu shows the owner's avatar and name,
// and how many people are waiting to join.
import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { toNpub } from './npub.js';

const HEX = 'a'.repeat(64);
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1)); };
let mod;
let dom;

async function boot({ profile = { name: 'olive', display_name: 'Olive', avatar: true } } = {}) {
  vi.resetModules();
  dom = new JSDOM('<nav><button id="t"><span class="profile-avatar">C</span><span data-account-name>Continuum</span></button><a id="w" data-waiting hidden></a></nav>', { url: 'https://continuum.test.invalid/' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'MutationObserver']) vi.stubGlobal(key, dom.window[key]);
  mod = await import('./account-chip.js');
  const deps = {
    ownerNpub: () => toNpub(HEX),
    isOwner: () => true,
    teamProfiles: vi.fn(async (list) => ({ ok: true, data: { profiles: Object.fromEntries(list.map((x) => [x, profile])) } })),
    teamAvatarBlob: vi.fn(async () => null),
    pendingInvites: vi.fn(async () => ({ ok: true, data: { pending: { studio: 2, other: 1 } } })),
  };
  mod.initAccountChip(deps);
  return deps;
}

afterEach(() => { mod?._resetAccountChip(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('paintAccount swaps the letter C for the owner avatar and shows their name', async () => {
  const deps = await boot();
  const t = dom.window.document.getElementById('t');
  mod.paintAccount(t);
  await tick();
  expect(deps.teamProfiles).toHaveBeenCalledWith([HEX]);
  const avatar = t.querySelector('.profile-avatar');
  expect(avatar).not.toBeNull();
  expect(avatar.textContent).not.toBe('C');
  expect(t.querySelector('[data-account-name]').textContent).toBe('Olive');
});

test('paintAccount does nothing without a signed-in owner', async () => {
  const deps = await boot();
  deps.ownerNpub = () => '';
  const t = dom.window.document.getElementById('t');
  mod.paintAccount(t);
  await tick();
  expect(deps.teamProfiles).not.toHaveBeenCalled();
  expect(t.querySelector('.profile-avatar').textContent).toBe('C');
});

test('waiting alert: hidden at zero, counts across projects, opens the first project', async () => {
  const deps = await boot();
  const w = dom.window.document.getElementById('w');
  const onOpen = vi.fn();
  mod.paintWaiting(w, { onOpen });
  expect(w.hidden).toBe(true);
  expect(await mod.refreshWaiting()).toBe(3);
  expect(w.hidden).toBe(false);
  expect(w.textContent).toBe('3 people waiting to join');
  w.click();
  expect(onOpen).toHaveBeenCalledWith('studio');
  deps.pendingInvites.mockResolvedValueOnce({ ok: true, data: { pending: { studio: 1 } } });
  await mod.refreshWaiting();
  expect(w.textContent).toBe('1 person waiting to join');
});

test('waiting: not the owner or a failed check keeps the last safe state', async () => {
  const deps = await boot();
  const w = dom.window.document.getElementById('w');
  mod.paintWaiting(w);
  deps.isOwner = () => false;
  expect(await mod.refreshWaiting()).toBe(0);
  expect(deps.pendingInvites).not.toHaveBeenCalled();
  deps.isOwner = () => true;
  await mod.refreshWaiting();
  deps.pendingInvites.mockRejectedValueOnce(new Error('offline'));
  expect(await mod.refreshWaiting()).toBe(3);
});

test('startWaiting polls every 60 s while visible; stopWaiting clears and hides', async () => {
  vi.useFakeTimers();
  const deps = await boot();
  const w = dom.window.document.getElementById('w');
  mod.paintWaiting(w);
  mod.startWaiting(dom.window.document);
  mod.startWaiting(dom.window.document);
  await vi.advanceTimersByTimeAsync(0);
  expect(deps.pendingInvites).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deps.pendingInvites).toHaveBeenCalledTimes(2);
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deps.pendingInvites).toHaveBeenCalledTimes(2);
  mod.stopWaiting();
  expect(w.hidden).toBe(true);
});

test('coming back to the tab checks at once', async () => {
  const deps = await boot();
  mod.startWaiting(dom.window.document);
  await tick();
  expect(deps.pendingInvites).toHaveBeenCalledTimes(1);
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'visible', configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await tick();
  expect(deps.pendingInvites).toHaveBeenCalledTimes(2);
  mod.stopWaiting();
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await tick();
  expect(deps.pendingInvites).toHaveBeenCalledTimes(2);
});
