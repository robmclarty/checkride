/**
 * Contract: legacy invariance, the resolution half (S1).
 *
 * A 0.13 TypeScript repo run with no new flag or config key resolves the same
 * checks, in the same order, under the same names, spawns the same argv and
 * names the same output files (C2). This half holds that on every `pnpm check`:
 * for each example and each `init` shape, it drives the real CLI in-process
 * with `spawn` faked, so nothing is installed and no tool runs, and compares
 * what each check would have spawned against
 * `test/fixtures/invariance/resolution.json`. Summaries and exit codes need
 * real tools, so they are the e2e half (`test/e2e/invariance.e2e.test.ts`).
 *
 * The fake spawner answers every spawn with `{}` on stdout and with the argv it
 * was handed on stderr. `{}` parses, so a check that declares a JSON output file
 * writes it and the summary names it, as a real tool's JSON would. The stderr
 * line lands in `.check/<name>.stderr.txt`, and reading it back is how each
 * argv is pinned to its check. That attribution never asks how the engine
 * schedules or launches a check, on purpose: the refactors this golden guards
 * (packs, the launcher, the output directory) move exactly that machinery.
 *
 * Each subject is recorded three ways: its canonical run (the args its
 * `expected.json` declares), the same with `--all`, which reaches every opt-in
 * adapter the repo detects, and the same with `--changed` in a git repo whose
 * `origin/main` resolves, which is the case where `{base}` must still expand to
 * 0.13's argv. Built-ins record no argv, as the summary's own `argv` won't.
 *
 * Changing the golden is a contract change. Re-record it deliberately with
 * `CHECKRIDE_UPDATE_INVARIANCE=1 pnpm exec vitest run test/contract/invariance.contract.test.ts`,
 * and say in the commit which behavior moved and why.
 */

// `execFileSync` comes from the mocked module, which spreads the real one, so
// git setup still runs for real. Only `spawn`, which every check goes through,
// is faked.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';
import { ADAPTERS } from '../../src/index.js';

/** Prefix of the stderr line the fake spawner writes; nothing a real tool prints starts with it. */
const { MARKER } = vi.hoisted(() => ({ MARKER: 'invariance-spawn: ' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');

  /**
   * Stand in for a child process that exits 0 at once. `close` waits for both
   * streams to drain, the order a real child's events arrive in, so the caller
   * has every byte before it settles.
   */
  function spawn(command: string, args: readonly string[], options: { cwd?: string } = {}): unknown {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout, stderr });
    let open = 2;
    const drained = (): void => {
      open -= 1;
      if (open === 0) child.emit('close', 0, null);
    };
    stdout.on('end', drained);
    stderr.on('end', drained);
    setImmediate(() => {
      stdout.end('{}');
      stderr.end(`${MARKER}${JSON.stringify({ argv: [command, ...args], cwd: options.cwd ?? null })}\n`);
      stdout.resume();
      stderr.resume();
    });
    return child;
  }

  return { ...actual, spawn };
});

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const EXAMPLES = join(ROOT, 'examples');
const GOLDEN = join(ROOT, 'test', 'fixtures', 'invariance', 'resolution.json');
const SUMMARIES_GOLDEN = join(ROOT, 'test', 'fixtures', 'invariance', 'summaries.json');
const UPDATE = process.env['CHECKRIDE_UPDATE_INVARIANCE'] === '1';

/**
 * What a local run or install leaves in an example, all of it gitignored. The
 * copy is the tree CI checks out, so a stale build or lockfile on one laptop
 * can't move the golden.
 */
const NOT_COPIED = /(?:^|[\\/])(?:node_modules|\.check|\.fallow|__pycache__|pnpm-lock\.yaml|[^\\/]*\.tsbuildinfo)(?:[\\/]|$)/;

/**
 * The 0.13 subjects: every example and `init` shape that existed when the
 * golden was first recorded. A later example is not a legacy repo, so it
 * joins no list here; a subject leaves the list only in a commit that says so.
 */
const EXAMPLE_NAMES = [
  'agent-loop',
  'custom-checks',
  'dal-boundaries',
  'dal-boundaries-declarative',
  'existing-repo-baseline',
  'module-boundaries',
  'polyglot',
  'prose-voice',
  'shared-preset',
] as const;
const SHAPES = ['flat', 'monorepo', 'hybrid'] as const;

/** The flags each subject is run with on top of its own args. */
const PASSES: readonly (readonly string[])[] = [[], ['--all'], ['--changed']];

