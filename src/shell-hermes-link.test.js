/**
 * Hermes launcher link (v0.2.138-alpha): the Continuum sidebar opens the
 * same-origin Hermes dashboard at /hermes/ — full-page navigation, NOT an
 * internal hash route — and only on a configured install (never the /demo
 * mockup). The Nostr session gate on /hermes/ re-checks the current Continuum
 * session, so the link inherits the operator's identity with no second login.
 *
 * Source-structure assertions, matching the repo's jsdom-free convention:
 * the link's exact shape (absolute path, non-hash, non-demo) is a load-bearing
 * guarantee — a regression to a `#/hermes` hash href or a demoAware() wrap
 * would silently break the launch and turn red here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, 'shell.js'), 'utf8');

describe('Hermes launcher link (source structure)', () => {
  it('links to the absolute same-origin /hermes/ path — never an internal hash route', () => {
    expect(shell).toContain('href="/hermes/"');
    expect(shell).not.toContain('href="#/hermes"');
    expect(shell).not.toContain("demoAware('#/hermes");
  });

  it('is gated on a configured install so it never appears in the demo mockup', () => {
    // The conditional wraps the link and only emits it when the agent URL is set.
    expect(shell).toMatch(/isAgentConfigured\(\)\s*\?[\s\S]*?\/hermes\//);
  });

  it('carries an accessible label naming Hermes', () => {
    expect(shell).toContain('aria-label="Open Hermes (owner brain)"');
  });
});