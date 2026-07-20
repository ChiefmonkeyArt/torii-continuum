/**
 * Demo-mode helpers (v0.2.85-alpha).
 *
 * These lock the tiny demo/real fork that keeps demo-capable views from
 * duplicating code:
 *   • isDemo(opts)            — truthy only when opts.demo is set;
 *   • demoSource(opts, store) — the fixtures facade in demo, else the real store;
 *   • demoPath(opts, path)    — keeps in-app links inside the /demo subtree;
 *   • demoBanner()            — the persistent, obviously-fake-data banner whose
 *                               sign-in control routes to the real login page.
 *
 * The repo runs vitest with the node environment (no jsdom), so demoBanner() is
 * rendered against the same minimal DOM shim the other view tests use, and the
 * router is mocked so we can assert the sign-in control routes to '/'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const navigate = vi.fn();
vi.mock('../router.js', () => ({ navigate: (...a) => navigate(...a) }));

import {
  isDemo, demoSource, demoPath, demoBanner, goToLogin,
  demoAware, demoIntercept, openLoginModal, renderDemoStub,
} from './demo-mode.js';
import { demoStore } from './demo-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const readMain = () => readFileSync(join(here, '..', 'main.js'), 'utf8');

// ── Minimal DOM shim (only what h() calls) ──────────────────────────
function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    className: '',
    _text: '',
    dataset: {},
    parentNode: null,
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent ?? '').join('');
      return this._text;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    click() { (listeners.click || []).forEach((fn) => fn({ target: el, stopPropagation() {} })); },
    get firstChild() { return this.children[0] || null; },
  };
  return el;
}

function walk(el, out = []) {
  out.push(el);
  for (const c of el.children || []) if (c && c.children) walk(c, out);
  return out;
}

beforeEach(() => {
  navigate.mockReset();
  global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
  };
});

afterEach(() => {
  delete global.document;
});

describe('isDemo', () => {
  it('is truthy only when opts.demo is set', () => {
    expect(isDemo({ demo: true })).toBe(true);
    expect(isDemo({ demo: false })).toBe(false);
    expect(isDemo({})).toBe(false);
    expect(isDemo()).toBe(false);
    expect(isDemo(null)).toBe(false);
  });
});

describe('demoSource', () => {
  const realStore = { listProjects: () => ['real'] };

  it('returns the real store when not in demo mode', () => {
    expect(demoSource({}, realStore)).toBe(realStore);
    expect(demoSource(undefined, realStore)).toBe(realStore);
  });

  it('returns the fixtures facade in demo mode (opts.fixtures, else demoStore)', () => {
    expect(demoSource({ demo: true, fixtures: demoStore }, realStore)).toBe(demoStore);
    // Falls back to the module demoStore when no fixtures are supplied.
    expect(demoSource({ demo: true }, realStore)).toBe(demoStore);
  });
});

describe('demoPath', () => {
  it('prefixes /demo only while browsing the mockup', () => {
    expect(demoPath({ demo: true }, '/projects/acme')).toBe('/demo/projects/acme');
    expect(demoPath({ demo: true }, '/marketplace')).toBe('/demo/marketplace');
    expect(demoPath({}, '/projects/acme')).toBe('/projects/acme');
    expect(demoPath(undefined, '/team')).toBe('/team');
  });
});

describe('goToLogin', () => {
  it('routes to the real login surface at root', () => {
    goToLogin();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('demoBanner', () => {
  it('renders an obviously-fake-data notice tagged DEMO MODE', () => {
    const el = demoBanner();
    expect(el.className).toBe('demo-banner');
    expect(el.getAttribute('role')).toBe('status');
    const tag = walk(el).find((e) => e.className === 'demo-banner-tag');
    expect(tag.textContent).toBe('DEMO MODE');
    // The banner as a whole advertises that the data is fake.
    expect(el.textContent).toMatch(/fake data/i);
  });

  it('exposes a sign-in control that routes to the real login page', () => {
    const el = demoBanner();
    const link = walk(el).find((e) => e.tagName === 'BUTTON');
    expect(link).toBeTruthy();
    expect(link.textContent).toMatch(/sign in/i);
    link.click();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('demoAware — keep hash hrefs inside the /demo subtree while browsing it', () => {
  afterEach(() => { delete global.document.location; });

  it('prefixes /demo when the current view is a demo screen', () => {
    global.document.location = { hash: '#/demo/dashboard' };
    expect(demoAware('#/projects')).toBe('#/demo/projects');
    expect(demoAware('#/routstr')).toBe('#/demo/routstr');
  });

  it('leaves the href unchanged when not on a demo screen', () => {
    global.document.location = { hash: '#/dashboard' };
    expect(demoAware('#/projects')).toBe('#/projects');
  });

  it('never double-prefixes an already-demo href, and leaves the login CTA (#/) alone', () => {
    global.document.location = { hash: '#/demo/routstr' };
    expect(demoAware('#/demo/team')).toBe('#/demo/team');
    expect(demoAware('#/')).toBe('#/');
  });

  it('leaves non-hash / external hrefs untouched even in demo mode', () => {
    global.document.location = { hash: '#/demo' };
    expect(demoAware('https://routstr.com')).toBe('https://routstr.com');
    expect(demoAware('/api/thing')).toBe('/api/thing');
  });
});

describe('openLoginModal / demoIntercept — mutating CTAs route to login in demo', () => {
  it('openLoginModal routes to the real login surface at root', () => {
    openLoginModal();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('demoIntercept opens login instead of firing the action in demo mode', () => {
    const action = vi.fn();
    const handler = demoIntercept({ demo: true }, action);
    handler('arg');
    expect(action).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('demoIntercept runs the real action (with args) outside demo mode', () => {
    const action = vi.fn(() => 'ran');
    const handler = demoIntercept({ demo: false }, action);
    const out = handler('a', 'b');
    expect(action).toHaveBeenCalledWith('a', 'b');
    expect(out).toBe('ran');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('accepts a bare boolean demo flag too', () => {
    const action = vi.fn();
    demoIntercept(true, action)();
    expect(action).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('renderDemoStub — banner + one fake card + sign-in CTA', () => {
  it('renders the demo banner, a titled fake card, and a login CTA', () => {
    const mount = makeEl('div');
    renderDemoStub(mount, { demo: true }, { title: 'Settings' });
    const nodes = walk(mount);
    expect(nodes.find((e) => e.className === 'demo-banner')).toBeTruthy();
    expect(nodes.find((e) => e.className === 'page-title')?.textContent).toBe('Settings');
    const cta = nodes.find((e) => e.tagName === 'BUTTON');
    expect(cta.textContent).toMatch(/sign in/i);
    cta.click();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});

describe('src/main.js — every required demo route is registered (nav wiring)', () => {
  const main = readMain();
  const REQUIRED = [
    '/demo', '/demo/dashboard', '/demo/projects', '/demo/projects/:slug',
    '/demo/marketplace', '/demo/routstr', '/demo/team',
    '/demo/genesis', '/demo/memory', '/demo/settings', '/demo/health',
  ];
  for (const pattern of REQUIRED) {
    it(`registers ${pattern}`, () => {
      const re = new RegExp(`route\\(\\s*'${pattern.replace(/[/:]/g, (m) => '\\' + m)}'\\s*,\\s*demoRoute`);
      expect(main).toMatch(re);
    });
  }

  it('the sidebar navigation is demo-aware (no guarded bounce while in the mockup)', () => {
    const shell = readFileSync(join(here, '..', 'shell.js'), 'utf8');
    expect(shell).toContain("import { demoAware } from './demo/demo-mode.js'");
    // Nav items are real anchors whose href is baked demo-aware at render time.
    expect(shell).toMatch(/demoAware\('#' \+ n\.path\)/);
  });

  it('the sidebar renders nav items as real anchors that intercept plain clicks', () => {
    const shell = readFileSync(join(here, '..', 'shell.js'), 'utf8');
    expect(shell).toContain("import { navClickTarget } from './components/nav-link.js'");
    // <a class="nav-item" href=…> not a role=button div.
    expect(shell).toMatch(/<a class="nav-item/);
    expect(shell).toMatch(/navClickTarget\(e, el\.getAttribute\('href'\)\)/);
  });
});
