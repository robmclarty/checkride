import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runInit } from '../../src/init/index.js';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli', 'index.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

type Config = { checks: Record<string, string | false> };

describe('existing-project adoption', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-existing-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('existing-biome: adopts lint -> biome from a present biome.json', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'biome.json'), '{}');
    await runInit({ cwd: dir, probeFailures: () => Promise.resolve([]) });
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Config;
    expect(cfg.checks['lint']).toBe('biome');
  });

  test('existing-failing: init disables a failing slot, then checkride is green', async () => {
    // Start from a green flat project and install its tools.
    await execFileP('node', [CLI, 'init', '--shape', 'flat', '--name', 't'], { cwd: dir, ...BIG });
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
    if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await execFileP('pnpm', ['install'], { cwd: dir, ...BIG });

    // Introduce a deliberate, non-cascading failure: a broken relative link.
    await writeFile(join(dir, 'BROKEN.md'), '# broken\n\n[missing](./does-not-exist.md)\n');

    // Existing-mode init runs the adopted checks once; the links slot fails and
    // is recorded as disabled.
    await execFileP('node', [CLI, 'init'], { cwd: dir, ...BIG });
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Config;
    expect(cfg.checks['links']).toBe(false);

    // With the failing slot disabled, the pipeline is green.
    await execFileP('node', [CLI], { cwd: dir, ...BIG });
  });
});
