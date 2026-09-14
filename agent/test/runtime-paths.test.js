/**
 * Audit A21 — runtime-path ignore coverage.
 *
 * Guards the agent/.gitignore so newly-added runtime state on disk can never be
 * accidentally committed: encrypted operator secrets and the scoped sealed
 * memory store (owners/bots/projects ciphertext + consent pending + quarantine).
 * A regressed ignore rule would leak ciphertext/credentials into git history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('A21: agent/.gitignore excludes runtime secret + scoped-memory paths', () => {
  // Runs from agent/ via `node --test`, so .gitignore is relative to cwd.
  const ignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
  for (const entry of ['memory/secrets/', 'memory/owners/', 'memory/procedural/']) {
    assert.ok(
      ignore.split('\n').some((l) => l.trim() === entry),
      `.gitignore must contain ${entry}`,
    );
  }
});