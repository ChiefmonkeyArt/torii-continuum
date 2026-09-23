// One-time operator-authorized activation. Never prints configuration contents.
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { isDeepStrictEqual } from 'node:util';

export async function setPaymentMode(mode, {
  path = '/apps/continuum/agent/repo/agent/config.yaml',
  backupDir = '/root/continuum-payment-backups',
} = {}) {
  if (!['x_cashu', 'ephemeral_bearer'].includes(mode)) throw new Error('Invalid payment mode');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Config must be a regular file');
  const original = await readFile(path, 'utf8');
  const doc = parseDocument(original);
  if (doc.errors.length) throw new Error('Invalid configuration YAML');
  const before = doc.toJS();
  if (!before?.routstr || typeof before.routstr !== 'object' || Array.isArray(before.routstr))
    throw new Error('Missing routstr configuration');
  const previous = before.routstr.payment_mode || 'x_cashu';
  if (!['x_cashu', 'ephemeral_bearer'].includes(previous)) throw new Error('Unknown current payment mode');
  if (previous === mode) return { changed: false, previous, mode };
  doc.setIn(['routstr', 'payment_mode'], mode);
  const output = String(doc);
  const after = parseDocument(output).toJS();
  delete before.routstr.payment_mode;
  delete after.routstr.payment_mode;
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
  return { changed: true, previous, mode, backup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) { console.error('One payment mode is required'); process.exit(1); }
  try { console.log(JSON.stringify(await setPaymentMode(process.argv[2]))); }
  catch { console.error('Payment-mode activation failed; configuration values were not printed.'); process.exit(1); }
}
