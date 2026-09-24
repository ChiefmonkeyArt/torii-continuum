/**
 * Private history. Titles, pins and project associations remain inside the
 * existing sealed session blob. No new plaintext persistence or relay writes.
 * Injected transport/identity makes delayed sign-out and conflicting-tab writes
 * testable without a signer or a paid model call.
 */
import { sessionIdFor } from './chat-threads.js';
import { sessionMetadata } from './session-crypto.js';

export function createSessionLibrary(deps) {
  let owner = null, generation = 0, pending = null, loaded = false, error = '';
  let records = new Map();
  const listeners = new Set(), queues = new Map(), removed = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  const valid = (epoch) => epoch === generation && owner === deps.identity() && !!owner;
  function reset() {
    generation++; owner = deps.identity(); records = new Map(); queues.clear(); removed.clear();
    loaded = false; pending = null; error = ''; notify();
  }
  function checkOwner() { if (owner !== deps.identity()) reset(); }
  function rows() {
    checkOwner();
    return [...records.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }
  function status() { return { loading: !!pending, loaded, error }; }
  async function load() {
    checkOwner();
    if (!owner) return [];
    if (pending) return pending;
    if (loaded) return rows();
    const epoch = generation;
    pending = (async () => {
      try {
        const result = await deps.list();
        if (!valid(epoch)) return [];
        if (!result.ok) throw new Error('History could not be loaded. Please retry.');
        if (result.data?.index_corrupt) throw new Error('History needs repair. Existing conversations have not been changed.');
        for (const rec of result.data?.sessions || []) records.set(rec.id, { ...rec, locked: true });
        notify();
        // Sequential signer calls avoid concurrent extension permission prompts.
        for (const rec of [...records.values()]) {
          if (!valid(epoch)) return [];
          try {
            const r = await deps.read(rec.id);
            if (!valid(epoch)) return [];
            if (!r.ok) continue;
            const decoded = await deps.unseal(r.data.ciphertext);
            if (!valid(epoch)) return [];
            if (sessionIdFor(decoded.threadKey) !== rec.id) continue;
            const metadata = sessionMetadata(decoded.metadata || {
              project: decoded.threadKey.startsWith('project:') ? decoded.threadKey.slice(8) : null,
            });
            records.set(rec.id, { ...rec, ...decoded, metadata, locked: false });
            notify();
          } catch { /* Unreadable ciphertext is retained, never overwritten. */ }
        }
        loaded = true;
        return rows();
      } catch (e) {
        if (valid(epoch)) error = e.message;
        return [];
      } finally {
        if (valid(epoch)) { pending = null; notify(); }
      }
    })();
    return pending;
  }
  function write(key, change) {
    checkOwner();
    const epoch = generation, id = sessionIdFor(key);
    const work = (queues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      await load();
      if (!valid(epoch)) throw new Error('Your sign-in changed. Please reopen the conversation.');
      if (removed.has(id)) throw new Error('This conversation was deleted. Start a new chat.');
      if (!loaded || error) throw new Error(error || 'History is unavailable.');
      const old = records.get(id);
      if (old?.locked) throw new Error('Unlock this conversation with your signer before changing it.');
      const next = change(old || { id, threadKey: key, messages: [], metadata: sessionMetadata() });
      const ciphertext = await deps.seal(next);
      if (!valid(epoch)) throw new Error('Your sign-in changed. Nothing was saved.');
      const r = await deps.save(id, ciphertext, old?.sha256 ?? null);
      if (!valid(epoch)) throw new Error('Your sign-in changed.');
      if (!r.ok) throw new Error(r.data?.code === 'conflict' || r.code === 'conflict'
        ? 'This conversation changed in another tab. Reload before continuing.'
        : 'Could not save this conversation. Keep this tab open and retry.');
      records.set(id, { ...next, ...r.data, id, locked: false });
      notify();
      return records.get(id);
    });
    queues.set(id, work);
    work.finally(() => { if (queues.get(id) === work) queues.delete(id); }).catch(() => {});
    return work;
  }
  return {
    load, rows, status, reset,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    retry() { loaded = false; error = ''; return load(); },
    save(key, messages, metadata) {
      return write(key, old => ({ ...old, threadKey: key, messages,
        metadata: sessionMetadata({ ...old.metadata, ...metadata }) }));
    },
    patch(id, metadata) {
      const rec = records.get(id);
      if (!rec?.threadKey || rec.locked) return Promise.reject(new Error('This conversation is still locked.'));
      return write(rec.threadKey, old => ({ ...old,
        metadata: sessionMetadata({ ...old.metadata, ...metadata }) }));
    },
    async remove(id) {
      checkOwner();
      const epoch = generation;
      await (queues.get(id) || Promise.resolve()).catch(() => {});
      if (!valid(epoch)) throw new Error('Your sign-in changed.');
      const r = await deps.remove(id);
      if (!valid(epoch)) return;
      if (!r.ok) throw new Error('Could not delete this conversation.');
      removed.add(id);
      records.delete(id); notify();
    },
  };
}

export function historyTitle(record) {
  if (record.metadata?.title) return record.metadata.title;
  const first = record.messages?.find(m => m.who === 'user')?.text;
  if (first) return first.replace(/\s+/g, ' ').slice(0, 70);
  if (record.id === 'general') return 'General chat';
  if (record.id?.startsWith('project-')) return 'Project · ' + record.id.slice(8);
  if (record.id?.startsWith('page-')) return 'Page · ' + record.id.slice(5);
  return record.locked ? 'Locked conversation' : 'New conversation';
}
