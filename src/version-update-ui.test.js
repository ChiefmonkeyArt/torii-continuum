/**
 * Source-structure + CSS assertions for the VERSION-UPDATE-1 and AUTH-DIRECT-1
 * UI surfaces (login card, sidebar, styles). jsdom-free, matching the repo
 * convention: we assert the wiring exists rather than rendering a DOM.
 *
 * Covered:
 *   • login card: inline status sink, non-interactive version display, direct
 *     startLogin({onStatus}) with no modal.
 *   • sidebar: version stamp retained, gated Update affordance (two-step confirm),
 *     reuse of the existing update client, reload-on-upgrade.
 *   • CSS: the classes both surfaces rely on exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

describe('login view (src/views/login.js) — direct login + version display', () => {
  const login = read('views/login.js');

  it('calls startLogin with an inline onStatus sink (no modal)', () => {
    expect(login).toMatch(/startLogin\(\{\s*onStatus\s*\}\)/);
    expect(login).not.toMatch(/openModal|showModal|LoginModal/);
  });

  it('renders an inline status region with aria-live for accessibility', () => {
    expect(login).toContain('login-inline-status');
    expect(login).toContain("'aria-live': 'polite'");
  });

  it('fetches the version summary and describes it non-interactively', () => {
    expect(login).toContain('versionInfo()');
    expect(login).toContain('describeVersionState');
  });

  it('shows the latest release without any unauthenticated update action', () => {
    // A non-interactive badge only — no button, no requestUpdate on this surface.
    expect(login).toContain('login-version-badge');
    expect(login).not.toContain('requestUpdate');
  });

  it('offers signer install links when the extension is missing', () => {
    expect(login).toContain('signerMissing');
  });
});

describe('sidebar (src/shell.js) — version stamp + gated Update affordance', () => {
  const shell = read('shell.js');

  it('retains the current version stamp in the footer', () => {
    expect(shell).toContain('data-app-version');
    expect(shell).toContain('.textContent = appVersion()');
  });

  it('has a hidden sidebar-update slot revealed only when newer', () => {
    expect(shell).toMatch(/data-sidebar-update/);
    expect(shell).toContain('refreshSidebarVersion');
  });

  it('only shows the Update affordance when logged in AND agent configured', () => {
    expect(shell).toMatch(/isAgentConfigured\(\)\s*\|\|\s*!isSessionLive\(\)|!isAgentConfigured\(\)\s*\|\|\s*!isSessionLive\(\)/);
  });

  it('gates the button on the server-reported newer state', () => {
    expect(shell).toContain('describeVersionState');
    expect(shell).toContain('updateTargetTag');
    expect(shell).toMatch(/state\.state !== 'newer'/);
  });

  it('uses a two-step arm→confirm before queuing the update (no modal)', () => {
    expect(shell).toContain('renderUpdateAffordance');
    expect(shell).toMatch(/armed/);
    expect(shell).toMatch(/Confirm update/);
  });

  it('reuses the existing update client and reloads once upgraded', () => {
    expect(shell).toContain('requestUpdate(tag)');
    expect(shell).toContain('pollForUpgrade');
    expect(shell).toMatch(/location(\?\.reload|\.reload)/);
  });

  it('passes an inline onStatus sink to sidebar login (no modal)', () => {
    expect(shell).toMatch(/startLogin\(\{\s*onStatus:/);
    expect(shell).toContain('data-login-status');
  });
});

describe('agent client (src/data/agent.js) — version/update methods', () => {
  const agent = read('data/agent.js');

  it('exposes a public versionInfo() reader', () => {
    expect(agent).toMatch(/export async function versionInfo\(\)/);
    expect(agent).toContain("req('GET', '/api/version')");
  });

  it('sends confirm:true when requesting an update', () => {
    expect(agent).toMatch(/export async function requestUpdate\(tag\)/);
    expect(agent).toContain("req('POST', '/api/update', { tag, confirm: true })");
  });

  it('exposes update status + cancel readers', () => {
    expect(agent).toMatch(/export async function updateStatus\(\)/);
    expect(agent).toMatch(/export async function cancelUpdate\(\)/);
  });
});

describe('styles (src/styles/landing.css) — new UI classes exist', () => {
  const css = read('styles/landing.css');

  it('styles the login inline status states', () => {
    expect(css).toContain('.login-inline-status');
    expect(css).toContain('.login-inline-status.error');
  });

  it('styles the non-interactive version badges', () => {
    expect(css).toContain('.login-version');
    expect(css).toContain('.login-version-badge');
  });

  it('styles the sidebar update affordance', () => {
    expect(css).toContain('.sidebar-update');
    expect(css).toContain('.sidebar-update-btn');
    expect(css).toContain('.sidebar-update-btn.armed');
  });

  it('hides the sidebar update slot until revealed', () => {
    expect(css).toContain('.sidebar-update[hidden]');
  });
});
