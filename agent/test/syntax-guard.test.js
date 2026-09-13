/**
 * Entry-point + skill syntax guard.
 *
 * `node --test` only loads files that a test imports. The agent entry point
 * (`index.mjs`) and the dynamically-loaded skills (`skills/*.mjs`) are NOT on
 * that transitive path, which is exactly how a syntax error in `/api/chat`
 * shipped in v0.2.143-alpha and took the live agent down (502). This test
 * `node --check`s those blind spots so a syntax regression fails CI instead of
 * the deploy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function mjsFiles(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'test') continue;
    const p = join(dir, name.name);
    if (name.isDirectory()) mjsFiles(p, out);
    else if (name.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// The entry point plus every non-test .mjs reachable from the agent root — the
// files `import` never touches transitively from a test.
const files = [join(root, 'index.mjs'), ...mjsFiles(join(root, 'skills'))];

test('entry point + skills all parse (no syntax regressions)', () => {
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    const rel = f.slice(root.length + 1);
    assert.equal(r.status, 0, `syntax error in ${rel}:\n${r.stderr}`);
  }
});