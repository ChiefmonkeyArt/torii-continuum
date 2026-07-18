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
