import { test, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
let dom;
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1)); };
const setup = { app_id: 123, client_id: 'Iv1.testclient', slug: 'continuum-read' };
const base = { ok: true, configured: true, setup, state: 'disconnected', links: [],
  install_url: 'https://github.com/apps/continuum-read/installations/new' };
const ok = data => ({ ok: true, data });
async function boot(data = base, overrides = {}) {
  vi.resetModules();
  dom = new JSDOM('<main></main>', { url: 'https://test.invalid/continuum/#/settings/connections' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'MutationObserver', 'FormData']) vi.stubGlobal(key, dom.window[key]);
  const api = { status: vi.fn(async () => ok(data)), start: vi.fn(), configure: vi.fn(), poll: vi.fn(),
    cancel: vi.fn(), disconnect: vi.fn(), installations: vi.fn(), repositories: vi.fn(), link: vi.fn(), ...overrides };
  const { renderConnections } = await import('./connections.js');
  renderConnections(document.querySelector('main'), { api, project: 'studio', projects: () => [{ content: { slug: 'studio', name: 'Studio' } }] });
  await tick();
  return api;
}
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
const button = name => [...document.querySelectorAll('button')].find(el => el.textContent === name);
test('unconfigured setup is honest and never asks for a password or token', async () => {
  const api = await boot({ ...base, configured: false, setup: null, state: 'setup_required' });
  expect(document.body.textContent).toContain('Setup needed');
  expect(document.body.textContent).toContain('Planned');
  expect(document.querySelector('input[type=password]')).toBeNull();
  expect(button('Connect GitHub')).toBeUndefined();
  expect(api.start).not.toHaveBeenCalled();
});
test('connection requires checkbox consent before requesting a device code', async () => {
  const api = await boot(base, { start: vi.fn(async () => ok({ ...base, pending: { id: 'one', user_code: 'ABCD-EFGH', interval: 60, expires_at: Date.now() + 900000 } })) });
  expect(button('Connect GitHub').disabled).toBe(true);
  const consent = document.querySelector('input[type=checkbox]'); consent.checked = true; consent.dispatchEvent(new window.Event('change'));
  button('Connect GitHub').click(); await tick();
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.connection-code').textContent).toContain('ABCD-EFGH');
  expect(document.querySelector('.connection-code a').href).toBe('https://github.com/login/device');
});
test('connected repository picker links a verified repository to the selected project', async () => {
  const connected = { ...base, state: 'connected', account: 'alice', expires_at: Date.now() + 3600000 };
  const api = await boot(connected, {
    installations: vi.fn(async () => ok({ installations: [{ id: 7, account: 'alice' }] })),
    repositories: vi.fn(async () => ok({ page: 1, has_more: false, repositories: [{ id: 55, full_name: 'alice/site', private: true, description: '<script>no</script>' }] })),
    link: vi.fn(async () => ok({ ...connected, links: [{ project: 'studio', repository: { full_name: 'alice/site', private: true } }] })),
  });
  button('Choose a repository').click(); await tick(); await tick();
  expect(document.querySelector('#github-project').value).toBe('studio');
  expect(document.querySelector('.repository-results script')).toBeNull();
  expect(button('Link to project').disabled).toBe(false);
  button('Link to project').click(); await tick();
  expect(api.link).toHaveBeenCalledWith({ installation: 7, repository: 55, page: 1, project: 'studio' });
  expect(document.querySelector('.connection-links').textContent).toContain('alice/site');
});
test('revoked GitHub access asks for reconnect without representing a Continuum sign-out', async () => {
  await boot({ ...base, state: 'connected', account: 'alice', expires_at: Date.now() + 3600000 }, {
    installations: async () => ({ ok: false, code: 'reauthorize', reason: 'GitHub access expired.' }),
  });
  button('Choose a repository').click(); await tick();
  expect(button('Reconnect GitHub')).toBeTruthy();
  expect(document.querySelector('.connection-feedback').textContent).toBe('GitHub access expired.');
});
test('failed initial load stays visible rather than pretending connected', async () => {
  await boot(base, { status: async () => ({ ok: false, reason: 'Service unavailable. Please retry.' }) });
  expect(document.querySelector('.connection-feedback').textContent).toContain('Service unavailable');
  expect(document.body.textContent).not.toContain('Connected as');
});
