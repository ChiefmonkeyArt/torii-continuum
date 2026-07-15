/**
 * Kanban board view for a project. Columns (default Todo/Doing/Done, plus any
 * custom ones) hold cards. Cards can be created, edited, deleted, dragged
 * between/within columns, and — for keyboard and touch users who can't drag —
 * moved with explicit arrow controls. All state flows through the local store
 * (data/store.js), so it is per-project, persisted, and Nostr-shaped.
 *
 * Rendering goes exclusively through util.h() (textContent only) — no raw
 * HTML, so user-entered titles/descriptions can never inject markup.
 */
import { h, clear, openModal, timeAgo } from './util.js';
import {
  getProject,
  boardColumnsFor,
  cardsFor,
  addColumn,
  renameColumn,
  moveColumn,
  deleteColumn,
  addCard,
  updateCard,
  deleteCard,
  moveCard,
  BOARD_LIMITS,
} from '../data/store.js';
import { navigate } from '../router.js';
import { setChatContext } from '../chat.js';
import { renderProjectTabs } from './projectHome.js';

let mountEl = null;
let currentSlug = null;

function refresh() {
  if (mountEl && currentSlug) renderBoard(mountEl, currentSlug);
}

export function renderBoard(mount, slug) {
  mountEl = mount;
  currentSlug = slug;

  const p = getProject(slug);
  if (!p) {
    clear(mount);
    mount.appendChild(h('div', { class: 'empty' }, [
      h('div', { class: 'big', text: '⛩' }),
      h('div', { text: 'No project with that slug.' }),
      h('button', { style: 'margin-top: 12px', onClick: () => navigate('/projects') }, ['Back to projects']),
    ]));
    return;
  }

  setChatContext({ label: `${p.content.name} · Board`, where: 'project-board:' + slug });
  clear(mount);

  mount.appendChild(h('div', { class: 'crumbs' }, [
    h('a', { onClick: () => navigate('/projects') }, ['Projects']),
    h('span', { text: '›' }),
    h('a', { onClick: () => navigate(`/projects/${slug}`) }, [h('span', { class: 'mono', text: slug })]),
    h('span', { text: '›' }),
    h('span', { text: 'Board' }),
  ]));
  mount.appendChild(renderProjectTabs(slug, 'board'));

  const columns = boardColumnsFor(slug);
  const totalCards = columns.reduce((n, c) => n + cardsFor(slug, c.content.id).length, 0);

  mount.appendChild(h('div', { class: 'page-header' }, [
    h('div', {}, [
      h('h1', { class: 'page-title', text: 'Board' }),
      h('div', { class: 'page-sub', text: `${columns.length} columns · ${totalCards} cards · drag or use the arrow controls to move work along.` }),
    ]),
    h('div', { class: 'page-actions' }, [
      h('button', { class: 'primary', onClick: () => openColumnEditor(slug) }, ['+ Add column']),
    ]),
  ]));

  const scroller = h('div', { class: 'board-scroller' });
  columns.forEach((col, i) => scroller.appendChild(renderColumn(slug, col, columns, i)));
  mount.appendChild(scroller);
}

function renderColumn(slug, col, columns, index) {
  const colId = col.content.id;
  const cards = cardsFor(slug, colId);

  const controls = h('div', { class: 'col-controls' }, [
    iconBtn('‹', 'Move column left', () => { moveColumn(slug, colId, 'left'); refresh(); }, index === 0),
    iconBtn('›', 'Move column right', () => { moveColumn(slug, colId, 'right'); refresh(); }, index === columns.length - 1),
    iconBtn('✎', 'Rename column', () => openColumnEditor(slug, col)),
    iconBtn('✕', 'Delete column', () => openDeleteColumn(slug, col, columns)),
  ]);

  const header = h('div', { class: 'col-header' }, [
    h('div', { class: 'col-title' }, [
      h('span', { class: 'col-name', text: col.content.name }),
      h('span', { class: 'col-count', text: String(cards.length) }),
    ]),
    controls,
  ]);

  const list = h('div', { class: 'card-list', dataset: { columnId: colId } });
  if (cards.length === 0) {
    list.appendChild(h('div', { class: 'card-empty muted', text: 'No cards yet.' }));
  } else {
    cards.forEach((card, ci) => list.appendChild(renderCard(slug, card, columns, index, ci, cards.length)));
  }

  // Drag targeting: allow dropping onto the list; compute an insertion index
  // from the pointer position so drops land where the user aims.
  list.addEventListener('dragover', (e) => {
    if (!dragState.cardId) return;
    e.preventDefault();
    list.classList.add('drag-over');
  });
  list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
  list.addEventListener('drop', (e) => {
    if (!dragState.cardId) return;
    e.preventDefault();
    list.classList.remove('drag-over');
    const toIndex = insertionIndex(list, e.clientY);
    try {
      moveCard(slug, dragState.cardId, colId, toIndex);
    } catch (err) {
      window.alert(err.message);
    }
    dragState.cardId = null;
    refresh();
  });

  const addBtn = h('button', { class: 'ghost col-add', onClick: () => openCardEditor(slug, colId) }, ['+ Add card']);

  return h('div', { class: 'board-column' }, [header, list, addBtn]);
}

