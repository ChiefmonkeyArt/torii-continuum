/** Projects list view. */
import { h, clear, openModal, timeAgo } from './util.js';
import * as store from '../data/store.js';
import { navigate } from '../router.js';
import { setChatContext } from '../chat.js';
import { renderSidebar } from '../shell.js';
import { isDemo, demoSource, demoBanner, demoPath, goToLogin } from '../demo/demo-mode.js';

export function renderProjects(mount, opts = {}) {
  const demo = isDemo(opts);
  const S = demoSource(opts, store);
  setChatContext({ label: 'Projects', where: 'projects' });
  clear(mount);

  if (demo) mount.appendChild(demoBanner());

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Projects' }),
      h('div', { class: 'page-sub', text: 'Your project engine. Continuum tracks each build like a nostr identity: portable, signable, yours.' }),
    ]),
    h('div', { class: 'page-actions' }, [
      h('button', { class: 'primary', onClick: () => (demo ? goToLogin() : openNewProject()) }, ['+ New project']),
    ]),
  ]);
  mount.appendChild(header);

  const grid = h('div', { class: 'grid-auto' });
  const projects = S.listProjects();
  for (const p of projects) {
    grid.appendChild(renderProjectCard(p, S, opts));
  }
  grid.appendChild(renderAddCard(demo));
  mount.appendChild(grid);
}

function renderProjectCard(p, S, opts) {
  const slug = p.content.slug;
  const ms = S.milestonesFor(slug);
  const done = ms.filter((m) => m.content.status === 'done').length;
  const active = ms.filter((m) => m.content.status === 'active').length;
  const pct = ms.length ? Math.round((done / ms.length) * 100) : 0;
  const todos = S.todosFor(slug);
  const openTodos = todos.filter((t) => !t.content.done).length;

  const sourcePill = p.content.source && p.content.source !== 'local'
    ? h('span', { class: 'pill', text: p.content.source })
    : h('span', { class: 'pill', text: 'local' });

  const card = h('div', { class: 'card project-card', role: 'button', tabindex: 0 }, [
    h('div', { class: 'row' }, [
      h('h3', { text: p.content.name }),
      sourcePill,
    ]),
    h('p', { class: 'muted', text: p.content.description || '—' }),
    h('div', { class: 'project-meta' }, [
      h('span', {}, [h('b', { text: String(done) }), ' / ', String(ms.length), ' milestones']),
      h('span', {}, [h('b', { text: String(openTodos) }), ' open todos']),
      active > 0 ? h('span', { class: 'pill hot', text: 'active' }) : null,
    ]),
    h('div', { class: 'project-progress', 'aria-label': `${pct}% complete` }, [
      h('i', { style: `width: ${pct}%` }),
    ]),
    h('div', { class: 'project-meta' }, [
      h('span', { class: 'mono muted', text: slug }),
      h('span', { class: 'muted', text: `updated ${timeAgo(p.created_at)}` }),
    ]),
  ]);
  card.addEventListener('click', () => navigate(demoPath(opts, `/projects/${slug}`)));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
  });
  return card;
}

function renderAddCard(demo) {
  const card = h('div', { class: 'card project-card add', role: 'button', tabindex: 0 }, [
    h('div', { class: 'plus', text: '+' }),
    h('div', { text: 'Start a new project' }),
    h('div', { class: 'muted mono', text: 'blank · GitHub · ngit' }),
  ]);
  card.addEventListener('click', () => (demo ? goToLogin() : openNewProject()));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
  });
  return card;
}

function openNewProject() {
  let activeTab = 'blank';

  const nameInput   = h('input', { type: 'text', placeholder: 'e.g. Torii Bazaar' });
  const descInput   = h('textarea', { rows: 2, placeholder: 'One-line description (optional)' });
  const repoInput   = h('input', { type: 'text', placeholder: 'https://github.com/user/repo · or · ngit://relay/pubkey/repo' });
  const tagsInput   = h('input', { type: 'text', placeholder: 'tags, comma separated (optional)' });
  const errorEl     = h('div', { class: 'muted', style: 'color: var(--accent-danger); min-height: 18px;' });

  const tabs = h('div', { class: 'tabs' }, [
    h('div', { class: 'tab active', dataset: { tab: 'blank' }, text: 'Blank' }),
    h('div', { class: 'tab', dataset: { tab: 'github' }, text: 'GitHub' }),
    h('div', { class: 'tab', dataset: { tab: 'ngit' }, text: 'ngit' }),
  ]);

  const repoRow = h('div', { class: 'form-row', style: 'display:none' }, [
    h('label', { text: 'Repository URL' }),
    repoInput,
    h('div', { class: 'muted', style: 'font-size:11.5px', text: 'Continuum imports the repo as a project reference. Nothing is cloned yet — the URL is stored as a signed reference.' }),
  ]);

  const body = h('div', {}, [
    tabs,
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Project name' }),
      nameInput,
    ]),
    repoRow,
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Description' }),
      descInput,
    ]),
    h('div', { class: 'form-row' }, [
      h('label', { text: 'Tags' }),
      tagsInput,
    ]),
    errorEl,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
      h('button', { class: 'primary', onClick: () => submit() }, ['Create project']),
    ]),
  ]);

  const modal = openModal({ title: 'New project', subtitle: 'Blank canvas, a GitHub repo, or an ngit remote — all stored as nostr-shaped project events.', body });

  tabs.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      repoRow.style.display = (activeTab === 'blank') ? 'none' : 'flex';
      if (activeTab === 'github') repoInput.placeholder = 'https://github.com/user/repo';
      else if (activeTab === 'ngit') repoInput.placeholder = 'ngit://relay/pubkey/repo';
    });
  });

  nameInput.focus();

  function submit() {
    errorEl.textContent = '';
    const name = nameInput.value.trim();
    if (!name) { errorEl.textContent = 'Give the project a name.'; return; }
    let source = 'local', sourceUrl = null;
    if (activeTab !== 'blank') {
      const url = repoInput.value.trim();
      if (!url) { errorEl.textContent = `Paste a ${activeTab === 'github' ? 'GitHub' : 'ngit'} URL, or switch to Blank.`; return; }
      const valid = activeTab === 'github'
        ? /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+/i.test(url)
        : /^ngit:\/\//i.test(url) || /^nostr:\/\//i.test(url);
      if (!valid) {
        errorEl.textContent = activeTab === 'github'
          ? 'That doesn\'t look like a github.com URL.'
          : 'ngit URLs start with ngit:// (or nostr://).';
        return;
      }
      source = activeTab;
      sourceUrl = url;
    }
    const tags = tagsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const ev = store.createProject({
        name, description: descInput.value.trim(), source, sourceUrl, tags,
      });
      modal.close();
      renderSidebar();
      navigate(`/projects/${ev.content.slug}`);
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }
}
