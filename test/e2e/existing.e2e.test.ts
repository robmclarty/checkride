import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
type Baseline = { slots: Record<string, string[]>; captured_with?: Record<string, { pin_source: string; toolchain_version?: string }> };
type Summary = { checks: { name: string; ok: boolean; baselined?: number }[] };
/** The `ratchet` block of an example's `expected.json`; see examples/README.md. */
type Ratchet = {
  newFinding: { file: string; contents: string; exitCode: number };
  fix: { file: string; find: string; replace: string; exitCode: number; baselineKeysAfter: number };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Run the built CLI, under `env` when given, returning its exit code, stdout and stderr instead of throwing on failure. */
async function runCli(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], { cwd, ...BIG, ...(env !== undefined ? { env } : {}) });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof code === 'number' ? code : -1, stdout: stdout ?? '', stderr: stderr ?? '' };
  }
}

/**
 * Whether a PATH entry stays for a run that must not find this repo's tools:
 * any but a `node_modules/.bin`, unless it holds pnpm itself, as the one CI's
 * pnpm/action-setup installs does.
 */
function keepOnPath(dir: string): boolean {
  return !dir.includes(join('node_modules', '.bin')) || existsSync(join(dir, 'pnpm'));
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

  test('existing-uninstalled: a declared tool nothing installed is left on, naming pnpm install, and the run says so too', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy', private: true, devDependencies: { oxlint: '1.87.0' } }));
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    await writeFile(join(dir, 'a.js'), 'export const a = 1;\n');
    const hint = "`oxlint` isn't in node_modules/.bin, and checks never install a tool: run `pnpm install` first";
    // `pnpm exec` runs a copy PATH holds when node_modules has none, and the suite's PATH holds this repo's.
    const env = { ...process.env, PATH: (process.env['PATH'] ?? '').split(delimiter).filter(keepOnPath).join(delimiter) };

    const dry = await runCli(dir, ['init', '--dry-run'], env);
    expect(dry.code, dry.stdout).toBe(0);
    expect(dry.stdout).toContain(`left on, can't run until set up (then \`checkride baseline\` grandfathers what it finds): lint (${hint})`);
    // The dry run probed lint and wrote nothing, its artifacts included (#17).
    expect(existsSync(join(dir, '.check'))).toBe(false);

    const adopted = await runCli(dir, ['init'], env);
    expect(adopted.code, adopted.stdout).toBe(0);
    expect(adopted.stdout).toContain(`: lint (${hint})`);
    expect(adopted.stdout).not.toContain('disabled failing slots');
    expect((await readJson<Config>(join(dir, 'checkride.config.json'))).checks['lint']).toBe('oxlint');

    const run = await runCli(dir, ['--only', 'lint'], env);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(hint);
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
    // exactly what the example commits. The capture also records the Go
    // release golangci-lint ran on, which the committed file leaves out, since
    // a machine on another Go minor would hold its ratchet back.
    const cfg = await readJson<Config>(join(dir, 'checkride.config.json'));
    expect(cfg.checks['lint']).toBe('golangci-lint');
    expect(Object.keys(cfg.checks).filter((slot) => cfg.checks[slot] === false), 'adoption disabled a slot').toEqual([]);
    const captured = await readJson<Baseline>(join(dir, 'checkride.baseline.json'));
    const committed = await readJson<Baseline>(join(GO_EXAMPLE, 'checkride.baseline.json'));
    expect(captured.slots).toEqual(committed.slots);
    expect(Object.keys(captured.captured_with ?? {})).toEqual(Object.keys(committed.captured_with ?? {}));
    for (const [check, record] of Object.entries(captured.captured_with ?? {})) {
      expect(record.pin_source, check).toBe(committed.captured_with?.[check]?.pin_source);
      if (record.toolchain_version !== undefined) expect(record.toolchain_version, check).toMatch(/^\d+\.\d+/);
    }

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