function renderCard(slug, card, columns, colIndex, cardIndex, cardCount) {
  const c = card.content;
  const colId = c.columnId;

  const footer = [];
  if (c.assignee) footer.push(h('span', { class: 'pill card-assignee', text: c.assignee }));
  if (c.dueDate) footer.push(h('span', { class: `pill card-due ${isOverdue(c.dueDate) ? 'danger' : ''}`, text: c.dueDate }));

  // Accessible move controls (keyboard + touch): shift between columns and
  // reorder within a column without dragging.
  const moves = h('div', { class: 'card-moves' }, [
    iconBtn('‹', 'Move to previous column', () => {
      const prev = columns[colIndex - 1];
      if (prev) { safeMove(slug, c.id, prev.content.id); }
    }, colIndex === 0),
    iconBtn('↑', 'Move up', () => moveCardBy(slug, c.id, colId, cardIndex, -1), cardIndex === 0),
    iconBtn('↓', 'Move down', () => moveCardBy(slug, c.id, colId, cardIndex, 1), cardIndex === cardCount - 1),
    iconBtn('›', 'Move to next column', () => {
      const next = columns[colIndex + 1];
      if (next) { safeMove(slug, c.id, next.content.id); }
    }, colIndex === columns.length - 1),
  ]);

  const el = h('div', {
    class: 'board-card',
    draggable: 'true',
    tabindex: 0,
    role: 'button',
    'aria-label': `Card: ${c.title}. Press Enter to edit.`,
    dataset: { cardId: c.id },
  }, [
    h('div', { class: 'card-title', text: c.title }),
    c.description ? h('div', { class: 'card-desc', text: c.description }) : null,
    footer.length ? h('div', { class: 'card-footer' }, footer) : null,
    h('div', { class: 'card-meta muted', text: `updated ${timeAgo(c.updatedAt || c.createdAt)}` }),
    moves,
  ]);

  el.addEventListener('click', (e) => {
    // Ignore clicks that originated on the move buttons.
    if (e.target.closest('.card-moves')) return;
    openCardEditor(slug, colId, card);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); openCardEditor(slug, colId, card); }
  });
  el.addEventListener('dragstart', (e) => {
    dragState.cardId = c.id;
    el.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragState.cardId = null; });

  return el;
}

const dragState = { cardId: null };

// Insertion index for a drop at pointer-Y: first card whose vertical midpoint
// is below the pointer wins; otherwise append.
function insertionIndex(list, clientY) {
  const cards = [...list.querySelectorAll('.board-card:not(.dragging)')];
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return i;
  }
  return cards.length;
}

function safeMove(slug, cardId, toColumnId) {
  try {
    moveCard(slug, cardId, toColumnId);
  } catch (err) {
    window.alert(err.message);
  }
  refresh();
}

function moveCardBy(slug, cardId, colId, cardIndex, delta) {
  moveCard(slug, cardId, colId, cardIndex + delta);
  refresh();
}

function isOverdue(dueDate) {
  const today = new Date().toISOString().slice(0, 10);
  return dueDate < today;
}

function iconBtn(glyph, label, onClick, disabled = false) {
  return h('button', {
    class: 'icon-btn',
    'aria-label': label,
    title: label,
    disabled: disabled ? 'disabled' : false,
    onClick: (e) => { e.stopPropagation(); if (!disabled) onClick(); },
  }, [glyph]);
}

// --- Modals ---

