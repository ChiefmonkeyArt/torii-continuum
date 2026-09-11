/**
 * Hash-chained append-only audit ledger (GENESIS-1).
 *
 * Verifies: appends chain (each prev == previous hash, seed for the first);
 * verify() passes on a well-formed chain; a partial edit (the realistic attack:
 * one incriminating line silently changed or removed) breaks the chain and is
 * detected; concurrent appends serialize without forking; the file is 0600.
 *
 * This is tamper EVIDENCE, not tamper PROOFING — the owner can always rewrite
 * and re-chain the whole file. The property under test is that a PARTIAL edit
 * cannot go unnoticed.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile as realAppendFile, readFile as realReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAudit } from '../lib/audit.mjs';

function tmpPath() {
  const dir = mkdtempSync(join(tmpdir(), 'torii-audit-'));
  return { dir, path: join(dir, 'memory', 'audit.jsonl') };
}

test('appends form a verifiable chain with sequential seqs', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    const a = await audit.append('genesis.create', { bot_id: 'aaaa' });
    const b = await audit.append('genesis.create', { bot_id: 'bbbb' });
    assert.equal(a.seq, 0);
    assert.equal(b.seq, 1);
    assert.equal(b.prev, a.hash); // chained
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify detects a silently edited line', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    await audit.append('genesis.create', { bot_id: 'aaaa' });
    await audit.append('genesis.create', { bot_id: 'bbbb' });
    // Tamper: edit the payload of the first line without recomputing hashes.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    first.bot_id = 'evil';
    lines[0] = JSON.stringify(first);
    writeFileSync(path, lines.join('\n') + '\n');
    const v = await audit.verify();
    assert.equal(v.ok, false);
    assert.equal(v.seq, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify detects a removed line (chain break)', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    await audit.append('e', { n: 1 });
    await audit.append('e', { n: 2 });
    await audit.append('e', { n: 3 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines.splice(1, 1); // drop the middle line
    writeFileSync(path, lines.join('\n') + '\n');
    const v = await audit.verify();
    assert.equal(v.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent appends serialize without forking the chain', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => audit.append('e', { n: i })),
    );
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit file is written 0600', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    await audit.append('e', { n: 1 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty log verifies as an ok chain of length 0', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected append does not poison the queue (invalid event then valid)', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit = createAudit(path);
    await assert.rejects(audit.append(123), /event tag required/);
    const a = await audit.append('e', { n: 1 });
    const b = await audit.append('e', { n: 2 });
    assert.equal(a.seq, 0);
    assert.equal(b.seq, 1);
    assert.equal(b.prev, a.hash);
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transient write failure recovers and keeps the chain intact', async () => {
  const { dir, path } = tmpPath();
  let failNext = false;
  const flakyAppendFile = async (p, data, opts) => {
    if (failNext) { failNext = false; throw new Error('EIO: transient disk error'); }
    return realAppendFile(p, data, opts);
  };
  try {
    const audit = createAudit(path, { appendFile: flakyAppendFile });
    const a = await audit.append('e', { n: 1 });
    failNext = true;
    await assert.rejects(audit.append('e', { n: 2 }), /EIO/);
    const b = await audit.append('e', { n: 3 });
    assert.equal(b.seq, 1);
    assert.equal(b.prev, a.hash);
    const v = await audit.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append reads the log at most once regardless of history length', async () => {
  const { dir, path } = tmpPath();
  let reads = 0;
  const countingReadFile = async (p, enc) => {
    reads += 1;
    return realReadFile(p, enc);
  };
  try {
    const audit = createAudit(path, { readFile: countingReadFile });
    for (let i = 0; i < 50; i++) await audit.append('e', { n: i });
    // The only read should be the initial tail load; every later append uses the
    // cached tail instead of re-reading the growing file (O(1) appends).
    assert.equal(reads, 1);
    await audit.verify(); // verify() intentionally re-reads the whole chain once
    assert.equal(reads, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh instance resumes the chain from the existing log', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit1 = createAudit(path);
    const a = await audit1.append('e', { n: 1 });
    const b = await audit1.append('e', { n: 2 });
    const audit2 = createAudit(path); // "restart"
    const c = await audit2.append('e', { n: 3 });
    assert.equal(c.seq, 2);
    assert.equal(c.prev, b.hash);
    const v = await audit2.verify();
    assert.equal(v.ok, true);
    assert.equal(v.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh instance fails closed on a corrupt tail', async () => {
  const { dir, path } = tmpPath();
  try {
    const audit1 = createAudit(path);
    await audit1.append('e', { n: 1 });
    writeFileSync(path, 'this line is not valid json\n', 'utf8');
    const audit2 = createAudit(path); // "restart" onto a corrupt tail
    await assert.rejects(audit2.append('e', { n: 2 }), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
