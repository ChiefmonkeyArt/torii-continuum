/**
 * Read-only GitHub App connector. Fixed-origin GETs only, apart from the two
 * GitHub device-authorization POSTs. Never a general API proxy or git runner.
 * Credentials and project bindings stay in the encrypted operator secret store.
 */
import { createHash, randomUUID } from 'node:crypto';

export class ConnectionError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new ConnectionError(code, message, status); };
const integer = value => Number.isSafeInteger(value) && value > 0;
const allowedPermissions = p => p && p.contents === 'read' && Object.entries(p).every(
  ([name, level]) => ['contents', 'metadata'].includes(name) && level === 'read');
export function validateGitHubSetup(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'app_id,client_id,slug' ||
      !integer(input.app_id) || !/^[A-Za-z0-9._-]{8,100}$/.test(input.client_id || '') ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.slug || ''))
    fail('invalid_setup', 'Enter the GitHub App ID, public Client ID and app slug.');
  return { app_id: input.app_id, client_id: input.client_id, slug: input.slug };
}

export function createGitHubConnection({ secretStore, fetchFn = fetch, now = Date.now, projectExists = () => false }) {
  const queues = new Map(), pending = new Map();
  const key = owner => 'github_' + createHash('sha256').update(owner).digest('hex').slice(0, 24);
  const sessionKey = session => createHash('sha256').update(session).digest('hex');
  async function serial(owner, fn) {
    const k = key(owner), previous = queues.get(k) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      try { return await fn(k); }
      catch (e) {
        if (e instanceof ConnectionError && e.code === 'reauthorize' && e.status === 401) {
          const state = await read(k);
          if (state.credential) { state.credential.expires_at = 0; await save(k, state); }
        }
        throw e;
      }
    });
    queues.set(k, work);
    try { return await work; } finally { if (queues.get(k) === work) queues.delete(k); }
  }
  async function read(k) {
    try {
      const text = await secretStore.get(k);
      if (!text) return { schema: 1, setup: null, credential: null, links: [] };
      const value = JSON.parse(text);
      if (value.schema !== 1 || !Array.isArray(value.links)) throw Error('invalid');
      if (value.setup) validateGitHubSetup(value.setup);
      return value;
    } catch { fail('storage_unavailable', 'Connection storage needs attention. Nothing has been overwritten.', 503); }
  }
  async function save(k, state) {
    try { await secretStore.put(k, JSON.stringify(state), { atomic: true }); }
    catch { fail('storage_unavailable', 'The connection could not be saved securely. Please retry.', 503); }
  }
  async function json(url, { token, form } = {}) {
    // URLs are constructed exclusively by this module, never received from UI.
    const signal = AbortSignal.timeout(12000);
    let r;
    try {
      r = await fetchFn(url, { method: form ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'User-Agent': 'Torii-Continuum',
          ...(token ? { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } : {}),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
      if (r.status === 401) fail('reauthorize', 'GitHub access expired or was revoked. Connect again.', 401);
      if (r.status === 403 || r.status === 429) fail('github_limited', 'GitHub refused this request or reached a limit. Check app access, then retry later.', 503);
      if (!r.ok) fail('github_unavailable', 'GitHub could not complete this request. Please retry.', 502);
      const reader = r.body.getReader(); let length = 0; const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) { await reader.cancel(); throw Error('size'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      if (e instanceof ConnectionError) throw e;
      fail('github_unavailable', 'GitHub did not respond safely in time. Please retry.', 502);
    }
  }
  function view(state, p) {
    const connected = !!state.credential && state.credential.expires_at > now();
    return { ok: true, configured: !!state.setup, setup: state.setup,
      state: connected ? 'connected' : state.credential ? 'expired' : state.setup ? 'disconnected' : 'setup_required',
      account: connected ? state.credential.login : null,
      expires_at: state.credential?.expires_at || null, permissions: ['Repository metadata: read', 'Repository contents: read'],
      links: connected ? state.links : [],
      install_url: state.setup ? `https://github.com/apps/${state.setup.slug}/installations/new` : null,
      pending: p && p.expires_at > now() ? { id: p.id, user_code: p.user_code,
        verification_uri: 'https://github.com/login/device', expires_at: p.expires_at, interval: p.interval } : null };
  }
  function credential(state) {
    if (!state.credential || state.credential.expires_at <= now())
      fail('reauthorize', 'Connect GitHub to read approved repositories.', 409);
    return state.credential.token;
  }
  async function installations(state) {
    const data = await json('https://api.github.com/user/installations?per_page=100', { token: credential(state) });
    if (!Array.isArray(data.installations) || data.total_count > 100)
      fail('installation_limit', 'GitHub returned too many installations. Use a dedicated account connection.', 409);
    const found = data.installations.filter(i => i.app_id === state.setup.app_id && !i.suspended_at);
    if (found.some(i => !allowedPermissions(i.permissions) || i.repository_selection !== 'selected'))
      fail('permissions_too_broad', 'Choose only selected repositories and read-only Contents/Metadata permissions in GitHub.', 409);
    return found.map(i => ({ id: i.id, account: String(i.account?.login || 'GitHub').slice(0, 100) })).filter(i => integer(i.id));
  }
  async function repos(state, installation, page) {
    if (!integer(installation) || !integer(page) || page > 100) fail('invalid_request', 'Choose a valid repository page.');
    const grants = await installations(state);
    if (!grants.some(i => i.id === installation)) fail('not_granted', 'This installation is not granted to your connection.', 403);
    const data = await json(`https://api.github.com/user/installations/${installation}/repositories?per_page=100&page=${page}`, { token: credential(state) });
    if (!Array.isArray(data.repositories)) fail('github_unavailable', 'GitHub returned an invalid repository list.', 502);
    return { ok: true, page, has_more: page * 100 < data.total_count,
      repositories: data.repositories.filter(r => integer(r.id) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.full_name || '')).map(r => ({
        id: r.id, full_name: r.full_name, private: r.private === true,
        description: String(r.description || '').slice(0, 240), url: `https://github.com/${r.full_name}`,
        default_branch: String(r.default_branch || '').slice(0, 255),
      })) };
  }
  return {
    status(owner, session) { return serial(owner, async k => {
      const p = pending.get(k);
      return view(await read(k), p?.session === sessionKey(session) ? p : null);
    }); },
    configure(owner, input) { return serial(owner, async k => {
      const setup = validateGitHubSetup(input), state = await read(k);
      if (state.credential) fail('disconnect_first', 'Disconnect the existing account before changing its app.', 409);
      const app = await json(`https://api.github.com/apps/${setup.slug}`);
      if (app.id !== setup.app_id || app.client_id !== setup.client_id || !allowedPermissions(app.permissions))
        fail('invalid_app', 'The app details must match a GitHub App with only read-only Contents and Metadata permissions.');
      pending.delete(k);
      state.setup = setup; state.links = [];
      await save(k, state);
      return view(state);
    }); },
    start(owner, session) { return serial(owner, async k => {
      const state = await read(k);
      if (!state.setup) fail('setup_required', 'Set up the read-only GitHub App first.', 409);
      if (state.credential && state.credential.expires_at > now()) return view(state);
      const existing = pending.get(k);
      if (existing?.expires_at > now() && existing.session === sessionKey(session)) return view(state, existing);
      const data = await json('https://github.com/login/device/code', { form: { client_id: state.setup.client_id } });
      if (data.error) fail('device_setup', 'Enable Device flow in the GitHub App settings, then retry.', 409);
      if (typeof data.device_code !== 'string' || data.device_code.length > 200 ||
          !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code || '') || data.verification_uri !== 'https://github.com/login/device' ||
          !integer(data.expires_in) || data.expires_in > 900 || !integer(data.interval) || data.interval > 900)
        fail('github_unavailable', 'GitHub returned an invalid authorization request.', 502);
      const p = { id: randomUUID(), device_code: data.device_code, user_code: data.user_code,
        session: sessionKey(session), interval: Math.max(5, data.interval),
        expires_at: now() + data.expires_in * 1000, next_poll: 0 };
      p.next_poll = now() + p.interval * 1000;
      pending.set(k, p);
      return view(state, p);
    }); },
    poll(owner, session, id) { return serial(owner, async k => {
      const p = pending.get(k), state = await read(k);
      if (!p || p.id !== id || p.session !== sessionKey(session))
        fail('authorization_missing', 'This approval request ended. Start a new connection.', 409);
      if (p.expires_at <= now()) { pending.delete(k); fail('authorization_expired', 'The approval code expired. Connect again.', 409); }
      if (now() < p.next_poll) return view(state, p);
      p.next_poll = now() + p.interval * 1000;
      const data = await json('https://github.com/login/oauth/access_token', { form: {
        client_id: state.setup.client_id, device_code: p.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
      if (data.error === 'authorization_pending') return view(state, p);
      if (data.error === 'slow_down') {
        p.interval = Math.max(p.interval + 5, integer(data.interval) && data.interval <= 900 ? data.interval : 0);
        p.next_poll = now() + p.interval * 1000; return view(state, p);
      }
      if (data.error) { pending.delete(k); fail('authorization_declined', 'GitHub approval was declined or expired. You can start again.', 409); }
      pending.delete(k); // A successful device-code exchange is single-use.
      if (!/^ghu_[A-Za-z0-9_]+$/.test(data.access_token || '') || data.access_token.length > 512 ||
          !integer(data.expires_in) || data.expires_in > 28800 || data.scope || data.token_type !== 'bearer') {
        pending.delete(k);
        fail('unsafe_token', 'Use an expiring GitHub App user token, not a personal token. Enable token expiration in the app.', 409);
      }
      const user = await json('https://api.github.com/user', { token: data.access_token });
      if (!integer(user.id) || !/^[A-Za-z0-9-]{1,100}$/.test(user.login || '')) fail('github_unavailable', 'GitHub account verification failed.', 502);
      // No refresh token is persisted. A reconnection is explicit after expiry.
      const next = { ...state, credential: { token: data.access_token, login: user.login, user_id: user.id,
        expires_at: now() + data.expires_in * 1000 }, links: state.credential?.user_id === user.id ? state.links : [] };
      await installations(next); // Reject overbroad grants before storing access.
      await save(k, next);
      pending.delete(k);
      return view(next);
    }); },
    cancel(owner, session, id) { return serial(owner, async k => {
      const p = pending.get(k);
      if (p?.session === sessionKey(session) && p.id === id) pending.delete(k);
      return { ok: true };
    }); },
    disconnect(owner) { return serial(owner, async k => {
      const state = await read(k); pending.delete(k);
      state.credential = null; state.links = [];
      await save(k, state);
      return { ...view(state), revoke_url: 'https://github.com/settings/installations' };
    }); },
    installations(owner) { return serial(owner, async k => ({ ok: true, installations: await installations(await read(k)) })); },
    repositories(owner, installation, page) { return serial(owner, async k => repos(await read(k), installation, page)); },
    link(owner, input) { return serial(owner, async k => {
      if (!input || Object.keys(input).sort().join(',') !== 'installation,page,project,repository' ||
          typeof input.project !== 'string' || input.project.length > 160 || !projectExists(input.project) || !integer(input.repository))
        fail('invalid_project', 'Choose an existing project and an approved repository.');
      const state = await read(k), rows = await repos(state, input.installation, input.page);
      const repository = rows.repositories.find(r => r.id === input.repository);
      if (!repository) fail('not_granted', 'That repository is no longer in the approved list.', 403);
      state.links = state.links.filter(l => l.project !== input.project);
      if (state.links.length >= 100) fail('link_limit', 'A maximum of 100 project links is supported.', 409);
      state.links.push({ project: input.project, installation: input.installation, repository, linked_at: now() });
      await save(k, state);
      return view(state);
    }); },
    unlink(owner, project) { return serial(owner, async k => {
      const state = await read(k); state.links = state.links.filter(l => l.project !== project);
      await save(k, state); return view(state);
    }); },
  };
}

export function registerGitHubRoutes(app, { requireAdmin, connection }) {
  const session = req => req.headers.authorization || '';
  const routes = [
    ['GET', '', req => connection.status(req.session.npub, session(req))],
    ['PUT', '/setup', req => connection.configure(req.session.npub, req.body)],
    ['POST', '/start', req => {
      if (req.body?.consent !== true || Object.keys(req.body).length !== 1) fail('consent_required', 'Approve the read-only connection first.');
      return connection.start(req.session.npub, session(req));
    }],
    ['POST', '/poll', req => connection.poll(req.session.npub, session(req), req.body?.id)],
    ['POST', '/cancel', req => connection.cancel(req.session.npub, session(req), req.body?.id)],
    ['POST', '/disconnect', req => {
      if (req.body?.confirm !== true) fail('confirmation_required', 'Confirm disconnecting this connection.');
      return connection.disconnect(req.session.npub);
    }],
    ['GET', '/installations', req => connection.installations(req.session.npub)],
    ['GET', '/repositories', req => connection.repositories(req.session.npub, Number(req.query.installation), Number(req.query.page || 1))],
    ['PUT', '/project', req => connection.link(req.session.npub, req.body)],
    ['DELETE', '/project/:slug', req => connection.unlink(req.session.npub, req.params.slug)],
  ];
  for (const [method, suffix, call] of routes) app.route({ method, url: '/api/connections/github' + suffix,
    preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      try { return await call(req); }
      catch (e) {
        // GitHub 401 is not Continuum 401: do not sign the operator out.
        const status = e instanceof ConnectionError ? (e.status === 401 ? 409 : e.status) : 503;
        return reply.code(status).send({ ok: false, code: e instanceof ConnectionError ? e.code : 'connection_error',
          error: e instanceof ConnectionError ? e.message : 'The connection is unavailable. Please retry.' });
      }
    } });
}
