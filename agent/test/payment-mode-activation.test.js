import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { setPaymentMode } from '../ops/set-payment-mode.mjs';

async function fixture(fn, text = '# keep comment\nsession_secret: test-private-value\nroutstr:\n  models: {chat: deepseek-v3.2}\n  limits: {max_sats_per_request: 50}\n') {
  const dir = await mkdtemp(join(tmpdir(), 'payment-activate-'));
  const path = join(dir, 'config.yaml'), backupDir = join(dir, 'backups');
  await writeFile(path, text, { mode: 0o600 });
  try { await fn({ path, backupDir, dir, original: text }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('activation preserves model, caps, secrets, comments and ownership; private backup is exact', async () => fixture(async f => {
  const before = await stat(f.path);
  const result = await setPaymentMode('ephemeral_bearer', f);
  const output = await readFile(f.path, 'utf8');
  assert.equal(parse(output).routstr.payment_mode, 'ephemeral_bearer');
  assert.equal(parse(output).routstr.models.chat, 'deepseek-v3.2');
  assert.equal(parse(output).routstr.limits.max_sats_per_request, 50);
  assert.equal(parse(output).session_secret, 'test-private-value');
  assert.ok(output.includes('# keep comment'));
  assert.equal(await readFile(result.backup, 'utf8'), f.original);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.equal((await stat(f.backupDir)).mode & 0o777, 0o700);
  assert.equal((await stat(f.path)).uid, before.uid);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes('test-private-value'));
}));

test('same-mode activation is a no-op; explicit rollback preserves all other fields', async () => fixture(async f => {
  await setPaymentMode('ephemeral_bearer', f);
  assert.equal((await setPaymentMode('ephemeral_bearer', f)).changed, false);
  assert.equal((await readdir(f.backupDir)).length, 1);
  await setPaymentMode('x_cashu', f);
  const current = parse(await readFile(f.path, 'utf8'));
  assert.equal(current.routstr.payment_mode, 'x_cashu');
  assert.equal(current.routstr.models.chat, 'deepseek-v3.2');
}));

test('invalid mode cannot alter configuration', async () => fixture(async f => {
  await assert.rejects(setPaymentMode('automatic', f));
  assert.equal(await readFile(f.path, 'utf8'), f.original);
}));

test('malformed YAML and missing routstr block fail closed', async () => {
  for (const text of ['routstr: [broken', 'session_secret: value\n']) {
    await fixture(async f => {
      await assert.rejects(setPaymentMode('ephemeral_bearer', f));
      assert.equal(await readFile(f.path, 'utf8'), f.original);
    }, text);
  }
});

test('config symlink and public backup directory are refused', async () => fixture(async f => {
  const alias = join(f.dir, 'alias.yaml');
  await symlink(f.path, alias);
  await assert.rejects(setPaymentMode('ephemeral_bearer', { ...f, path: alias }));
  await mkdir(f.backupDir, { mode: 0o755 });
  await assert.rejects(setPaymentMode('ephemeral_bearer', f));
  assert.equal(await readFile(f.path, 'utf8'), f.original);
}));
