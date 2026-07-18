/**
 * Sign-out UX (v0.2.72-alpha): the "Sign out" control must open a local
 * confirmation modal and NEVER invoke a NIP-07 signer.
 *
 * Two layers:
 *   1. Behavioural tests that run confirmSignOut() against a tiny DOM shim (the
 *      repo runs without jsdom, so we shim only the handful of DOM calls that
 *      openModal + h() make). We assert: the modal opens with the right copy,
 *      Cancel is a no-op (session intact, no session-changed, no navigation),
 *      Yes clears both session keys and dispatches continuum:session-changed
 *      (the PR #82 handler routes that to the login modal), and window.nostr /
 *      NIP-07 is never touched on the sign-out path.
 *   2. Source-structure assertions locking in that the sidebar sign-out branch
 *      routes to confirmSignOut (not startLogin) and that the sign-out helpers
 *      contain no signer call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { confirmSignOut, signOutOutcomes } from './shell.js';
import { sessionChangeTarget, ROOT_PATH } from './nav-guard.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

const TOKEN_KEY = 'continuum.session.v1';
const ONBOARDING_KEY = 'torii.session';

// ── Minimal DOM shim (only what openModal + h() call) ───────────────
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

function findButton(root, label) {
  return walk(root).find((e) => e.tagName === 'BUTTON' && e.textContent === label);
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

let signerCalls;

beforeEach(() => {
  const body = makeEl('body');
  const docListeners = {};
  global.document = {
    body,
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    dispatchEvent(ev) { (docListeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  global.localStorage = new FakeStorage();
  signerCalls = { signEvent: 0, getPublicKey: 0 };
  global.window = {
    location: { origin: 'https://the-live-site.example', pathname: '/' },
    nostr: {
      signEvent: (...a) => { signerCalls.signEvent++; return Promise.resolve({ a }); },
      getPublicKey: () => { signerCalls.getPublicKey++; return Promise.resolve('pk'); },
    },
  };
});

afterEach(() => {
  delete global.document;
  delete global.CustomEvent;
  delete global.localStorage;
  delete global.window;
});

function backdrop() { return global.document.body.children[0]; }

describe('confirmSignOut — opens a local confirmation modal', () => {
  it('shows "Signing out?" with Yes and Cancel buttons', () => {
    confirmSignOut();
    const bd = backdrop();
    expect(bd).toBeTruthy();
    const heading = walk(bd).find((e) => e.tagName === 'H3');
    expect(heading.textContent).toBe('Signing out?');
    expect(findButton(bd, 'Yes')).toBeTruthy();
    expect(findButton(bd, 'Cancel')).toBeTruthy();
  });
});

describe('Cancel — no session clear, no navigation', () => {
  it('closes the modal but leaves both session keys intact and dispatches nothing', () => {
    localStorage.setItem(TOKEN_KEY, '1.9999999999.pk.sig');
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ token: 't' }));
    const onChange = vi.fn();
    document.addEventListener('continuum:session-changed', onChange);

    confirmSignOut();
    findButton(backdrop(), 'Cancel').click();

    // Session untouched.
    expect(localStorage.getItem(TOKEN_KEY)).toBe('1.9999999999.pk.sig');
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe(JSON.stringify({ token: 't' }));
    // No session-change → no navigation was triggered.
    expect(onChange).not.toHaveBeenCalled();
    // Modal is dismissed.
    expect(global.document.body.children.length).toBe(0);
    // Signer never touched.
    expect(signerCalls.signEvent).toBe(0);
    expect(signerCalls.getPublicKey).toBe(0);
  });
});

describe('Yes — purely local logout that routes to the login modal', () => {
  it('removes both session keys and dispatches continuum:session-changed', () => {
    localStorage.setItem(TOKEN_KEY, '1.9999999999.pk.sig');
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ token: 't' }));
    const onChange = vi.fn();
    document.addEventListener('continuum:session-changed', onChange);

    confirmSignOut();
    findButton(backdrop(), 'Yes').click();

    // Both the SPA session and the onboarding handoff are cleared.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
    // The routing trigger fired exactly once…
    expect(onChange).toHaveBeenCalledTimes(1);
    // …and unauthenticated routing lands on the login modal (root).
    expect(sessionChangeTarget(false)).toBe(ROOT_PATH);
    // Modal dismissed.
    expect(global.document.body.children.length).toBe(0);
  });

  it('never invokes window.nostr / NIP-07 on the sign-out path', () => {
    localStorage.setItem(TOKEN_KEY, '1.9999999999.pk.sig');
    confirmSignOut();
    findButton(backdrop(), 'Yes').click();
    expect(signerCalls.signEvent).toBe(0);
    expect(signerCalls.getPublicKey).toBe(0);
  });
});

describe('signOutOutcomes — pure decision logic', () => {
  it('onConfirm calls the injected endSession; onCancel does nothing', () => {
    const end = vi.fn();
    const { onConfirm, onCancel } = signOutOutcomes({ endSession: end });
    onCancel();
    expect(end).not.toHaveBeenCalled();
    onConfirm();
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('src/shell.js — sign-out branch never reaches the signer (source structure)', () => {
  const shell = read('shell.js');

  it('the sidebar sign-out branch calls confirmSignOut, not startLogin', () => {
    expect(shell).toMatch(/isSessionLive\(\)\)\s*\{\s*confirmSignOut\(\);/);
  });

  it('startLogin is only reachable from the else (sign-in) branch', () => {
    const confirmIdx = shell.indexOf('confirmSignOut();');
    const startLoginIdx = shell.indexOf('startLogin({');
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(startLoginIdx).toBeGreaterThan(confirmIdx);
  });

  it('the sign-out helpers contain no NIP-07 / signer references', () => {
    const from = shell.indexOf('export function signOutOutcomes');
    const to = shell.indexOf('// -- Theme --');
    const region = shell.slice(from, to);
    expect(region).not.toMatch(/window\.nostr|signEvent|getPublicKey|startLogin|requestChallenge/);
  });

  it('reuses the shared openModal helper and the "Signing out?" copy', () => {
    expect(shell).toContain("import { h, openModal } from './views/util.js'");
    expect(shell).toContain("title: 'Signing out?'");
  });
});
