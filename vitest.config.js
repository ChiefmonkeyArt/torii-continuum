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
// (and build output) here.
//
// FE-15: the include list is EXPLICIT (current SPA suites + the current .21
// onboarding test only), so an archived/misplaced suite can neither silently
// inflate the count nor vanish without failing the run. passWithNoTests is
// false (the default) so failed test DISCOVERY fails CI instead of green-passing
// an empty run.
export default defineConfig({
  // Mirror the Vite build-time define so `appVersion()` resolves the real
  // package version under test instead of falling back to the placeholder.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: [
      'src/**/*.test.js',
      'test/**/*.test.js',
      'preview-assets/onboarding-v0.1.21/test/**/*.test.js',
    ],
    exclude: ['node_modules/**', 'dist/**', 'agent/**'],
    passWithNoTests: false,
  },
});
