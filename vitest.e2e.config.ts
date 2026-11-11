import { defineConfig } from 'vitest/config';

// Slow end-to-end suite: generates projects, installs them, and runs the built
// CLI against them. Kept out of the default `pnpm check` (see vitest.config.ts);
// run explicitly via `pnpm test:e2e` in CI and before any release.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    // No case reads a CHECKRIDE_* variable the shell or CI exported.
    setupFiles: ['test/helpers/clean-env.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ['default'],
  },
});
