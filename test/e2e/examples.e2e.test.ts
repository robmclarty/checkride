/**
 * The examples suite.
 *
 * An example nobody executes is a claim nobody checks — the same failure mode
 * the `snippets` slot exists to prevent for README fences. So every directory
 * under `examples/` declares what a correct run looks like in `expected.json`,
 * and this suite installs it, runs the built CLI against it, and asserts that
 * contract. Adding an example registers it automatically; there is no list.
 *
 * Each example is copied to a temp directory first. That keeps installs and the
 * deliberately destructive ratchet steps out of the working tree, and it is why
 * the copy's `checkride` devDependency is dropped: `link:../..` resolves
 * relative to the example's own location, which the copy no longer shares. The
 * built CLI is driven directly instead, exactly as the shapes suite does.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const EXAMPLES = join(ROOT, 'examples');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

/** Artifacts of a previous local run; never copied into the scratch dir. */
const NOT_COPIED = /(?:^|[\\/])(?:node_modules|\.check)(?:[\\/]|$)/;

/** The subset of `.check/summary.json` these assertions read. */
type SummaryCheck = { name: string; ok: boolean; skipped?: boolean; baselined?: number };
type Summary = { checks: SummaryCheck[] };

/** One example's declared contract — see examples/README.md. */
type SlotExpectation = { ok?: boolean; skipped?: boolean; baselined?: number };
type Expected = {
  args?: string[];
  exitCode: number;
  checks?: Record<string, SlotExpectation>;
  digestContains?: string[];
  ratchet?: {
    newFinding: { file: string; contents: string; exitCode: number };
    fix: { file: string; find: string; replace: string; exitCode: number; baselineKeysAfter: number };
  };
};

/** Every example directory, discovered rather than listed. */
const names = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Run the built CLI, returning its exit code instead of throwing on failure. */
async function runCli(cwd: string, args: readonly string[]): Promise<number> {
  try {
    await execFileP('node', [CLI, ...args], { cwd, ...BIG });
    return 0;
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : -1;
  }
}

/** Copy an example to `dir` and install its own dependencies there. */
async function prepare(name: string, dir: string): Promise<void> {
  await cp(join(EXAMPLES, name), dir, { recursive: true, filter: (src) => !NOT_COPIED.test(src) });

  const pkgPath = join(dir, 'package.json');
  const pkg = await readJson<{ devDependencies?: Record<string, string> }>(pkgPath);
  if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await execFileP('pnpm', ['install'], { cwd: dir, ...BIG });
}

/** Total grandfathered keys across every slot of a committed baseline. */
async function baselineKeys(dir: string): Promise<number> {
  const baseline = await readJson<{ slots?: Record<string, readonly string[]> }>(
    join(dir, 'checkride.baseline.json'),
  );
  return Object.values(baseline.slots ?? {}).reduce((total, keys) => total + keys.length, 0);
}

/** Assert the named slots of a summary; slots the example doesn't name are ignored. */
function assertChecks(summary: Summary, expected: Record<string, SlotExpectation>): void {
  for (const [slot, want] of Object.entries(expected)) {
    const got = summary.checks.find((check) => check.name === slot);
    expect(got, `slot '${slot}' is missing from summary.json`).toBeDefined();
    if (!got) continue;
    if (want.ok !== undefined) expect(got.ok, `${slot}.ok`).toBe(want.ok);
    if (want.skipped !== undefined) expect(got.skipped ?? false, `${slot}.skipped`).toBe(want.skipped);
    if (want.baselined !== undefined) expect(got.baselined, `${slot}.baselined`).toBe(want.baselined);
  }
}

describe('examples', () => {
  test('the suite has examples to run', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  // Cheap structural checks, and the one thing the temp-dir runs cannot cover:
  // the copies strip the `link:../..` devDependency, so nothing else would
  // notice if an example stopped pointing at the working tree.
  test('every example is a standalone package linking the working tree', async () => {
    const manifests = await Promise.all(
      names.map(async (name) => ({
        name,
        pkg: await readJson<{ private?: boolean; devDependencies?: Record<string, string> }>(
          join(EXAMPLES, name, 'package.json'),
        ),
      })),
    );

    for (const { name, pkg } of manifests) {
      const dir = join(EXAMPLES, name);
      // `.oxlintrc.json` is required for isolation, not style: without one, an
      // example inherits the repo root's oxlint config through ancestor
      // discovery and stops being standalone. See test/dogfood-config.test.ts
      // for the matching half of this constraint.
      for (const file of ['README.md', 'expected.json', 'pnpm-workspace.yaml', '.oxlintrc.json']) {
        expect(existsSync(join(dir, file)), `${name}/${file} is missing`).toBe(true);
      }

      expect(pkg.private, `${name} must be private so it can never be published`).toBe(true);
      expect(pkg.devDependencies?.['checkride'], `${name} must link the working tree`).toBe('link:../..');
    }
  });

  for (const name of names) {
    test(`${name} behaves as its expected.json declares`, async () => {
      const expected = await readJson<Expected>(join(EXAMPLES, name, 'expected.json'));
      const args = expected.args ?? [];
      const dir = await mkdtemp(join(tmpdir(), `checkride-example-${name}-`));

      try {
        await prepare(name, dir);

        expect(await runCli(dir, args), `${name}: exit code`).toBe(expected.exitCode);

        const summary = await readJson<Summary>(join(dir, '.check', 'summary.json'));
        if (expected.checks) assertChecks(summary, expected.checks);

        if (expected.digestContains) {
          const digest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
          for (const needle of expected.digestContains) expect(digest).toContain(needle);
        }

        if (expected.ratchet) {
          const { newFinding, fix } = expected.ratchet;
          const granted = await baselineKeys(dir);

          // A finding that isn't grandfathered fails the run — and a failing
          // run still leaves the baseline alone.
          await writeFile(join(dir, newFinding.file), newFinding.contents);
          expect(await runCli(dir, args), 'a new finding must fail the run').toBe(newFinding.exitCode);
          expect(await baselineKeys(dir), 'a failing run must not prune the baseline').toBe(granted);
          await unlink(join(dir, newFinding.file));

          // Fixing grandfathered debt prunes its entry: the ratchet.
          const target = join(dir, fix.file);
          const before = await readFile(target, 'utf8');
          expect(before, `${fix.file} no longer contains the debt to fix`).toContain(fix.find);
          await writeFile(target, before.replace(fix.find, fix.replace));
          expect(await runCli(dir, args), 'fixing debt must leave the run green').toBe(fix.exitCode);
          expect(await baselineKeys(dir), 'the ratchet must prune the fixed entry').toBe(fix.baselineKeysAfter);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
