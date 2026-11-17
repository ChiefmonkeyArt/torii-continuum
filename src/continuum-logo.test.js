/**
 * Continuum logo and favicon (docs/adr-continuum-logo.md).
 * Source-level checks, in the repo's jsdom-free style.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p));

describe('Continuum logo', () => {
  it('replaces the drawn torii on the sign-in card and the About hero, decorative', () => {
    for (const [file, cls] of [['views/login.js', 'login-logo'], ['views/landing.js', 'landing-logo']]) {
      const src = read(file).toString();
      expect(src).toContain("import continuumLogo from '../assets/continuum-logo.webp'");
      expect(src).not.toContain('toriiSvg');
      expect(src).toContain(`class: '${cls}', src: continuumLogo, alt: '', 'aria-hidden': 'true'`);
      expect(src).toContain("width: '440', height: '278'");
    }
  });

  it('drops the old torii SVG and its styles', () => {
    expect(read('views/landing.js').toString()).not.toMatch(/function toriiSvg|svg\(/);
    expect(read('styles/landing.css').toString()).not.toMatch(/landing-torii|login-mark|login-hero/);
  });

  it('is a 440x278 WebP with transparency, at most 40 KB', () => {
    const b = read('assets/continuum-logo.webp');
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.toString('ascii', 8, 16)).toBe('WEBPVP8X');
    expect(b[20] & 0x10).toBe(0x10); // alpha
    expect(b.readUIntLE(24, 3) + 1).toBe(440);
    expect(b.readUIntLE(27, 3) + 1).toBe(278);
    expect(b.length).toBeLessThanOrEqual(40_000);
  });
});

describe('sidebar brand mark', () => {
  it('shows the favicon image instead of the torii glyph', () => {
    const src = read('shell.js').toString();
    expect(src).toContain('<img class="brand-mark" src="${import.meta.env.BASE_URL}favicon.svg" alt="" aria-hidden="true" width="34" height="34"');
    expect(src).not.toContain('<div class="brand-mark">');
  });
});

describe('favicon', () => {
  it('stays at /favicon.svg: one bundled 48 px PNG, small, no outside requests', () => {
    const svg = read('../public/favicon.svg').toString();
    expect(svg).toContain('viewBox="0 0 48 48"');
    expect(svg.match(/data:image\/png;base64,/g)).toHaveLength(1);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg.length).toBeLessThanOrEqual(6_500);
    const png = Buffer.from(svg.match(/base64,([^"]+)"/)[1], 'base64');
    expect(png.toString('ascii', 1, 4)).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(48);
    expect(png.readUInt32BE(20)).toBe(48);
  });
});
