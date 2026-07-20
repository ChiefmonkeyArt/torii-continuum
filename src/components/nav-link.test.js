/**
 * NavLink — real anchors that transition in-SPA (v0.2.86-alpha, Item 3).
 *
 * The repo runs vitest with the node environment (no jsdom), so NavLink is
 * exercised against the same minimal DOM shim the view tests use, and the
 * router is mocked so we can assert what a click routes to without a real hash
 * write. navClickTarget is a pure function and is tested directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const navigate = vi.fn();
vi.mock('../router.js', () => ({ navigate: (...a) => navigate(...a) }));

import { NavLink, navClickTarget } from './nav-link.js';

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
    get firstChild() { return this.children[0] || null; },
    dispatch(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
  };
  return el;
}

function clickEvent(overrides = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() { this.defaultPrevented = true; },
    ...overrides,
  };
}

beforeEach(() => {
  navigate.mockReset();
  global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
    location: { hash: '#/dashboard' },
  };
});

afterEach(() => {
  delete global.document;
});

describe('navClickTarget — when to intercept vs. defer to the browser', () => {
  it('returns the router target (href minus #) for a plain left click', () => {
    expect(navClickTarget(clickEvent(), '#/projects')).toBe('/projects');
    expect(navClickTarget(clickEvent(), '#/demo/team')).toBe('/demo/team');
  });

  it('defers to the browser for modifier clicks (new tab / window / download)', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      expect(navClickTarget(clickEvent({ [mod]: true }), '#/projects')).toBeNull();
    }
  });

  it('defers for non-primary buttons (middle / right click)', () => {
    expect(navClickTarget(clickEvent({ button: 1 }), '#/projects')).toBeNull();
    expect(navClickTarget(clickEvent({ button: 2 }), '#/projects')).toBeNull();
  });

  it('honours an already-prevented event and ignores non-hash hrefs', () => {
    expect(navClickTarget(clickEvent({ defaultPrevented: true }), '#/projects')).toBeNull();
    expect(navClickTarget(clickEvent(), 'https://routstr.com')).toBeNull();
    expect(navClickTarget(clickEvent(), '/api/thing')).toBeNull();
  });
});

describe('NavLink — real anchor element', () => {
  it('renders an <a> with the href and content', () => {
    const a = NavLink({ href: '#/projects', children: ['Projects'], class: 'crumb' });
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('#/projects');
    expect(a.className).toBe('crumb');
    expect(a.textContent).toBe('Projects');
  });

  it('carries aria-label, title and dataset through', () => {
    const a = NavLink({ href: '#/team', children: ['Team'], ariaLabel: 'Team', title: 'Go to team', dataset: { path: '/team' } });
    expect(a.getAttribute('aria-label')).toBe('Team');
    expect(a.getAttribute('title')).toBe('Go to team');
    expect(a.dataset.path).toBe('/team');
  });
});

describe('NavLink — click behaviour', () => {
  it('intercepts a plain left click and routes in-SPA (no full reload)', () => {
    const a = NavLink({ href: '#/projects', children: ['Projects'] });
    const ev = clickEvent();
    a.dispatch('click', ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/projects');
  });

  it('fires the onNavigate hook with the router target', () => {
    const onNavigate = vi.fn();
    const a = NavLink({ href: '#/dashboard', children: ['Dashboard'], onNavigate });
    a.dispatch('click', clickEvent());
    expect(onNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('lets a ⌘/Ctrl-click through to the browser (opens a new tab)', () => {
    const a = NavLink({ href: '#/projects', children: ['Projects'] });
    const ev = clickEvent({ metaKey: true });
    a.dispatch('click', ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('NavLink — demoAware composed at construction', () => {
  it('keeps the href inside /demo while browsing the mockup', () => {
    global.document.location.hash = '#/demo/dashboard';
    const a = NavLink({ href: '#/projects', children: ['Projects'] });
    expect(a.getAttribute('href')).toBe('#/demo/projects');
    a.dispatch('click', clickEvent());
    expect(navigate).toHaveBeenCalledWith('/demo/projects');
  });

  it('leaves the href unchanged outside demo mode', () => {
    global.document.location.hash = '#/dashboard';
    const a = NavLink({ href: '#/projects', children: ['Projects'] });
    expect(a.getAttribute('href')).toBe('#/projects');
  });
});
