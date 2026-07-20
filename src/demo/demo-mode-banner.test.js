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

const navigate = vi.fn();
vi.mock('../router.js', () => ({ navigate: (...a) => navigate(...a) }));

import { isDemo, demoSource, demoPath, demoBanner, goToLogin } from './demo-mode.js';
import { demoStore } from './demo-fixtures.js';

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
