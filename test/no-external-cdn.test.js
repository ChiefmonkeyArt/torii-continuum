/**
 * Production build must make ZERO external requests.
 *
 * Standing rules for this repo:
 *   - NEVER load anything from Google (fonts.googleapis.com, fonts.gstatic.com,
 *     or any *.google* host).
 *   - No third-party CDNs in production (Fontshare, unpkg, jsdelivr, cdnjs, …).
 *
 * This suite builds the app fresh and asserts that the emitted index.html and
 * every built asset are free of banned hosts and of any external
 * stylesheet/font/preconnect reference. Same-origin app routes (e.g. the
 * `/continuum/api` proxy) are explicitly allowed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Resource/CDN hosts that must NEVER appear in a production artifact. These
// only ever occur as a loaded resource (font CSS, script, preconnect), so any
// occurrence at all is a violation. NB: bare "google.com" is intentionally not
// here — an inert outbound <a target="_blank"> link to e.g. a browser-extension
// store loads nothing at page render and does not breach the "load/install
// nothing from Google" rule. The `no external loading references` test below is
// what actually enforces that no resource (incl. any *.google* host) is fetched.
const BANNED = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'googleapis.com',
  'gstatic.com',
  'googletagmanager',
  'google-analytics',
  'apis.google.com',
  'api.fontshare.com',
  'fontshare.com',
  'unpkg.com',
  'jsdelivr.net',
  'cdnjs.cloudflare.com',
  'cdnjs.com',
  'esm.sh',
  'skypack.dev',
  'ga.jspm.io',
  'use.typekit.net',
];

let indexHtml = '';
let assetFiles = [];
let assetBlobs = '';

beforeAll(() => {
  // Fresh, deterministic build — the test asserts on exactly what ships.
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
  assetFiles = readdirSync(join(dist, 'assets'));
  assetBlobs = assetFiles
    .map((f) => readFileSync(join(dist, 'assets', f), 'utf8'))
    .join('\n');
}, 60_000);

describe('production build has no external hosts', () => {
  it('index.html contains no banned CDN/font host', () => {
    for (const host of BANNED) {
      expect(indexHtml.toLowerCase(), `index.html must not reference ${host}`)
        .not.toContain(host);
    }
  });

  it('built assets contain no banned CDN/font host', () => {
    const hay = assetBlobs.toLowerCase();
    for (const host of BANNED) {
      expect(hay, `built assets must not reference ${host}`).not.toContain(host);
    }
  });

  it('index.html declares no preconnect/dns-prefetch to any host', () => {
    expect(indexHtml).not.toMatch(/rel=["']?(?:preconnect|dns-prefetch)/i);
  });

  it('index.html has no external stylesheet or font <link>', () => {
    // Every <link href> must be relative (Vite emits `./assets/...`, `./favicon`),
    // never an absolute http(s) URL.
    const linkHrefs = [...indexHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)]
      .map((m) => m[1]);
    expect(linkHrefs.length).toBeGreaterThan(0);
    for (const href of linkHrefs) {
      expect(href, `<link href> must be same-origin/relative: ${href}`)
        .not.toMatch(/^https?:\/\//i);
    }
  });

  it('index.html loads no external script', () => {
    const scriptSrcs = [...indexHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((m) => m[1]);
    for (const src of scriptSrcs) {
      expect(src, `<script src> must be same-origin/relative: ${src}`)
        .not.toMatch(/^https?:\/\//i);
    }
  });

  it('assets contain no @font-face pointing at an external URL', () => {
    // @import url(https://…) and src:url(https://…) are the CSS webfont vectors.
    expect(assetBlobs).not.toMatch(/@import\s+url\(\s*["']?https?:/i);
    expect(assetBlobs).not.toMatch(/@font-face[\s\S]*?src\s*:\s*url\(\s*["']?https?:/i);
  });

  it('assets fetch/load no external resource (incl. any *.google* host)', () => {
    // The real security property: nothing is LOADED from an external origin.
    // Scan the actual loading vectors in the bundle — CSS @import/url(),
    // dynamic import(), fetch()/XHR, and element .src/.href assignments — for an
    // absolute http(s) URL, and assert none target an external host. Inert
    // outbound <a target="_blank"> links (rendered as clickable text, e.g. a
    // browser-extension store) are NOT loading vectors and are allowed.
    const loadingUrl =
      /(?:@import\s+url\(|url\(|\bimport\(|\bfetch\(|\.src\s*=\s*|\.href\s*=\s*|new\s+Image[^;]*\.src\s*=\s*)\s*["'`]?(https?:\/\/[^"'`)\s]+)/gi;
    const hits = [...assetBlobs.matchAll(loadingUrl)].map((m) => m[1].toLowerCase());
    for (const u of hits) {
      expect(u, `external resource is loaded at runtime: ${u}`).not.toMatch(/^https?:\/\//);
      expect(u, `Google-hosted resource is loaded: ${u}`).not.toMatch(/\.google(?:apis|tagmanager)?\.com/);
    }
    // Also: no absolute-URL webfont anywhere.
    expect(assetBlobs).not.toMatch(/src\s*:\s*url\(\s*["']?https?:/i);
  });
});
