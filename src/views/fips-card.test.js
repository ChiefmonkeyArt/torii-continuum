import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

const NPUB_A = 'npub1' + 'q'.repeat(58), NPUB_B = 'npub1' + 'p'.repeat(58);
const peerB = { transportNpub: NPUB_B, beaconPubkey: 'b'.repeat(64), ownerPubkey: 'c'.repeat(64), zoneId: 'quest-torii', website: 'https://b.example/quest/' };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function boot(status, extra = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/' });
  for (const key of ['window', 'document']) vi.stubGlobal(key, dom.window[key]);
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const mod = await import('./fips-card.js');
  const puts = [];
  const api = {
    fipsStatus: vi.fn(async () => ({ ok: true, data: typeof status === 'function' ? status() : status })),
    fipsIntroduction: async () => ({ ok: true, data: { template: { kind: 27530, created_at: 1, tags: [['t', 'torii-fips-intro']], content: '{}' } } }),
    fipsCheckCard: async () => ({ ok: true, data: { peer: peerB } }),
    putFipsPeers: async (e) => { puts.push(e); return { ok: true, data: { queued: 1 } }; },
    ...extra,
  };
  const signer = { signEvent: async (e) => ({ ...e, pubkey: 'a'.repeat(64), id: 'i'.repeat(64), sig: 's'.repeat(128) }) };
  const card = mod.FipsCard({ api, signer: () => signer });
  document.querySelector('main').append(card);
  await flush(); await flush();
  return { mod, card, puts, writeText, api };
}

const button = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);

test('running with one peer; Copy copies the FIPS name; no fd address', async () => {
  const { card, writeText } = await boot({ installed: true, running: true, npub: NPUB_A, peers: [peerB], pending: false, max: 8 });
  expect(card.textContent).toContain('Running');
  expect(card.textContent).toContain('Peers: 1 of 8');
  expect(card.textContent).toContain('b.example · quest-torii');
  expect(card.textContent).not.toMatch(/fd[0-9a-f]{2}:/);
  button(card, 'Copy').click(); await flush();
  expect(writeText).toHaveBeenCalledWith(NPUB_A);
});

test('not installed and not running say so', async () => {
  expect((await boot({ installed: false, running: false, npub: null, peers: [], max: 8 })).card.textContent).toContain('not installed');
  expect((await boot({ installed: true, running: false, npub: NPUB_A, peers: [], max: 8 })).card.textContent).toContain('Not running');
});

test('check then add signs the full list with the new peer', async () => {
  const { card, puts } = await boot({ installed: true, running: true, npub: NPUB_A, peers: [], pending: false, max: 8 });
  card.querySelector('textarea').value = 'torii-fips-intro:x';
  button(card, 'Check card').click(); await flush(); await flush();
  expect(card.textContent).toContain('b.example · zone quest-torii');
  button(card, 'Add peer').click(); await flush(); await flush();
  expect(puts).toHaveLength(1);
  expect(puts[0].kind).toBe(27532);
  expect(JSON.parse(puts[0].content)).toEqual({ version: 1, peers: [peerB] });
});

test('remove signs the list without that peer', async () => {
  const { card, puts } = await boot({ installed: true, running: true, npub: NPUB_A, peers: [peerB], pending: false, max: 8 });
  button(card, 'Remove').click(); await flush(); await flush();
  expect(JSON.parse(puts[0].content).peers).toEqual([]);
});

test('make introduction card yields a copyable signed card', async () => {
  const { card } = await boot({ installed: true, running: true, npub: NPUB_A, peers: [], pending: false, max: 8 });
  button(card, 'Make introduction card').click(); await flush(); await flush();
  const field = card.querySelector('input[aria-label="Introduction card"]');
  expect(field.value.startsWith('torii-fips-intro:')).toBe(true);
  const ev = JSON.parse(Buffer.from(field.value.slice(17), 'base64url').toString());
  expect(ev.sig).toHaveLength(128);
});

test('a full node refuses a ninth peer before signing', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ ...peerB, transportNpub: 'npub1' + 'z'.repeat(57) + 'acdefghj'[i] }));
  const { card, puts } = await boot({ installed: true, running: true, npub: NPUB_A, peers: eight, pending: false, max: 8 });
  card.querySelector('textarea').value = 'torii-fips-intro:x';
  button(card, 'Check card').click(); await flush(); await flush();
  expect(card.textContent).toContain('already has 8 peers');
  expect(puts).toHaveLength(0);
});
