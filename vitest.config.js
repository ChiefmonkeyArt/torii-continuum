import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

// The frontend (root) and the agent are separate packages with separate test
// runners. The agent ships its own `node --test` suite under `agent/test/`
// (run via `npm --prefix agent test`); those files are node:test modules, not
// vitest suites, so vitest must not collect them. Exclude the agent subtree
// (and build output) here. The root has no vitest suites yet, so an empty run
// is a pass rather than a failure.
export default defineConfig({
  // Mirror the Vite build-time define so `appVersion()` resolves the real
  // package version under test instead of falling back to the placeholder.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    exclude: ['node_modules/**', 'dist/**', 'agent/**'],
    passWithNoTests: true,
  },
});
