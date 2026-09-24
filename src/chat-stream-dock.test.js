import { test, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function setup() {
  vi.resetModules();
  dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://torii.test/continuum/#/dashboard' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'])
    vi.stubGlobal(key, dom.window[key]);
  const token = `1.${Math.floor(Date.now() / 1000) + 3600}.${'a'.repeat(64)}.1.sig`;
  localStorage.setItem('continuum.session.v1', token);
  window.__CONTINUUM_AGENT_URL__ = '/agent';
  let controller;
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (!String(url).endsWith('/api/chat')) return new Response('{}');
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const module = await import('./chat.js');
  module.mountChat(document.getElementById('root'));
  const send = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  document.querySelector('textarea').value = 'gm';
  document.querySelector('.chat-send').click();
  await sleep(10);
  return { module, send, text: () => document.querySelector('.chat-log').textContent };
}

test('dock shows partial text before final, never persists preview, then renders timings', async () => {
  const { send, text } = await setup();
  send({ type: 'delta', delta: 'Live partial' });
  await sleep(70);
  expect(text()).toContain('Live partial');
  expect(localStorage.getItem('continuum.chat.threads')).toBeNull();
  send({ type: 'done', reply: 'Completed reply', timings: { first_text_ms: 100, total_ms: 300, attempts: 1 } });
  await sleep(70);
  expect(text()).not.toContain('Live partial');
  expect(text()).toContain('Completed reply');
  expect(text()).toContain('First text 0.1s');
});

test('waiting is explicit, disables duplicate submission, and clears on completion', async () => {
  const { send } = await setup();
  const button = document.querySelector('.chat-send');
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Waiting…');
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('textarea').placeholder).toBe('Reply in progress…');
  expect(document.querySelector('[data-testid="chat-stream-status"]').getAttribute('role')).toBe('status');
  send({ type: 'phase', phase: 'provider_wait' });
  await sleep(70);
  expect(document.querySelector('.chat-thinking').textContent).toContain('Waiting for model');
  send({ type: 'done', reply: 'gm' });
  await sleep(70);
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('Send');
  expect(document.querySelector('.chat-thinking')).toBeNull();
});

test('dock clears failed-provider partials when the fallback begins', async () => {
  const { send, text } = await setup();
  send({ type: 'delta', delta: 'Failed provider text' });
  await sleep(70);
  send({ type: 'reset', provider: 'ollama', attempt: 2 });
  send({ type: 'delta', delta: 'Local answer' });
  await sleep(70);
  expect(text()).not.toContain('Failed provider text');
  expect(text()).toContain('Local answer');
  send({ type: 'error', code: 'upstream_empty', error: 'Interrupted' });
  await sleep(70);
  expect(text()).not.toContain('Local answer');
});

test('navigation pins live text to the originating thread', async () => {
  const { module, send, text } = await setup();
  window.location.hash = '#/projects';
  module.setChatContext({ route: '/projects', where: 'projects', label: 'Projects' });
  send({ type: 'delta', delta: 'Private dashboard text' });
  await sleep(70);
  expect(text()).not.toContain('Private dashboard text');
  send({ type: 'done', reply: 'Final dashboard text' });
  await sleep(70);
  expect(text()).not.toContain('Final dashboard text');
});

test('sign-out drops preview and late completion, never restores prior owner text', async () => {
  const { send, text } = await setup();
  send({ type: 'delta', delta: 'Old owner preview' });
  await sleep(70);
  localStorage.removeItem('continuum.session.v1');
  document.dispatchEvent(new CustomEvent('continuum:session-changed'));
  send({ type: 'done', reply: 'Old owner final' });
  await sleep(70);
  expect(text()).not.toContain('Old owner');
  expect(localStorage.getItem('continuum.chat.threads') || '').not.toContain('Old owner');
});
