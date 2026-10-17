import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runInit } from '../../src/init.js';
import { describeWithToolchain } from '../helpers/toolchains.js';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };
const GO_EXAMPLE = join(here, '..', '..', 'examples', 'go-existing-baseline');

type Config = { checks: Record<string, string | false> };
type Baseline = { slots: Record<string, string[]> };
type Summary = { checks: { name: string; ok: boolean; baselined?: number }[] };
/** The `ratchet` block of an example's `expected.json`; see examples/README.md. */
type Ratchet = {
  newFinding: { file: string; contents: string; exitCode: number };
  fix: { file: string; find: string; replace: string; exitCode: number; baselineKeysAfter: number };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Run the built CLI, returning its exit code and stdout instead of throwing on failure. */
async function runCli(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileP('node', [CLI, ...args], { cwd, ...BIG });
    return { code: 0, stdout };
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: string };
    return { code: typeof code === 'number' ? code : -1, stdout: stdout ?? '' };
  }
}

/** The lint check of the last run's summary. */
async function lintCheck(dir: string): Promise<Summary['checks'][number] | undefined> {
  const summary = await readJson<Summary>(join(dir, '.check', 'summary.json'));
  return summary.checks.find((check) => check.name === 'lint');
}

async function lintKeys(dir: string): Promise<number> {
  const baseline = await readJson<Baseline>(join(dir, 'checkride.baseline.json'));
  return baseline.slots['lint']?.length ?? 0;
}

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
    // Start from a green flat project and install its tools. New mode names
    // every check in checkride.config.json, and existing mode keeps a config it
    // finds, so take it away: the project stands in for a repo with tools and
    // no checkride config yet.
    await execFileP('node', [CLI, 'init', '--shape', 'flat', '--name', 't'], { cwd: dir, ...BIG });
    await rm(join(dir, 'checkride.config.json'));
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

describeWithToolchain('go')('existing Go adoption', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-existing-go-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('go-existing-baseline: init --baseline grandfathers the lint debt, a new finding fails, and a fix ratchets', async () => {
    // The example as it stood before adoption: its Go code and golangci-lint
    // config, without the baseline adoption wrote or the README describing
    // it, which links that baseline. A root go.mod and no package.json put
    // init in existing mode with the go pack (R2.1).
    const adoptedFiles = /[\\/](?:\.check|checkride\.baseline\.json|README\.md|expected\.json)$/;
    await cp(GO_EXAMPLE, dir, { recursive: true, filter: (src) => !adoptedFiles.test(src) });

    const adopted = await runCli(dir, ['init', '--baseline']);
    expect(adopted.code, adopted.stdout).toBe(0);
    expect(adopted.stdout).toContain('grandfathered failing slots into checkride.baseline.json: lint');
    expect(adopted.stdout, 'a root with no package.json has no package manager to announce').not.toContain('package manager');
    expect(existsSync(join(dir, 'package.json'))).toBe(false);

    // The failing slot stays enabled, nothing is disabled, and the debt is
    // exactly what the example commits.
    const cfg = await readJson<Config>(join(dir, 'checkride.config.json'));
    expect(cfg.checks['lint']).toBe('golangci-lint');
    expect(Object.keys(cfg.checks).filter((slot) => cfg.checks[slot] === false), 'adoption disabled a slot').toEqual([]);
    expect(await readJson<Baseline>(join(dir, 'checkride.baseline.json'))).toEqual(
      await readJson<Baseline>(join(GO_EXAMPLE, 'checkride.baseline.json')),
    );

    // Masked: green, with all three findings grandfathered.
    expect((await runCli(dir, [])).code).toBe(0);
    expect(await lintCheck(dir)).toMatchObject({ ok: true, baselined: 3 });

    // The same edits the examples suite makes to the committed example.
    const { ratchet } = await readJson<{ ratchet: Ratchet }>(join(GO_EXAMPLE, 'expected.json'));

    // A new finding fails beside the masked ones, and a failing run prunes nothing.
    await writeFile(join(dir, ratchet.newFinding.file), ratchet.newFinding.contents);
    expect((await runCli(dir, [])).code).toBe(ratchet.newFinding.exitCode);
    expect(await lintCheck(dir)).toMatchObject({ ok: false, baselined: 3 });
    expect(await lintKeys(dir)).toBe(3);
    await rm(join(dir, ratchet.newFinding.file));

    // Fixing one finding ratchets its key away.
    const fixed = join(dir, ratchet.fix.file);
    const before = await readFile(fixed, 'utf8');
    expect(before).toContain(ratchet.fix.find);
    await writeFile(fixed, before.replace(ratchet.fix.find, ratchet.fix.replace));
    expect((await runCli(dir, [])).code).toBe(ratchet.fix.exitCode);
    expect(await lintKeys(dir)).toBe(ratchet.fix.baselineKeysAfter);
  });
});
