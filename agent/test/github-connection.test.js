import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createGitHubConnection, registerGitHubRoutes } from '../core/github-connection.mjs';
import { createSecretStore } from '../lib/secretstore.mjs';
import { buildApp } from '../index.mjs';

const setup = { app_id: 123, client_id: 'Iv1.testclient', slug: 'continuum-read' };
const permissions = { metadata: 'read', contents: 'read' };
const repo = { id: 55, full_name: 'alice/website', private: true, description: 'My site', default_branch: 'main' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
function harness(overrides = {}) {
  let clock = 1000000;
  const memory = new Map(), calls = [];
  const state = { permissions, selected: 'selected', tokenError: null, expires: 28800, authStatus: 200, identity: 22 };
  const store = { get: async k => memory.get(k) || null, put: async (k, v) => memory.set(k, v) };
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://api.github.com/apps/')) return reply({ ...setup, id: setup.app_id, permissions: state.permissions });
    if (url === 'https://github.com/login/device/code') return reply({ device_code: 'private-device-code',
      user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (url === 'https://github.com/login/oauth/access_token') return reply(state.tokenError || {
      access_token: 'ghu_TESTPRIVATE', refresh_token: 'ghr_NEVERSTORE', expires_in: state.expires, token_type: 'bearer', scope: '',
    });
    if (state.authStatus !== 200) return reply({ message: 'do not echo upstream messages' }, state.authStatus);
    if (url === 'https://api.github.com/user') return reply({ login: 'alice', id: state.identity });
    if (url.includes('/user/installations?')) return reply({ total_count: 1, installations: [{
      id: 7, app_id: setup.app_id, permissions: state.permissions, repository_selection: state.selected, account: { login: 'alice' },
    }] });
    if (url.includes('/user/installations/7/repositories')) return reply({ total_count: 1, repositories: [repo] });
    throw Error('Unexpected destination: ' + url);
  };
  const deps = { secretStore: store, fetchFn, now: () => clock, projectExists: p => p === 'studio', ...overrides };
  const connection = createGitHubConnection(deps);
  async function configured() { await connection.configure('owner', setup); }
  async function start() { await configured(); return (await connection.start('owner', 'session')).pending; }
  async function connected() { const p = await start(); clock += 5000; return connection.poll('owner', 'session', p.id); }
  return { connection, state, memory, calls, deps, store, configured, start, connected, advance: n => { clock += n; } };
}
test('unconfigured is explicit, with no external requests or fabricated account', async () => {
  const h = harness();
  assert.equal((await h.connection.status('owner', 'session')).state, 'setup_required');
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.connection.start('owner', 'session'), { code: 'setup_required' });
});
test('setup verifies public app identity and rejects write permissions and unsafe input', async () => {
  const h = harness();
  for (const input of [{ ...setup, secret: 'no' }, { ...setup, slug: '../../bad' }, { ...setup, app_id: -1 }])
    await assert.rejects(h.connection.configure('owner', input));
  assert.equal(h.calls.length, 0);
  h.state.permissions = { ...permissions, contents: 'write' };
  await assert.rejects(h.configured(), { code: 'invalid_app' });
  assert.equal(h.memory.size, 0);
});
test('device code stays server-side, polling respects interval, and success never returns credentials', async () => {
  const h = harness(), p = await h.start();
  assert.ok(p.id); assert.equal(JSON.stringify(p).includes('private-device-code'), false);
  const before = h.calls.length;
  await h.connection.poll('owner', 'session', p.id); assert.equal(h.calls.length, before);
  h.advance(5000);
  const result = await h.connection.poll('owner', 'session', p.id);
  assert.equal(result.state, 'connected'); assert.equal(result.account, 'alice');
  assert.equal(JSON.stringify(result).includes('ghu_'), false);
  assert.equal([...h.memory.values()].join('').includes('ghr_'), false);
  assert.equal([...h.memory.values()].join('').includes('private-device-code'), false);
});
test('pending device authorization is bound to both owner and sign-in', async () => {
  const h = harness(), p = await h.start(); h.advance(5000);
  await assert.rejects(h.connection.poll('owner', 'other-session', p.id), { code: 'authorization_missing' });
  await assert.rejects(h.connection.poll('other-owner', 'session', p.id), { code: 'authorization_missing' });
  assert.equal((await h.connection.status('owner', 'other-session')).pending, null);
});
test('slow_down postpones polling and cancellation prevents a later exchange', async () => {
  const h = harness(), p = await h.start(); h.advance(5000);
  h.state.tokenError = { error: 'slow_down', interval: 10 };
  assert.equal((await h.connection.poll('owner', 'session', p.id)).pending.interval, 10);
  const n = h.calls.length; h.advance(5000);
  await h.connection.poll('owner', 'session', p.id); assert.equal(h.calls.length, n);
  await h.connection.cancel('owner', 'session', p.id);
  await assert.rejects(h.connection.poll('owner', 'session', p.id), { code: 'authorization_missing' });
});
test('expired and declined codes terminate safely', async () => {
  const h = harness(), p = await h.start(); h.advance(901000);
  await assert.rejects(h.connection.poll('owner', 'session', p.id), { code: 'authorization_expired' });
  const p2 = (await h.connection.start('owner', 'session')).pending; h.advance(5000);
  h.state.tokenError = { error: 'access_denied' };
  await assert.rejects(h.connection.poll('owner', 'session', p2.id), { code: 'authorization_declined' });
  assert.equal((await h.connection.status('owner', 'session')).pending, null);
});
test('non-expiring tokens and all-repository installations are refused before persistence', async () => {
  const h = harness(); h.state.expires = undefined;
  await assert.rejects(h.connected(), { code: 'unsafe_token' });
  assert.equal([...h.memory.values()].join('').includes('ghu_'), false);
  const h2 = harness(); h2.state.selected = 'all';
  await assert.rejects(h2.connected(), { code: 'permissions_too_broad' });
  assert.equal([...h2.memory.values()].join('').includes('ghu_'), false);
});
test('only permitted installation repositories can be linked to an existing project', async () => {
  const h = harness(); await h.connected();
  await assert.rejects(h.connection.repositories('owner', 8, 1), { code: 'not_granted' });
  await assert.rejects(h.connection.repositories('owner', 7, 0), { code: 'invalid_request' });
  await assert.rejects(h.connection.link('owner', { installation: 7, page: 1, repository: 55, project: 'missing' }), { code: 'invalid_project' });
  await assert.rejects(h.connection.link('owner', { installation: 7, page: 1, repository: 999, project: 'studio' }), { code: 'not_granted' });
  const result = await h.connection.link('owner', { installation: 7, page: 1, repository: 55, project: 'studio' });
  assert.equal(result.links[0].repository.full_name, 'alice/website');
  assert.equal((await h.connection.status('other-owner', 'session')).links.length, 0);
  assert.ok(h.calls.every(c => c.opts.method === 'GET' || c.url === 'https://github.com/login/device/code' || c.url === 'https://github.com/login/oauth/access_token'));
  assert.ok(h.calls.every(c => c.opts.redirect === 'error'));
});
test('permission expansion and revoked GitHub access fail closed without Continuum logout', async () => {
  const h = harness(); await h.connected();
  h.state.permissions = { ...permissions, contents: 'write' };
  await assert.rejects(h.connection.repositories('owner', 7, 1), { code: 'permissions_too_broad' });
  h.state.permissions = permissions; h.state.authStatus = 401;
  await assert.rejects(h.connection.repositories('owner', 7, 1), { code: 'reauthorize' });
  assert.equal((await h.connection.status('owner', 'session')).state, 'expired');
});
test('disconnect removes the token and local bindings but not repositories', async () => {
  const h = harness(); await h.connected();
  await h.connection.link('owner', { installation: 7, page: 1, repository: 55, project: 'studio' });
  const before = h.calls.length;
  const result = await h.connection.disconnect('owner');
  assert.equal(result.state, 'disconnected'); assert.equal(result.links.length, 0);
  assert.equal([...h.memory.values()].join('').includes('ghu_'), false);
  assert.equal(h.calls.length, before);
});
test('encrypted storage survives restart and never writes a plaintext token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'github-connection-'));
  try {
    const secretStore = createSecretStore({ session_secret: 'x'.repeat(64) }, { dir });
    const h = harness({ secretStore }); await h.connected();
    const file = join(dir, (await readdir(dir))[0]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes('ghu_TESTPRIVATE'), false);
    const restarted = createGitHubConnection(h.deps);
    assert.equal((await restarted.status('owner', 'session')).state, 'connected');
    h.advance(28800001);
    assert.equal((await restarted.status('owner', 'session')).state, 'expired');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('corrupt private state is never overwritten or reported as disconnected', async () => {
  let writes = 0;
  const h = harness({ secretStore: { get: async () => '{broken', put: async () => { writes++; } } });
  await assert.rejects(h.connection.status('owner', 'session'), { code: 'storage_unavailable' });
  await assert.rejects(h.configured(), { code: 'storage_unavailable' });
  assert.equal(writes, 0);
});
test('routes enforce authentication, explicit consent, error sanitization and no-store', async () => {
  const h = harness(), app = Fastify();
  const requireAdmin = async (req, reply) => {
    if (req.headers.authorization !== 'Bearer session') return reply.code(401).send({});
    req.session = { npub: 'owner' };
  };
  registerGitHubRoutes(app, { requireAdmin, connection: h.connection });
  const headers = { authorization: 'Bearer session' };
  try {
    for (const [method, path] of [['GET', ''], ['PUT', '/setup'], ['POST', '/start'], ['POST', '/poll'],
      ['POST', '/cancel'], ['POST', '/disconnect'], ['GET', '/installations'], ['GET', '/repositories'], ['PUT', '/project'], ['DELETE', '/project/studio']])
      assert.equal((await app.inject({ method, url: '/api/connections/github' + path })).statusCode, 401);
    assert.equal(h.calls.length, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/connections/github/start', headers, payload: {} })).statusCode, 400);
    const status = await app.inject({ method: 'GET', url: '/api/connections/github', headers });
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.json().state, 'setup_required');
    await h.connected(); h.state.authStatus = 401;
    const denied = await app.inject({ method: 'GET', url: '/api/connections/github/installations', headers });
    assert.equal(denied.statusCode, 409); assert.equal(denied.json().code, 'reauthorize');
  } finally { await app.close(); }
});
test('actual agent registers the protected connection routes', async () => {
  const cfg = { session_secret: 'a'.repeat(64), admin_npub: '', admin_bootstrap: true,
    server: { host: '127.0.0.1', port: 0, cors_origins: [] }, cashu: { mints: [] }, rate_limit: { enabled: false },
    routstr: { endpoint: 'https://example.invalid', models: { chat: 'deepseek-v3.2' }, discovery: { enabled: false }, limits: { max_sats_per_request: 50 } },
    ollama: { enabled: false }, logging: { level: 'silent' } };
  const h = harness();
  const { app } = await buildApp(cfg, { githubConnection: h.connection,
    auth: { verifySessionToken: t => ({ ok: t === 'test', npub: 'owner' }), isClaimed: () => true } });
  try {
    assert.equal((await app.inject({ url: '/api/connections/github' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/connections/github', headers: { authorization: 'Bearer test' } })).json().state, 'setup_required');
  } finally { await app.close(); }
});

test('a queued disconnect wins over an already-started approval exchange', async () => {
  const h = harness();
  let unblock, arrived;
  const entered = new Promise(resolve => { arrived = resolve; });
  const hold = new Promise(resolve => { unblock = resolve; });
  const original = h.deps.fetchFn;
  h.deps.fetchFn = async (url, opts) => {
    if (url === 'https://api.github.com/user') { arrived(); await hold; }
    return original(url, opts);
  };
  const c = createGitHubConnection(h.deps);
  await c.configure('owner', setup);
  const p = (await c.start('owner', 'session')).pending; h.advance(5000);
  const exchanging = c.poll('owner', 'session', p.id);
  await entered;
  const disconnecting = c.disconnect('owner');
  unblock();
  await exchanging; await disconnecting;
  assert.equal((await c.status('owner', 'session')).state, 'disconnected');
  assert.equal([...h.memory.values()].join('').includes('ghu_'), false);
});

test('unsafe redirects, upstream failures and oversized responses stay sanitized', async () => {
  for (const fetchFn of [
    async () => { throw Error('redirect to secret-value'); },
    async () => reply({ access_token: 'sensitive-upstream-body' }, 500),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const h = harness({ fetchFn });
    await assert.rejects(h.configured(), e => e.code === 'github_unavailable' && !/secret-value|sensitive-upstream/.test(e.message));
    assert.equal(h.memory.size, 0);
  }
});
