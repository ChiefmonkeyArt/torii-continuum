/**
 * Same-mint self-transfer hint (v0.2.89-alpha, Item 5).
 *
 * setSameMintHint fills the under-QR hint node with Cashu-source copy (naming the
 * mint host when known) or the simpler NWC-source copy, and hides it otherwise.
 * Node-env vitest, minimal DOM shim (mirrors nwc-card.test.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../router.js', () => ({ navigate: vi.fn() }));
vi.mock('../chat.js', () => ({ setChatContext: vi.fn(), compose: vi.fn() }));

import { setSameMintHint } from './routstr.js';

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    _text: '',
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
  };
}
beforeEach(() => { global.document = { createElement: (t) => makeEl(t) }; });
afterEach(() => { delete global.document; });

describe('setSameMintHint', () => {
  it('shows the Cashu same-mint copy with the mint host when known', () => {
    const el = makeEl('div');
    setSameMintHint(el, 'cashu', 'https://mint.minibits.cash/Bitcoin');
    expect(el.style.display).toBe('');
    expect(el.textContent).toContain('same mint (mint.minibits.cash)');
    expect(el.textContent).toContain('they still move into Continuum');
  });

  it('drops the parenthetical host when the mint is unknown', () => {
    const el = makeEl('div');
    setSameMintHint(el, 'cashu', null);
    expect(el.style.display).toBe('');
    expect(el.textContent).toContain('on the same mint,');
    expect(el.textContent).not.toContain('(');
  });

  it('shows the simpler NWC copy for the NWC source', () => {
    const el = makeEl('div');
    setSameMintHint(el, 'nwc', null);
    expect(el.style.display).toBe('');
    expect(el.textContent).toBe('Pay this invoice from your connected NWC wallet on your phone.');
    expect(el.textContent).not.toContain('same mint');
  });

  it('hides the hint for an unknown source', () => {
    const el = makeEl('div');
    setSameMintHint(el, 'other', null);
    expect(el.style.display).toBe('none');
    expect(el.textContent).toBe('');
  });

  it('is a no-op on a missing element', () => {
    expect(() => setSameMintHint(null, 'cashu', 'https://mint.example')).not.toThrow();
  });
});
