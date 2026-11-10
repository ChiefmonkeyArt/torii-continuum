// One assistant bar with "+" (docs/adr-one-assistant-bar.md): the pure
// attachment helpers, and the dock end to end in jsdom (pick, chip, remove,
// send, names-only history, same bar on every page).
import { test, expect, describe, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  classifyFile, fitWithin, checkAdd, attachedLine, toPayload, readFile, ACCEPT,
  MAX_ITEMS, MAX_PAYLOAD,
} from './chat-attachments.js';

describe('attachment helpers', () => {
  test('images and text files are recognised; svg, pdf and binaries are not', () => {
    expect(classifyFile('a.png', 'image/png')).toBe('image');
    expect(classifyFile('a.webp', 'image/webp')).toBe('image');
    expect(classifyFile('a.svg', 'image/svg+xml')).toBe(null);
    expect(classifyFile('a.heic', 'image/heic')).toBe(null);
    expect(classifyFile('notes.md', '')).toBe('text');
    expect(classifyFile('data.json', 'application/json')).toBe('text');
    expect(classifyFile('x.log', 'text/plain')).toBe('text');
    expect(classifyFile('doc.pdf', 'application/pdf')).toBe(null);
    expect(classifyFile('a.zip', 'application/zip')).toBe(null);
    expect(ACCEPT).toContain('image/png');
    expect(ACCEPT).toContain('.md');
  });

  test('images shrink to 1568 px on the long side and never grow', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1568, height: 1176 });
    expect(fitWithin(1000, 3136)).toEqual({ width: 500, height: 1568 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test('limits: four items, 100 KB per file, 200 KB of files, whole message under 1 MB', () => {
    const t = (n, kb) => ({ kind: 'text', name: n, text: 'a'.repeat(kb * 1024) });
    const img = (kb) => ({ kind: 'image', name: 'i.jpg', type: 'image/jpeg', data: 'A'.repeat(kb * 1024) });
    expect(checkAdd([], t('a', 1))).toBe('');
    expect(checkAdd(Array(MAX_ITEMS).fill(t('a', 1)), t('b', 1))).toMatch(/Up to 4/);
    expect(checkAdd([], t('big', 101))).toMatch(/100 KB/);
    expect(checkAdd([t('a', 90), t('b', 90)], t('c', 90))).toMatch(/200 KB in total/);
    expect(checkAdd([img(500)], img(500))).toMatch(/too much/);
    expect(MAX_PAYLOAD).toBeLessThan(1024 * 1024);
  });

  test('history keeps names only; the payload carries the data', () => {
    const list = [{ kind: 'image', name: 'shot.jpg', type: 'image/jpeg', data: 'QUJD' }, { kind: 'text', name: 'n.md', text: 'hi' }];
    expect(attachedLine(list)).toBe('Attached: shot.jpg, n.md');
    expect(attachedLine([])).toBe('');
    expect(toPayload(list)).toEqual([
      { kind: 'image', name: 'shot.jpg', type: 'image/jpeg', data: 'QUJD' },
      { kind: 'text', name: 'n.md', text: 'hi' },
    ]);
  });

  test('readFile shrinks images to JPEG, reads text, and explains refusals', async () => {
    const shrink = vi.fn(async () => 'QUJD');
    const png = { name: 'C:\\shots\\screen.png', type: 'image/png', size: 5e6 };
    expect(await readFile(png, { shrink })).toEqual({ item: { kind: 'image', name: 'screen.jpg', type: 'image/jpeg', data: 'QUJD' } });
    const bad = await readFile(png, { shrink: async () => { throw new Error('x'); } });
    expect(bad.error).toMatch(/could not be read/);
    const txt = { name: 'n.md', type: 'text/markdown', size: 2, text: async () => 'hi' };
    expect(await readFile(txt)).toEqual({ item: { kind: 'text', name: 'n.md', text: 'hi' } });
    expect((await readFile({ ...txt, text: async () => 'a\u0000b' })).error).toMatch(/not a text file/);
    expect((await readFile({ ...txt, size: 200 * 1024 })).error).toMatch(/100 KB/);
    expect((await readFile({ name: 'd.pdf', type: 'application/pdf', size: 1 })).error).toMatch(/only images/);
  });
});

// ── the dock in a browser-like DOM ─────────────────────────

let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mountDock() {
  vi.resetModules();
  dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://torii.test/continuum/#/dashboard' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'File'])
    vi.stubGlobal(key, dom.window[key]);
  localStorage.setItem('continuum.session.v1', `1.${Math.floor(Date.now() / 1000) + 3600}.${'a'.repeat(64)}.1.sig`);
  window.__CONTINUUM_AGENT_URL__ = '/agent';
  const bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (!String(url).endsWith('/api/chat')) return new Response('{}');
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ reply: 'seen it', model: 'm', provider: 'routstr' }), { headers: { 'content-type': 'application/json' } });
  }));
  const module = await import('./chat.js');
  module.mountChat(document.getElementById('root'));
  const q = (s) => document.querySelector(s);
  const pick = async (files) => {
    Object.defineProperty(q('.chat-file'), 'files', { configurable: true, value: files });
    q('.chat-file').dispatchEvent(new window.Event('change'));
    await sleep(20);
  };
  return { module, bodies, q, pick };
}

