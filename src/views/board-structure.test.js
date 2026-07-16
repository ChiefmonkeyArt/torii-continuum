/**
 * View-semantics guardrails for the board + project-tab navigation. These are
 * source-structure assertions (the repo's tests run without a DOM/jsdom), so
 * they read the view modules as text and lock in the two accessibility
 * decisions from the PR #42 review:
 *   1. Overview/Board navigation uses <nav>/<a>/aria-current — not the ARIA
 *      tab pattern (role="tab"/"tablist") which we do not fully implement.
 *   2. Cards are non-interactive containers: no role="button" on .board-card,
 *      and an explicit Edit button lives inside so keyboard/AT users can edit
 *      without interactive controls nested under a button role.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(here, 'board.js'), 'utf8');
const projectHomeSrc = readFileSync(join(here, 'projectHome.js'), 'utf8');

describe('project view tabs — link/nav semantics, not the ARIA tab pattern', () => {
  it('renders a <nav> with an accessible label', () => {
    expect(projectHomeSrc).toMatch(/h\('nav',\s*\{[^}]*'aria-label':\s*'Project views'/);
  });

  it('uses real anchors with hash hrefs for routing', () => {
    expect(projectHomeSrc).toMatch(/h\('a',\s*attrs/);
    expect(projectHomeSrc).toMatch(/href:\s*`#\$\{path\}`/);
  });

  it('marks the active tab with aria-current="page"', () => {
    expect(projectHomeSrc).toContain("attrs['aria-current'] = 'page'");
  });

  it('does not use the role=tab / role=tablist ARIA tab pattern', () => {
    expect(projectHomeSrc).not.toMatch(/role:\s*'tab'/);
    expect(projectHomeSrc).not.toMatch(/role:\s*'tablist'/);
    expect(projectHomeSrc).not.toMatch(/'aria-selected'/);
  });
});

describe('board cards — non-interactive container, explicit controls', () => {
  it('does not put role="button" (or tabindex) on the card container', () => {
    expect(boardSrc).not.toMatch(/role:\s*'button'/);
    // The only card-level focus target should be the real <button> controls,
    // not the div itself.
    expect(boardSrc).not.toMatch(/class:\s*'board-card',[\s\S]*?tabindex/);
  });

  it('exposes an explicit Edit button on each card', () => {
    expect(boardSrc).toMatch(/iconBtn\('✎',\s*`Edit card:/);
  });

  it('builds move/edit controls as real <button>s via iconBtn', () => {
    expect(boardSrc).toMatch(/function iconBtn\([^)]*\)\s*\{\s*return h\('button'/);
  });

  it('keeps drag-and-drop wired up alongside the accessible controls', () => {
    expect(boardSrc).toContain("draggable: 'true'");
    expect(boardSrc).toContain("el.addEventListener('dragstart'");
  });
});

describe('imported (read-only) source cards — never mutate local cards', () => {
  it('imported records live in an ephemeral map, never written to the store', () => {
    expect(boardSrc).toMatch(/const importState = new Map\(\)/);
    // The board store mutators must never be called with imported records.
    expect(boardSrc).not.toMatch(/addCard\([^)]*rec/);
    expect(boardSrc).not.toMatch(/updateCard\([^)]*rec/);
  });

  it('imported cards are read-only: not draggable and carry no move/edit controls', () => {
    // The imported card builder must not add draggable or a card-moves control block.
    const fn = boardSrc.slice(boardSrc.indexOf('function renderImportedCard'), boardSrc.indexOf('function renderSyncBar'));
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toContain("draggable: 'true'");
    expect(fn).not.toContain('card-moves');
    expect(fn).toContain("class: 'board-card imported'");
  });

  it('imported cards announce their read-only state to assistive tech', () => {
    expect(boardSrc).toContain('Read-only imported card:');
    expect(boardSrc).toMatch(/imported-badge/);
  });

  it('external source links are safe (noopener noreferrer, new tab)', () => {
    expect(boardSrc).toMatch(/rel:\s*'noopener noreferrer'/);
    expect(boardSrc).toMatch(/target:\s*'_blank'/);
  });

  it('exposes source + status filters and a manual refresh control', () => {
    expect(boardSrc).toContain("'aria-label': 'Filter by source'");
    expect(boardSrc).toContain("'aria-label': 'Filter by status'");
    expect(boardSrc).toMatch(/doRefresh\(slug\)/);
  });

  it('surfaces partial/stale/error sync states to the operator', () => {
    expect(boardSrc).toMatch(/sync-banner/);
    expect(boardSrc).toMatch(/st\.status === 'stale'|status === 'partial'|status === 'error'/);
  });
});
