import { h, clear } from './util.js';
import * as store from '../data/store.js';
import { navigate } from '../router.js';
import { attachChatWorkspace, newConversation, openConversation, sessionLibrary, historyTitle, setChatContext } from '../chat.js';
import { renderProjectTabs, renderMilestones, renderFiles, renderTodos } from './projectHome.js';

export function renderNewChat() {
  navigate('/sessions/' + newConversation(), { replace: true });
}

/** One conversation surface, with project context beside it rather than under it. */
export function renderWorkspace(mount, { id, project = null }) {
  clear(mount);
  const existing = id && sessionLibrary.rows().find(r => r.id === id);
  project ||= existing?.metadata?.project || null;
  const projectRecord = project && store.getProject(project);
  if (project && !projectRecord) {
    setChatContext({ label: 'Projects', where: 'projects' });
    const empty = h('div', { class: 'empty' }, [h('h1', { text: 'Project unavailable' }), h('p', { text: 'No project with that slug. Return to Projects, or wait for your projects to finish loading.' }),
      h('button', { text: 'Projects', onclick: () => navigate('/projects') })]);
    mount.append(empty);
    const unsubscribe = store.subscribe(() => {
      if (!empty.isConnected) { unsubscribe(); return; }
      if (store.getProject(project)) { unsubscribe(); renderWorkspace(mount, { id, project }); }
    });
    return;
  }
  const root = h('section', { class: 'conversation-workspace' });
  const title = h('h1', { class: 'page-title', text: projectRecord?.content.name || (existing ? historyTitle(existing) : 'New conversation') });
  const pin = h('button', { class: 'ghost', text: 'Pin', type: 'button', disabled: true });
  const rename = h('button', { class: 'ghost', text: 'Rename', type: 'button', disabled: true });
  const state = h('p', { class: 'workspace-status muted', role: 'status', text: 'Opening your conversation…' });
  const fresh = h('button', { class: 'primary', text: 'New chat', onclick: () => navigate('/sessions/' + newConversation(project)) });
  const header = h('header', { class: 'workspace-header' }, [
    h('div', {}, [h('span', { class: 'workspace-eyebrow', text: project ? 'PROJECT WORKSPACE' : 'YOUR WORKSPACE' }), title]),
    h('div', { class: 'workspace-actions' }, [pin, rename, fresh]),
  ]);
  root.append(header);
  if (project) root.append(renderProjectTabs(project, 'workspace'));
  const chatHost = h('div', { class: 'workspace-conversation', hidden: true });
  const split = h('div', { class: project ? 'workspace-split' : 'workspace-split solo' }, [chatHost]);
  root.append(state, split);
  mount.append(root);
  attachChatWorkspace(chatHost);
  let activeId = id;
  function update() {
    if (!root.isConnected) { document.removeEventListener('continuum:history-changed', update); return; }
    const rec = sessionLibrary.rows().find(r => r.id === activeId);
    pin.disabled = rename.disabled = !rec || rec.locked;
    pin.textContent = rec?.metadata?.pinned ? 'Unpin' : 'Pin';
    pin.setAttribute('aria-pressed', String(!!rec?.metadata?.pinned));
    if (!project && rec) title.textContent = historyTitle(rec);
  }
  document.addEventListener('continuum:history-changed', update);
  pin.addEventListener('click', async () => {
    pin.disabled = true;
    const rec = sessionLibrary.rows().find(r => r.id === activeId);
    try { await sessionLibrary.patch(activeId, { pinned: !rec?.metadata?.pinned }); state.textContent = 'Saved privately.'; }
    catch (e) { state.textContent = e.message; }
    update();
  });
  rename.addEventListener('click', async () => {
    const rec = sessionLibrary.rows().find(r => r.id === activeId);
    const text = window.prompt('Conversation title', historyTitle(rec));
    if (!text?.trim()) return;
    try { await sessionLibrary.patch(activeId, { title: text }); state.textContent = 'Title saved.'; }
    catch (e) { state.textContent = e.message; }
  });
  if (project) {
    const panel = h('aside', { class: 'workspace-context', 'aria-label': 'Project context' });
    const contents = h('div', { class: 'workspace-panel-body' });
    const tabs = h('div', { class: 'workspace-panel-tabs', role: 'group', 'aria-label': 'Project information' });
    const panelToggle = h('button', { type: 'button', class: 'workspace-context-toggle', text: 'Project details', 'aria-expanded': 'false',
      onclick: () => {
        const expanded = panel.classList.toggle('details-expanded');
        panelToggle.setAttribute('aria-expanded', String(expanded));
        panelToggle.textContent = expanded ? 'Hide project details' : 'Project details';
      } });
    const show = (name) => {
      clear(contents);
      for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.textContent === name));
      if (name === 'Tasks') contents.append(renderTodos(project, store, { onRefresh: () => show('Tasks') }));
      else if (name === 'Files') contents.append(renderFiles(project, store));
      else if (name === 'Chats') {
        const rows = sessionLibrary.rows().filter(r => r.metadata?.project === project);
        contents.append(h('h2', { text: 'Project conversations' }));
        if (!rows.length) contents.append(h('p', { class: 'muted', text: 'Start a chat here to keep it with this project.' }));
        for (const row of rows) contents.append(h('a', { class: 'workspace-session-link', href: '#/sessions/' + row.id, text: historyTitle(row) }));
      } else {
        contents.append(h('h2', { text: 'Project context' }), h('p', { class: 'muted', text: projectRecord.content.description || 'Add a project description to keep your goal in view.' }), renderMilestones(project, store));
      }
    };
    for (const name of ['Context', 'Tasks', 'Files', 'Chats']) tabs.append(h('button', { type: 'button', text: name, onclick: () => show(name) }));
    panel.append(panelToggle, tabs, contents);
    split.append(panel);
    show('Context');
  }
  void (async () => {
    // A brand-new UUID needs no history lookup. Existing sessions load privately.
    if (!activeId) {
      await sessionLibrary.load();
      if (!root.isConnected) return;
      const recent = sessionLibrary.rows().find(r => r.metadata?.project === project && !r.locked);
      activeId = recent?.id || newConversation(project);
    }
    if (!root.isConnected) return;
    const opened = await openConversation(activeId, project);
    if (!root.isConnected) return;
    // A direct session URL can discover its project only after decryption.
    const record = sessionLibrary.rows().find(r => r.id === activeId);
    if (!project && record?.metadata?.project && store.getProject(record.metadata.project)) {
      renderWorkspace(mount, { id: activeId, project: record.metadata.project }); return;
    }
    chatHost.hidden = !opened;
    state.textContent = opened ? 'Private conversation · History saves encrypted when your signer is connected' :
      'This conversation could not be opened. Check your signer, then reload. Your stored history is unchanged.';
    update();
  })();
}
