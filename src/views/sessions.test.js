/**
 * Sessions view (OWNER-UI-1) — the session history + delete surface.
 *
 * Two layers: pure `sessionLabel` mapping (imported + unit-tested directly),
 * and source-structure assertions that pin the security-relevant shape of the
 * list/delete UI — the view reads only non-secret index metadata (never the
 * ciphertext, never a NIP-44 decrypt), and deletion is gated on a confirm().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sessionLabel } from './sessions.js';

const here = dirname(fileURLToPath(import.meta.url));
const viewSrc = readFileSync(join(here, 'sessions.js'), 'utf8');

describe('sessionLabel', () => {
  it('maps known id prefixes to readable labels', () => {
    expect(sessionLabel('general')).toBe('General chat');
    expect(sessionLabel('project-torii-quest')).toBe('Project · torii-quest');
    expect(sessionLabel('page-dashboard')).toBe('Page · dashboard');
    expect(sessionLabel('page-projects-slug-board')).toBe('Page · projects-slug-board');
  });

  it('falls back to the raw id for unknown shapes', () => {
    expect(sessionLabel('custom-123')).toBe('custom-123');
    expect(sessionLabel('')).toBe('Untitled session');
  });
});

describe('sessions view — list/delete surface', () => {
  it('lists sessions from the agent and deletes via the session API', () => {
    expect(viewSrc).toMatch(/listSessions\(\)/);
    expect(viewSrc).toMatch(/deleteSession\(s\.id\)/);
  });

  it('gates deletion behind an explicit confirm()', () => {
    // The delete button handler must not fire deleteSession without a confirm.
    const confirmIdx = viewSrc.indexOf('window.confirm');
    const deleteIdx = viewSrc.indexOf('deleteSession(s.id)');
    expect(confirmIdx).not.toBe(-1);
    expect(deleteIdx).toBeGreaterThan(confirmIdx);
  });

  it('never decrypts — the list reads only non-secret index metadata', () => {
    // The view must not touch ciphertext or a NIP-44 signer: it shows id +
    // timestamps + size and deletes by id, so it works with no signer present.
    expect(viewSrc).not.toMatch(/nip44|decrypt|getPublicKey/);
  });

  it('renders an explicit empty state', () => {
    expect(viewSrc).toMatch(/No sessions yet/);
  });
});