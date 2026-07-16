import { describe, it, expect } from 'vitest';
import { parseNpub, toNpub, shortNpub } from './npub.js';

// Canonical NIP-19 test vector.
const HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

describe('parseNpub', () => {
  it('decodes a valid npub1… to the expected 64-hex', () => {
    const r = parseNpub(NPUB);
    expect(r.ok).toBe(true);
    expect(r.hex).toBe(HEX);
  });

  it('accepts a raw 64-hex key', () => {
    const r = parseNpub(HEX);
    expect(r.ok).toBe(true);
    expect(r.hex).toBe(HEX);
  });

  it('canonicalises hex case and trims whitespace', () => {
    const r = parseNpub(`  ${HEX.toUpperCase()}  `);
    expect(r.ok).toBe(true);
    expect(r.hex).toBe(HEX);
  });

  it('accepts an uppercase npub1…', () => {
    const r = parseNpub(NPUB.toUpperCase());
    expect(r.ok).toBe(true);
    expect(r.hex).toBe(HEX);
  });

  it('rejects an empty input', () => {
    expect(parseNpub('').ok).toBe(false);
    expect(parseNpub('   ').ok).toBe(false);
  });

  it('rejects a too-short npub', () => {
    expect(parseNpub('npub1x').ok).toBe(false);
  });

  it('rejects gibberish', () => {
    expect(parseNpub('zzz').ok).toBe(false);
  });

  it('rejects a 63-hex string', () => {
    expect(parseNpub(HEX.slice(0, 63)).ok).toBe(false);
  });

  it('rejects an npub with a broken checksum', () => {
    const bad = NPUB.slice(0, -1) + (NPUB.endsWith('w') ? '0' : 'w');
    expect(parseNpub(bad).ok).toBe(false);
  });
});

describe('toNpub', () => {
  it('round-trips hex → npub → hex', () => {
    expect(toNpub(HEX)).toBe(NPUB);
    expect(parseNpub(toNpub(HEX)).hex).toBe(HEX);
  });

  it('returns null for bad hex', () => {
    expect(toNpub('nothex')).toBe(null);
  });
});

describe('shortNpub', () => {
  it('renders a truncated npub1… form', () => {
    const s = shortNpub(HEX);
    expect(s.startsWith('npub1')).toBe(true);
    expect(s).toContain('…');
  });
});