test('the bar is "+", message box, Send and ▲, with no context chip or scope switch', async () => {
  const { q, module } = await mountDock();
  const row = [...q('.chat-input-row').children].filter((el) => !el.hidden).map((el) => el.className);
  expect(row).toEqual(['chat-attach', 'chat-input', 'chat-send', 'chat-toggle']);
  expect(q('.chat-attach').getAttribute('aria-label')).toBe('Add images or files');
  expect(q('.chat-file').accept).toContain('image/png');
  expect(q('.chat-context')).toBeNull();
  expect(q('.chat-mode')).toBeNull();
  // Moving to another page keeps the same bar and the same conversation.
  const before = q('.chat-log').textContent;
  module.setChatContext({ label: 'Marketplace', where: 'marketplace' });
  expect(q('.chat-log').textContent).toBe(before);
  expect(q('.chat-attach')).not.toBeNull();
});

test('a picked file shows as a removable chip, goes with the message, and history keeps only its name', async () => {
  const { q, pick, bodies } = await mountDock();
  q('.chat-attach').click();
  await pick([new File(['secret file body'], 'notes.md', { type: 'text/markdown' }), new File(['x'], 'tool.exe', { type: 'application/octet-stream' })]);
  expect(q('.chat-attachments').hidden).toBe(false);
  expect(q('.chat-chip').textContent).toContain('notes.md');
  expect(q('.chat-attach-error').textContent).toMatch(/only images/);

  q('textarea').value = 'what does this say';
  q('.chat-send').click();
  await sleep(50);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].message).toBe('what does this say');
  expect(bodies[0].attachments).toEqual([{ kind: 'text', name: 'notes.md', text: 'secret file body' }]);
  expect(bodies[0].context.mode).toBeUndefined();
  expect(bodies[0].context.label).toBe('Continuum');
  const log = q('.chat-log').textContent;
  expect(log).toContain('Attached: notes.md');
  expect(log).not.toContain('secret file body');
  expect(log).toContain('seen it');
  expect(q('.chat-attachments').hidden).toBe(true);
});

test('a file alone can be sent; a removed chip is not sent', async () => {
  const { q, pick, bodies } = await mountDock();
  await pick([new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })]);
  q('.chat-chip button').click();
  expect(document.querySelectorAll('.chat-chip')).toHaveLength(1);
  q('.chat-send').click();
  await sleep(50);
  expect(bodies[0].message).toBe('');
  expect(bodies[0].attachments.map((a) => a.name)).toEqual(['b.txt']);
});

test('a message without attachments sends no attachments field', async () => {
  const { q, bodies } = await mountDock();
  q('textarea').value = 'gm';
  q('.chat-send').click();
  await sleep(50);
  expect('attachments' in bodies[0]).toBe(false);
});
