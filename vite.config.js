import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // Relative base so assets resolve regardless of where the site is mounted
  // (VPS root, subdirectory hosting under torii-base, or a bundled static demo).
  base: './',
  // Bake the package version into the bundle so the landing page (and any
  // other UI that surfaces the app version) never drifts from the shipped
  // package. Falls back to a placeholder when the constant is somehow
  // undefined (e.g. running the file outside Vite's build pipeline).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5180,
    host: '127.0.0.1',
  },
  preview: {
    port: 5181,
    host: '127.0.0.1',
  },
});
