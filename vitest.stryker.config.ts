import { defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

// Stryker's own test config: the unit suite, less the tests that read this
// repo's git state. Stryker runs the tests in `.stryker-tmp/sandbox-*`, a
// gitignored copy with no git state of its own, so `git ls-files` there lists
// nothing and those tests fail the dry run before a single mutant runs. They
// guard the repo's files rather than the code stryker mutates, and `pnpm check`
// still runs them through vitest.config.ts.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: ['test/integration/dogfood-config.test.ts'],
    },
  }),
);
