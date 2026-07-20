/**
 * NWC card — alias + inferred maker (v0.2.86-alpha, Item 4).
 *
 * The connected NWC wallet card shows: line 1 the wallet alias (or "Wallet"),
 * line 2 the inferred maker + a small badge, line 3 the muted pubkey shortcode.
 * The maker is inferred from a case-insensitive substring fingerprint built
 * only from the alias + relay hosts — never the secret, URI, or pubkey.
 *
 * The repo runs vitest with the node environment (no jsdom), so the render
 * assertions use the minimal DOM shim; the fingerprint/maker helpers are pure
 * and tested directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../router.js', () => ({ navigate: vi.fn() }));
vi.mock('../chat.js', () => ({ setChatContext: vi.fn(), compose: vi.fn() }));

import { inferWalletMaker, nwcFingerprint, renderNwcIdentity } from './routstr.js';

// ── Minimal DOM shim (only what h() calls) ──────────────────────────
function makeEl(tag) {
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
    addEventListener() {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
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
  global.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), _text: String(t) }),
  };
});
afterEach(() => { delete global.document; });

describe('inferWalletMaker — case-insensitive substring fingerprint table', () => {
  const cases = [
    ['alby', 'Alby'],
    ['getalby.com', 'Alby'],
    ['My GetAlby Hub', 'Alby'],
    ['mutiny', 'Mutiny'],
    ['relay.mutinywallet.com', 'Mutiny'],
    ['cashu.me', 'cashu.me'],
    ['zeus', 'Zeus'],
    ['zeusln.app', 'Zeus'],
    ['coinos.io', 'Coinos'],
    ['strike', 'Strike'],
    ['phoenix', 'Phoenix'],
  ];
  for (const [fp, maker] of cases) {
    it(`maps "${fp}" → ${maker}`, () => {
      expect(inferWalletMaker(fp)).toEqual({ maker, known: true });
    });
  }

  it('is case-insensitive', () => {
    expect(inferWalletMaker('WSS://RELAY.MUTINYWALLET.COM').maker).toBe('Mutiny');
  });

  it('returns "Unknown wallet" (known:false) for an unrecognised fingerprint', () => {
    expect(inferWalletMaker('some-random-relay.example')).toEqual({ maker: 'Unknown wallet', known: false });
    expect(inferWalletMaker('')).toEqual({ maker: 'Unknown wallet', known: false });
    expect(inferWalletMaker(null)).toEqual({ maker: 'Unknown wallet', known: false });
  });
});

describe('nwcFingerprint — built only from alias + relay hosts, never secrets', () => {
  it('joins alias and relay hosts, lowercased', () => {
    const fp = nwcFingerprint({ alias: 'Alby Hub', wallet: { relays: ['relay.getalby.com', 'nostr.mutinywallet.com'] } });
    expect(fp).toBe('alby hub relay.getalby.com nostr.mutinywallet.com');
  });

  it('never includes a pubkey prefix or secret', () => {
    const fp = nwcFingerprint({
      alias: 'x', wallet: { relays: ['r.example'], wallet_pubkey_prefix: 'deadbeef1234', secret_fingerprint: 'abc' },
    });
    expect(fp).not.toContain('deadbeef');
    expect(fp).not.toContain('abc');
  });

  it('handles missing fields', () => {
    expect(nwcFingerprint({})).toBe('');
    expect(nwcFingerprint(null)).toBe('');
    expect(nwcFingerprint({ wallet: { relays: ['ONLY.RELAY'] } })).toBe('only.relay');
  });
});

describe('renderNwcIdentity — three-line connected identity block', () => {
  it('renders alias, maker + badge, and pubkey shortcode', () => {
    const el = renderNwcIdentity({
      alias: 'My Alby Hub',
      network: 'mainnet',
      wallet: { relays: ['relay.getalby.com'], wallet_pubkey_prefix: 'aabbccddeeff' },
    });
    const nodes = walk(el);
    expect(nodes.find((e) => e.className === 'nwc-alias')?.textContent).toBe('My Alby Hub');
    const maker = nodes.find((e) => e.className === 'nwc-maker');
    expect(maker.textContent).toContain('Alby');
    // Badge shows the network when present.
    expect(nodes.find((e) => e.className === 'badge')?.textContent).toBe('mainnet');
    // Shortcode line uses the pubkey prefix (truncated), never a full pubkey.
    const shortcode = nodes.find((e) => e.className === 'mono muted');
    expect(shortcode?.textContent).toBe('aabbccddeeff…');
  });

  it('falls back to "Wallet" and "NWC" badge, and shows the relay host for an unknown maker', () => {
    const el = renderNwcIdentity({ wallet: { relays: ['relay.example.com'], wallet_pubkey_prefix: '0011' } });
    const nodes = walk(el);
    expect(nodes.find((e) => e.className === 'nwc-alias')?.textContent).toBe('Wallet');
    expect(nodes.find((e) => e.className === 'nwc-maker')?.textContent).toContain('Unknown wallet');
    expect(nodes.find((e) => e.className === 'badge')?.textContent).toBe('NWC');
    // Unknown maker → relay host surfaced in muted text.
    expect(nodes.some((e) => e.textContent === 'relay.example.com')).toBe(true);
  });
});
