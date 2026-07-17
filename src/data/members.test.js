/**
 * Operator roster store tests (TEAMS-1) — pure data layer, no DOM.
 * localStorage is a tiny in-memory stub (mirrors board.test.js). Covers npub
 * validation + lowercasing, duplicate rejection, label clamping, listMembers
 * sort order, removeMember, and defensive coercion of a legacy state blob that
 * predates the `members` array.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function makeStorageStub() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

let store;
async function freshStore() {
  const stub = makeStorageStub();
  globalThis.localStorage = stub;
  vi.resetModules();
  store = await import('./store.js');
  store.initStore();
  return stub;
}

beforeEach(async () => {
  await freshStore();
});
afterEach(() => {
  delete globalThis.localStorage;
});

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

// Canonical NIP-19 vector: this npub1… decodes to NPUB_HEX.
const NPUB_BECH32 = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
const NPUB_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';

describe('addMember validation', () => {
  it('adds a valid 64-hex npub as an operator', () => {
    const ev = store.addMember({ npub: HEX_A, label: 'Alice' });
    expect(ev.content.npub).toBe(HEX_A);
    expect(ev.content.role).toBe('operator');
    expect(ev.content.addedBy).toBe('admin');
    expect(typeof ev.content.addedAt).toBe('number');
    expect(store.listMembers()).toHaveLength(1);
  });

  it('lowercases the npub before storing', () => {
    const ev = store.addMember({ npub: HEX_A.toUpperCase() });
    expect(ev.content.npub).toBe(HEX_A);
  });

  it('trims surrounding whitespace on the npub', () => {
    const ev = store.addMember({ npub: `  ${HEX_A}  ` });
    expect(ev.content.npub).toBe(HEX_A);
  });

  it('rejects an empty npub', () => {
    expect(() => store.addMember({ npub: '' })).toThrow();
    expect(store.listMembers()).toHaveLength(0);
  });

  it('rejects a too-short npub', () => {
    expect(() => store.addMember({ npub: 'abc' })).toThrow();
  });

  it('rejects a non-hex npub of the right length', () => {
    expect(() => store.addMember({ npub: 'z'.repeat(64) })).toThrow();
  });

  it('rejects a duplicate npub (case-insensitively)', () => {
    store.addMember({ npub: HEX_A });
    expect(() => store.addMember({ npub: HEX_A.toUpperCase() })).toThrow();
    expect(store.listMembers()).toHaveLength(1);
  });

  it('accepts an npub1… (Bech32) and stores the canonical hex', () => {
    const ev = store.addMember({ npub: NPUB_BECH32, label: 'Bech32' });
    expect(ev.content.npub).toBe(NPUB_HEX);
    expect(store.listMembers()).toHaveLength(1);
  });

  it('dedupes across equivalent npub1… and 64-hex forms', () => {
    store.addMember({ npub: NPUB_BECH32 });
    expect(() => store.addMember({ npub: NPUB_HEX })).toThrow();
    expect(store.listMembers()).toHaveLength(1);
  });

  it('rejects an npub with a bad checksum', () => {
    const bad = NPUB_BECH32.slice(0, -1) + '0';
    expect(() => store.addMember({ npub: bad })).toThrow();
    expect(store.listMembers()).toHaveLength(0);
  });

  it('clamps the label to 40 characters', () => {
    const ev = store.addMember({ npub: HEX_A, label: 'x'.repeat(100) });
    expect(ev.content.label).toHaveLength(40);
  });

  it('defaults label to an empty string when omitted', () => {
    const ev = store.addMember({ npub: HEX_A });
    expect(ev.content.label).toBe('');
  });
});

describe('listMembers', () => {
  it('sorts members by addedAt ascending', () => {
    // Each addMember reads Date.now() twice (event created_at + content.addedAt).
    const now = 1_000_000;
    const spy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce((now + 30) * 1000).mockReturnValueOnce((now + 30) * 1000) // HEX_A later
      .mockReturnValueOnce((now + 10) * 1000).mockReturnValueOnce((now + 10) * 1000); // HEX_B earlier
    store.addMember({ npub: HEX_A, label: 'later' });
    store.addMember({ npub: HEX_B, label: 'earlier' });
    spy.mockRestore();

    const labels = store.listMembers().map((m) => m.content.label);
    expect(labels).toEqual(['earlier', 'later']);
  });

  it('returns a copy — mutating the result does not corrupt the store', () => {
    store.addMember({ npub: HEX_A });
    const list = store.listMembers();
    list.pop();
    expect(store.listMembers()).toHaveLength(1);
  });
});

describe('removeMember', () => {
  it('removes a member by npub', () => {
    store.addMember({ npub: HEX_A });
    store.addMember({ npub: HEX_B });
    store.removeMember(HEX_A);
    const remaining = store.listMembers().map((m) => m.content.npub);
    expect(remaining).toEqual([HEX_B]);
  });

  it('matches case-insensitively', () => {
    store.addMember({ npub: HEX_A });
    store.removeMember(HEX_A.toUpperCase());
    expect(store.listMembers()).toHaveLength(0);
  });

  it('is a no-op for an unknown npub', () => {
    store.addMember({ npub: HEX_A });
    store.removeMember(HEX_B);
    expect(store.listMembers()).toHaveLength(1);
  });
});

describe('persistence & migration', () => {
  it('persists members across a reload (new store instance, same storage)', async () => {
    store.addMember({ npub: HEX_A, label: 'survivor' });
    vi.resetModules();
    const store2 = await import('./store.js');
    store2.initStore();
    expect(store2.listMembers().map((m) => m.content.label)).toContain('survivor');
  });

  it('coerces a missing members array on legacy state load', async () => {
    const legacy = {
      projects: [{
        id: null, pubkey: null, created_at: 1000, kind: 30078, sig: null,
        tags: [['d', 'legacy']],
        content: { slug: 'legacy', name: 'Legacy', description: '', source: 'local', status: 'active', createdAt: 1000, tagList: [] },
      }],
      sessions: [], milestones: [], todos: [], files: [],
    };
    const stub = makeStorageStub();
    stub.setItem('continuum.v1', JSON.stringify(legacy));
    globalThis.localStorage = stub;
    vi.resetModules();
    const store2 = await import('./store.js');
    store2.initStore();
    expect(store2.listMembers()).toEqual([]);
    // And the coerced array is writable.
    store2.addMember({ npub: HEX_A });
    expect(store2.listMembers()).toHaveLength(1);
  });

  it('does not cascade members on deleteProject (roster is global)', () => {
    store.addMember({ npub: HEX_A });
    store.deleteProject('continuum');
    expect(store.listMembers()).toHaveLength(1);
  });
});
