/**
 * The test process never sees a `CHECKRIDE_*` variable from the shell or the
 * CI job that started it: `test/helpers/clean-env.ts` removes them before any
 * test file loads, and every vitest config in the repo lists it. CI sets
 * `CHECKRIDE_ANNOTATE` on the step that runs these tests, and a test that
 * calls `runCli` with no `env` reads `process.env`.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

const ROOT = new URL('../../', import.meta.url);

/** The variables the tests read for themselves, which the setup file leaves. */
const HARNESS_VARS = ['CHECKRIDE_REQUIRE_TOOLCHAINS', 'CHECKRIDE_UPDATE_INVARIANCE'];

describe('the test environment', () => {
  test('holds no CHECKRIDE_* variable but the two the tests read for themselves', () => {
    const set = Object.keys(process.env).filter((name) => name.startsWith('CHECKRIDE_') && !HARNESS_VARS.includes(name));
    expect(set).toEqual([]);
  });

  test('every vitest config lists the setup file that clears them, the stryker one through the config it merges', () => {
    const configs = readdirSync(ROOT).filter((name) => /^vitest\..*config\.ts$/.test(name) || name === 'vitest.config.ts');
    expect(configs.toSorted()).toEqual(['vitest.config.ts', 'vitest.e2e.config.ts', 'vitest.stryker.config.ts']);
    for (const name of configs) {
      const text = readFileSync(new URL(name, ROOT), 'utf8');
      const cleared = text.includes("setupFiles: ['test/helpers/clean-env.ts']") || (text.includes("from './vitest.config.ts'") && text.includes('mergeConfig('));
      expect(cleared, name).toBe(true);
    }
  });

  test('a run started with no env of its own writes no annotation, whatever the job exported', async () => {
    let stderr = '';
    const sink = { write: (text: string) => { stderr += text; return true; } };
    // A flag the run rejects after it has read its variables: an exported CHECKRIDE_ANNOTATE=nope would be named first.
    expect(await runCli(['--base', ''], { cwd: process.cwd(), stdout: sink, stderr: sink })).toBe(2);
    expect(stderr).toBe('checkride: --base was passed with no ref\n');
  });
});
