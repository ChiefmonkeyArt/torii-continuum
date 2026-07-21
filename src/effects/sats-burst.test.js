/**
 * Sats-burst celebration (v0.2.89-alpha, Item 4).
 *
 * Node-env vitest (no jsdom): a minimal DOM shim plus injected raf/now/setTimeout
 * so the rAF loops run deterministically. Covers: runs without throwing against a
 * stub canvas, the reduced-motion path swaps in the flash + static chip (no
 * canvas burst), and the canvas self-cleans (removed from the DOM) once the burst
 * duration elapses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { satsBurst } from './sats-burst.js';

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    width: 300,
    height: 300,
    clientWidth: 300,
    clientHeight: 300,
    style: { cssText: '', transition: '', opacity: '', transform: '' },
    _text: '',
    parentNode: null,
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent ?? '').join('');
      return this._text;
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
  };
  return el;
}

// A canvas whose getContext returns a no-op 2d stub (so drawing never throws).
function makeCanvas() {
  const el = makeEl('canvas');
  el.getContext = () => ({
    clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {},
    fillText() {}, set globalAlpha(_v) {}, set font(_v) {}, set fillStyle(_v) {},
    set textAlign(_v) {}, set textBaseline(_v) {},
  });
  return el;
}

// Deterministic frame pump: raf queues callbacks; pump() flushes them, advancing
// a fake clock 16ms per frame until the loop stops re-enqueuing.
function harness() {
  let clock = 0;
  const queue = [];
  const timeouts = [];
  return {
    now: () => clock,
    raf: (cb) => { queue.push(cb); return queue.length; },
    cancelRaf: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    pump(maxFrames = 5000) {
      let n = 0;
      while (queue.length && n++ < maxFrames) {
        const cb = queue.shift();
        clock += 16;
        cb(clock);
      }
    },
    flushTimeouts() { while (timeouts.length) timeouts.shift()(); },
    get clock() { return clock; },
  };
}

beforeEach(() => {
  global.document = { createElement: (t) => (t === 'canvas' ? makeCanvas() : makeEl(t)) };
});
afterEach(() => { delete global.document; });

describe('satsBurst — full-motion path', () => {
  it('runs without throwing against a stub canvas + card', () => {
    const h = harness();
    const modalBody = makeEl('div');
    const card = makeEl('div');
    const balanceEl = makeEl('span');
    expect(() => satsBurst({
      modalBody, card, balanceEl, origin: { x: 150, y: 120 },
      from: 1000, to: 1369, formatSats: (n) => String(n),
      reducedMotion: false, ...h,
    })).not.toThrow();
    // A canvas got mounted and a chip added.
    expect(modalBody.children.some((c) => c.className === 'sats-burst-canvas')).toBe(true);
    expect(card.children.some((c) => c.className === 'sats-burst-chip')).toBe(true);
  });

  it('tweens the balance number toward the new value and lands exactly on it', () => {
    const h = harness();
    const balanceEl = makeEl('span');
    satsBurst({
      modalBody: makeEl('div'), card: makeEl('div'), balanceEl,
      from: 1000, to: 1369, formatSats: (n) => String(n), reducedMotion: false, ...h,
    });
    h.pump();
    expect(balanceEl.textContent).toBe('1369');
  });

  it('canvas self-cleans (removed from the DOM) after the burst duration', () => {
    const h = harness();
    const modalBody = makeEl('div');
    const res = satsBurst({
      modalBody, card: makeEl('div'), balanceEl: makeEl('span'),
      from: 0, to: 500, formatSats: (n) => String(n), reducedMotion: false, ...h,
    });
    expect(modalBody.children.some((c) => c.className === 'sats-burst-canvas')).toBe(true);
    h.pump();
    expect(modalBody.children.some((c) => c.className === 'sats-burst-canvas')).toBe(false);
    expect(res.reduced).toBe(false);
  });
});

describe('satsBurst — prefers-reduced-motion', () => {
  it('replaces the burst with a flash + static chip and no canvas', () => {
    const h = harness();
    const modalBody = makeEl('div');
    const card = makeEl('div');
    const balanceEl = makeEl('span');
    const res = satsBurst({
      modalBody, card, balanceEl,
      from: 1000, to: 1369, formatSats: (n) => String(n),
      reducedMotion: true, ...h,
    });
    expect(res.reduced).toBe(true);
    // No canvas burst in the reduced path.
    expect(modalBody.children.some((c) => c.className === 'sats-burst-canvas')).toBe(false);
    // Balance is set directly (no tween), chip is present.
    expect(balanceEl.textContent).toBe('1369');
    expect(card.children.some((c) => c.className === 'sats-burst-chip')).toBe(true);
    // A 200ms flash was applied to the card.
    expect(card.style.opacity).toBe('0.4');
    h.flushTimeouts();
    expect(card.style.opacity).toBe('1');
  });

  it('detects reduced motion via injected matchMedia', () => {
    const h = harness();
    const modalBody = makeEl('div');
    satsBurst({
      modalBody, card: makeEl('div'), balanceEl: makeEl('span'),
      from: 0, to: 100, formatSats: (n) => String(n),
      matchMedia: (q) => ({ matches: /reduce/.test(q) }), ...h,
    });
    expect(modalBody.children.some((c) => c.className === 'sats-burst-canvas')).toBe(false);
  });
});
