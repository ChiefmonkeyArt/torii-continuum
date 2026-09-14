/**
 * FE-09 — a fresh REAL profile must start EMPTY, not fabricate prototype data.
 * Prototype/demo examples belong exclusively in src/demo/demo-fixtures.js; the
 * normal store's first-run state carries no phantom projects, sessions,
 * milestones, todos, files, or marketplace bounties.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

let store;
async function freshStore() {
  globalThis.localStorage = makeStorageStub();
  vi.resetModules();
  store = await import('./store.js');
  store.initStore();
}

beforeEach(freshStore);
afterEach(() => { delete globalThis.localStorage; });

describe('FE-09: fresh real state is empty, not seeded', () => {
  it('starts with no phantom projects', () => {
    expect(store.listProjects()).toEqual([]);
  });

  it('starts with no phantom milestones, todos, sessions, or files', () => {
    const s = store.getState();
    expect(s.milestones).toEqual([]);
    expect(s.todos).toEqual([]);
    expect(s.sessions).toEqual([]);
    expect(s.files).toEqual([]);
  });

  it('starts with no fabricated marketplace bounties', () => {
    expect(store.listMarketTasks()).toEqual([]);
  });
});