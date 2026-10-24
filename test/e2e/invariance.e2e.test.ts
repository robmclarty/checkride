/**
 * Legacy invariance, the summary half (S1).
 *
 * A 0.13 TypeScript repo run with no new flag or config key exits with the same
 * code, and its `summary.json` differs only by the additive fields R8 lists
 * (C2). This half installs each example and each `init` shape, runs the built
 * CLI the way its canonical run does, and compares the exit code and the
 * summary against `test/fixtures/invariance/summaries.json`. The resolution
 * half (`test/contract/invariance.contract.test.ts`) holds checks, order,
 * names, argv and output files on every `pnpm check`; this one needs real
 * tools, so it runs with `pnpm test:e2e`.
 *
 * What the comparison ignores decides what it can catch, so it ignores as
 * little as it can:
 *
 * - The volatile fields are masked, not dropped, so their presence is still
 *   held: `timestamp`, `total_duration_ms`, and `duration_ms` on a check that
 *   ran. A skipped check's `duration_ms` is always 0 and stays compared.
 * - Of R8's fields, only those whose presence rule can fire in such a run are
 *   stripped before comparing: `run` and `git` at the top, and `origin`,
 *   `detected_by`, `pin_source`, `tool_version` and `argv` per check. R8's
 *   others (`targets`, `target`, `slot`, `pack`, `cwd`, `narrowed`) belong to
 *   multi-target mode, a non-`ts` implicit pack, a target root or Go
 *   narrowing, so one appearing here is itself the regression, and it fails.
 *   The top-level `digest` (0.19.0) is stripped too: a red `--digest` run, as
 *   agent-loop's canonical one is, carries it.
 *
 * Changing the golden is a contract change. Re-record it deliberately with
 * `CHECKRIDE_UPDATE_INVARIANCE=1 pnpm test:e2e test/e2e/invariance.e2e.test.ts`,
 * and say in the commit which behavior moved and why.
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const EXAMPLES = join(ROOT, 'examples');
/**
 * Where a subject whose example has since changed is kept as 0.13 left it:
 * `polyglot`, a TypeScript repo checking Python through custom checks, which
 * became `examples/python-project` on the python pack.
 */
const FROZEN = join(ROOT, 'test', 'fixtures', 'invariance', 'examples');

/** The tree a 0.13 example subject is recorded from: its frozen copy when it has one, else the example. */
function subjectTree(name: string): string {
  const frozen = join(FROZEN, name);
  return existsSync(frozen) ? frozen : join(EXAMPLES, name);
}
const GOLDEN = join(ROOT, 'test', 'fixtures', 'invariance', 'summaries.json');
const UPDATE = process.env['CHECKRIDE_UPDATE_INVARIANCE'] === '1';
const BIG = { maxBuffer: 32 * 1024 * 1024 };

/**
 * What a local run or install leaves in an example, all of it gitignored. The
 * copy is the tree CI checks out, so a stale build or lockfile on one laptop
 * can't move the golden.
 */
const NOT_COPIED = /(?:^|[\\/])(?:node_modules|\.check|\.fallow|__pycache__|pnpm-lock\.yaml|[^\\/]*\.tsbuildinfo)(?:[\\/]|$)/;

/** The 0.13 subjects, the same list the resolution half records. */
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

/** Stands in for a value that changes run to run. */
const VOLATILE = '<volatile>';

/** The additive top-level fields a 0.13 TypeScript repo's run may gain: R8's `run` and `git`, and `digest`. */
const ADDITIVE_TOP: readonly string[] = ['run', 'git', 'digest'];

/** R8's per-check fields that a 0.13 TypeScript repo's run may gain. */
const ADDITIVE_CHECK: readonly string[] = ['origin', 'detected_by', 'pin_source', 'tool_version', 'argv'];

type Json = Record<string, unknown>;

/** One subject's golden entry: the args of its canonical run, its exit code and its masked summary. */
type SubjectRecord = { args: string[]; exit_code: number; summary: Json };

/** A subject to record: `prepare` lays out its tree in `dir` and says what its run needs. */
type Subject = { key: string; prepare: (dir: string) => Promise<{ args: string[]; requires: string[] }> };

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * The environment the CLI runs under: this one, minus every `CHECKRIDE_*`
 * variable. A shell that exports a future one (`--config`'s, `--out`'s) would
 * be running something other than a 0.13 repo with no new input.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CHECKRIDE_')));
}

/** Run the built CLI, returning its exit code instead of throwing on failure. */
async function runCli(cwd: string, args: readonly string[]): Promise<number> {
  try {
    await execFileP('node', [CLI, ...args], { cwd, env: cleanEnv(), ...BIG });
    return 0;
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : -1;
  }
}

