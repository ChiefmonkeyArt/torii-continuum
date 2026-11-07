import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function boot({ canvas = true } = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/' });
  for (const key of ['window', 'document']) vi.stubGlobal(key, dom.window[key]);
  const calls = [];
  // jsdom has no canvas: a recording 2D context stands in.
  dom.window.HTMLCanvasElement.prototype.getContext = canvas
    ? function () { return { set fillStyle(v) { calls.push(['style', v]); }, fillRect: (...a) => calls.push(['rect', ...a]) }; }
    : function () { return null; };
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const mod = await import('./invite-share.js');
  return { ...mod, calls, writeText };
}

test('inviteQr draws dark modules for the link on a white canvas', async () => {
  const { inviteQr, calls } = await boot();
  const el = inviteQr('https://teams.example/i/abc#secret', 160);
  expect(el.tagName).toBe('CANVAS');
  expect(el.getAttribute('aria-label')).toContain('QR');
  expect(calls.filter((c) => c[0] === 'rect').length).toBeGreaterThan(100);
  expect(calls.some((c) => c[0] === 'style' && c[1] === '#000000')).toBe(true);
});

test('inviteQr falls back to a note when the browser cannot draw', async () => {
  const { inviteQr } = await boot({ canvas: false });
  const el = inviteQr('https://teams.example/i/abc#secret');
  expect(el.tagName).toBe('DIV');
  expect(el.textContent).toContain('Copy the link');
});

test('inviteShare copies the link and toggles the QR', async () => {
  const { inviteShare, writeText } = await boot();
  const onCopied = vi.fn();
  const el = inviteShare({ url: 'https://teams.example/i/x#y', onCopied });
  document.body.appendChild(el);
  const btn = (t) => [...el.querySelectorAll('button')].find((b) => b.textContent === t);
  expect(el.querySelector('input').value).toBe('https://teams.example/i/x#y');
  expect(el.querySelector('.invite-qr')).toBeNull();
  btn('Show QR').click();
  expect(el.querySelector('.invite-qr')).not.toBeNull();
  btn('Hide QR').click();
  expect(el.querySelector('.invite-qr')).toBeNull();
  btn('Copy link').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(writeText).toHaveBeenCalledWith('https://teams.example/i/x#y');
  expect(onCopied).toHaveBeenCalledWith(true);
});
