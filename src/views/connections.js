import { h, clear } from './util.js';
import { githubConnections } from '../data/connections.js';
import { listProjects } from '../data/store.js';
import { authEpochNow } from '../data/agent.js';
import { setChatContext } from '../chat.js';

const external = (label, href, className = 'btn') => h('a', {
  text: label, href, class: className, target: '_blank', rel: 'noopener noreferrer',
});

/** Settings surface, not a token entry form. All dynamic values use textContent. */
export function renderConnections(mount, { api = githubConnections, project = null, projects = listProjects, demo = false } = {}) {
  clear(mount);
  setChatContext({ label: 'Connections', where: 'connections' });
  const epoch = authEpochNow();
  const root = h('section', { class: 'connections-page', 'aria-label': 'Connections settings' });
  const status = h('p', { class: 'connection-feedback muted', role: 'status', 'aria-live': 'polite', text: 'Loading connections…' });
  const body = h('div', { class: 'connection-body' });
  const badge = h('span', { class: 'connection-badge', text: 'Checking' });
  let state = null, timer = null, busy = false, repoGeneration = 0;
  const alive = () => root.isConnected && epoch === authEpochNow();
  const stop = () => { clearTimeout(timer); timer = null; };
  const button = (label, fn, primary = false) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', text: label, onclick: fn });
  const retry = button('Retry connection status', () => void action(() => api.status(), 'Checking connection…'));
  retry.hidden = true;
  const steps = h('ol', { class: 'connection-steps' }, [
    h('li', { text: 'Choose access' }), h('li', { text: 'Approve on GitHub' }), h('li', { text: 'Attach a repository' }),
  ]);
  root.append(
    h('header', { class: 'connections-header' }, [
      h('span', { class: 'workspace-eyebrow', text: 'SETTINGS / CONNECTIONS' }),
      h('h1', { text: 'Your tools. Your control.' }),
      h('p', { class: 'muted', text: 'Connect the code behind your projects. Start with reading, not permission to change anything.' }),
    ]),
    h('div', { class: 'connections-grid' }, [
      h('article', { class: 'connection-card github-connection' }, [
        h('div', { class: 'connection-card-heading' }, [
          h('span', { class: 'connection-mark', 'aria-hidden': 'true', text: 'GH' }),
          h('div', {}, [h('h2', { text: 'GitHub' }), h('p', { class: 'muted', text: 'Your approved repositories' })]), badge,
        ]), steps, status, retry, body,
      ]),
      h('aside', { class: 'connection-rules' }, [
        h('span', { class: 'workspace-eyebrow', text: 'PERMISSION BOUNDARY' }),
        h('h2', { text: 'Read-only means read-only.' }),
        h('ul', {}, [
          h('li', { text: 'Only the repositories you select in GitHub.' }),
          h('li', { text: 'No pushes, commits, merges, deletion or code execution.' }),
          h('li', { text: 'No passwords or personal access tokens to paste here.' }),
          h('li', { text: 'Repository code is not sent to AI by connecting.' }),
        ]),
        h('p', { class: 'muted', text: 'An expiring GitHub access token is encrypted on this server. The AI and your browser never receive it. Reconnect after expiry, at most eight hours; automatic renewal comes later.' }),
      ]),
    ]),
    h('article', { class: 'connection-card connection-next' }, [
      h('div', {}, [h('span', { class: 'connection-badge', text: 'Planned' }), h('h2', { text: 'nGit · Code on Nostr' }),
        h('p', { class: 'muted', text: 'A future remote-signer connection, keeping your personal identity key outside Continuum. No nGit account is connected by this screen.' })]),
      h('details', {}, [h('summary', { text: 'See the next step' }),
        h('p', { text: 'Pair a compatible signer, choose a repository and grant read access first. Publishing will need a separate review. A signer connection credential is still sensitive and must be protected; signing in alone is not publishing consent.' })]),
    ]),
  );
  mount.append(root);
  // Pending approval must not keep polling after navigation or sign-out.
  const observer = new MutationObserver(() => { if (!alive()) { stop(); observer.disconnect(); } });
  observer.observe(mount, { childList: true });
  async function action(fn, message = 'Working…', after = draw) {
    if (busy || !alive()) return;
    retry.hidden = true;
    busy = true; status.textContent = message; root.setAttribute('aria-busy', 'true');
    const controls = [...body.querySelectorAll('button, input, select')].map(el => [el, el.disabled]);
    for (const [el] of controls) el.disabled = true;
    try {
      const result = await fn();
      if (!alive()) return;
      if (!result.ok) {
        if ((result.code || result.data?.code) === 'reauthorize' && state) draw({ ...state, state: 'expired', pending: null, account: null, links: [] });
        throw Error(result.reason || result.data?.error || 'Could not complete the connection. Please retry.');
      }
      await after(result.data);
    } catch (e) {
      if (alive()) {
        if (state?.pending) draw({ ...state, pending: null });
        status.textContent = e.message;
        retry.hidden = false;
      }
    } finally {
      busy = false;
      for (const [el, disabled] of controls) if (el.isConnected) el.disabled = disabled;
      if (alive()) { root.removeAttribute('aria-busy'); schedule(); }
    }
  }
  function schedule() {
    stop();
    if (!alive() || !state?.pending) return;
    const request = state.pending;
    timer = setTimeout(() => {
      if (alive() && state?.pending?.id === request.id)
        void action(() => api.poll(request.id), 'Waiting for approval on GitHub…');
    }, Math.max(5, request.interval) * 1000);
  }
  function setupForm() {
    const details = h('details', { class: 'connection-setup', open: !state?.configured });
    const fields = [
      ['app_id', 'App ID', 'number', 'e.g. 123456'],
      ['client_id', 'Public Client ID', 'text', 'Shown on the GitHub App settings page'],
      ['slug', 'App slug', 'text', 'The part after github.com/apps/'],
    ];
    const form = h('form', { class: 'connection-form' });
    for (const [key, label, type, placeholder] of fields) {
      const id = 'github-setup-' + key;
      form.append(h('label', { for: id, text: label }), h('input', { id, name: key, type, placeholder,
        required: true, value: state?.setup?.[key] || '', autocomplete: 'off', maxlength: 100 }));
    }
    const submit = h('button', { type: 'submit', class: 'btn', text: 'Verify app setup' });
    form.append(submit);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form)); values.app_id = Number(values.app_id);
      void action(() => api.configure(values), 'Verifying the app and its read-only permissions…');
    });
    details.append(h('summary', { text: 'One-time setup for this server' }),
      h('p', { text: 'Register your own GitHub App. This keeps Continuum self-hosted, without a central credential service.' }),
      h('ol', {}, [
        h('li', { text: 'Create a GitHub App with Contents: Read-only and Metadata: Read-only. Leave every other permission off.' }),
        h('li', { text: 'Enable Device flow and expiring user access tokens. Disable webhooks; no callback or private key is needed for this first connection flow.' }),
        h('li', { text: 'The app’s public profile must be visible at github.com/apps/your-app. Copy its public App ID, Client ID and slug below. Never paste a client secret, password or private key.' }),
      ]),
      external('Open GitHub App registration', 'https://github.com/settings/apps/new'),
      form);
    return details;
  }
  function draw(data) {
    stop(); repoGeneration++; state = data; clear(body);
    const names = { setup_required: 'Setup needed', disconnected: 'Not connected', expired: 'Reconnect needed', connected: 'Read-only · Connected' };
    badge.textContent = data.pending ? 'Awaiting approval' : names[data.state] || 'Not connected';
    status.textContent = '';
    if (data.pending) {
      const code = data.pending;
      status.textContent = 'Waiting for you to approve on GitHub. Never enter a code supplied by someone else.';
      body.append(h('div', { class: 'connection-code' }, [
        h('p', { text: 'Enter your one-time code on GitHub' }), h('strong', { text: code.user_code }),
        h('p', { class: 'muted', text: 'This code expires at ' + new Date(code.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        external('Open GitHub to approve', 'https://github.com/login/device', 'btn primary'),
        button('Cancel connection', () => {
          stop();
          void action(() => api.cancel(code.id), 'Cancelling…', async () => {
            const next = await api.status(); if (!next.ok) throw Error('Refresh to check the connection.'); draw(next.data);
          });
        }),
      ]));
      return;
    }
    if (data.state !== 'connected') {
      if (!data.configured) {
        body.append(h('p', { text: 'One small setup step before your first connection. No account or repository access has been granted yet.' }), setupForm());
        return;
      }
      const consent = h('input', { type: 'checkbox', id: 'github-read-consent' });
      const start = button(data.state === 'expired' ? 'Reconnect GitHub' : 'Connect GitHub', () => {
        if (consent.checked) void action(() => api.start(), 'Requesting your one-time GitHub code…');
      }, true); start.disabled = true;
      consent.addEventListener('change', () => { start.disabled = !consent.checked; });
      body.append(h('p', { text: data.state === 'expired' ? 'Your GitHub access expired. Your repositories are unchanged; approve a fresh connection to continue.' :
        'First install the read-only app on selected repositories. Then approve your account connection.' }),
      external('Choose repositories in GitHub', data.install_url),
      h('label', { class: 'connection-consent', for: 'github-read-consent' }, [consent,
        h('span', { text: 'Allow read-only repository access and encrypted storage of the expiring access token on this server.' })]),
      start, setupForm());
      if (data.state === 'expired') body.append(button('Disconnect', () => {
        if (window.confirm('Remove the expired GitHub credential and local project links? GitHub repositories are unchanged.'))
          void action(() => api.disconnect(), 'Removing the expired connection…');
      }));
      return;
    }
    status.textContent = `Connected as ${data.account}. Access expires ${new Date(data.expires_at).toLocaleString()}.`;
    body.append(h('div', { class: 'connection-actions' }, [
      button('Choose a repository', () => void chooseRepositories(), true),
      external('Manage GitHub access', 'https://github.com/settings/installations'),
      button('Disconnect', () => {
        if (window.confirm('Disconnect GitHub and remove local project links? Your GitHub repositories are not changed. Revoke the app in GitHub separately if you want to remove its grant too.'))
          void action(() => api.disconnect(), 'Removing the stored token and local links…');
      }),
    ]));
    const links = h('div', { class: 'connection-links' });
    links.append(h('h3', { text: 'Linked projects' }));
    if (!data.links?.length) links.append(h('p', { class: 'muted', text: 'No repositories linked yet. Choose a repository to give a project its code home.' }));
    for (const link of data.links || []) {
      links.append(h('div', { class: 'connection-linked-row' }, [
        h('div', {}, [h('strong', { text: link.repository.full_name }),
          h('p', { class: 'muted', text: `Project: ${link.project} · ${link.repository.private ? 'Private' : 'Public'} · Last approved link` })]),
        button('Unlink', () => {
          if (window.confirm(`Remove the local link for ${link.project}? GitHub is unchanged.`))
            void action(() => api.unlink(link.project), 'Removing project link…');
        }),
      ]));
    }
    body.append(links);
  }
  async function chooseRepositories() {
    const generation = ++repoGeneration;
    await action(() => api.installations(), 'Checking the repositories your app can access…', async data => {
      if (!alive() || generation !== repoGeneration) return;
      body.querySelector('.repository-picker')?.remove();
      const panel = h('section', { class: 'repository-picker', 'aria-label': 'Repository picker' });
      body.append(panel);
      if (!data.installations?.length) {
        panel.append(h('p', { text: 'No approved installation yet. Install the app on selected repositories, then check again.' }),
          external('Choose repositories in GitHub', state.install_url),
          button('Check again', () => void chooseRepositories()));
        status.textContent = 'Connected to your account; repository access still needs approval.'; return;
      }
      const accounts = h('select', { id: 'github-installation', 'aria-label': 'GitHub account or organization' },
        data.installations.map(i => h('option', { value: i.id, text: i.account })));
      const projectSelect = h('select', { id: 'github-project', 'aria-label': 'Continuum project' }, [
        h('option', { value: '', text: 'Choose a project' }),
        ...projects().map(p => h('option', { value: p.content.slug, text: p.content.name || p.content.slug })),
      ]);
      if (project) projectSelect.value = project;
      const search = h('input', { type: 'search', placeholder: 'Filter this page of repositories', 'aria-label': 'Filter repositories' });
      const rows = h('div', { class: 'repository-results' }), pager = h('div', { class: 'connection-actions' });
      panel.append(h('h3', { text: 'Attach a code repository' }),
        h('p', { class: 'muted', text: 'Linking saves a reference only. It does not clone, run, publish or send code to AI.' }),
        h('label', { for: 'github-installation', text: 'GitHub account' }), accounts,
        h('label', { for: 'github-project', text: 'Continuum project' }), projectSelect, search, rows, pager);
      let page = 1, result = null;
      const drawRows = () => {
        clear(rows);
        const matches = (result?.repositories || []).filter(r => r.full_name.toLowerCase().includes(search.value.toLowerCase()));
        if (!matches.length) rows.append(h('p', { class: 'muted', text: 'No repositories match on this page.' }));
        for (const repo of matches) {
          const linkButton = button('Link to project', () => {
            if (!projectSelect.value) return;
            const existing = state.links?.find(l => l.project === projectSelect.value);
            if (existing && !window.confirm('Replace this project’s existing repository link? No GitHub content changes.')) return;
            void action(() => api.link({ installation: Number(accounts.value), page,
              repository: repo.id, project: projectSelect.value }), 'Verifying access and saving the project link…');
          });
          linkButton.disabled = !projectSelect.value;
          rows.append(h('div', { class: 'repository-row' }, [
            h('div', {}, [h('strong', { text: repo.full_name }), h('span', { class: 'connection-badge', text: repo.private ? 'Private' : 'Public' }),
              h('p', { class: 'muted', text: repo.description || 'No description provided.' })]), linkButton,
          ]));
        }
      };
      const loadPage = async () => {
        const installation = Number(accounts.value);
        await action(() => api.repositories(installation, page), 'Reading approved repositories…', data => {
          if (!panel.isConnected || generation !== repoGeneration) return;
          result = data; drawRows(); clear(pager);
          if (page > 1) pager.append(button('Previous page', () => { page--; void loadPage(); }));
          if (data.has_more) pager.append(button('Next page', () => { page++; void loadPage(); }));
          status.textContent = `Page ${page}. Select a project to enable linking.`;
        });
      };
      accounts.addEventListener('change', () => { page = 1; void loadPage(); });
      projectSelect.addEventListener('change', drawRows); search.addEventListener('input', drawRows);
      // Run only after the outer action has released its busy guard.
      setTimeout(() => { if (panel.isConnected && generation === repoGeneration) void loadPage(); }, 0);
    });
  }
  if (demo) {
    badge.textContent = 'Preview only'; status.textContent = 'Sign in to manage real connections.';
    body.append(h('p', { text: 'GitHub access begins with selected repositories and an explicit read-only approval. No external requests run in this preview.' }));
  } else void action(() => api.status(), 'Loading your connections…');
  return root;
}

export function renderProjectRepositoryLink(project) {
  return h('div', { class: 'project-repository-entry' }, [
    h('h3', { text: 'Code repository' }),
    h('p', { class: 'muted', text: 'Attach an approved GitHub repository. Read-only for now; code stays out of AI until a later, explicit action.' }),
    h('a', { class: 'btn', href: '#/settings/connections/' + encodeURIComponent(project), text: 'Connect repository' }),
  ]);
}
