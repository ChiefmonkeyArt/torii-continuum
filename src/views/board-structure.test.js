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
