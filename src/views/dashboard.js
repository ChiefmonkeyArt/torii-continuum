/** Dashboard — the Continuum project-oversight surface, now an internal page.
 *  Kept intentionally light: it summarises the projects you have and links
 *  out to each sibling app's own dashboard.
 */
import { h, clear, timeAgo } from './util.js';
import { listProjects, milestonesFor, todosFor, sessionsFor } from '../data/store.js';
import { setChatContext } from '../chat.js';

export function renderDashboard(mount) {
  setChatContext({ label: 'Dashboard', where: 'dashboard' });
  clear(mount);

  const projects = listProjects();
  let totalMs = 0, doneMs = 0, activeMs = 0, openTodos = 0, totalTodos = 0, totalSessions = 0;
  for (const p of projects) {
    const ms = milestonesFor(p.content.slug);
    totalMs += ms.length;
    doneMs += ms.filter((m) => m.content.status === 'done').length;
    activeMs += ms.filter((m) => m.content.status === 'active').length;
    const td = todosFor(p.content.slug);
    totalTodos += td.length;
    openTodos += td.filter((t) => !t.content.done).length;
    totalSessions += sessionsFor(p.content.slug).length;
  }
  const pct = totalMs ? Math.round((doneMs / totalMs) * 100) : 0;

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Dashboard' }),
      h('div', { class: 'page-sub', text: 'Cross-project oversight at a glance. Everything here is derived from your local nostr-shaped events.' }),
    ]),
  ]);
  mount.appendChild(header);

  const grid = h('div', { class: 'grid-3' }, [
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Overall progress' }),
        h('span', { class: 'value', text: `${pct}%` }),
      ]),
      h('div', { class: 'usage-bar', style: 'margin-top: 12px;' }, [h('i', { style: `width: ${pct}%` })]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 8px;', text: `${doneMs} / ${totalMs} milestones done · ${activeMs} active` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Open todos' }),
        h('span', { class: 'value', text: String(openTodos) }),
      ]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 12px;', text: `${totalTodos} tracked across ${projects.length} projects.` }),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'stat' }, [
        h('span', { class: 'label', text: 'Sessions logged' }),
        h('span', { class: 'value', text: String(totalSessions) }),
      ]),
      h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 12px;', text: 'Chat + build sessions across all projects.' }),
    ]),
  ]);
  mount.appendChild(grid);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Per-project rundown
  const perProj = h('div', { class: 'card' }, [
    h('h3', { text: 'By project' }),
    h('p', { class: 'muted', text: 'Click any project to open its home page.' }),
    ...projects.map((p) => {
      const ms = milestonesFor(p.content.slug);
      const d = ms.filter((m) => m.content.status === 'done').length;
      const pctP = ms.length ? Math.round((d / ms.length) * 100) : 0;
      return h('div', { class: 'session', style: 'margin-bottom: 6px; cursor:pointer;', role: 'button', onClick: () => { window.location.hash = `#/projects/${p.content.slug}`; } }, [
        h('div', { class: 'title', text: p.content.name }),
        h('div', { style: 'flex: 1; padding: 0 12px;' }, [
          h('div', { class: 'project-progress' }, [h('i', { style: `width: ${pctP}%` })]),
        ]),
        h('div', { class: 'meta', text: `${d}/${ms.length} · ${pctP}%` }),
      ]);
    }),
  ]);
  mount.appendChild(perProj);

  mount.appendChild(h('div', { style: 'height: 16px' }));

  // Link out to the sibling Torii Quest project (separate repo + app)
  mount.appendChild(h('div', { class: 'card' }, [
    h('h3', { text: 'Torii Quest (sibling app)' }),
    h('p', { class: 'muted', text: 'Torii Quest is a separate repo and app — the arena shooter. Its own build-time oversight dashboard lives on its own site.' }),
    h('a', { href: 'https://torii-quest.pplx.app', target: '_blank', rel: 'noopener noreferrer' }, ['Open torii-quest.pplx.app ↗']),
  ]));
}
