/**
 * Version drift guard (deploy health-gate protection).
 *
 * The ansible deploy's health gate compares the deployed git tag against the
 * version the agent self-reports at GET /api/health. That reported string comes
 * from agent/package.json (index.mjs reads it once at boot into VERSION). A past
 * release bumped the ROOT package.json but not the agent's, so /api/health kept
 * reporting the previous version and the gate failed + rolled back the deploy.
 *
 * These tests assert the two package.json versions stay identical, so a future
 * bump can't drift them apart again. They read agent/package.json the same way
 * index.mjs does — no live server, deterministic.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(AGENT_ROOT, '..');

async function readVersion(pkgPath) {
  const raw = await readFile(pkgPath, 'utf8');
  return JSON.parse(raw).version;
}

test('agent /api/health version source matches the root package.json version', async () => {
  const agentVersion = await readVersion(join(AGENT_ROOT, 'package.json'));
  const rootVersion = await readVersion(join(REPO_ROOT, 'package.json'));

  assert.equal(
    agentVersion,
    rootVersion,
    `agent version (${agentVersion}) must equal root version (${rootVersion}); ` +
      'the deploy health gate compares the agent /api/health version to the deployed tag',
  );
});

test('agent version is a non-empty string (so /api/health never reports "unknown")', async () => {
  const agentVersion = await readVersion(join(AGENT_ROOT, 'package.json'));
  assert.equal(typeof agentVersion, 'string');
  assert.ok(agentVersion.length > 0);
});
