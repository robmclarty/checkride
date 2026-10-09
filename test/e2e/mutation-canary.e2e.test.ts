/**
 * Mutation testing still kills mutants.
 *
 * stryker breaks silently. Under vitest 5 its runner's per-test filter matched
 * nothing (stryker-js #6210), so every mutant run executed zero tests and every
 * mutant "survived". Under TypeScript 7 its tsconfig rewrite crashed, but only
 * when a tsconfig was there to rewrite. In both cases the unit suite stayed
 * green, and only a 25-minute mutation run showed the score had collapsed.
 *
 * This canary runs the repo's real `stryker.config.mjs`, narrowed to a
 * three-test project, in seconds. Its tests sit inside a `describe`, because
 * #6210 bites only on nested test names, and it carries a `tsconfig.json`,
 * because the TypeScript 7 crash needs one. A run that kills nothing fails here.
 * If it does, read the `patchedDependencies` comment in pnpm-workspace.yaml
 * before anything else: that's where the carried stryker fix and its
 * retirement test live.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const STRYKER = join(ROOT, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

/** A clamp is small, and each of its branches has a test that notices a change. */
const SOURCE = `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;

const TESTS = `import { describe, expect, test } from 'vitest';

import { clamp } from '../src/clamp.js';

describe('clamp', () => {
  test('raises a value below the range to the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  test('lowers a value above the range to the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
`;

const FILES: Record<string, string> = {
  'package.json': '{ "name": "mutation-canary", "private": true, "type": "module" }\n',
  'tsconfig.json':
    '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true }, "include": ["src", "test"] }\n',
  'vitest.config.ts': "export default { test: { include: ['test/**/*.test.ts'] } };\n",
  'src/clamp.ts': SOURCE,
  'test/clamp.test.ts': TESTS,
};

type MutationReport = { files: Record<string, { mutants: { status: string }[] }> };

/** The repo's own stryker config, so the canary exercises exactly what `pnpm mutation` runs. */
async function repoStrykerConfig(): Promise<Record<string, unknown>> {
  const mod = (await import(pathToFileURL(join(ROOT, 'stryker.config.mjs')).href)) as {
    default: Record<string, unknown>;
  };
  return mod.default;
}

/** Status → count across every mutant in the report. */
function tally(report: MutationReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of Object.values(report.files)) {
    for (const { status } of file.mutants) counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

describe('mutation canary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-mutation-canary-'));
    for (const [path, body] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), body);
    }
    // The repo's install, patched runner included, resolves from the temp dir.
    await symlink(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the repo's stryker setup kills mutants under nested test names", async () => {
    const config = {
      ...(await repoStrykerConfig()),
      mutate: ['src/**/*.ts'],
      incremental: false,
      reporters: ['json'],
      jsonReporter: { fileName: 'reports/mutation.json' },
      thresholds: { high: 80, low: 60, break: null },
      concurrency: 2,
    };
    await writeFile(join(dir, 'stryker.config.json'), JSON.stringify(config, null, 2));

    await execFileP(process.execPath, [STRYKER, 'run', 'stryker.config.json'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    });

    const report = JSON.parse(await readFile(join(dir, 'reports', 'mutation.json'), 'utf8')) as MutationReport;
    const counts = tally(report);
    const killed = counts['Killed'] ?? 0;
    const total = Object.values(counts).reduce((n, c) => n + c, 0);

    expect(
      killed,
      `stryker killed no mutants (${JSON.stringify(counts)}). Mutation testing is broken without saying so; ` +
        'check the patchedDependencies comment in pnpm-workspace.yaml (stryker-js #6210).',
    ).toBeGreaterThan(0);
    // A healthy run kills most of them; the one survivor class here is the
    // equivalent `<` to `<=` boundary, which returns the same value either way.
    expect(killed / total).toBeGreaterThanOrEqual(0.6);
  });
});
