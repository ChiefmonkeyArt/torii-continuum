/** Marketplace — tasks available for AI work. Ours highlighted in amber. */
import { h, clear, formatSats, timeAgo } from './util.js';
import * as store from '../data/store.js';
import { setChatContext } from '../chat.js';
import { isDemo, demoSource, demoBanner } from '../demo/demo-mode.js';

export function renderMarketplace(mount, opts = {}) {
  const S = demoSource(opts, store);
  setChatContext({ label: 'Marketplace', where: 'marketplace' });
  clear(mount);

  if (isDemo(opts)) mount.appendChild(demoBanner());

  const all = S.listMarketTasks();
  const ours = all.filter((t) => t.content.ours);

  let filter = { query: '', complexity: 'all', oursOnly: false };
  let sort = 'bounty';

  const header = h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Marketplace' }),
      h('div', { class: 'page-sub' }, [
        'Open AI-work tasks across the network. ',
        h('span', { class: 'pill ours', text: 'Ours' }),
        ' rows belong to your projects.',
      ]),
    ]),
    h('div', { class: 'page-actions' }, [
      h('span', { class: 'pill', text: `${all.length} total` }),
      h('span', { class: 'pill ours', text: `${ours.length} ours` }),
    ]),
  ]);
  mount.appendChild(header);

  // Filter bar
  const search = h('input', { type: 'text', placeholder: 'Search tasks or repos…' });
  const complexitySel = h('select', {}, [
    h('option', { value: 'all', text: 'Any size' }),
    h('option', { value: 'S', text: 'Small' }),
    h('option', { value: 'M', text: 'Medium' }),
    h('option', { value: 'L', text: 'Large' }),
  ]);
  const oursBtn = h('button', {}, ['Show ours only']);
  const sortSel = h('select', {}, [
    h('option', { value: 'bounty', text: 'Sort: highest bounty' }),
    h('option', { value: 'recent', text: 'Sort: most recent' }),
    h('option', { value: 'ours', text: 'Sort: ours first' }),
  ]);

  const bar = h('div', { class: 'filter-bar' }, [search, complexitySel, sortSel, oursBtn]);
  mount.appendChild(bar);

  const listWrap = h('div', {});
  mount.appendChild(listWrap);

  function draw() {
    listWrap.innerHTML = '';
    let rows = all.slice();
    if (filter.query) {
      const q = filter.query.toLowerCase();
      rows = rows.filter((t) => t.content.title.toLowerCase().includes(q) || t.content.repo.toLowerCase().includes(q));
    }
    if (filter.complexity !== 'all') rows = rows.filter((t) => t.content.complexity === filter.complexity);
    if (filter.oursOnly) rows = rows.filter((t) => t.content.ours);
    if (sort === 'bounty') rows.sort((a, b) => b.content.bounty - a.content.bounty);
    else if (sort === 'recent') rows.sort((a, b) => b.content.postedAt - a.content.postedAt);
    else if (sort === 'ours') rows.sort((a, b) => Number(b.content.ours) - Number(a.content.ours) || b.content.bounty - a.content.bounty);

    listWrap.appendChild(h('div', { class: 'task-header' }, [
      h('span', { text: 'Task' }),
      h('span', { text: 'Size' }),
      h('span', { text: 'Posted' }),
      h('span', { text: 'Bounty' }),
    ]));

    const list = h('div', { class: 'task-list' });
    for (const t of rows) {
      list.appendChild(h('div', { class: `task-row ${t.content.ours ? 'ours' : ''}`, role: 'button', tabindex: 0 }, [
        h('div', { class: 'task-title' }, [
          t.content.ours ? h('span', { class: 'pill ours', text: 'ours' }) : null,
          h('span', { class: 'name', text: t.content.title }),
          h('span', { class: 'repo', text: t.content.repo }),
        ]),
        h('span', { class: 'task-cell' }, [complexityLabel(t.content.complexity)]),
        h('span', { class: 'task-cell muted', text: timeAgo(t.content.postedAt) }),
        h('span', { class: `task-cell ${t.content.ours ? 'hot' : ''}` }, [formatSats(t.content.bounty), ' sats']),
      ]));
    }
    if (rows.length === 0) {
      list.appendChild(h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '∅' }),
        h('div', { text: 'No tasks match those filters.' }),
      ]));
    }
    listWrap.appendChild(list);
  }

  search.addEventListener('input', () => { filter.query = search.value; draw(); });
  complexitySel.addEventListener('change', () => { filter.complexity = complexitySel.value; draw(); });
  sortSel.addEventListener('change', () => { sort = sortSel.value; draw(); });
  oursBtn.addEventListener('click', () => {
    filter.oursOnly = !filter.oursOnly;
    oursBtn.textContent = filter.oursOnly ? 'Show all' : 'Show ours only';
    oursBtn.classList.toggle('primary', filter.oursOnly);
    draw();
  });

  draw();
}

function complexityLabel(c) {
  if (c === 'S') return 'S · small';
  if (c === 'M') return 'M · med';
  if (c === 'L') return 'L · large';
  return c;
}
