/**
 * Integration-style proof of the production nginx route for the SPA.
 *
 * The live "black page" was caused by a nested asset location
 * (`location /continuum/assets/ { alias …; try_files … }`) that returned 404
 * for the hashed `/continuum/assets/*.js` and `*.css`. The fix is a SINGLE
 * prefix alias that serves both the entry document and the hashed bundle:
 *
 *   location /continuum/ {
 *       alias   <webroot>/;
 *       index   index.html;
 *       try_files $uri $uri/ /continuum/index.html;   # SPA fallback
 *   }
 *
 * This suite builds the app, reads the ACTUAL hashed filenames out of
 * dist/index.html, then stands up a tiny HTTP server that faithfully models the
 * nginx `alias` + `try_files` semantics above and issues real requests. It
 * proves index, JS and CSS all resolve to 200 under /continuum/ and that a deep
 * SPA route falls back to index.html — with no nested asset block present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import http from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const MOUNT = '/continuum';

const CTYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Faithful model of: location /continuum/ { alias dist/; try_files $uri $uri/ /continuum/index.html; }
function makeServer(webroot) {
  return http.createServer((req, res) => {
    const uri = decodeURIComponent(req.url.split('?')[0]);
    if (uri !== MOUNT && !uri.startsWith(MOUNT + '/')) {
      res.writeHead(404).end('outside mount');
      return;
    }
    // `alias` strips the mount prefix and resolves the remainder under webroot.
    const mapToFile = (u) => {
      let rel = u.slice(MOUNT.length).replace(/^\/+/, ''); // strip "/continuum/"
      if (rel === '') rel = 'index.html';
      const abs = normalize(join(webroot, rel));
      // Never escape the webroot (models nginx refusing traversal).
      if (!abs.startsWith(webroot)) return null;
      return abs;
    };
    // try_files $uri  →  $uri/  →  /continuum/index.html
    let file = mapToFile(uri);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      const idxOfDir = file && existsSync(file) && statSync(file).isDirectory()
        ? join(file, 'index.html') : null;
      if (idxOfDir && existsSync(idxOfDir)) {
        file = idxOfDir;
      } else {
        file = mapToFile(MOUNT + '/index.html'); // SPA fallback
      }
    }
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': CTYPE[ext] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
}

let server;
let base;
let hashedJs;
let hashedCss;

beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const html = readFileSync(join(dist, 'index.html'), 'utf8');

  // Pull the REAL hashed filenames Vite emitted into the entry document.
  const js = html.match(/src=["']\.?\/?(assets\/[^"']+\.js)["']/i);
  const css = html.match(/href=["']\.?\/?(assets\/[^"']+\.css)["']/i);
  hashedJs = js && js[1];
  hashedCss = css && css[1];

  server = makeServer(dist);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(() => { if (server) server.close(); });

describe('nginx /continuum/ single-alias routing', () => {
  it('resolved actual hashed JS and CSS names from dist/index.html', () => {
    expect(hashedJs, 'dist/index.html should reference a hashed .js').toBeTruthy();
    expect(hashedCss, 'dist/index.html should reference a hashed .css').toBeTruthy();
    expect(hashedJs).toMatch(/^assets\/index-[\w-]+\.js$/);
    expect(hashedCss).toMatch(/^assets\/index-[\w-]+\.css$/);
  });

  it('GET /continuum/ serves the SPA index (200, html)', async () => {
    const r = await fetch(`${base}${MOUNT}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toContain('<div id="app"');
  });

  it('GET /continuum/<hashed>.js resolves to 200 javascript', async () => {
    const r = await fetch(`${base}${MOUNT}/${hashedJs}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/javascript/);
    expect((await r.text()).length).toBeGreaterThan(1000);
  });

  it('GET /continuum/<hashed>.css resolves to 200 css', async () => {
    const r = await fetch(`${base}${MOUNT}/${hashedCss}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/css/);
    expect((await r.text()).length).toBeGreaterThan(1000);
  });

  it('deep SPA route /continuum/dashboard falls back to index.html (200)', async () => {
    const r = await fetch(`${base}${MOUNT}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toContain('<div id="app"');
  });

  it('the shipped nginx templates contain NO nested assets location', () => {
    // Lock the fix: neither the rendered j2 nor the source template may
    // reintroduce a `location .../assets/` block (the 404 regression).
    const j2 = readFileSync(
      join(root, 'ops/ansible/roles/continuum/templates/continuum.nginx.conf.j2'), 'utf8');
    const tmpl = readFileSync(join(root, 'ops/nginx/continuum.conf.template'), 'utf8');
    const noComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(noComments(j2)).not.toMatch(/location\s+\S*\/assets\//);
    expect(noComments(tmpl)).not.toMatch(/location\s+\S*\/assets\//);
    // And the single parent alias + SPA fallback must be present.
    expect(noComments(j2)).toMatch(/try_files\s+\$uri\s+\$uri\/\s+.*index\.html/);
    expect(noComments(tmpl)).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/continuum\/index\.html/);
  });
});