function openCardEditor(slug, columnId, card = null) {
  const editing = !!card;
  const c = card ? card.content : {};

  const titleInput = h('input', { type: 'text', maxlength: String(BOARD_LIMITS.CARD_TITLE), placeholder: 'Card title', value: c.title || '' });
  const descInput = h('textarea', { rows: 4, maxlength: String(BOARD_LIMITS.CARD_DESCRIPTION), placeholder: 'Description (optional)' });
  descInput.value = c.description || '';
  const assigneeInput = h('input', { type: 'text', maxlength: String(BOARD_LIMITS.CARD_ASSIGNEE), placeholder: 'Assignee (optional)', value: c.assignee || '' });
  const dueInput = h('input', { type: 'date', value: c.dueDate || '' });
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const actions = [
    h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
    h('button', { class: 'primary', onClick: () => submit() }, [editing ? 'Save' : 'Add card']),
  ];
  if (editing) {
    actions.unshift(h('button', {
      class: 'ghost',
      style: 'margin-right: auto; color: hsl(var(--destructive));',
      onClick: () => { deleteCard(slug, c.id); modal.close(); refresh(); },
    }, ['Delete']));
  }

  const body = h('div', {}, [
    formRow('Title', titleInput),
    formRow('Description', descInput),
    formRow('Assignee', assigneeInput),
    formRow('Due date', dueInput),
    errorEl,
    h('div', { class: 'form-actions' }, actions),
  ]);

  const modal = openModal({
    title: editing ? 'Edit card' : 'New card',
    subtitle: editing ? 'Update this card. Changes persist to your local, signable store.' : 'Cards are Nostr-shaped events, addressable and portable.',
    body,
  });
  titleInput.focus();

  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  function submit() {
    errorEl.textContent = '';
    const patch = {
      title: titleInput.value,
      description: descInput.value,
      assignee: assigneeInput.value,
      dueDate: dueInput.value || null,
    };
    try {
      if (editing) updateCard(slug, c.id, patch);
      else addCard(slug, columnId, patch);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function openColumnEditor(slug, col = null) {
  const editing = !!col;
  const nameInput = h('input', { type: 'text', maxlength: String(BOARD_LIMITS.COLUMN_NAME), placeholder: 'Column name', value: editing ? col.content.name : '' });
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const body = h('div', {}, [
    formRow('Name', nameInput),
    errorEl,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
      h('button', { class: 'primary', onClick: () => submit() }, [editing ? 'Rename' : 'Add column']),
    ]),
  ]);

  const modal = openModal({
    title: editing ? 'Rename column' : 'New column',
    subtitle: editing ? null : `Up to ${BOARD_LIMITS.MAX_COLUMNS} columns per board.`,
    body,
  });
  nameInput.focus();
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  function submit() {
    errorEl.textContent = '';
    try {
      if (editing) renameColumn(slug, col.content.id, nameInput.value);
      else addColumn(slug, nameInput.value);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function openDeleteColumn(slug, col, columns) {
  const colId = col.content.id;
  const cards = cardsFor(slug, colId);
  const others = columns.filter((c) => c.content.id !== colId);

  if (columns.length <= 1) {
    window.alert('A board needs at least one column.');
    return;
  }

  // Empty column → simple confirm, no card handling needed.
  if (cards.length === 0) {
    if (window.confirm(`Delete column "${col.content.name}"?`)) {
      try { deleteColumn(slug, colId); } catch (err) { window.alert(err.message); }
      refresh();
    }
    return;
  }

  // Non-empty → force a destination so no card is lost.
  const select = h('select', {},
    others.map((c) => h('option', { value: c.content.id, text: c.content.name })));
  const errorEl = h('div', { class: 'muted', style: 'color: hsl(var(--destructive)); min-height: 18px;' });

  const body = h('div', {}, [
    h('p', { class: 'muted', text: `"${col.content.name}" holds ${cards.length} card${cards.length === 1 ? '' : 's'}. Move them to another column, then delete.` }),
    formRow('Move cards to', select),
    errorEl,
    h('div', { class: 'form-actions' }, [
      h('button', { class: 'ghost', onClick: () => modal.close() }, ['Cancel']),
      h('button', { class: 'primary', onClick: () => submit() }, ['Move & delete']),
    ]),
  ]);

  const modal = openModal({ title: 'Delete column', subtitle: 'Cards are never lost — they are relocated first.', body });

  function submit() {
    errorEl.textContent = '';
    try {
      deleteColumn(slug, colId, select.value);
      modal.close();
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }
}

function formRow(label, control) {
  return h('div', { class: 'form-row' }, [h('label', { text: label }), control]);
}
