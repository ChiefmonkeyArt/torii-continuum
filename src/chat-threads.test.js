/**
 * Thread-key derivation tests (CHAT-CONTEXT-1) — pure, DOM-free. Covers the
 * context+mode → thread key mapping the chat dock uses to keep a separate
 * conversation per project / per page / for general side chats, plus the
 * slug/page-type helpers and the defensive trim/sanitize used for persistence.
 */
import { describe, it, expect } from 'vitest';
import {
  threadKeyFor,
  projectSlugFrom,
  pageTypeFor,
  trimThread,
  sanitizeThreads,
  THREAD_CAP,
} from './chat-threads.js';

describe('threadKeyFor', () => {
  it('project board context + page mode → project:<slug>', () => {
    const ctx = { where: 'project-board:torii', route: '/projects/torii/board' };
    expect(threadKeyFor(ctx, 'page')).toBe('project:torii');
  });

  it('project home context + page mode → project:<slug>', () => {
    const ctx = { where: 'project:torii', route: '/projects/torii' };
    expect(threadKeyFor(ctx, 'page')).toBe('project:torii');
  });

  it('explicit projectSlug wins in page mode', () => {
    const ctx = { where: 'projects', projectSlug: 'alpha', route: '/projects' };
    expect(threadKeyFor(ctx, 'page')).toBe('project:alpha');
  });

  it('dashboard + page mode → page:/dashboard', () => {
    const ctx = { where: 'dashboard', route: '/dashboard' };
    expect(threadKeyFor(ctx, 'page')).toBe('page:/dashboard');
  });

  it('non-project page → page:<route>', () => {
    const ctx = { where: 'marketplace', route: '/marketplace' };
    expect(threadKeyFor(ctx, 'page')).toBe('page:/marketplace');
  });

  it('projects index (no colon) is not a project thread', () => {
    const ctx = { where: 'projects', route: '/projects' };
    expect(threadKeyFor(ctx, 'page')).toBe('page:/projects');
  });

  it('general mode → general regardless of context', () => {
    expect(threadKeyFor({ where: 'project-board:torii' }, 'general')).toBe('general');
    expect(threadKeyFor({ where: 'dashboard' }, 'general')).toBe('general');
    expect(threadKeyFor(null, 'general')).toBe('general');
  });

  it('missing route falls back to page:/', () => {
    expect(threadKeyFor({ where: 'marketplace' }, 'page')).toBe('page:/');
    expect(threadKeyFor(null, 'page')).toBe('page:/');
  });
});

describe('projectSlugFrom', () => {
  it('prefers explicit projectSlug', () => {
    expect(projectSlugFrom({ projectSlug: 'alpha', where: 'project:beta' })).toBe('alpha');
  });
  it('parses project:<slug> and project-board:<slug>', () => {
    expect(projectSlugFrom({ where: 'project:torii' })).toBe('torii');
    expect(projectSlugFrom({ where: 'project-board:torii' })).toBe('torii');
  });
  it('returns null for the projects index and other pages', () => {
    expect(projectSlugFrom({ where: 'projects' })).toBeNull();
    expect(projectSlugFrom({ where: 'dashboard' })).toBeNull();
    expect(projectSlugFrom(null)).toBeNull();
  });
});

describe('pageTypeFor', () => {
  it('maps known router patterns', () => {
    expect(pageTypeFor('/')).toBe('landing');
    expect(pageTypeFor('/projects')).toBe('projects');
    expect(pageTypeFor('/projects/:slug')).toBe('project-home');
    expect(pageTypeFor('/projects/:slug/board')).toBe('project-board');
    expect(pageTypeFor('/marketplace')).toBe('marketplace');
    expect(pageTypeFor('/routstr')).toBe('routstr');
    expect(pageTypeFor('/dashboard')).toBe('dashboard');
  });
  it('unknown pattern → unknown', () => {
    expect(pageTypeFor('/nope')).toBe('unknown');
    expect(pageTypeFor(null)).toBe('unknown');
  });
});

describe('trimThread', () => {
  it('returns a copy under the cap', () => {
    const msgs = [{ who: 'ai', text: 'hi' }];
    const out = trimThread(msgs, 5);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });
  it('keeps the newest cap entries', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ who: 'user', text: String(i) }));
    const out = trimThread(msgs, 3);
    expect(out.map((m) => m.text)).toEqual(['7', '8', '9']);
  });
  it('non-array → []', () => {
    expect(trimThread(null)).toEqual([]);
  });
});

describe('sanitizeThreads', () => {
  it('drops malformed entries and trims each thread', () => {
    const raw = {
      'page:/': [
        { who: 'ai', text: 'ok' },
        { who: 'user' },
        null,
        'nope',
        { text: 'no who' },
      ],
      'project:torii': 'not-an-array',
    };
    const out = sanitizeThreads(raw);
    expect(out['page:/']).toEqual([{ who: 'ai', text: 'ok' }]);
    expect(out['project:torii']).toBeUndefined();
  });
  it('non-object → {}', () => {
    expect(sanitizeThreads(null)).toEqual({});
    expect(sanitizeThreads('x')).toEqual({});
  });
  it('applies the cap', () => {
    const raw = { 'general': Array.from({ length: THREAD_CAP + 5 }, () => ({ who: 'ai', text: 'x' })) };
    expect(sanitizeThreads(raw).general).toHaveLength(THREAD_CAP);
  });
});
