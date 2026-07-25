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

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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
type SummaryCheck = {
  name: string;
  ok: boolean;
  description?: string;
  skipped?: boolean;
  reason?: string;
  baselined?: number;
};
type Summary = { checks: SummaryCheck[] };

/** One example's declared contract — see examples/README.md. */
type SlotExpectation = {
  ok?: boolean;
  description?: string;
  skipped?: boolean;
  reason?: string;
  baselined?: number;
};
type Ratchet = {
  newFinding: { file: string; contents: string; exitCode: number };
  fix: { file: string; find: string; replace: string; exitCode: number; baselineKeysAfter: number };
};

/**
 * One deliberate rule-breaking edit, and the failure it must produce.
 *
 * A boundary rule that never fires is worse than no rule: it reads like
 * enforcement in review and enforces nothing. `failing` is a floor, not an
 * exact set — one violation often trips several checks, and pinning all of them
 * would make the suite brittle. `deadSummary` pins *which* fallow finding
 * fired, so "the file was unused" can't masquerade as "the boundary held".
 */
type Violation = {
  name: string;
  edits: { file: string; find?: string; replace?: string; contents?: string }[];
  exitCode: number;
  failing?: string[];
  deadSummary?: Record<string, number>;
  structRules?: string[];
};
type Expected = {
  args?: string[];
  requires?: string[];
  exitCode: number;
  checks?: Record<string, SlotExpectation>;
  firstCheck?: string;
  lastCheck?: string;
  digestContains?: string[];
  ratchet?: Ratchet;
  violations?: Violation[];
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
    if (want.description !== undefined) expect(got.description, `${slot}.description`).toBe(want.description);
    if (want.skipped !== undefined) expect(got.skipped ?? false, `${slot}.skipped`).toBe(want.skipped);
    if (want.reason !== undefined) expect(got.reason, `${slot}.reason`).toBe(want.reason);
    if (want.baselined !== undefined) expect(got.baselined, `${slot}.baselined`).toBe(want.baselined);
  }
}

/** Whether a binary an example depends on is callable on this machine. */
function onPath(binary: string): boolean {
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  return probe.error === undefined && probe.status === 0;
}

/** The example's canonical run: exit code, per-slot verdicts, pipeline order, digest. */
async function assertCanonicalRun(dir: string, name: string, expected: Expected): Promise<void> {
  expect(await runCli(dir, expected.args ?? []), `${name}: exit code`).toBe(expected.exitCode);

  const summary = await readJson<Summary>(join(dir, '.check', 'summary.json'));
  if (expected.checks) assertChecks(summary, expected.checks);

  // Ordering is a promise `order: "first"` / `"last"` makes, so assert it rather
  // than trusting the run output to have looked right.
  if (expected.firstCheck !== undefined) {
    expect(summary.checks[0]?.name, `${name}: first check in pipeline order`).toBe(expected.firstCheck);
  }
  if (expected.lastCheck !== undefined) {
    expect(summary.checks.at(-1)?.name, `${name}: last check in pipeline order`).toBe(expected.lastCheck);
  }

  if (expected.digestContains) {
    const digest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
    for (const needle of expected.digestContains) expect(digest).toContain(needle);
  }
}

/** Apply one violation's edits, returning a restore function for each touched file. */
async function applyEdits(dir: string, violation: Violation): Promise<() => Promise<void>> {
  const undo: (() => Promise<void>)[] = [];

  for (const edit of violation.edits) {
    const path = join(dir, edit.file);

    if (edit.find !== undefined) {
      const before = await readFile(path, 'utf8');
      expect(before, `${violation.name}: ${edit.file} no longer contains the text to edit`).toContain(edit.find);
      await writeFile(path, before.replace(edit.find, edit.replace ?? ''));
      undo.push(async () => writeFile(path, before));
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, edit.contents ?? '');
      undo.push(async () => rm(path, { force: true }));
    }
  }

  return async () => {
    for (const restore of undo) await restore();
  };
}

/** Assert the fallow finding counters a violation must produce. */
async function assertDeadSummary(dir: string, violation: Violation): Promise<void> {
  const dead = await readJson<{ summary: Record<string, number> }>(join(dir, '.check', 'dead.json'));
  for (const [counter, count] of Object.entries(violation.deadSummary ?? {})) {
    expect(dead.summary[counter], `${violation.name}: fallow ${counter}`).toBe(count);
  }
}