/** One check as the golden records it: what resolved, what it spawned, what it wrote. */
type CheckRecord = {
  name: string;
  adapter: string | null;
  skipped?: true;
  reason?: string;
  argv?: string[];
  output_file: string | null;
};

/** One subject's golden entry: its canonical args, then each pass's checks keyed by the command line. */
type SubjectRecord = { args: string[]; runs: Record<string, CheckRecord[]> };

/** The subset of `.check/summary.json` this half reads. */
type SummaryCheck = {
  name: string;
  adapter: string | null;
  skipped?: boolean;
  reason?: string;
  output_file: string | null;
};

/** A subject to record: `prepare` lays out its tree in `dir` and returns the args of its canonical run. */
type Subject = { key: string; prepare: (dir: string) => Promise<string[]> };

/** A sink that keeps what it is given, so a failed run can say why. */
function buffer(): { out: CliDeps['stdout']; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Drop the `link:../..` checkride devDependency, as the e2e suites do (it can't
 * resolve from a copy), so both halves see the same manifest.
 */
async function dropCheckrideDep(dir: string): Promise<void> {
  const path = join(dir, 'package.json');
  const pkg = await readJson<{ devDependencies?: Record<string, string> }>(path);
  if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
  await writeFile(path, JSON.stringify(pkg, null, 2));
}

/**
 * Link each remaining `link:` dependency into `node_modules`, which is all
 * pnpm would do for it, so a config `extends` that names a sibling package
 * resolves without an install.
 */
async function linkLocalDeps(dir: string): Promise<void> {
  const pkg = await readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(dir, 'package.json'),
  );
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, spec] of Object.entries(deps)) {
    if (!spec.startsWith('link:')) continue;
    const link = join(dir, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(resolve(dir, spec.slice('link:'.length)), link);
  }
}

function exampleSubject(name: string): Subject {
  return {
    key: `example:${name}`,
    prepare: async (dir) => {
      await cp(join(EXAMPLES, name), dir, { recursive: true, filter: (src) => !NOT_COPIED.test(src) });
      await dropCheckrideDep(dir);
      await linkLocalDeps(dir);
      return (await readJson<{ args?: string[] }>(join(dir, 'expected.json'))).args ?? [];
    },
  };
}

function shapeSubject(shape: string): Subject {
  return {
    key: `init:${shape}`,
    prepare: async (dir) => {
      const err = buffer();
      const code = await runCli(['init', '--shape', shape, '--name', 't', '--scope', '@demo'], {
        cwd: dir,
        stdout: buffer().out,
        stderr: err.out,
      });
      expect(code, `init --shape ${shape}: ${err.text()}`).toBe(0);
      await dropCheckrideDep(dir);
      return [];
    },
  };
}

/**
 * Make `dir` a git repo whose `origin/main` resolves to its one commit, so a
 * `--changed` run has the base every default resolves to. Signing, hooks and
 * the user's identity are switched off, so the machine's git config can't
 * fail the commit.
 */
function commitTree(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=invariance', '-c', 'user.email=invariance@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'invariance');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
}

/** Adapters the engine runs itself; the summary records no argv for them, and neither does the golden. */
const BUILTINS: ReadonlySet<string> = new Set(ADAPTERS.filter((a) => a.builtin !== undefined).map((a) => a.name));

/** Replace the scratch directory in an argument, in both its spellings, so the golden holds no temp path. */
function portable(arg: string, roots: readonly string[]): string {
  return roots.reduce((text, root) => text.replaceAll(root, '<root>'), arg);
}

/**
 * The argv a check spawned, read back from the stderr line the fake spawner
 * wrote, or `null` when it spawned nothing. A spawned check must have spawned
 * exactly once, at the repo root.
 */
async function spawnedArgv(dir: string, check: SummaryCheck): Promise<string[] | null> {
  if (check.adapter !== null && BUILTINS.has(check.adapter)) return null;
  const path = join(dir, '.check', `${check.name}.stderr.txt`);
  if (!existsSync(path)) return null;
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.startsWith(MARKER));
  if (lines.length === 0) return null;
  expect(lines, `${check.name} spawned more than once`).toHaveLength(1);
  const spawned = JSON.parse((lines[0] ?? '').slice(MARKER.length)) as { argv: string[]; cwd: string | null };
  const roots = [dir, realpathSync(dir)];
  expect(roots, `${check.name} spawned outside the repo root`).toContain(spawned.cwd);
  return spawned.argv.map((arg) => portable(arg, roots));
}

