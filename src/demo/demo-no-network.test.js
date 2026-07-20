/**
 * Demo mode makes NO network calls (v0.2.85-alpha).
 *
 * The /demo/* surface is a signed-out, read-only mockup rendered from
 * obviously-fake fixtures. It must never touch src/data/agent.js — the agent
 * endpoints are admin-gated and there is no session, so a demo render that
 * called them would 401 (and defeat the point of an offline mockup).
 *
 * This mounts the REAL renderDashboard against a minimal DOM shim (the repo runs
 * vitest with the node environment, no jsdom) in demo mode and asserts that not
 * one agent client function was invoked. agent.js and chat.js are mocked so the
 * assertion is exact and the render stays hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Spy on every agent client entry point the dashboard could reach. If demo mode
// leaks a network call, one of these registers it. vi.hoisted so the object is
// available inside the hoisted vi.mock factory below.
const agentSpies = vi.hoisted(() => {
  const stub = () => vi.fn(() => Promise.resolve({ ok: false, reason: 'should-not-be-called' }));
  return {
    isAgentConfigured: vi.fn(() => true),
    isLoggedIn: vi.fn(() => false),
    healthModels: stub(),
    walletHealth: stub(),
    // Routstr-reachable client methods — every mutating CTA in the demo view
    // must leave all of these untouched.
    walletBalance: stub(),
    walletReceive: stub(),
    walletMintQuote: stub(),
    walletMintQuoteStatus: stub(),
    walletNwcInvoice: stub(),
    walletNwcInvoiceStatus: stub(),
    nwcStatus: stub(),
    nwcConnect: stub(),
    nwcTest: stub(),
    nwcDisconnect: stub(),
  };
});
vi.mock('../data/agent.js', () => agentSpies);
vi.mock('../chat.js', () => ({ setChatContext: vi.fn() }));
// The banner's sign-in control uses the router; stub it so no real hash write.
vi.mock('../router.js', () => ({ navigate: vi.fn() }));

import { renderDashboard } from '../views/dashboard.js';
import { renderRoutstr } from '../views/routstr.js';
import { demoStore } from './demo-fixtures.js';

// ── Minimal DOM shim (only what h()/clear() call) ───────────────────
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
    isConnected: true,
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
    click() { (listeners.click || []).forEach((fn) => fn({ target: el, stopPropagation() {}, preventDefault() {} })); },
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
  for (const fn of Object.values(agentSpies)) fn.mockClear();
  global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
  };
});

afterEach(() => {
  delete global.document;
});

describe('renderDashboard in demo mode', () => {
  it('renders the mockup without invoking any agent client function', () => {
    const mount = makeEl('div');
    renderDashboard(mount, { demo: true, fixtures: demoStore });

    // Not one agent call — no health probe, no wallet probe, no login/config
    // check driving a network path.
    expect(agentSpies.healthModels).not.toHaveBeenCalled();
    expect(agentSpies.walletHealth).not.toHaveBeenCalled();

    // Sanity: the demo banner actually rendered (so we know the view ran, not
    // that it short-circuited before the network-bearing section).
    const banner = walk(mount).find((e) => e.className === 'demo-banner');
    expect(banner).toBeTruthy();

    // And the fixture-derived heading is present.
    const title = walk(mount).find((e) => e.className === 'page-title');
    expect(title && title.textContent).toBe('Dashboard');
  });
});

describe('renderRoutstr in demo mode — mutating CTAs never reach the agent', () => {
  it('renders from fixtures and no CTA click invokes an agent client method', () => {
    const mount = makeEl('div');
    renderRoutstr(mount, { demo: true, fixtures: demoStore });

    // The banner proves the demo view ran (not a short-circuit before the CTAs).
    expect(walk(mount).find((e) => e.className === 'demo-banner')).toBeTruthy();

    // Click every button on the view — Connect/Top Up/Sign in/Disconnect etc.
    // In demo each is wrapped by demoIntercept, so it routes to login instead of
    // firing a handler that would touch the agent.
    for (const btn of walk(mount).filter((e) => e.tagName === 'BUTTON')) btn.click();

    // Not one agent client method was called by the render or any CTA.
    for (const [name, spy] of Object.entries(agentSpies)) {
      if (name === 'isAgentConfigured' || name === 'isLoggedIn') continue; // pure guards
      expect(spy, `agent.${name} must not be called in demo`).not.toHaveBeenCalled();
    }
  });
});
