/**
 * OWNER-UI-4 — the Hermes Web Dashboard is retired. The sidebar no longer
 * mounts a third-party /hermes/ launcher: Continuum's own console is the sole
 * owner interface. This guard pins the retirement so a stray re-add of the
 * launcher link (or the now-dead icon) fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, 'shell.js'), 'utf8');

describe('Hermes launcher link (retired)', () => {
  it('no longer links to the retired /hermes/ dashboard', () => {
    expect(shell).not.toContain('href="/hermes/"');
  });

  it('drops the now-unused Hermes icon', () => {
    expect(shell).not.toContain('iconHermes');
  });
});