async function recordCheck(dir: string, check: SummaryCheck): Promise<CheckRecord> {
  const base = { name: check.name, adapter: check.adapter };
  if (check.skipped === true) {
    return { ...base, skipped: true, ...(check.reason !== undefined ? { reason: check.reason } : {}), output_file: check.output_file };
  }
  const argv = await spawnedArgv(dir, check);
  return { ...base, ...(argv !== null ? { argv } : {}), output_file: check.output_file };
}

/** Run the CLI in `dir` with `argv` and record every check its summary lists, in order. */
async function recordRun(dir: string, argv: readonly string[]): Promise<CheckRecord[]> {
  await rm(join(dir, '.check'), { recursive: true, force: true });
  const err = buffer();
  const code = await runCli([...argv], { cwd: dir, stdout: buffer().out, stderr: err.out });
  expect(code, `checkride ${argv.join(' ')} was a usage error: ${err.text()}`).not.toBe(2);
  const summary = await readJson<{ checks: SummaryCheck[] }>(join(dir, '.check', 'summary.json'));
  const records: CheckRecord[] = [];
  for (const check of summary.checks) records.push(await recordCheck(dir, check));
  return records;
}

/** A JSON scalar: printed the same at any depth. */
function plain(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/**
 * JSON with one check per line, so a golden diff reads check by check: objects
 * and arrays nest by indent for `depth` levels, and anything deeper, or any
 * array of plain values, stays on one line.
 */
function stringifyGolden(value: unknown, depth: number, indent = ''): string {
  if (plain(value) || depth === 0 || (Array.isArray(value) && value.every(plain))) return JSON.stringify(value);
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => `${inner}${stringifyGolden(v, depth - 1, inner)}`)
    : Object.entries(value as Record<string, unknown>).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringifyGolden(v, depth - 1, inner)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length === 0 ? `${open}${close}` : `${open}\n${items.join(',\n')}\n${indent}${close}`;
}

/** The command line a pass is keyed by in the golden. */
function passKey(argv: readonly string[]): string {
  return ['checkride', ...argv].join(' ');
}

async function recordSubject(subject: Subject): Promise<SubjectRecord> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-invariance-'));
  try {
    const args = await subject.prepare(dir);
    commitTree(dir);
    const runs: Record<string, CheckRecord[]> = {};
    for (const pass of PASSES) {
      const argv = [...args, ...pass];
      runs[passKey(argv)] = await recordRun(dir, argv);
    }
    return { args, runs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('legacy invariance: resolution (S1)', () => {
  const subjects: Subject[] = [...EXAMPLE_NAMES.map(exampleSubject), ...SHAPES.map(shapeSubject)];
  const recorded: Record<string, SubjectRecord> = {};
  let golden: Record<string, SubjectRecord> = {};

  // A shell that exports a future CHECKRIDE_* variable (--config's, --out's)
  // would be running something other than a 0.13 repo with no new input.
  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CHECKRIDE_')) vi.stubEnv(key, undefined);
    }
    golden = existsSync(GOLDEN) ? await readJson<Record<string, SubjectRecord>>(GOLDEN) : {};
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!UPDATE) return;
    const ordered = Object.fromEntries(subjects.map((s) => [s.key, recorded[s.key] ?? golden[s.key]]));
    // Subject, runs, pass, check: four levels deep, then one check per line.
    await writeFile(GOLDEN, `${stringifyGolden(ordered, 4)}\n`);
  });

  test('every subject still exists, and the golden records exactly those subjects', () => {
    for (const name of EXAMPLE_NAMES) expect(existsSync(join(EXAMPLES, name, 'expected.json')), name).toBe(true);
    if (UPDATE) return;
    expect(Object.keys(golden)).toEqual(subjects.map((s) => s.key));
  });

  test('the summaries golden covers the same subjects', async () => {
    const summaries = await readJson<Record<string, unknown>>(SUMMARIES_GOLDEN);
    expect(Object.keys(summaries)).toEqual(subjects.map((s) => s.key));
  });

  for (const subject of subjects) {
    test(`${subject.key} resolves and spawns as 0.13 did`, async () => {
      const actual = await recordSubject(subject);
      recorded[subject.key] = actual;
      if (UPDATE) return;
      expect(actual).toStrictEqual(golden[subject.key]);
    });
  }
});