/** Assert the ast-grep rules a violation must trip. */
async function assertStructRules(dir: string, violation: Violation): Promise<void> {
  const matches = await readJson<{ ruleId: string }[]>(join(dir, '.check', 'struct.json'));
  const tripped = new Set(matches.map((match) => match.ruleId));
  for (const rule of violation.structRules ?? []) {
    expect([...tripped], `${violation.name}: ast-grep rules that fired`).toContain(rule);
  }
}

/**
 * Every declared violation must actually break the build — and break it for the
 * stated reason. Each is applied to the working copy, run, then reverted, so
 * the violations are independent of one another.
 */
async function assertViolations(dir: string, args: readonly string[], violations: readonly Violation[]): Promise<void> {
  for (const violation of violations) {
    const revert = await applyEdits(dir, violation);
    try {
      expect(await runCli(dir, args), `violation "${violation.name}" must exit ${violation.exitCode}`).toBe(
        violation.exitCode,
      );

      const summary = await readJson<Summary>(join(dir, '.check', 'summary.json'));
      const failed = summary.checks.filter((check) => !check.ok && check.skipped !== true).map((check) => check.name);
      for (const slot of violation.failing ?? []) {
        expect(failed, `violation "${violation.name}" must fail the ${slot} check`).toContain(slot);
      }

      if (violation.deadSummary) await assertDeadSummary(dir, violation);
      if (violation.structRules) await assertStructRules(dir, violation);
    } finally {
      await revert();
    }
  }
}

/** The baseline ratchet: a new finding fails, a failing run doesn't prune, a fix does. */
async function assertRatchet(dir: string, args: readonly string[], ratchet: Ratchet): Promise<void> {
  const { newFinding, fix } = ratchet;
  const granted = await baselineKeys(dir);

  await writeFile(join(dir, newFinding.file), newFinding.contents);
  expect(await runCli(dir, args), 'a new finding must fail the run').toBe(newFinding.exitCode);
  expect(await baselineKeys(dir), 'a failing run must not prune the baseline').toBe(granted);
  await unlink(join(dir, newFinding.file));

  const target = join(dir, fix.file);
  const before = await readFile(target, 'utf8');
  expect(before, `${fix.file} no longer contains the debt to fix`).toContain(fix.find);
  await writeFile(target, before.replace(fix.find, fix.replace));
  expect(await runCli(dir, args), 'fixing debt must leave the run green').toBe(fix.exitCode);
  expect(await baselineKeys(dir), 'the ratchet must prune the fixed entry').toBe(fix.baselineKeysAfter);
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
      for (const file of ['README.md', 'expected.json', 'pnpm-workspace.yaml']) {
        expect(existsSync(join(dir, file)), `${name}/${file} is missing`).toBe(true);
      }

      // An example that runs oxlint needs its own config for isolation, not
      // style: without one it inherits the repo root's through ancestor
      // discovery and stops being standalone. See test/dogfood-config.test.ts
      // for the matching half of this constraint. An example that doesn't
      // install oxlint never runs it, so it needs nothing.
      if (pkg.devDependencies?.['oxlint'] !== undefined) {
        expect(existsSync(join(dir, '.oxlintrc.json')), `${name} installs oxlint but has no .oxlintrc.json`).toBe(
          true,
        );
      }

      expect(pkg.private, `${name} must be private so it can never be published`).toBe(true);
      expect(pkg.devDependencies?.['checkride'], `${name} must link the working tree`).toBe('link:../..');
    }
  });

  for (const name of names) {
    test(`${name} behaves as its expected.json declares`, async ({ skip }) => {
      const expected = await readJson<Expected>(join(EXAMPLES, name, 'expected.json'));
      const args = expected.args ?? [];

      // An example may depend on a toolchain outside npm's reach. CI has these,
      // so the coverage is real; a contributor's laptop might not, and skipping
      // loudly beats a failure that says nothing about their change.
      const missing = (expected.requires ?? []).filter((binary) => !onPath(binary));
      if (missing.length > 0) skip(`${name} requires ${missing.join(', ')}, not on PATH`);

      const dir = await mkdtemp(join(tmpdir(), `checkride-example-${name}-`));

      try {
        await prepare(name, dir);
        await assertCanonicalRun(dir, name, expected);
        if (expected.violations) await assertViolations(dir, args, expected.violations);
        if (expected.ratchet) await assertRatchet(dir, args, expected.ratchet);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
