/**
 * Pending Top-Ups recovery card (v0.2.89-alpha, Item 3).
 *
 * The card lists the caller's unminted quotes (payments that reached the mint but
 * never got minted into the wallet) with a per-row + bulk "Resume" that calls
 * POST /api/wallet/quotes/:quote/resume. It renders only when the list is
 * non-empty; on a successful resume the row disappears and the live balance
 * number updates.
 *
 * The repo runs vitest under the node environment (no jsdom), so these use a
 * minimal DOM shim that also captures click listeners so resume flows can fire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../router.js', () => ({ navigate: vi.fn() }));
vi.mock('../chat.js', () => ({ setChatContext: vi.fn(), compose: vi.fn() }));
vi.mock('../data/store.js', () => ({
  getRoutstr: vi.fn(() => ({ content: {} })),
  updateRoutstr: vi.fn(),
}));

// Control the two recovery endpoints; the rest are inert stand-ins so the module
// import chain resolves under the node env.
const walletPendingQuotes = vi.fn();
const walletResumeQuote = vi.fn();
vi.mock('../data/agent.js', () => ({
  walletBalance: vi.fn(async () => ({ ok: true, data: { total_sats: 0 } })),
  walletReceive: vi.fn(),
  isAgentConfigured: vi.fn(() => true),
  walletMintQuote: vi.fn(),
  walletMintQuoteStatus: vi.fn(),
  walletNwcInvoice: vi.fn(),
  walletNwcInvoiceStatus: vi.fn(),
  walletPendingQuotes: (...a) => walletPendingQuotes(...a),
  walletResumeQuote: (...a) => walletResumeQuote(...a),
  nwcStatus: vi.fn(),
  nwcConnect: vi.fn(),
  nwcTest: vi.fn(),
  nwcDisconnect: vi.fn(),
}));

import { renderPendingTopUps, mountPendingTopUps, fmtAge } from './routstr.js';

// ── Minimal DOM shim that captures click listeners ──────────────────
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    className: '',
    style: {},
    disabled: false,
    _text: '',
    dataset: {},
    parentNode: null,
    _listeners: {},
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent ?? '').join('');
      return this._text;
    },
    get isConnected() { let n = el; while (n.parentNode) n = n.parentNode; return n._root === true; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; },
    get firstChild() { return this.children[0] || null; },
  };
  return el;
}
function walk(el, out = []) {
  out.push(el);
  for (const c of el.children || []) if (c && c.children) walk(c, out);
  return out;
}
async function click(el) {
  for (const fn of el._listeners.click || []) await fn();
}
function findByClass(root, cls) {
  return walk(root).filter((e) => String(e.className).split(/\s+/).includes(cls));
}

beforeEach(() => {
  walletPendingQuotes.mockReset();
  walletResumeQuote.mockReset();
  global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
  };
});
afterEach(() => { delete global.document; });

const sampleQuotes = [
  { quote: 'q-1', mint: 'https://mint.minibits.cash/Bitcoin', amount_sats: 369, created_at: 1, age_seconds: 4 * 3600 },
  { quote: 'q-2', mint: 'https://mint.example', amount_sats: 1000, created_at: 2, age_seconds: 90 },
];

describe('fmtAge — coarse created-ago labels', () => {
  it('buckets by magnitude and pluralises', () => {
    expect(fmtAge(5)).toBe('just now');
    expect(fmtAge(90)).toBe('1 minute ago');
    expect(fmtAge(600)).toBe('10 minutes ago');
    expect(fmtAge(3600)).toBe('1 hour ago');
    expect(fmtAge(4 * 3600)).toBe('4 hours ago');
    expect(fmtAge(48 * 3600)).toBe('2 days ago');
  });
  it('clamps junk to "just now"', () => {
    expect(fmtAge(-5)).toBe('just now');
    expect(fmtAge('nope')).toBe('just now');
  });
});

describe('renderPendingTopUps — structure', () => {
  it('returns null for an empty or absent list', () => {
    expect(renderPendingTopUps([])).toBeNull();
    expect(renderPendingTopUps(null)).toBeNull();
    expect(renderPendingTopUps(undefined)).toBeNull();
  });

  it('renders one row per quote with amount · host · created-ago', () => {
    const card = renderPendingTopUps(sampleQuotes, {});
    expect(card).not.toBeNull();
    const rows = findByClass(card, 'pending-row');
    expect(rows.length).toBe(2);
    const labels = findByClass(card, 'pending-row-label').map((e) => e.textContent);
    expect(labels[0]).toContain('369 sats');
    expect(labels[0]).toContain('mint.minibits.cash');
    expect(labels[0]).toContain('created 4 hours ago');
    expect(labels[1]).toContain('1000 sats');
    // Per-row Resume + one bulk Resume-all.
    expect(findByClass(card, 'pending-resume').length).toBe(2);
    expect(findByClass(card, 'pending-resume-all').length).toBe(1);
  });

  it('shows the explanatory footer', () => {
    const card = renderPendingTopUps(sampleQuotes, {});
    const txt = card.textContent;
    expect(txt).toContain("weren't minted into your wallet");
  });
});

describe('renderPendingTopUps — resume wiring', () => {
  it('per-row Resume invokes onResume with the quote + row ui handles', async () => {
    const onResume = vi.fn(async () => true);
    const card = renderPendingTopUps(sampleQuotes, { onResume });
    const btn = findByClass(card, 'pending-resume')[0];
    await click(btn);
    expect(onResume).toHaveBeenCalledTimes(1);
    const [q, ui] = onResume.mock.calls[0];
    expect(q.quote).toBe('q-1');
    expect(ui.btn).toBe(btn);
    expect(ui.row).toBeTruthy();
    expect(ui.statusEl).toBeTruthy();
  });

  it('Resume all replays every row sequentially', async () => {
    const seen = [];
    const onResume = vi.fn(async (q) => { seen.push(q.quote); return true; });
    const card = renderPendingTopUps(sampleQuotes, { onResume });
    await click(findByClass(card, 'pending-resume-all')[0]);
    expect(seen).toEqual(['q-1', 'q-2']);
  });
});

describe('mountPendingTopUps — endpoint-driven card', () => {
  function rootContainer() {
    const c = makeEl('div');
    c._root = true; // makes isConnected walk terminate truthy
    return c;
  }

  it('mounts nothing when the pending list is empty', async () => {
    walletPendingQuotes.mockResolvedValue({ ok: true, data: { quotes: [] } });
    const container = rootContainer();
    await mountPendingTopUps(container, false);
    expect(container.children.length).toBe(0);
  });

  it('mounts nothing in demo mode (no network call)', async () => {
    const container = rootContainer();
    await mountPendingTopUps(container, true);
    expect(walletPendingQuotes).not.toHaveBeenCalled();
    expect(container.children.length).toBe(0);
  });

  it('mounts the card when the list is non-empty', async () => {
    walletPendingQuotes.mockResolvedValue({ ok: true, data: { quotes: sampleQuotes } });
    const container = rootContainer();
    await mountPendingTopUps(container, false);
    expect(container.children.length).toBe(1);
    expect(findByClass(container, 'pending-row').length).toBe(2);
  });

  it('a successful per-row resume calls the endpoint, removes the row, keeps others', async () => {
    walletPendingQuotes.mockResolvedValue({ ok: true, data: { quotes: sampleQuotes } });
    walletResumeQuote.mockResolvedValue({ ok: true, paid: true, data: { new_balance_sats: 4321 } });
    const container = rootContainer();
    await mountPendingTopUps(container, false);

    const firstBtn = findByClass(container, 'pending-resume')[0];
    await click(firstBtn);

    expect(walletResumeQuote).toHaveBeenCalledWith('q-1');
    // Row q-1 is gone; q-2 remains.
    const labels = findByClass(container, 'pending-row-label').map((e) => e.textContent);
    expect(labels.length).toBe(1);
    expect(labels[0]).toContain('1000 sats');
  });

  it('a failed resume re-enables the button and surfaces the reason', async () => {
    walletPendingQuotes.mockResolvedValue({ ok: true, data: { quotes: [sampleQuotes[0]] } });
    walletResumeQuote.mockResolvedValue({ ok: false, reason: 'not_yours' });
    const container = rootContainer();
    await mountPendingTopUps(container, false);

    const btn = findByClass(container, 'pending-resume')[0];
    await click(btn);

    expect(findByClass(container, 'pending-row').length).toBe(1); // row stays
    expect(btn.disabled).toBe(false);
    const status = findByClass(container, 'pending-row-status')[0];
    expect(status.textContent).toContain('Not yours');
  });
});
