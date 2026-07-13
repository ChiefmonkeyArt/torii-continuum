import { defineConfig } from 'vitest/config';

// The frontend (root) and the agent are separate packages with separate test
// runners. The agent ships its own `node --test` suite under `agent/test/`
// (run via `npm --prefix agent test`); those files are node:test modules, not
// vitest suites, so vitest must not collect them. Exclude the agent subtree
// (and build output) here. The root has no vitest suites yet, so an empty run
// is a pass rather than a failure.
export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**', 'agent/**'],
    passWithNoTests: true,
  },
});
