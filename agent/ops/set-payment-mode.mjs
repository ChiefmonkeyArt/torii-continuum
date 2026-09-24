// One-time operator-authorized activation. Never prints configuration contents.
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { validQuarantine } from '../core/provider-quarantine.mjs';

async function updateField(field, update, {
  path = '/apps/continuum/agent/repo/agent/config.yaml',
  backupDir = '/root/continuum-payment-backups',
} = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Config must be a regular file');
  const original = await readFile(path, 'utf8');
  const doc = parseDocument(original);
  if (doc.errors.length) throw new Error('Invalid configuration YAML');
  const before = doc.toJS();
  if (!before?.routstr || typeof before.routstr !== 'object' || Array.isArray(before.routstr))
    throw new Error('Missing routstr configuration');
  const previous = before.routstr[field];
  const value = update(previous);
  if (isDeepStrictEqual(previous, value)) return { changed: false, previous, value };
  doc.setIn(['routstr', field], value);
  const output = String(doc);
  const after = parseDocument(output).toJS();
  delete before.routstr[field];
  delete after.routstr[field];
  if (!isDeepStrictEqual(before, after)) throw new Error('Refusing unrelated config change');

  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backupDir);
  if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink() || (backupInfo.mode & 0o077))
    throw new Error('Backup directory must be private');
  const nonce = randomBytes(8).toString('hex');
  const backup = join(backupDir, `config-${Date.now()}-${nonce}.yaml`);
  const backupFile = await open(backup, 'wx', 0o600);
  try { await backupFile.writeFile(original); await backupFile.sync(); }
  finally { await backupFile.close(); }
  const backupDirectory = await open(backupDir, 'r');
  try { await backupDirectory.sync(); } finally { await backupDirectory.close(); }

  const temporary = `${path}.${nonce}.tmp`;
  try {
    const fh = await open(temporary, 'wx', 0o600);
    try {
      await fh.writeFile(output);
      await fh.chown(info.uid, info.gid);
      await fh.sync();
    } finally { await fh.close(); }
    // Refuse a concurrent operator edit between our read and replacement.
    const current = await lstat(path);
    if (current.ino !== info.ino || await readFile(path, 'utf8') !== original)
      throw new Error('Config changed concurrently; refusing overwrite');
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  return { changed: true, previous, value, backup };
}

export async function setPaymentMode(mode, options) {
  if (!['x_cashu', 'ephemeral_bearer'].includes(mode)) throw new Error('Invalid payment mode');
  const { value, previous, ...result } = await updateField('payment_mode', current => {
    if (!['x_cashu', 'ephemeral_bearer'].includes(current || 'x_cashu')) throw new Error('Unknown current payment mode');
    return mode;
  }, options);
  return { ...result, previous: previous || 'x_cashu', mode: value };
}

export async function quarantineProvider(base, options) {
  if (!validQuarantine([base])) throw new Error('Invalid provider origin');
  const { value, ...result } = await updateField('quarantined_providers', current => {
    const list = [...new Set([...(current || []), base])];
    if (!validQuarantine(list)) throw new Error('Invalid provider quarantine');
    return list;
  }, options);
  return { ...result, providers: value };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('One payment mode is required'); process.exit(1); }
  try { console.log(JSON.stringify(await setPaymentMode(process.argv[2]))); }
  catch { console.error('Payment-mode activation failed; configuration values were not printed.'); process.exit(1); }
}
