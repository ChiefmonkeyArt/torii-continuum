// Owner-selected chat model. No credentials, provider URLs or spending caps.
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { agentRoot } from './config.mjs';

export const validModelId = id => typeof id === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id);

export async function createChatModelSettings(cfg, {
  path = join(agentRoot(), 'memory', 'chat-model.json'),
} = {}) {
  let selected = null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw.schema !== 1 || !validModelId(raw.model)) throw new Error('Invalid saved chat model');
    selected = raw.model;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fallback = cfg.routstr?.models?.chat || 'auto';
  let gate = Promise.resolve();
  return {
    override: () => selected,
    current: () => selected || fallback,
    async save(model) {
      if (!validModelId(model)) throw new Error('Invalid model');
      const prior = gate;
      let unlock; gate = new Promise(resolve => { unlock = resolve; }); await prior;
      const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const fh = await open(temp, 'wx', 0o600);
        try { await fh.writeFile(JSON.stringify({ schema: 1, model }) + '\n'); await fh.sync(); }
        finally { await fh.close(); }
        await rename(temp, path);
        const dir = await open(dirname(path), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
        selected = model; // Apply only after durable persistence, next turn.
        return { ok: true, selected_model: selected };
      } finally {
        try { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        finally { unlock(); }
      }
    },
  };
}
