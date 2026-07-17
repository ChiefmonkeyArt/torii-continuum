/**
 * Guards the build-time version stamp (v0.2.57-alpha+):
 *   1. `appVersion()` reflects the real package.json version via the Vite/
 *      vitest `__APP_VERSION__` define (proves the define is wired end-to-end).
 *   2. The sidebar footer renders the stamp via textContent (data-app-version
 *      placeholder + appVersion()), visible to logged-in and demo users alike.
 *   3. The login card still surfaces the version in its eyebrow.
 * These are source-structure assertions where a DOM would be needed, matching
 * the repo's jsdom-free test convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appVersion } from './shell.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const read = (p) => readFileSync(join(here, p), 'utf8');

describe('appVersion()', () => {
  it('returns the package version with a leading v', () => {
    expect(appVersion()).toBe(`v${pkg.version}`);
  });

  it('matches the v0.2.x-alpha shape', () => {
    expect(appVersion()).toMatch(/^v\d+\.\d+\.\d+/);
  });
});

describe('sidebar version stamp (source structure)', () => {
  const shell = read('shell.js');

  it('renders a version placeholder in the sidebar footer', () => {
    expect(shell).toContain('data-app-version');
    expect(shell).toMatch(/sidebar-footer[\s\S]*data-app-version/);
  });

  it('fills the placeholder via textContent (never innerHTML)', () => {
    expect(shell).toContain('.textContent = appVersion()');
  });
});

describe('login card version stamp (source structure)', () => {
  it('surfaces the build-time version in the login eyebrow', () => {
    expect(read('views/login.js')).toContain('__APP_VERSION__');
  });
});