/** Drop the `link:../..` checkride devDependency, which can't resolve from a copy, and install. */
async function install(dir: string): Promise<void> {
  const pkgPath = join(dir, 'package.json');
  const pkg = await readJson<{ devDependencies?: Record<string, string> }>(pkgPath);
  if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  await execFileP('pnpm', ['install'], { cwd: dir, ...BIG });
}

function exampleSubject(name: string): Subject {
  return {
    key: `example:${name}`,
    prepare: async (dir) => {
      await cp(subjectTree(name), dir, { recursive: true, filter: (src) => !NOT_COPIED.test(src) });
      const expected = await readJson<{ args?: string[]; requires?: string[] }>(join(dir, 'expected.json'));
      return { args: expected.args ?? [], requires: expected.requires ?? [] };
    },
  };
}

function shapeSubject(shape: string): Subject {
  return {
    key: `init:${shape}`,
    prepare: async (dir) => {
      await execFileP('node', [CLI, 'init', '--shape', shape, '--name', 't', '--scope', '@demo'], { cwd: dir, ...BIG });
      return { args: [], requires: [] };
    },
  };
}

/** Whether a binary a subject depends on is callable on this machine. */
function onPath(binary: string): boolean {
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore' });
  return probe.error === undefined && probe.status === 0;
}

/** Copy `record` without the `drop` keys. */
function without(record: Json, drop: readonly string[]): Json {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.includes(key)));
}

/**
 * Copy `record` with each `keys` value it holds replaced by the mask. A key it
 * doesn't hold stays absent, so a field that goes missing still fails.
 */
function masked(record: Json, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, keys.includes(key) ? VOLATILE : value]));
}

/** A check entry with R8's per-check fields stripped and a ran check's duration masked. */
function maskCheck(check: Json): Json {
  const kept = without(check, ADDITIVE_CHECK);
  return check['skipped'] === true ? kept : masked(kept, ['duration_ms']);
}

/** The summary as the golden holds it: R8's fields stripped, volatile values masked. */
function maskSummary(summary: Json): Json {
  const checks = Array.isArray(summary['checks']) ? (summary['checks'] as Json[]) : [];
  return { ...masked(without(summary, ADDITIVE_TOP), ['timestamp', 'total_duration_ms']), checks: checks.map(maskCheck) };
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
    : Object.entries(value as Json).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringifyGolden(v, depth - 1, inner)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length === 0 ? `${open}${close}` : `${open}\n${items.join(',\n')}\n${indent}${close}`;
}

describe('legacy invariance: summaries and exit codes (S1)', () => {
  const subjects: Subject[] = [...EXAMPLE_NAMES.map(exampleSubject), ...SHAPES.map(shapeSubject)];
  const recorded: Record<string, SubjectRecord> = {};
  let golden: Record<string, SubjectRecord> = {};

  beforeAll(async () => {
    golden = existsSync(GOLDEN) ? await readJson<Record<string, SubjectRecord>>(GOLDEN) : {};
  });

  // A subject skipped for a missing toolchain keeps the entry it had.
  afterAll(async () => {
    if (!UPDATE) return;
    const ordered = Object.fromEntries(subjects.map((s) => [s.key, recorded[s.key] ?? golden[s.key]]));
    // Subject, summary, checks, check: four levels deep, then one check per line.
    await writeFile(GOLDEN, `${stringifyGolden(ordered, 4)}\n`);
  });

  test('the golden records exactly these subjects', () => {
    if (UPDATE) return;
    expect(Object.keys(golden)).toEqual(subjects.map((s) => s.key));
  });

  for (const subject of subjects) {
    test(`${subject.key} keeps its 0.13 summary and exit code`, async ({ skip }) => {
      const dir = await mkdtemp(join(tmpdir(), 'checkride-invariance-'));
      try {
        const { args, requires } = await subject.prepare(dir);
        // A toolchain outside npm's reach: CI has it; a laptop might not.
        const missing = requires.filter((binary) => !onPath(binary));
        if (missing.length > 0) skip(`${subject.key} requires ${missing.join(', ')}, not on PATH`);

        await install(dir);
        const exitCode = await runCli(dir, args);
        const summary = await readJson<Json>(join(dir, '.check', 'summary.json'));
        const actual: SubjectRecord = { args, exit_code: exitCode, summary: maskSummary(summary) };
        recorded[subject.key] = actual;
        if (UPDATE) return;
        expect(actual).toStrictEqual(golden[subject.key]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
