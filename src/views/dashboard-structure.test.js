/**
 * Dashboard Providers card — never-blank guarantee (v0.2.49-alpha).
 *
 * Regression guard for the v0.2.48 live defect: the Providers panel rendered its
 * "Polling every 20s" header but an empty body. Root cause was ordering — the
 * first tickProvider() ran synchronously inside ProviderCard() before the card
 * was appended, so body.isConnected was false and the tick bailed, leaving the
 * body empty until the first 20s interval fired.
 *
 * Source-structure assertions (the repo's tests run without a DOM), mirroring
 * board-structure.test.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dashSrc = readFileSync(join(here, 'dashboard.js'), 'utf8');

describe('dashboard Providers card — renders immediately, ticks once connected', () => {
  it('shows a synchronous placeholder so the body is never blank', () => {
    expect(dashSrc).toMatch(/Checking providers…/);
  });

  it('defers the first tick to a microtask (card is appended by then)', () => {
    expect(dashSrc).toMatch(/queueMicrotask\(\(\) => tickProvider\(body\)\)/);
  });

  it('does not fire an eager synchronous first tick that would bail pre-append', () => {
    // The old code called `tickProvider(body);` on its own line before append.
    expect(dashSrc).not.toMatch(/\n\s*tickProvider\(body\);\s*\n/);
  });

  it('still polls on an interval', () => {
    expect(dashSrc).toMatch(/setInterval\(\(\) => tickProvider\(body\), POLL_INTERVAL_MS\)/);
  });
});
