import { describe, it, expect } from 'vitest';
import { createSessionLibrary, historyTitle } from './session-library.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fakeRecord(id = 'session-a') {
  return { id, created_at: 1, updated_at: 2, bytes: 8, sha256: 'old' };
}
function harness() {
  let identity = 'owner-a', releaseSave;
  const saves = [], removes = [];
  const api = {
    identity: () => identity,
    list: async () => ({ ok: true, data: { sessions: [fakeRecord()] } }),
    read: async () => ({ ok: true, data: { ciphertext: 'sealed' } }),
    unseal: async () => ({ threadKey: 'session-a', messages: [{ who: 'user', text: 'Build the workspace', at: 1 }], metadata: { pinned: false, project: 'torii' } }),
    seal: async value => JSON.stringify(value),
    save: async (...args) => { saves.push(args); return { ok: true, data: { ...fakeRecord(), sha256: 'new', updated_at: 3 } }; },
    remove: async id => { removes.push(id); return { ok: true }; },
  };
  const library = createSessionLibrary(api);
  return { library, api, saves, removes, setIdentity(v) { identity = v; }, holdSave() {
    api.save = (...args) => { saves.push(args); return new Promise(resolve => { releaseSave = resolve; }); };
    return result => releaseSave(result);
  } };
}

describe('private session library', () => {
  it('decrypts titles/pins/project only in the browser cache', async () => {
    const h = harness();
    await h.library.load();
    const [row] = h.library.rows();
    expect(row.locked).toBe(false);
    expect(row.metadata).toEqual({ title: '', pinned: false, project: 'torii' });
    expect(historyTitle(row)).toBe('Build the workspace');
  });

  it('persists pin metadata in the sealed blob using compare-and-swap', async () => {
    const h = harness();
    await h.library.load();
    await h.library.patch('session-a', { pinned: true });
    expect(h.saves[0][0]).toBe('session-a');
    expect(h.saves[0][2]).toBe('old');
    expect(JSON.parse(h.saves[0][1]).metadata.pinned).toBe(true);
  });

  it('drops delayed decrypt results after sign-out/owner change', async () => {
    const h = harness();
    let release;
    h.api.unseal = () => new Promise(resolve => { release = resolve; });
    const loading = h.library.load();
    await tick();
    h.setIdentity('owner-b');
    h.library.reset();
    release({ threadKey: 'session-a', messages: [], metadata: { pinned: true } });
    await loading;
    expect(h.library.rows()).toEqual([]);
  });

  it('serializes delete behind an in-flight save and prevents resurrection', async () => {
    const h = harness();
    await h.library.load();
    const release = h.holdSave();
    const saving = h.library.patch('session-a', { title: 'New title' });
    await tick();
    const deleting = h.library.remove('session-a');
    expect(h.removes).toEqual([]);
    release({ ok: true, data: { ...fakeRecord(), sha256: 'new' } });
    await saving; await deleting;
    expect(h.removes).toEqual(['session-a']);
    await expect(h.library.patch('session-a', { pinned: true })).rejects.toThrow(/locked|deleted/i);
  });

  it('surfaces a conflicting tab rather than silently overwriting', async () => {
    const h = harness();
    await h.library.load();
    h.api.save = async () => ({ ok: false, code: 'conflict' });
    await expect(h.library.patch('session-a', { pinned: true })).rejects.toThrow(/another tab/i);
  });
});
