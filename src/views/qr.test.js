import { describe, it, expect } from 'vitest';
import { QrCode, Ecl, renderQR } from './qr.js';

// A representative BOLT11 (testnet-style fixture; never paid). Uppercased before
// encoding because the alphanumeric QR mode only covers A–Z/0–9/a few symbols,
// which yields a denser code than falling back to byte mode for lowercase.
const BOLT11 =
  'lnbc10u1p3pj257pp5yztkwjcz5ftl5laxkav23zmzekaw37zk6kmv80pk4xaev5qhtz7qdpdwd3xger9wd5kwm36yprx7u3qd36kucmgyp282etnv3shjcqzpgxqyz5vqsp5usyc4lk9chsfp53kvcnvq456ganh60d89reykdngsmtj6yw3nhvq9qyyssqy';
const PAYLOAD = `lightning:${BOLT11.toUpperCase()}`;

describe('QrCode.encodeText', () => {
  it('encodes a BOLT11 payment payload into a valid QR matrix', () => {
    const qr = QrCode.encodeText(PAYLOAD, Ecl.MEDIUM);
    // A string this long needs a mid-range version; size = version*4 + 17.
    expect(qr.version).toBeGreaterThanOrEqual(1);
    expect(qr.version).toBeLessThanOrEqual(40);
    expect(qr.size).toBe(qr.version * 4 + 17);
    // Module count matches the encoded version for this exact fixture. If the
    // encoder or its capacity tables regress, this pins the failure.
    expect(qr.size).toBe(57);
  });

  it('draws the three finder patterns (7-module quiet-bordered squares)', () => {
    const qr = QrCode.encodeText(PAYLOAD, Ecl.MEDIUM);
    // Top-left finder: solid 7 dark modules then a light separator.
    for (let x = 0; x < 7; x++) expect(qr.getModule(x, 0)).toBe(true);
    expect(qr.getModule(7, 0)).toBe(false);
    // Top-right finder starts at size-7.
    for (let x = qr.size - 7; x < qr.size; x++) expect(qr.getModule(x, 0)).toBe(true);
    expect(qr.getModule(qr.size - 8, 0)).toBe(false);
  });

  it('is deterministic for the same input', () => {
    const a = QrCode.encodeText(PAYLOAD, Ecl.MEDIUM);
    const b = QrCode.encodeText(PAYLOAD, Ecl.MEDIUM);
    const rowOf = (q) =>
      Array.from({ length: q.size }, (_, x) => (q.getModule(x, 0) ? 1 : 0)).join('');
    expect(rowOf(a)).toBe(rowOf(b));
  });

  it('picks a smaller version for short alphanumeric input', () => {
    const small = QrCode.encodeText('LIGHTNING:TEST', Ecl.MEDIUM);
    const big = QrCode.encodeText(PAYLOAD, Ecl.MEDIUM);
    expect(small.version).toBeLessThan(big.version);
  });

  it('throws when the payload cannot fit any version', () => {
    const huge = 'A'.repeat(5000);
    expect(() => QrCode.encodeText(huge, Ecl.HIGH)).toThrow();
  });
});

describe('renderQR', () => {
  it('returns a canvas with the requested pixel dimensions', () => {
    // Minimal document/canvas stub so the pure renderer is exercised without a
    // real DOM (the root vitest run has no jsdom environment).
    const calls = [];
    const fakeCtx = {
      fillStyle: '',
      fillRect: (...a) => calls.push(a),
    };
    const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
    const prevDoc = globalThis.document;
    globalThis.document = { createElement: () => fakeCanvas };
    try {
      const canvas = renderQR(PAYLOAD, { size: 256, ecl: 'M' });
      expect(canvas.width).toBe(256);
      expect(canvas.height).toBe(256);
      // At least the finder patterns should have produced dark fillRect calls.
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
