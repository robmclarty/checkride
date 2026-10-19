import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ADAPTERS, SLOTS } from '../../adapters.js';
import type { Adapter, Order } from '../../adapters.js';
import type { Baseline } from '../../baseline/index.js';
import { resolveChecks } from '../../config.js';
import type { ResolvedCheck } from '../../config.js';
import { detectPackageManager } from '../../launch/index.js';
import { PACKS } from '../../packs/index.js';
import type { Target } from '../../targets/index.js';
import { resolveRunContext } from '../context.js';
import { executeChecks } from '../execute.js';
import { fixInvocation } from '../fix.js';
import type { CheckRunner, Out, RunFlags, RunOptions, RunResult, Summary, SummaryCheck } from '../index.js';
import { runChecks, runFix, selectChecks } from '../index.js';
import { formatStatusLine } from '../report.js';
import { defaultConcurrency, defaultRunner, missingExemplarsOutcome, runtimeArgs } from '../spawn.js';

function mkResolved(slot: string, optIn = false): ResolvedCheck {
  return { slot, optIn, adapter: null, skip: null };
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

function sink(): { out: Out; lines: string[] } {
  const lines: string[] = [];
  return { lines, out: { write: (text: string) => { lines.push(text); return true; } } };
}

/**
 * True while `pid` names a live process (signal 0 probes without delivering).
 * An empty pid file reads as 0, which names this process's own group, so the
 * SIGKILL safety net after a probe would take the test runner down with it:
 * a pid that isn't positive fails the test instead.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid to probe: read ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const failLint: CheckRunner = (r) =>
  Promise.resolve({ ok: r.slot !== 'lint', exit_code: r.slot === 'lint' ? 1 : 0, stdout: '', stderr: '' });

const okRunner: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

/** A runner that reports `types` as a pinned npm tool with its version, and every other check as a tool from PATH. */
const pinned: CheckRunner = (r) => Promise.resolve({
  ok: true, exit_code: 0, stdout: '', stderr: '',
  ...(r.slot === 'types' ? { argv: ['tsc'], pin_source: 'js-lockfile' as const, tool_version: '5.9.3' } : { argv: ['oxlint'], pin_source: 'path' as const }),
});

/** A runner that reports `[<slot>, '--flag']` as the argv it spawned, and exits 77 for `licenses`. */
const argvRunner: CheckRunner = (r) => {
  const exit_code = r.slot === 'licenses' ? 77 : 0;
  return Promise.resolve({ ok: exit_code === 0, exit_code, stdout: '', stderr: '', argv: [r.slot, '--flag'] });
};

/** A runner that writes its own `.check/test.json`, the way vitest/jest do via `--outputFile`. */
const toolWrites: CheckRunner = async (_r, ctx) => {
  await writeFile(join(ctx.cwd, '.check', 'test.json'), JSON.stringify({ fresh: true }));
  return { ok: true, exit_code: 0, stdout: '', stderr: '' };
};

/**
 * A fresh orchestrator module graph per test. `runChecks` clears the interrupt
 * latch on entry, so a latched instance no longer poisons later tests, but each
 * signal test still wants its own `liveChecks` registry — an in-flight check
 * from another test would otherwise be reaped by this one's `killLiveChecks`.
 * Both live in `spawn.ts`; `vi.resetModules()` drops every cached module, so
 * importing the barrel re-evaluates the whole `orchestrator/` graph and the
 * returned `runChecks`/`killLiveChecks` share one new `spawn.ts` instance.
 */
async function freshOrchestrator(): Promise<typeof import('../index.js')> {
  vi.resetModules();
  return import('../index.js');
}

/** Poll until `path` exists (the spawned check has started) or fail loudly. */
async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- poll loop: the await is the intentional delay between existence checks.
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(existsSync(path)).toBe(true);
}

/** A runner that emits a small JSON payload on stdout (for output-capture tests). */
const jsonRunner: CheckRunner = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: JSON.stringify({ analysis: { types: true } }), stderr: '' });

/** A runner that emits non-JSON text on stdout (persisted as `<slot>.stdout.txt`). */
const textRunner: CheckRunner = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: 'not json output', stderr: '' });

/**
 * A runner whose JSON arrives behind pnpm's dependency-check narration — the
 * shape a direct `node dist/cli.js` sees when no outer pnpm process has run.
 */
const preambleRunner: CheckRunner = () =>
  Promise.resolve({
    ok: true,
    exit_code: 0,
    stdout: `Already up to date\nDone in 210ms using pnpm v11.1.2\n${JSON.stringify({ analysis: { types: true } })}`,
    stderr: '',
  });

const KEY_A = 'a.ts:no-x:bad';
const KEY_B = 'b.ts:no-y:worse';

/** Build an oxlint `--format=json` payload from `[file, code, message]` triples. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({
    diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })),
  });
}

/** A lint runner emitting the given findings; it fails when any are present. */
function lintRunner(findings: [string, string, string][]): CheckRunner {
  const stdout = oxlint(findings);
  const ok = findings.length === 0;
  return (r) =>
    Promise.resolve(
      r.slot === 'lint'
        ? { ok, exit_code: ok ? 0 : 1, stdout, stderr: '' }
        : { ok: true, exit_code: 0, stdout: '', stderr: '' },
    );
}

/**
 * A runner that records `start:<slot>` / `end:<slot>` in call order and tracks
 * the peak number of checks in flight at once — the seam the scheduler tests
 * observe. Each check yields on a real timer between start and end so genuine
 * siblings overlap; slots named in `fail` resolve non-ok (for `--bail`).
 */
function schedulingRunner(opts: { delayMs?: number; fail?: string[] } = {}): {
  runner: CheckRunner;
  events: string[];
  maxInFlight: () => number;
} {
  const delayMs = opts.delayMs ?? 10;
  const fail = new Set(opts.fail ?? []);
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner: CheckRunner = async (r) => {
    events.push(`start:${r.slot}`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, delayMs));
    inFlight -= 1;
    events.push(`end:${r.slot}`);
    const ok = !fail.has(r.slot);
    return { ok, exit_code: ok ? 0 : 1, stdout: '', stderr: '' };
  };
  return { runner, events, maxInFlight: () => maxInFlight };
}

/**
 * A runner under which each check finishes only once the check after it in
 * `names` has, recording completion order. Completion then runs exactly in
 * reverse whatever the machine's load, where timers spaced a few
 * milliseconds apart could swap; it needs every check in flight at once.
 */
function reversedRunner(names: readonly string[]): { runner: CheckRunner; endOrder: string[] } {
  const endOrder: string[] = [];
  const finished = new Map(names.map((name) => [name, Promise.withResolvers<void>()]));
  const runner: CheckRunner = async (r) => {
    const next = names[names.indexOf(r.slot) + 1];
    if (next !== undefined) await finished.get(next)?.promise;
    endOrder.push(r.slot);
    finished.get(r.slot)?.resolve();
    return { ok: true, exit_code: 0, stdout: '', stderr: '' };
  };
  return { runner, endOrder };
}

/**
 * The fake spawner the lock tests observe: each check holds for its mapped
 * time (10ms when unmapped) and records its interval as `start:<name>` and
 * `end:<name>` events, in the order they happened, where `<name>` is
 * `<target>:<slot>` for a target's check.
 */
function intervalRunner(holdMs: Record<string, number> = {}): { runner: CheckRunner; events: string[] } {
  const events: string[] = [];
  const runner: CheckRunner = async (r) => {
    const name = r.target === undefined ? r.slot : `${r.target}:${r.slot}`;
    events.push(`start:${name}`);
    await new Promise((res) => setTimeout(res, holdMs[name] ?? 10));
    events.push(`end:${name}`);
    return { ok: true, exit_code: 0, stdout: '', stderr: '' };
  };
  return { runner, events };
}

/** True when an {@link intervalRunner}'s events show checks `a` and `b` in flight at once. */
function overlapped(events: readonly string[], a: string, b: string): boolean {
  const at = (event: string): number => {
    const i = events.indexOf(event);
    expect(i, `${event} was recorded`).toBeGreaterThan(-1);
    return i;
  };
  return at(`start:${a}`) < at(`end:${b}`) && at(`start:${b}`) < at(`end:${a}`);
}

/** `target`'s check filled by `adapter`, as multi-target resolution makes one. */
function targetCheck(target: Target, adapter: Adapter): ResolvedCheck {
  return { slot: adapter.slot, optIn: false, adapter, skip: null, target: target.name, root: target.root, pack: target.pack };
}

describe('selectChecks', () => {
  const resolved = [mkResolved('types'), mkResolved('lint'), mkResolved('mutation', true)];

  test('default run excludes opt-in slots', () => {
    expect(selectChecks(resolved, {}).map((r) => r.slot)).toEqual(['types', 'lint']);
  });

  test('--all includes opt-in slots', () => {
    expect(selectChecks(resolved, { all: true }).map((r) => r.slot)).toContain('mutation');
  });

  test('--include adds a specific opt-in slot', () => {
    expect(selectChecks(resolved, { include: ['mutation'] }).map((r) => r.slot)).toContain('mutation');
  });

  test('an explicitly-configured opt-in slot runs without --include (naming opts in)', () => {
    const withFormat = [...resolved, { slot: 'format', optIn: true, adapter: null, skip: null, explicit: true }];
    expect(selectChecks(withFormat, {}).map((r) => r.slot)).toContain('format');
    // ...but an opt-in slot that was only detected (not named) still stays out.
    expect(selectChecks(resolved, {}).map((r) => r.slot)).not.toContain('mutation');
  });

  test('optIn:true keeps a named slot out of the default run but reachable by --all/--include', () => {
    // `explicit: false` is what config `optIn: true` resolves to: named, but not auto-included.
    const withAttw = [...resolved, { slot: 'attw', optIn: true, adapter: null, skip: null, explicit: false }];
    expect(selectChecks(withAttw, {}).map((r) => r.slot)).not.toContain('attw');
    expect(selectChecks(withAttw, { all: true }).map((r) => r.slot)).toContain('attw');
    expect(selectChecks(withAttw, { include: ['attw'] }).map((r) => r.slot)).toContain('attw');
  });

  test('--only restricts to the named slots', () => {
    expect(selectChecks(resolved, { only: ['lint'] }).map((r) => r.slot)).toEqual(['lint']);
  });

  test('--skip removes a slot entirely', () => {
    expect(selectChecks(resolved, { skip: ['lint'] }).map((r) => r.slot)).toEqual(['types']);
  });
});

describe('library-publishing slots (publint, attw)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-pub-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('publint and attw stay out of the default run, opted in by --include/--all', () => {
    const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: null, cwd: dir });
    const slotsFor = (flags: RunFlags): string[] => selectChecks(resolved, flags).map((r) => r.slot);
    expect(slotsFor({})).not.toContain('publint');
    expect(slotsFor({})).not.toContain('attw');
    expect(slotsFor({ include: ['publint', 'attw'] })).toEqual(expect.arrayContaining(['publint', 'attw']));
    expect(slotsFor({ all: true })).toEqual(expect.arrayContaining(['publint', 'attw']));
  });

  test('captures the attw slot JSON output to .check/attw.json', async () => {
    const attw = ADAPTERS.find((a) => a.name === 'attw');
    if (!attw) throw new Error('attw adapter missing from registry');
    const result = await runChecks({
      // Name attw in config so it resolves without the tool's dep on disk
      // (naming bypasses the detectDeps gate — an explicit ask to run it).
      cwd: dir, slots: [{ name: 'attw', optIn: true }], adapters: [attw], config: { checks: { attw: { use: 'attw' } } },
      include: ['attw'], runner: jsonRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'attw')).toMatchObject({ ok: true, output_file: 'attw.json' });
    expect(JSON.parse(await readFile(join(dir, '.check', 'attw.json'), 'utf8'))).toMatchObject({
      analysis: { types: true },
    });
  });

  /** Run the attw slot with a given runner; it is the simplest JSON-declaring slot. */
  async function runAttw(runner: CheckRunner) {
    const attw = ADAPTERS.find((a) => a.name === 'attw');
    if (!attw) throw new Error('attw adapter missing from registry');
    return runChecks({
      cwd: dir, slots: [{ name: 'attw', optIn: true }], adapters: [attw], config: { checks: { attw: { use: 'attw' } } },
      include: ['attw'], runner, json: true, stdout: sink().out, stderr: sink().out,
    });
  }

  test('output_file is null when the declared JSON file was never written', async () => {
    const result = await runAttw(textRunner);
    // The adapter *declares* attw.json; this run emitted text, so nothing wrote
    // it. Naming it anyway sends every consumer to an ENOENT.
    expect(result.summary.checks.find((c) => c.name === 'attw')?.output_file).toBeNull();
    await expect(readFile(join(dir, '.check', 'attw.json'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(dir, '.check', 'attw.stdout.txt'), 'utf8')).toBe('not json output');
  });

  test('a launcher preamble does not cost the slot its JSON artifact', async () => {
    const result = await runAttw(preambleRunner);
    expect(result.summary.checks.find((c) => c.name === 'attw')).toMatchObject({ ok: true, output_file: 'attw.json' });
    // The artifact must parse on its own — the preamble is not the tool's bytes.
    const written = await readFile(join(dir, '.check', 'attw.json'), 'utf8');
    expect(written.startsWith('Already up to date')).toBe(false);
    expect(JSON.parse(written)).toMatchObject({ analysis: { types: true } });
  });
});

describe('runtimeArgs', () => {
  const withChanged = fakeAdapter({ name: 'vitest', slot: 'test', args: ['run'], changedArgs: ['--changed', 'main'] });
  const withBase = fakeAdapter({ name: 'vitest', slot: 'test', args: ['run'], changedArgs: ['--changed', '{base}', '--since={base}'] });
  const noChanged = fakeAdapter({ name: 'tsc', slot: 'types', args: ['--build'] });

  test('appends changedArgs under --changed', () => {
    expect(runtimeArgs(withChanged, 'origin/main')).toEqual(['run', '--changed', 'main']);
  });
  test('expands {base} in every changedArg, inside one too', () => {
    expect(runtimeArgs(withBase, 'origin/develop')).toEqual(['run', '--changed', 'origin/develop', '--since=origin/develop']);
  });
  test('leaves args untouched without --changed', () => {
    expect(runtimeArgs(withChanged, null)).toEqual(['run']);
    expect(runtimeArgs(withBase, null)).toEqual(['run']);
  });
  test('adapters with no changedArgs are unaffected', () => {
    expect(runtimeArgs(noChanged, 'origin/main')).toEqual(['--build']);
  });
  test('the vitest and jest rows say {base} where 0.13 said origin/main', () => {
    expect(ADAPTERS.find((a) => a.name === 'vitest')?.changedArgs).toEqual(['--changed', '{base}']);
    expect(ADAPTERS.find((a) => a.name === 'jest')?.changedArgs).toEqual(['--changedSince', '{base}']);
  });
  test('expands {out} to .check in args and changedArgs, on --changed or off it', () => {
    const withOut = fakeAdapter({ name: 'vitest', slot: 'test', args: ['run', '--outputFile={out}/test.json'], changedArgs: ['--cache={out}/{base}'] });
    expect(runtimeArgs(withOut, null)).toEqual(['run', '--outputFile=.check/test.json']);
    expect(runtimeArgs(withOut, 'main')).toEqual(['run', '--outputFile=.check/test.json', '--cache=.check/main']);
  });
  test('expands {out} to the directory a run passes, which a run given --out makes absolute', () => {
    const withOut = fakeAdapter({ name: 'vitest', slot: 'test', args: ['run', '--outputFile={out}/test.json'] });
    expect(runtimeArgs(withOut, null, '/tmp/agent-out')).toEqual(['run', '--outputFile=/tmp/agent-out/test.json']);
  });
  test('the vitest and jest rows write their report through {out}', () => {
    for (const name of ['vitest', 'jest']) {
      const adapter = ADAPTERS.find((a) => a.name === name);
      expect(adapter?.args).toContain('--outputFile={out}/test.json');
      if (adapter) expect(runtimeArgs(adapter, null)).toContain('--outputFile=.check/test.json');
    }
  });
});

describe('runChecks (injected runner)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-orc-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'types' }, { name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'tsc', slot: 'types' }), fakeAdapter({ name: 'oxlint', slot: 'lint' })];

  test('reports per-check results and overall failure', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: failLint, json: true,
      stdout: std.out, stderr: sink().out,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary.schema_version).toBe(1);
    expect(result.summary.checks.map((c) => c.name)).toEqual(['types', 'lint']);
    const lint = result.summary.checks.find((c) => c.name === 'lint');
    expect(lint).toMatchObject({ ok: false, exit_code: 1, adapter: 'oxlint' });
    const written = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Summary;
    expect(written.checks).toHaveLength(2);
  });

  test("a runner's argv rides into the entry as given, and a check that skipped itself records none", async () => {
    const config = { checks: { licenses: { command: 'node', skipExitCode: 77 } } };
    const result = await runChecks({
      cwd: dir, slots, adapters, config, runner: argvRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    const byName = new Map(result.summary.checks.map((c) => [c.name, c]));
    expect(byName.get('types')?.argv).toEqual(['types', '--flag']);
    expect(byName.get('lint')?.argv).toEqual(['lint', '--flag']);
    expect(byName.get('licenses')).toMatchObject({ skipped: true });
    expect(byName.get('licenses')).not.toHaveProperty('argv');
    // A runner that reports no argv leaves every entry without one.
    const plain = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: okRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    for (const c of plain.summary.checks) expect(c, c.name).not.toHaveProperty('argv');
  });

  test("a runner's pin_source and tool_version ride into the entry beside its argv", async () => {
    const result = await runChecks({ cwd: dir, slots, adapters, config: null, runner: pinned, json: true, stdout: sink().out, stderr: sink().out });
    const byName = new Map(result.summary.checks.map((c) => [c.name, c]));
    expect(byName.get('types')).toMatchObject({ argv: ['tsc'], pin_source: 'js-lockfile', tool_version: '5.9.3' });
    expect(byName.get('lint')).toMatchObject({ argv: ['oxlint'], pin_source: 'path' });
    expect(byName.get('lint')).not.toHaveProperty('tool_version');
  });

  test("the runner gets the repo root, the check's pin chain and the config's requirePins", async () => {
    const seen: Parameters<CheckRunner>[1][] = [];
    const capture: CheckRunner = (_r, ctx) => { seen.push(ctx); return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); };
    await runChecks({ cwd: dir, slots: [{ name: 'lint' }], adapters, config: { requirePins: true }, runner: capture, json: true, stdout: sink().out, stderr: sink().out });
    expect(seen).toMatchObject([{ cwd: dir, repo: dir, pins: ['js-lockfile'], requirePins: true }]);
    seen.length = 0;
    await runChecks({ cwd: dir, slots: [{ name: 'lint' }], adapters, config: null, runner: capture, json: true, stdout: sink().out, stderr: sink().out });
    expect(seen).toMatchObject([{ requirePins: false }]);
  });

  test('--bail stops after the first failure', async () => {
    const failFirst = [{ name: 'lint' }, { name: 'types' }];
    const result = await runChecks({
      cwd: dir, slots: failFirst, adapters, config: null, runner: failLint, bail: true, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks).toHaveLength(1);
    expect(result.summary.checks[0]?.name).toBe('lint');
  });

  /**
   * A narrowed run's summary must state its own narrowing: a consumer reading
   * `.check/summary.json` after a gate profile or an `--only` iteration loop
   * has no other way to tell the subset from the whole.
   */
  test('slots deselected by --skip and --only ride the summary as skipped rows', async () => {
    const skipped = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: okRunner, skip: ['types'], json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(skipped.summary.checks_run).toBe(1);
    expect(skipped.summary.checks.find((c) => c.name === 'types')).toMatchObject({
      skipped: true, ok: true, reason: 'skipped by --skip',
    });
    const only = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: okRunner, only: ['lint'], json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(only.summary.checks_run).toBe(1);
    expect(only.summary.checks.find((c) => c.name === 'types')).toMatchObject({
      skipped: true, reason: 'not in --only',
    });
  });

  test('records a disabled slot as skipped and prints human output', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: { checks: { types: false } }, runner: okRunner, json: false,
      stdout: sink().out, stderr: std.out,
    });
    const types = result.summary.checks.find((c) => c.name === 'types');
    expect(types?.skipped).toBe(true);
    expect(types?.reason).toBe('disabled in checkride.config.json');
    expect(result.ok).toBe(true);
    expect(std.lines.join('')).toContain('all checks passed');
  });

  /**
   * The CLI rejects `--only ,` when it parses, but a programmatic caller can
   * hand `runChecks` an array it computed. `[]` is truthy, so `selectChecks`
   * reads it as "match nothing" — a run that verifies nothing and reports ok.
   */
  test('an empty selection array is a usage error, not a zero-check pass', async () => {
    for (const flag of ['only', 'skip', 'include'] as const) {
      await expect(runChecks({
        cwd: dir, slots, adapters, config: null, runner: okRunner, json: true,
        stdout: sink().out, stderr: sink().out, [flag]: [],
      })).rejects.toThrow(`--${flag}`);
    }
    // Rejected before any side effect: no `.check/` directory was created.
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  /** R8.1: `run` names each selection or mode flag given, and leaves out each one that wasn't. */
  test('the summary records each flag the run was given, and nothing for one it wasn’t', async () => {
    const plain = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: okRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(plain.summary.run).toEqual({ partial: false });

    const configPath = join(dir, 'ci.json');
    const flagged = await runChecks({
      cwd: dir, slots, adapters, config: {}, configPath, runner: okRunner,
      all: true, include: ['lint'], skip: ['types'], changed: true,
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(flagged.summary.run).toEqual({
      partial: true, skip: ['types'], include: ['lint'], all: true, changed: true, config: configPath,
    });
  });
});

/** Slots + matching fake adapters from `[name, order]` pairs (order optional). */
function waveFixture(specs: [string, Order?][]): { slots: { name: string; order?: Order }[]; adapters: Adapter[] } {
  const slots = specs.map(([name, order]) => (order === undefined ? { name } : { name, order }));
  const adapters = specs.map(([name]) => fakeAdapter({ name, slot: name }));
  return { slots, adapters };
}

describe('runChecks (wave scheduler)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-wave-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('equal-order checks in one wave overlap (intra-group concurrency)', async () => {
    const { slots, adapters } = waveFixture([['a'], ['b']]); // both default 'any' → one wave
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 2, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.maxInFlight()).toBe(2); // both were in flight at once
  });

  test('concurrency: 1 serializes an otherwise-concurrent wave', async () => {
    const { slots, adapters } = waveFixture([['a'], ['b']]);
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 1, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.maxInFlight()).toBe(1);
    expect(rec.events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('a barrier sits between distinct numeric values', async () => {
    const { slots, adapters } = waveFixture([['a', 1], ['b', 2]]);
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    // Even with room to overlap, wave 2 waits for wave 1 to fully drain.
    expect(rec.maxInFlight()).toBe(1);
    expect(rec.events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('decimal steps within a wave run sequentially (1 → 1.1 → 1.2)', async () => {
    const { slots, adapters } = waveFixture([['c', 1.2], ['a', 1], ['b', 1.1]]); // deliberately unsorted
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.maxInFlight()).toBe(1);
    expect(rec.events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  test("a 'single' runs with nothing else in flight, after the numeric line", async () => {
    const { slots, adapters } = waveFixture([['a'], ['b'], ['m', 'single']]);
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    // The single is the final wave; its start/end bracket the tail with nothing between.
    expect(rec.events.slice(-2)).toEqual(['start:m', 'end:m']);
    expect(rec.events.indexOf('start:m')).toBeGreaterThan(rec.events.indexOf('end:a'));
    expect(rec.events.indexOf('start:m')).toBeGreaterThan(rec.events.indexOf('end:b'));
  });

  test('two singles run one at a time, in catalogue order', async () => {
    const { slots, adapters } = waveFixture([['m1', 'single'], ['m2', 'single']]);
    const rec = schedulingRunner();
    await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.maxInFlight()).toBe(1);
    expect(rec.events).toEqual(['start:m1', 'end:m1', 'start:m2', 'end:m2']);
  });

  test('summary array order is deterministic under randomized completion', async () => {
    const { slots, adapters } = waveFixture([['a'], ['b'], ['c'], ['d']]); // one 'any' wave
    // Completion order is the reverse of selection order (d finishes first).
    const rec = reversedRunner(['a', 'b', 'c', 'd']);
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.endOrder).toEqual(['d', 'c', 'b', 'a']); // they really did finish reversed
    expect(result.summary.checks.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']); // report stays in order
  });

  test('--bail runs fail-fast and sequential, stopping at the first failure', async () => {
    const { slots, adapters } = waveFixture([['a'], ['b'], ['c']]); // all 'any'
    const rec = schedulingRunner({ fail: ['b'] });
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, bail: true, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.maxInFlight()).toBe(1); // never overlapped despite --concurrency 4
    expect(rec.events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']); // c never started
    expect(result.summary.checks.map((c) => c.name)).toEqual(['a', 'b']);
  });

  test('--bail with --concurrency > 1 notes that concurrency was ignored', async () => {
    const { slots, adapters } = waveFixture([['a']]);
    const std = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null, bail: true, concurrency: 4, runner: okRunner, json: false,
      stdout: sink().out, stderr: std.out,
    });
    expect(std.lines.join('')).toContain('--concurrency ignored under --bail');
  });

  test('firsts precede, and lasts follow, the numeric line', async () => {
    const { slots, adapters } = waveFixture([['n', 10], ['z', 'last'], ['a', 'first']]);
    const rec = schedulingRunner();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, concurrency: 4, runner: rec.runner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(rec.events).toEqual(['start:a', 'end:a', 'start:n', 'end:n', 'start:z', 'end:z']);
    expect(result.summary.checks.map((c) => c.name)).toEqual(['a', 'n', 'z']);
  });
});

/** The rust pack's row named `name`, its real lock key kept, detected anywhere so implicit mode runs it. */
function rustRow(name: string): Adapter {
  const row = PACKS.rust.adapters.find((a) => a.name === name);
  if (row === undefined) throw new Error(`the rust pack has no ${name} row`);
  return { ...row, detect: [] };
}

describe('runChecks (lock keys)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-lock-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const cargoCheck = rustRow('cargo-check');
  const clippy = rustRow('clippy');
  const rumdl = fakeAdapter({ name: 'rumdl', slot: 'docs' });

  /** Run `adapters` in implicit mode as one `'any'` wave, in the order given, through `runner`. */
  const run = (adapters: Adapter[], runner: CheckRunner, extra: Partial<RunOptions> = {}): Promise<RunResult> =>
    runChecks({
      cwd: dir, slots: adapters.map((a) => ({ name: a.slot })), adapters, config: null, concurrency: 4, runner,
      json: true, stdout: sink().out, stderr: sink().out, ...extra,
    });

  /** Hand `selected` straight to the scheduler, as a multi-target run does. */
  const executeTargets = (targets: Target[], selected: ResolvedCheck[], runner: CheckRunner): Promise<unknown> => {
    const ctx = resolveRunContext({
      cwd: dir, config: null, runner, pm: 'pnpm', baseline: null, concurrency: 4, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    return executeChecks(selected, { ...ctx, targets });
  };

  test('two cargo checks for one target in one wave never overlap, while an unlocked check runs beside them (F4)', async () => {
    const rec = intervalRunner({ types: 50, lint: 50, docs: 50 });
    await run([cargoCheck, clippy, rumdl], rec.runner);
    expect(overlapped(rec.events, 'types', 'lint')).toBe(false);
    // The lock held back clippy alone: rumdl ran while cargo-check held it.
    expect(overlapped(rec.events, 'types', 'docs')).toBe(true);
  });

  test('a check waiting on a lock is not started, so the wait never counts against its timeout (F4)', async () => {
    const rec = intervalRunner({ types: 300, lint: 0 });
    const err = sink();
    const result = await run([cargoCheck, { ...clippy, timeout: 0.2 }], rec.runner, { json: false, stderr: err.out });
    expect(rec.events).toEqual(['start:types', 'end:types', 'start:lint', 'end:lint']);
    // clippy waited out cargo-check's run, longer than its own 0.2s timeout,
    // yet its timed run, the window that timeout caps, opened only once the
    // lock came free.
    const [types, lint] = result.summary.checks;
    expect(types?.duration_ms).toBeGreaterThan(200);
    expect(lint?.duration_ms).toBeLessThan(200);
    // Nor did it report itself started while it waited.
    const lines = err.lines.join('').split('\n').map((l) => l.trim());
    const at = (prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));
    expect(at('✔ types')).toBeGreaterThan(-1);
    expect(at('▸ lint')).toBeGreaterThan(at('✔ types'));
  });

  test('under --concurrency 1 a lock changes nothing, and the checks keep their selection order', async () => {
    const rec = intervalRunner();
    await run([cargoCheck, rumdl, clippy], rec.runner, { concurrency: 1 });
    expect(rec.events).toEqual(['start:types', 'end:types', 'start:docs', 'end:docs', 'start:lint', 'end:lint']);
  });

  test('two go targets each running golangci-lint never overlap (F5)', async () => {
    const golangci = PACKS.go.adapters.find((a) => a.name === 'golangci-lint');
    if (golangci === undefined) throw new Error('the go pack has no golangci-lint row');
    const api = { name: 'api', pack: 'go', root: 'services/api' };
    const worker = { name: 'worker', pack: 'go', root: 'services/worker' };
    const rec = intervalRunner({ 'api:lint': 50, 'worker:lint': 50 });
    await executeTargets([api, worker], [targetCheck(api, golangci), targetCheck(worker, golangci)], rec.runner);
    expect(overlapped(rec.events, 'api:lint', 'worker:lint')).toBe(false);
  });

  test("cargo:{root} keeps each target's cargo checks apart, while two targets' run side by side", async () => {
    const core = { name: 'core', pack: 'rust', root: 'crates/core' };
    const cli = { name: 'cli', pack: 'rust', root: 'crates/cli' };
    const rec = intervalRunner({ 'core:types': 50, 'cli:types': 50, 'core:lint': 50, 'cli:lint': 50 });
    // R8.4's order: each slot, in target order.
    const selected = [targetCheck(core, cargoCheck), targetCheck(cli, cargoCheck), targetCheck(core, clippy), targetCheck(cli, clippy)];
    await executeTargets([core, cli], selected, rec.runner);
    expect(overlapped(rec.events, 'core:types', 'core:lint')).toBe(false);
    expect(overlapped(rec.events, 'cli:types', 'cli:lint')).toBe(false);
    expect(overlapped(rec.events, 'core:types', 'cli:types')).toBe(true);
  });
});

describe('runChecks (stale output cleanup)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-stale-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];

  test("clears a slot's stale stdout.txt when a later run emits nothing", async () => {
    const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint' })];
    await runChecks({ cwd: dir, slots, adapters, config: null, runner: textRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(existsSync(join(dir, '.check', 'lint.stdout.txt'))).toBe(true);

    await runChecks({ cwd: dir, slots, adapters, config: null, runner: okRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(existsSync(join(dir, '.check', 'lint.stdout.txt'))).toBe(false);
  });

  test("clears a slot's stale JSON output file when a later run emits nothing", async () => {
    const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];
    await runChecks({ cwd: dir, slots, adapters, config: null, runner: jsonRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(existsSync(join(dir, '.check', 'lint.json'))).toBe(true);

    await runChecks({ cwd: dir, slots, adapters, config: null, runner: okRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(existsSync(join(dir, '.check', 'lint.json'))).toBe(false);
  });

  test('does not clobber a .check/<slot>.json the tool writes during the run', async () => {
    // The real vitest/jest adapter has `outputFile: null` and writes
    // `.check/test.json` itself via `--outputFile`. The clear must run *before*
    // the runner, so this run's own artifact survives (it would be deleted if the
    // clear lived in persistOutput, which fires after the check).
    const adapters = [fakeAdapter({ name: 'vitest', slot: 'test' })];
    await runChecks({
      cwd: dir, slots: [{ name: 'test' }], adapters, config: null, runner: toolWrites, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(JSON.parse(await readFile(join(dir, '.check', 'test.json'), 'utf8'))).toEqual({ fresh: true });
  });
});

describe('runChecks (package manager)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-pm-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const audit = fakeAdapter({ name: 'pnpm-audit', slot: 'security', command: 'pnpm', args: ['audit', '--json'], outputFile: 'security.json' });

  test('skips the audit slot as unavailable under a non-pnpm PM', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'security', optIn: true }], adapters: [audit], config: null,
      include: ['security'], pm: 'npm', runner: okRunner, json: false, stdout: sink().out, stderr: std.out,
    });
    const sec = result.summary.checks.find((c) => c.name === 'security');
    expect(sec?.skipped).toBe(true);
    expect(sec?.reason).toContain('unavailable under npm');
    expect(result.ok).toBe(true);
    expect(std.lines.join('')).toContain('skip');
  });

  test('runs the audit slot normally under pnpm', async () => {
    const ran: string[] = [];
    const recording: CheckRunner = (r) => { ran.push(r.slot); return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); };
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'security', optIn: true }], adapters: [audit], config: null,
      include: ['security'], pm: 'pnpm', runner: recording, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(ran).toContain('security');
    expect(result.summary.checks.find((c) => c.name === 'security')?.skipped).toBeUndefined();
  });

  test('threads the resolved PM into the runner context', async () => {
    const seen: string[] = [];
    const spy: CheckRunner = (_r, ctx) => { seen.push(ctx.pm); return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); };
    await runChecks({
      cwd: dir, slots: [{ name: 'lint' }], adapters: [fakeAdapter({ name: 'oxlint', slot: 'lint' })], config: null,
      pm: 'yarn', runner: spy, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(seen).toEqual(['yarn']);
  });
});

describe('runChecks (real subprocess)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-spawn-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('spawns a command, captures JSON, and persists the output file', async () => {
    const adapter = fakeAdapter({
      name: 'emit', slot: 'emit',
      command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({ok:true}))'],
      outputFile: 'emit.json',
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'emit' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
    expect(JSON.parse(await readFile(join(dir, '.check', 'emit.json'), 'utf8'))).toEqual({ ok: true });
  });

  test('captures a non-zero exit and writes non-JSON stdout as text', async () => {
    const adapter = fakeAdapter({
      name: 'boom', slot: 'boom',
      command: 'node', args: ['-e', 'process.stdout.write("not json"); process.exit(3)'],
      outputFile: 'boom.json',
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'boom' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: 3 });
    expect(await readFile(join(dir, '.check', 'boom.stdout.txt'), 'utf8')).toBe('not json');
  });

  test('the build adapter runs the package build script through the PM-translated run path', async () => {
    // A real fixture: a package.json build script the `build` adapter drives via
    // `<pm> run build`. Under npm the canonical `pnpm run build` translates to
    // `npm run build`, spawns for real, and its stdout is captured (D13/D18).
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { build: `node -e "process.stdout.write('BUILT_OK')"` } }),
    );
    const build = fakeAdapter({
      name: 'build', slot: 'build', detectScript: 'build', command: 'pnpm', args: ['run', 'build'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'build', optIn: true, order: 10 }], adapters: [build], config: { timeout: 30 },
      pm: 'npm', include: ['build'], json: true, stdout: sink().out, stderr: sink().out,
    });
    // The summary records the translated form, the one that actually spawned.
    expect(result.summary.checks[0]).toMatchObject({ name: 'build', ok: true, exit_code: 0, argv: ['npm', 'run', 'build'], pin_source: 'js-lockfile' });
    expect(result.summary.checks[0]).not.toHaveProperty('tool_version');
    expect(await readFile(join(dir, '.check', 'build.stdout.txt'), 'utf8')).toContain('BUILT_OK');
  }, 30_000);

  test('reports a spawn failure for a missing binary, with the argv it tried', async () => {
    const adapter = fakeAdapter({
      name: 'ghost', slot: 'ghost', command: 'checkride-no-such-binary-xyz', args: ['--flag'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'ghost' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1, argv: ['checkride-no-such-binary-xyz', '--flag'] });
    // A command spawned as written resolved through no pin source.
    expect(result.summary.checks[0]).not.toHaveProperty('pin_source');
  });

  test('kills a check that exceeds the configured timeout, and keeps the argv it ran', async () => {
    const adapter = fakeAdapter({
      name: 'hang', slot: 'hang', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'hang' }], adapters: [adapter], config: { timeout: 0.2 }, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1, argv: ['node', '-e', 'setInterval(() => {}, 1000)'] });
    expect(await readFile(join(dir, '.check', 'hang.stderr.txt'), 'utf8')).toContain('timed out');
  });

  test('a tool the npx pre-flight refuses never spawned, so it records no argv', async () => {
    const adapter = fakeAdapter({
      name: 'absent', slot: 'lint', command: 'pnpm', args: ['exec', 'checkride-nonexistent-tool'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'lint' }], adapters: [adapter], config: null, pm: 'npm', json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: 1 });
    expect(result.summary.checks[0]).not.toHaveProperty('argv');
    expect(result.summary.checks[0]).not.toHaveProperty('pin_source');
  });

  test('a fast check completes normally under a generous timeout', async () => {
    const adapter = fakeAdapter({
      name: 'quick', slot: 'quick', command: 'node', args: ['-e', 'process.exit(0)'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'quick' }], adapters: [adapter], config: { timeout: 5 }, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
  });

  test('escalates SIGTERM to SIGKILL for a timed-out check that ignores it', async () => {
    const adapter = fakeAdapter({
      name: 'stubborn', slot: 'stubborn',
      command: 'node', args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'stubborn' }], adapters: [adapter], config: { timeout: 0.2 }, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });
    expect(await readFile(join(dir, '.check', 'stubborn.stderr.txt'), 'utf8')).toContain('timed out');
  }, 15_000);

  test('the timeout kill reaps a grandchild spawned by a wrapper, not just the child', async () => {
    // The check is a wrapper that spawns a long-lived grandchild (as a real tool
    // spawns a worker). A per-child SIGTERM would leave the grandchild orphaned and
    // running; the detached spawn + process-group kill must take the whole tree down.
    const pidFile = join(dir, 'gc.pid');
    await writeFile(
      join(dir, 'gc.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      join(dir, 'wrap.js'),
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'gc.js'))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
    );
    const adapter = fakeAdapter({ name: 'nest', slot: 'nest', command: 'node', args: [join(dir, 'wrap.js')] });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'nest' }], adapters: [adapter], config: { timeout: 1 }, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });

    const gcPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200)); // let the group signal propagate to the grandchild
    const alive = isAlive(gcPid);
    if (alive) process.kill(gcPid, 'SIGKILL'); // safety net: never leak the orphan if this regresses
    expect(alive).toBe(false);
  }, 15_000);

  test('captures multibyte output split across read chunks intact', async () => {
    // Emit U+20AC (euro, bytes E2 82 AC): the lead byte, then a tick later its two
    // continuation bytes — forcing a chunk boundary mid-character. A per-chunk
    // `toString()` decodes each half to U+FFFD; the UTF-8 stream decoder holds the
    // partial sequence until it completes and yields the real character.
    const adapter = fakeAdapter({
      name: 'euro', slot: 'euro', command: 'node',
      args: ['-e', 'process.stdout.write(Buffer.from([0xE2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xAC])), 50);'],
    });
    await runChecks({
      cwd: dir, slots: [{ name: 'euro' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    const euro = Buffer.from([0xE2, 0x82, 0xAC]).toString('utf8'); // the intact character, ASCII-defined here
    expect(await readFile(join(dir, '.check', 'euro.stdout.txt'), 'utf8')).toBe(euro);
  });

  test('reaps two concurrent checks on timeout — both grandchildren die (C6)', async () => {
    // Two checks in one 'any' wave with concurrency 2 are in flight together;
    // each spawns a long-lived grandchild then hangs. The per-check timeout +
    // process-group kill must reap BOTH trees — the kill layer already supports
    // N simultaneous groups (C6), and the scheduler must not weaken it.
    const setup = async (tag: string): Promise<{ adapter: Adapter; pidFile: string }> => {
      const pidFile = join(dir, `${tag}.gc.pid`);
      await writeFile(
        join(dir, `${tag}.gc.js`),
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      );
      await writeFile(
        join(dir, `${tag}.wrap.js`),
        `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, `${tag}.gc.js`))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
      );
      return { adapter: fakeAdapter({ name: tag, slot: tag, command: 'node', args: [join(dir, `${tag}.wrap.js`)] }), pidFile };
    };
    const one = await setup('one');
    const two = await setup('two');
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'one' }, { name: 'two' }], adapters: [one.adapter, two.adapter],
      config: { timeout: 1 }, concurrency: 2, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.every((c) => c.exit_code === -1)).toBe(true);

    await new Promise((r) => setTimeout(r, 200)); // let the group signals propagate to the grandchildren
    for (const pidFile of [one.pidFile, two.pidFile]) {
      // oxlint-disable-next-line no-await-in-loop -- two sequential reads; the assertion order does not matter.
      const gcPid = Number(await readFile(pidFile, 'utf8'));
      const alive = isAlive(gcPid);
      if (alive) process.kill(gcPid, 'SIGKILL'); // safety net: never leak an orphan if this regresses
      expect(alive).toBe(false);
    }
  }, 20_000);
});

describe('runChecks (vacuous green)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-vac-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // Resolves to nothing in an empty temp dir: the detect file is absent.
  const undetected = fakeAdapter({ name: 'tsc', slot: 'types', detect: ['tsconfig.json'] });

  test('checks_run counts executed checks, excluding skipped slots', async () => {
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'types' }, { name: 'lint' }],
      adapters: [fakeAdapter({ name: 'tsc', slot: 'types' }), fakeAdapter({ name: 'oxlint', slot: 'lint' })],
      config: { checks: { types: false } }, runner: okRunner, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks_run).toBe(1);
    const written = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Summary;
    expect(written.checks_run).toBe(1);
  });

  test('zero checks running stays exit 0 by default but warns with the detect hint', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'types' }], adapters: [undetected], config: null,
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.summary).toMatchObject({ ok: true, checks_run: 0 });
    expect(result.exitCode).toBe(0);
    const text = std.lines.join('');
    expect(text).toContain('0 checks ran');
    expect(text).toContain('tsc (add tsconfig.json)');
    expect(text).toContain('checkride doctor');
    expect(text).toContain('no checks ran');
    expect(text).not.toContain('all checks passed');
  });

  test('--strict turns zero checks running into exit 2', async () => {
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'types' }], adapters: [undetected], config: null, strict: true,
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.ok).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  test('--strict leaves a run that executed checks untouched', async () => {
    const failing = await runChecks({
      cwd: dir, slots: [{ name: 'lint' }], adapters: [fakeAdapter({ name: 'oxlint', slot: 'lint' })],
      config: null, strict: true, runner: failLint, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(failing.exitCode).toBe(1);
    const passing = await runChecks({
      cwd: dir, slots: [{ name: 'lint' }], adapters: [fakeAdapter({ name: 'oxlint', slot: 'lint' })],
      config: null, strict: true, runner: okRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(passing.exitCode).toBe(0);
  });
});

/** A runner whose custom checks exit with whatever code `codes` names for them (0 otherwise). */
function exitRunner(codes: Record<string, number>, stderr = ''): CheckRunner {
  return (r) => {
    const exit_code = codes[r.slot] ?? 0;
    return Promise.resolve({ ok: exit_code === 0, exit_code, stdout: 'partial output', stderr });
  };
}

describe('runChecks (a custom check skipping itself)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-selfskip-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint' })];
  const config = { checks: { licenses: { command: 'node', skipExitCode: 77 } } };

  // F23
  test('exiting its skipExitCode records the skipped shape, with its last stderr line as the reason', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config, runner: exitRunner({ licenses: 77 }, 'warming up\nno docker daemon here\n'),
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.summary.checks.find((c) => c.name === 'licenses')).toEqual({
      name: 'licenses',
      adapter: 'custom:licenses',
      description: 'Custom licenses check',
      ok: true,
      skipped: true,
      reason: 'no docker daemon here (exit 77)',
      exit_code: null,
      duration_ms: 0,
      output_file: null,
      origin: 'custom',
    });
    expect(result.summary.checks_run).toBe(1);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    // Nothing to fingerprint or digest, and no artifact: the partial stdout is not the check's verdict.
    expect(result.runs.map((r) => r.slot)).toEqual(['lint']);
    expect(existsSync(join(dir, '.check', 'licenses.stdout.txt'))).toBe(false);
    expect(existsSync(join(dir, '.check', 'licenses.stderr.txt'))).toBe(false);
    expect(std.lines.join('')).toMatch(/○ licenses\s+skip {2}no docker daemon here \(exit 77\)/);
  });

  test('with nothing on stderr, the reason still names the exit code', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config, runner: exitRunner({ licenses: 77 }),
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'licenses')?.reason).toBe('skipped itself (exit 77)');
  });

  test('any other non-zero exit still fails the check', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config, runner: exitRunner({ licenses: 1 }, 'a real finding\n'),
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'licenses')).toMatchObject({ ok: false, exit_code: 1 });
    expect(result.exitCode).toBe(1);
  });

  test('a check that declares no skipExitCode fails on that same code', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config: { checks: { licenses: { command: 'node' } } },
      runner: exitRunner({ licenses: 77 }), json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'licenses')).toMatchObject({ ok: false, exit_code: 77 });
  });

  // F24
  test('--strict exits 2 when every check skipped itself', async () => {
    const result = await runChecks({
      cwd: dir, slots: [], adapters: [],
      config: { checks: { licenses: { command: 'node', skipExitCode: 77 }, deps: { command: 'node', skipExitCode: 3 } } },
      runner: exitRunner({ licenses: 77, deps: 3 }), strict: true, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary).toMatchObject({ ok: true, checks_run: 0 });
    expect(result.summary.checks.every((c) => c.skipped === true)).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  test('the real spawn path carries the exit code and stderr through', async () => {
    const result = await runChecks({
      cwd: dir, slots: [], adapters: [],
      config: {
        checks: {
          probe: {
            command: process.execPath,
            args: ['-e', "process.stderr.write('needs a GPU\\n'); process.exit(77)"],
            skipExitCode: 77,
          },
        },
      },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ skipped: true, ok: true, reason: 'needs a GPU (exit 77)' });
  });
});

describe('provenance in the report (S21)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-provenance-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('the status line ends with the tag for each origin, and no tag without one', () => {
    const entry: SummaryCheck = {
      name: 'lint', adapter: 'oxlint', description: 'Lint', ok: true, exit_code: 0, duration_ms: 12, output_file: null,
    };
    const variants: SummaryCheck[] = [
      { ...entry, origin: 'config' },
      { ...entry, origin: 'detected', detected_by: '.oxlintrc.json' },
      { ...entry, origin: 'detected', detected_by: 'package.json: oxlint' },
      { ...entry, origin: 'detected', detected_by: 'package.json: scripts.build' },
      { ...entry, origin: 'built-in' },
      { ...entry, origin: 'custom', ok: false },
      entry,
    ];
    expect(variants.map((c) => formatStatusLine(c, 8))).toEqual([
      '  ✔ lint         12ms  Lint  [config]',
      '  ✔ lint         12ms  Lint  [detected: .oxlintrc.json]',
      '  ✔ lint         12ms  Lint  [detected: package.json: oxlint]',
      '  ✔ lint         12ms  Lint  [detected: package.json: scripts.build]',
      '  ✔ lint         12ms  Lint  [built-in]',
      '  ✘ lint         12ms  Lint  [custom]',
      '  ✔ lint         12ms  Lint',
    ]);
  });

  test('a run records origin on every check with an adapter, ran or sat out, and none on an unresolved one', async () => {
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    const std = sink();
    const result = await runChecks({
      cwd: dir,
      slots: [{ name: 'types' }, { name: 'lint' }, { name: 'docs' }, { name: 'links' }],
      adapters: [
        fakeAdapter({ name: 'tsc', slot: 'types', detect: ['tsconfig.json'] }),
        fakeAdapter({ name: 'oxlint', slot: 'lint', detect: ['.oxlintrc.json'] }),
        fakeAdapter({ name: 'markdownlint-cli2', slot: 'docs', detect: ['.markdownlint.json'] }),
        fakeAdapter({ name: 'links', slot: 'links' }),
      ],
      config: { checks: { lint: 'oxlint', licenses: { command: 'node', skipExitCode: 77 }, probe: { command: 'node' } } },
      runner: exitRunner({ licenses: 77 }, 'no docker daemon here\n'),
      skip: ['types'],
      json: false, stdout: sink().out, stderr: std.out,
    });
    const provenance = Object.fromEntries(
      result.summary.checks.map((c) => [c.name, { origin: c.origin, detected_by: c.detected_by }]),
    );
    expect(provenance).toEqual({
      // Narrowed away by --skip, it still says what would have run it.
      types: { origin: 'detected', detected_by: 'tsconfig.json' },
      lint: { origin: 'config', detected_by: undefined },
      docs: { origin: undefined, detected_by: undefined },
      links: { origin: 'built-in', detected_by: undefined },
      licenses: { origin: 'custom', detected_by: undefined },
      probe: { origin: 'custom', detected_by: undefined },
    });
    const lines = std.lines.join('').split('\n');
    expect(lines.find((l) => l.includes('✔ lint'))).toMatch(/ {2}\[config\]$/);
    expect(lines.find((l) => l.includes('✔ links'))).toMatch(/ {2}\[built-in\]$/);
    expect(lines.find((l) => l.includes('✔ probe'))).toMatch(/ {2}\[custom\]$/);
    // A skip line explains itself already and gets no tag.
    expect(lines.filter((l) => l.includes('○ ')).every((l) => !l.includes('['))).toBe(true);
  });
});

/** lint emits JSON and fails; types prints text and passes. */
const mixedRunner: CheckRunner = (r) =>
  Promise.resolve(r.slot === 'lint'
    ? { ok: false, exit_code: 1, stdout: oxlint([['a.ts', 'no-x', 'bad']]), stderr: 'lint warned\n' }
    : { ok: true, exit_code: 0, stdout: 'types ok', stderr: '' });

/** lint declines to run with the scratch reason, as a built-in without writable scratch does; types passes. */
const decliningRunner: CheckRunner = (r) =>
  Promise.resolve(r.slot === 'lint'
    ? { ok: true, exit_code: 0, stdout: 'partial', stderr: 'partial', skip: 'needs a writable ./.check for scratch files' }
    : { ok: true, exit_code: 0, stdout: '', stderr: '' });

describe('runChecks (--out)', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-out-'));
    outside = await mkdtemp(join(tmpdir(), 'checkride-out-outside-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const slots = [{ name: 'lint' }, { name: 'types' }];
  const adapters = [
    fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' }),
    fakeAdapter({ name: 'tsc', slot: 'types' }),
  ];

  test('the summary, the raw files and the digest land in --out, and .check/ is never made', async () => {
    const out = join(outside, 'artifacts');
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: mixedRunner, out, digest: true,
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.exitCode).toBe(1);
    for (const file of ['summary.json', 'lint.json', 'lint.stderr.txt', 'types.stdout.txt', 'digest.md']) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
    const written = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as Summary;
    expect(written.run).toEqual({ partial: false, out });
    expect(written.checks.find((c) => c.name === 'lint')?.output_file).toBe('lint.json');
  });

  test('an outside directory is named absolute in the report and the digest, so no line points at .check/', async () => {
    const std = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: mixedRunner, out: outside, digest: true,
      json: false, stdout: sink().out, stderr: std.out,
    });
    const printed = std.lines.join('');
    expect(printed).toContain(`report: ${outside}/summary.json`);
    expect(printed).toContain(`digest: ${outside}/digest.md`);
    expect(printed).not.toContain('.check/');
    const digest = await readFile(join(outside, 'digest.md'), 'utf8');
    expect(digest).toContain(`Raw: \`${outside}/lint.json\``);
    expect(digest).not.toContain('.check/');
  });

  test('a directory inside the repo is named relative to it, and a relative --out resolves against cwd', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: mixedRunner, out: join('build', 'check'), digest: true,
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.summary.run.out).toBe(join(dir, 'build', 'check'));
    expect(existsSync(join(dir, 'build', 'check', 'summary.json'))).toBe(true);
    expect(std.lines.join('')).toContain('report: build/check/summary.json');
    expect(await readFile(join(dir, 'build', 'check', 'digest.md'), 'utf8')).toContain('Raw: `build/check/lint.json`');
  });

  test('without --out, the summary carries no run.out and the lines say .check', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: mixedRunner, json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.summary.run).toEqual({ partial: false });
    expect(std.lines.join('')).toContain('report: .check/summary.json');
  });

  test('{out} reaches the runner as .check by default, and as the absolute directory under --out', async () => {
    const seen: (string | undefined)[] = [];
    const runner: CheckRunner = (_r, ctx) => { seen.push(ctx.out); return okRunner(_r, ctx); };
    await runChecks({ cwd: dir, slots: [{ name: 'lint' }], adapters, config: null, runner, json: true, stdout: sink().out, stderr: sink().out });
    await runChecks({ cwd: dir, slots: [{ name: 'lint' }], adapters, config: null, runner, out: 'elsewhere', json: true, stdout: sink().out, stderr: sink().out });
    expect(seen).toEqual(['.check', join(dir, 'elsewhere')]);
  });

  test('a check whose runner declines with a skip records the skipped shape and writes nothing', async () => {
    const result = await runChecks({ cwd: dir, slots, adapters, config: null, runner: decliningRunner, out: outside, json: true, stdout: sink().out, stderr: sink().out });
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({
      ok: true, skipped: true, reason: 'needs a writable ./.check for scratch files', exit_code: null, duration_ms: 0, output_file: null,
    });
    expect(result.summary.checks_run).toBe(1);
    expect(existsSync(join(outside, 'lint.stdout.txt'))).toBe(false);
    expect(result.runs.map((r) => r.slot)).toEqual(['types']);
  });

  // F29
  test.skipIf(process.getuid?.() === 0)('a read-only .check/ under --out skips smoke with the scratch reason, and the rest runs', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'smoke-out', version: '1.0.0', type: 'module', exports: { '.': { import: './dist/index.js' } },
    }));
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'index.js'), 'export const foo = 1;\n');
    await mkdir(join(dir, '.check'), { mode: 0o555 });
    try {
      const result = await runChecks({
        cwd: dir, slots: [{ name: 'smoke' }, { name: 'types' }],
        adapters: [fakeAdapter({ name: 'smoke', slot: 'smoke', builtin: 'smoke' }), fakeAdapter({ name: 'tsc', slot: 'types', command: process.execPath, args: ['-e', ''] })],
        config: null, out: outside, json: true, stdout: sink().out, stderr: sink().out,
      });
      expect(result.summary.checks.find((c) => c.name === 'smoke')).toMatchObject({
        skipped: true, ok: true, reason: 'needs a writable ./.check for scratch files',
      });
      expect(result.summary.checks.find((c) => c.name === 'types')).toMatchObject({ ok: true, exit_code: 0 });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(outside, 'summary.json'))).toBe(true);
    } finally {
      await chmod(join(dir, '.check'), 0o755);
    }
  });
});

describe('runChecks (baseline-aware)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-base-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];

  const oneA: [string, string, string][] = [['a.ts', 'no-x', 'bad']];
  const baselineFile = (): string => join(dir, 'checkride.baseline.json');
  const readWritten = async (): Promise<Baseline> =>
    JSON.parse(await readFile(baselineFile(), 'utf8')) as Baseline;

  test('passes green when only baselined diagnostics remain', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      baseline: { schema_version: 1, slots: { lint: [KEY_A] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const lint = result.summary.checks.find((c) => c.name === 'lint');
    expect(lint).toMatchObject({ ok: true, baselined: 1 });
  });

  test('fails on a genuinely new diagnostic, listing only the new key', async () => {
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner([['a.ts', 'no-x', 'bad'], ['c.ts', 'no-z', 'new']]),
      baseline: { schema_version: 1, slots: { lint: [KEY_A] } },
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: false, baselined: 1 });
    const printed = std.lines.join('');
    expect(printed).toContain('c.ts:no-z:new'); // the new finding is surfaced
    expect(printed).not.toContain(KEY_A); // the grandfathered one is not re-listed
  });

  test('ratchets the baseline smaller after a fix (fully-observed run)', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner(oneA), // KEY_B is gone → fixed
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.ok).toBe(true); // only the still-present KEY_A remains, all baselined
    expect((await readWritten()).slots['lint']).toEqual([KEY_A]);
  });

  // 1.1: a check that never reached a verdict contributes nothing to the ratchet,
  // so a refusal/spawn-failure/timeout can't silently empty its baseline slot.
  const mixSlots = [{ name: 'lint' }, { name: 'spell' }];
  const mixAdapters = [
    fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' }),
    fakeAdapter({ name: 'cspell', slot: 'spell' }),
  ];

  test('a refused cspell (exit 1, empty) never prunes spell, even while lint ratchets', async () => {
    const lint = lintRunner(oneA);
    const runner: CheckRunner = (r, rc) =>
      r.slot === 'spell'
        ? Promise.resolve({ ok: false, exit_code: 1, stdout: '', stderr: 'check-spell: cspell refused' })
        : lint(r, rc);
    await runChecks({
      cwd: dir, slots: mixSlots, adapters: mixAdapters, config: null, runner,
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B], spell: ['doc.md::teh'] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    const written = await readWritten();
    expect(written.slots['lint']).toEqual([KEY_A]); // lint ratcheted: KEY_B fixed
    expect(written.slots['spell']).toEqual(['doc.md::teh']); // spell untouched despite the refusal
  });

  test('a spawn failure (exit -1) never prunes', async () => {
    const lint = lintRunner(oneA);
    const runner: CheckRunner = (r, rc) =>
      r.slot === 'spell'
        ? Promise.resolve({ ok: false, exit_code: -1, stdout: '', stderr: 'Failed to spawn cspell' })
        : lint(r, rc);
    await runChecks({
      cwd: dir, slots: mixSlots, adapters: mixAdapters, config: null, runner,
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B], spell: ['doc.md::teh'] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect((await readWritten()).slots['spell']).toEqual(['doc.md::teh']);
  });

  test('a cspell timeout whose partial output is all grandfathered stays red and never prunes', async () => {
    const key = 'doc.md::Unknown word (teh)';
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'spell' }], adapters: [fakeAdapter({ name: 'cspell', slot: 'spell' })], config: null,
      // Timed out after printing one finding, which the baseline grandfathers.
      runner: () => Promise.resolve({ ok: false, exit_code: -1, stdout: 'doc.md:3:1 - Unknown word (teh)\n', stderr: 'cspell: timed out after 60s' }),
      baseline: { schema_version: 1, slots: { spell: [key] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.ok).toBe(false); // an unverified run is never masked green
    expect(result.summary.checks.find((c) => c.name === 'spell')).toMatchObject({ ok: false });
    expect(existsSync(baselineFile())).toBe(false); // nothing observed, nothing pruned
  });

  test('the next full run ratchets away the oxlint warning keys an older release captured (D27)', async () => {
    // Before gating keys, `checkride baseline` keyed oxlint's warnings too. With
    // no --deny-warnings in argv they can't fail the slot, so no run observes
    // them again: the error stays grandfathered and the warnings are pruned.
    const report = await readFile(new URL('../../__tests__/fixtures/baseline-oxlint.json', import.meta.url), 'utf8');
    const errorKey = 'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.';
    const warningKeys = [
      'src/doctor.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
      'src/init.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
    ];
    const oxlintRow = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json', command: 'pnpm', args: ['exec', 'oxlint', '--format=json'] });
    const result = await runChecks({
      cwd: dir, slots, adapters: [oxlintRow], config: null,
      runner: () => Promise.resolve({ ok: false, exit_code: 1, stdout: report, stderr: '' }),
      baseline: { schema_version: 1, slots: { lint: [errorKey, ...warningKeys].toSorted() } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: true, baselined: 1 });
    expect((await readWritten()).slots['lint']).toEqual([errorKey]);
  });

  test('a partial --only run never prunes the baseline', async () => {
    await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner(oneA), // KEY_B looks "fixed", but the run is partial
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      only: ['lint'], json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(existsSync(baselineFile())).toBe(false); // no rewrite happened
  });

  test('a --changed run never prunes the baseline', async () => {
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      changed: true, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(existsSync(baselineFile())).toBe(false);
  });

  test('a run reading a config outside the repo never prunes the baseline, and says so', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-base-outside-'));
    try {
      await writeFile(join(outside, 'ci.json'), '{}');
      const std = sink();
      await runChecks({
        cwd: dir, slots, adapters, config: {}, configPath: join(outside, 'ci.json'),
        runner: lintRunner(oneA), // KEY_B looks "fixed", but a consumer run never writes
        baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
        json: false, stdout: sink().out, stderr: std.out,
      });
      expect(existsSync(baselineFile())).toBe(false);
      expect(std.lines.join('')).toContain('not ratcheted, because a run with --config outside the repo');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // F27
  test('a run writing to an --out outside the repo never prunes the baseline, and says so', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-base-out-'));
    try {
      const std = sink();
      await runChecks({
        cwd: dir, slots, adapters, config: null, out: outside,
        runner: lintRunner(oneA), // KEY_B looks "fixed", but a consumer run never writes
        baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
        json: false, stdout: sink().out, stderr: std.out,
      });
      expect(existsSync(baselineFile())).toBe(false);
      expect(std.lines.join('')).toContain('not ratcheted, because a run with --out outside the repo');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a run writing to an --out inside the repo ratchets as if no flag were passed', async () => {
    await runChecks({
      cwd: dir, slots, adapters, config: null, out: join(dir, 'build', 'check'),
      runner: lintRunner(oneA),
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect((await readWritten()).slots['lint']).toEqual([KEY_A]);
  });

  test('a run reading a config inside the repo ratchets as if no flag were passed', async () => {
    await mkdir(join(dir, 'configs'));
    await writeFile(join(dir, 'configs', 'ci.json'), '{}');
    await runChecks({
      cwd: dir, slots, adapters, config: {}, configPath: join(dir, 'configs', 'ci.json'),
      runner: lintRunner(oneA),
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect((await readWritten()).slots['lint']).toEqual([KEY_A]);
  });

  test('an unchanged full run does not rewrite the baseline', async () => {
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      baseline: { schema_version: 1, slots: { lint: [KEY_A] } }, // nothing to prune
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(existsSync(baselineFile())).toBe(false);
  });

  test('with no baseline present, behavior is unchanged (no masking, no field)', async () => {
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.ok).toBe(false); // the failure stands
    expect(result.summary.checks.find((c) => c.name === 'lint')?.baselined).toBeUndefined();
  });

  test('a slot whose output cannot be read is never masked, and its keys survive the ratchet', async () => {
    // The run-level half of extractVale's `null` contract: vale's E100 report
    // arrives on a red exit, fingerprints to "not observed", and so can neither
    // mask the failure nor prune a grandfathered key — while the ratchet still
    // works the slots this run *did* observe.
    const PROSE_KEY = "docs/a.md:Repo.Drift:'delve' is a fingerprint of generated prose — say the plain thing instead.";
    const valeError = '{"Code":"E100","Text":"no config file found","Path":"","Line":0,"Span":0}';
    const runner: CheckRunner = (r) =>
      Promise.resolve(
        r.slot === 'lint'
          ? { ok: false, exit_code: 1, stdout: oxlint(oneA), stderr: '' }
          : { ok: false, exit_code: 2, stdout: valeError, stderr: '' },
      );
    const result = await runChecks({
      cwd: dir,
      slots: [{ name: 'lint' }, { name: 'prose' }],
      adapters: [...adapters, fakeAdapter({ name: 'vale', slot: 'prose', outputFile: 'prose.json' })],
      config: null, runner,
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B], prose: [PROSE_KEY] } },
      json: true, stdout: sink().out, stderr: sink().out,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: true, baselined: 1 });
    expect(result.summary.checks.find((c) => c.name === 'prose')).toMatchObject({ ok: false });

    // The ratchet ran — KEY_B is pruned from the observed lint slot — but the
    // unobserved prose slot keeps its grandfathered key intact.
    const written = await readWritten();
    expect(written.slots['lint']).toEqual([KEY_A]);
    expect(written.slots['prose']).toEqual([PROSE_KEY]);
  });

  /**
   * A mangled committed baseline (a botched merge, usually) masks nothing, so
   * everything grandfathered reports red — the run must say why, or the reader
   * is left diagnosing a wall of red that the tool already understood.
   */
  test('a present-but-unparseable baseline file gets a stderr warning naming recover', async () => {
    await writeFile(baselineFile(), '<<<<<<< HEAD\n{ mangled\n');
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.ok).toBe(false); // nothing was masked
    const printed = std.lines.join('');
    expect(printed).toContain('present but unparseable');
    expect(printed).toContain('checkride recover');
  });

  test('the unparseable warning never reaches stdout, and --json stays silent', async () => {
    await writeFile(baselineFile(), '{ mangled');
    const std = sink();
    const out = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      json: true, stdout: out.out, stderr: std.out,
    });
    expect(out.lines.join('')).not.toContain('unparseable');
    expect(std.lines.join('')).not.toContain('unparseable');
  });

  test('an absent baseline warns nothing (absent is not a diagnosis)', async () => {
    const std = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner(oneA),
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(std.lines.join('')).not.toContain('unparseable');
  });

  /**
   * R8.1: `run.partial` is the ratchet's own partial-run test. Each run here
   * holds a stale key that a whole run prunes, so whether the baseline file
   * was rewritten is the ratchet's verdict, and `partial` must say the opposite.
   */
  test.each<{ label: string; flags: RunFlags; typesOk: boolean }>([
    { label: 'a whole run', flags: {}, typesOk: true },
    { label: '--only', flags: { only: ['lint'] }, typesOk: true },
    { label: '--skip', flags: { skip: ['types'] }, typesOk: true },
    { label: '--changed', flags: { changed: true }, typesOk: true },
    { label: '--bail with nothing failing', flags: { bail: true }, typesOk: true },
    { label: '--bail stopped at a failure', flags: { bail: true }, typesOk: false },
  ])('run.partial agrees with the ratchet: $label', async ({ flags, typesOk }) => {
    const lint = lintRunner(oneA);
    const result = await runChecks({
      cwd: dir,
      slots: [...slots, { name: 'types' }],
      adapters: [...adapters, fakeAdapter({ name: 'tsc', slot: 'types' })],
      config: null,
      runner: (r, c) =>
        r.slot === 'types' ? Promise.resolve({ ok: typesOk, exit_code: typesOk ? 0 : 1, stdout: '', stderr: '' }) : lint(r, c),
      baseline: { schema_version: 1, slots: { lint: [KEY_A, KEY_B] } },
      ...flags, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.run.partial).toBe(!existsSync(baselineFile()));
  });
});

/** Is a real git usable here? The recover-hint suite skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
};

describe.skipIf(!gitAvailable)('runChecks red-run recover hint', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hint-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];

  /** The incident: a committed baseline grandfathering A and B, then B dropped. */
  async function seedDroppedEntry(): Promise<void> {
    gitIn(dir, 'init', '-q');
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: [KEY_A, KEY_B] } }));
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'baseline');
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: [KEY_A] } }));
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'entries dropped');
  }

  test('a red run whose new findings history grandfathered prints the hint', async () => {
    await seedDroppedEntry();
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner([['a.ts', 'no-x', 'bad'], ['b.ts', 'no-y', 'worse']]),
      json: false, stdout: sink().out, stderr: std.out,
    });
    expect(result.ok).toBe(false);
    const printed = std.lines.join('');
    expect(printed).toContain('hint: 1 of 1 new finding(s) were grandfathered until');
    expect(printed).toContain('checkride recover');
  });

  test('no hint on a green run, under --json, or when history never had the keys', async () => {
    await seedDroppedEntry();
    const green = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null, runner: lintRunner([['a.ts', 'no-x', 'bad']]),
      json: false, stdout: sink().out, stderr: green.out,
    });
    expect(green.lines.join('')).not.toContain('hint:');

    const json = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner([['a.ts', 'no-x', 'bad'], ['b.ts', 'no-y', 'worse']]),
      json: true, stdout: sink().out, stderr: json.out,
    });
    expect(json.lines.join('')).not.toContain('hint:');

    const unknown = sink();
    await runChecks({
      cwd: dir, slots, adapters, config: null,
      runner: lintRunner([['a.ts', 'no-x', 'bad'], ['z.ts', 'never-seen', 'brand new']]),
      json: false, stdout: sink().out, stderr: unknown.out,
    });
    expect(unknown.lines.join('')).not.toContain('hint:');
  });
});

describe('runFix', () => {
  const fixable = fakeAdapter({ name: 'oxlint', slot: 'lint', fixArgs: ['exec', 'oxlint', '--fix'] });
  const noFix = fakeAdapter({ name: 'tsc', slot: 'types' });

  test('runs fix only for active fixable adapters, passing the cwd', async () => {
    const calls: { name: string; cwd: string }[] = [];
    const std = sink();
    const result = await runFix({
      cwd: '/work', slots: [{ name: 'lint' }, { name: 'types' }], adapters: [fixable, noFix],
      config: null, stderr: std.out,
      fixRunner: (a, ctx) => { calls.push({ name: a.name, cwd: ctx.cwd }); return Promise.resolve({ ok: true, exit_code: 0 }); },
    });
    expect(calls).toEqual([{ name: 'oxlint', cwd: '/work' }]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, ran: ['oxlint'] });
    expect(std.lines.join('')).toContain('✔ lint');
  });

  test('reports a failing fix command with its exit code', async () => {
    const std = sink();
    const result = await runFix({
      cwd: '/tmp', slots: [{ name: 'lint' }], adapters: [fixable], config: null, stderr: std.out,
      fixRunner: () => Promise.resolve({ ok: false, exit_code: 2 }),
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(std.lines.join('')).toContain('✘ lint');
    expect(std.lines.join('')).toContain('exit 2');
  });

  test('the default fix runner spawns the adapter command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-'));
    try {
      const ok = fakeAdapter({ name: 'noop', slot: 'lint', command: 'node', args: [], fixArgs: ['-e', 'process.exit(0)'] });
      const pass = await runFix({ cwd: dir, slots: [{ name: 'lint' }], adapters: [ok], config: null, stderr: sink().out });
      expect(pass).toMatchObject({ ok: true, exitCode: 0, ran: ['noop'] });

      const bad = fakeAdapter({ name: 'boom', slot: 'lint', command: 'node', args: [], fixArgs: ['-e', 'process.exit(1)'] });
      const fail = await runFix({ cwd: dir, slots: [{ name: 'lint' }], adapters: [bad], config: null, stderr: sink().out });
      expect(fail).toMatchObject({ ok: false, exitCode: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('threads the detected package manager into the fix runner context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-pm-'));
    await writeFile(join(dir, 'package-lock.json'), '{}'); // npm, resolved from the lockfile
    try {
      const seen: string[] = [];
      await runFix({
        cwd: dir, slots: [{ name: 'lint' }], adapters: [fixable], config: null, stderr: sink().out,
        fixRunner: (_a, ctx) => { seen.push(ctx.pm); return Promise.resolve({ ok: true, exit_code: 0 }); },
      });
      expect(seen).toEqual(['npm']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the default fix runner spawns the PM-translated (npx) form, matching the run path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-npx-'));
    await writeFile(join(dir, 'package-lock.json'), '{}'); // an npm-detected fixture
    await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(dir, 'node_modules', '.bin', 'oxlint'), '');
    try {
      const pm = detectPackageManager({ cwd: dir });
      expect(pm).toBe('npm');
      // The canonical `pnpm exec oxlint --fix` becomes `npx --no-install oxlint
      // --fix`, the same translation the run path applies via `translateExec` in
      // `defaultRunner` — a fix must not npx-install a tool the run path won't.
      const adapter = fakeAdapter({ name: 'oxlint', slot: 'lint', command: 'pnpm', args: ['exec', 'oxlint'], fixArgs: ['exec', 'oxlint', '--fix'] });
      expect(fixInvocation(adapter, { cwd: dir, pm })).toMatchObject({ command: 'npx', args: ['--no-install', 'oxlint', '--fix'] });
      // The pnpm path keeps its prefix; only the deps-check override is added,
      // exactly as the run path does — a fix spawns tools the same way.
      expect(fixInvocation(adapter, { cwd: dir, pm: 'pnpm' })).toMatchObject({
        command: 'pnpm',
        args: ['--config.verify-deps-before-run=false', 'exec', 'oxlint', '--fix'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The run path refuses a tool the project never installed under `npx` or
   * `bunx`, whose caches could otherwise supply one; a fix, which writes
   * files, is refused the same way rather than run that cached copy.
   */
  test('the default fix runner refuses a tool the project never installed, as the run path does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-refuse-'));
    await writeFile(join(dir, 'package-lock.json'), '{}');
    try {
      const absent = fakeAdapter({ name: 'absent', slot: 'lint', command: 'pnpm', args: ['exec', 'checkride-nonexistent-tool'], fixArgs: ['exec', 'checkride-nonexistent-tool', '--fix'] });
      const std = sink();
      const result = await runFix({ cwd: dir, slots: [{ name: 'lint' }], adapters: [absent], config: null, stderr: std.out });
      expect(result).toMatchObject({ ok: false, exitCode: 1, ran: ['absent'] });
      const text = std.lines.join('');
      expect(text).toContain('✘ lint (exit 1)');
      expect(text).toContain('the `lint` slot needs `checkride-nonexistent-tool`, which is not installed in this project');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the fix runner gets the check's repo root, pin chain, requirePins and pack variables", async () => {
    const seen: unknown[] = [];
    await runFix({
      cwd: '/work', slots: [{ name: 'lint' }], adapters: [fixable], config: { requirePins: true }, pm: 'pnpm', stderr: sink().out,
      fixRunner: (_a, ctx) => { seen.push(ctx); return Promise.resolve({ ok: true, exit_code: 0 }); },
    });
    expect(seen).toEqual([{ cwd: '/work', pm: 'pnpm', repo: '/work', pins: ['js-lockfile'], requirePins: true, packEnv: {} }]);
  });

  test('reports a custom check whose fix exits its skipExitCode as skipped, not failed', async () => {
    const std = sink();
    const result = await runFix({
      cwd: '/tmp', slots: [], adapters: [], stderr: std.out,
      config: { checks: { licenses: { command: 'node', fixArgs: ['scripts/fix-licenses.mjs'], skipExitCode: 77 } } },
      fixRunner: () => Promise.resolve({ ok: false, exit_code: 77 }),
    });
    expect(result).toEqual({ ok: true, exitCode: 0, ran: [] });
    expect(std.lines.join('')).toContain('○ licenses skipped (exit 77)');
    expect(std.lines.join('')).not.toContain('✘');
  });

  test('no-ops when nothing is fixable', async () => {
    const std = sink();
    const result = await runFix({
      cwd: '/tmp', slots: [{ name: 'types' }], adapters: [noFix], config: null, stderr: std.out,
    });
    expect(result.ran).toEqual([]);
    expect(std.lines.join('')).toContain('no active adapters');
  });
});

describe('killLiveChecks (fatal-signal cleanup)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-sig-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("reaps an in-flight check's grandchild and lets the run resolve", async () => {
    const orch = await freshOrchestrator();
    const pidFile = join(dir, 'gc.pid');
    // Written whole, then renamed into place, so `waitFor` sees the file only
    // once the pid is in it: an interrupt landing between a plain write's
    // truncate and its bytes would leave the pid file empty for good.
    await writeFile(
      join(dir, 'gc.js'),
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      join(dir, 'wrap.js'),
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'gc.js'))}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
    );
    const adapter = fakeAdapter({ name: 'nest', slot: 'nest', command: 'node', args: [join(dir, 'wrap.js')] });
    const running = orch.runChecks({
      cwd: dir, slots: [{ name: 'nest' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    await waitFor(pidFile);
    await orch.killLiveChecks();
    const result = await running;
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });

    const gcPid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200)); // let the group signal propagate to the grandchild
    const alive = isAlive(gcPid);
    if (alive) process.kill(gcPid, 'SIGKILL'); // safety net: never leak the orphan if this regresses
    expect(alive).toBe(false);
  }, 30_000);

  test('latches: no successor check spawns after the interrupt', async () => {
    // Without the latch, the run loop — resumed by the killed first check's
    // outcome — would spawn the second check between cleanup and the CLI's
    // re-raise, creating exactly the orphan the cleanup exists to prevent.
    // `concurrency: 1` makes the two checks genuinely sequential, so `second` is
    // a queued successor (not a concurrent sibling that would have already
    // spawned) — the latch is precisely what must stop it starting.
    const orch = await freshOrchestrator();
    const marker = join(dir, 'first.started');
    const sentinel = join(dir, 'second.ran');
    await writeFile(
      join(dir, 'first.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`,
    );
    const first = fakeAdapter({ name: 'first', slot: 'first', command: 'node', args: [join(dir, 'first.js')] });
    const second = fakeAdapter({
      name: 'second', slot: 'second', command: 'node',
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, '1')`],
    });
    const running = orch.runChecks({
      cwd: dir, slots: [{ name: 'first' }, { name: 'second' }], adapters: [first, second], config: null,
      concurrency: 1, json: true, stdout: sink().out, stderr: sink().out,
    });
    await waitFor(marker);
    await orch.killLiveChecks();
    const result = await running;
    expect(existsSync(sentinel)).toBe(false);
    expect(result.summary.checks[0]).toMatchObject({ argv: ['node', join(dir, 'first.js')] });
    expect(result.summary.checks[1]).toMatchObject({ ok: false, exit_code: -1 });
    // The latch kept `second` from spawning, so it has no argv to record.
    expect(result.summary.checks[1]).not.toHaveProperty('argv');
  }, 30_000);

  test('escalates to SIGKILL for a check that ignores SIGTERM', async () => {
    const orch = await freshOrchestrator();
    const marker = join(dir, 'stubborn.started');
    await writeFile(
      join(dir, 'stubborn.js'),
      `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`,
    );
    const adapter = fakeAdapter({ name: 'stubborn', slot: 'stubborn', command: 'node', args: [join(dir, 'stubborn.js')] });
    const running = orch.runChecks({
      cwd: dir, slots: [{ name: 'stubborn' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    await waitFor(marker);
    // Resolves only via the grace escalation; the run resolving after proves
    // the SIGKILL landed (the child's `close` is what settles the outcome).
    await orch.killLiveChecks();
    const result = await running;
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });
  }, 30_000);

  /**
   * The latch is one-way *within* a run, and cleared at the start of the next
   * one. On the CLI path that never matters — the process re-raises the signal
   * and dies — but `runChecks` is exported, and a long-lived programmatic
   * consumer (a watcher, a daemon) that absorbed one SIGINT would otherwise
   * have every later run spawn nothing and report a green it never earned.
   */
  test('a later run on the same module still spawns checks after an interrupt', async () => {
    const orch = await freshOrchestrator();
    const marker = join(dir, 'hang.started');
    await writeFile(
      join(dir, 'hang.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setInterval(() => {}, 1000);`,
    );
    const hang = fakeAdapter({ name: 'hang', slot: 'hang', command: 'node', args: [join(dir, 'hang.js')] });
    const interrupted = orch.runChecks({
      cwd: dir, slots: [{ name: 'hang' }], adapters: [hang], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    await waitFor(marker);
    await orch.killLiveChecks();
    expect((await interrupted).summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });

    // Same module instance, still latched before the fix — this run must execute.
    const sentinel = join(dir, 'after.ran');
    const after = fakeAdapter({
      name: 'after', slot: 'after', command: 'node',
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, '1')`],
    });
    const result = await orch.runChecks({
      cwd: dir, slots: [{ name: 'after' }], adapters: [after], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
  }, 30_000);
});

describe('defaultConcurrency', () => {
  test('reserves a core locally, but not on CI (where nobody needs the machine responsive)', () => {
    // The load-bearing case: a standard GitHub-hosted runner reports 2 CPUs.
    // Reserving a core there collapsed the pool to 1 — wave scheduling
    // silently did nothing on exactly the machine class the docs gate on.
    expect(defaultConcurrency({}, 2)).toBe(1);
    expect(defaultConcurrency({ CI: 'true' }, 2)).toBe(2);
  });

  test('keeps the cap of 4 and the floor of 1 in both modes', () => {
    expect(defaultConcurrency({}, 12)).toBe(4);
    expect(defaultConcurrency({ CI: 'true' }, 12)).toBe(4);
    expect(defaultConcurrency({}, 1)).toBe(1);
    expect(defaultConcurrency({ CI: 'true' }, 1)).toBe(1);
    // An unset (or empty) CI variable means local.
    expect(defaultConcurrency({ CI: '' }, 2)).toBe(1);
  });
});

/**
 * The pre-flight that keeps the prose slot's voice anchor honest: a config
 * naming an `exemplars` directory fails the check when that directory is
 * missing or empty, instead of letting vale gate prose whose hand-written
 * reference no longer exists.
 */
describe('missingExemplarsOutcome', () => {
  const vale = fakeAdapter({ name: 'vale', slot: 'prose', options: { prose: { exemplars: 'docs/voice' } } });

  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-exemplars-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('is a no-op when no exemplars are configured', () => {
    expect(missingExemplarsOutcome(fakeAdapter({ name: 'vale', slot: 'prose' }), dir)).toBeNull();
  });

  test('a missing directory fails the check and names the path', () => {
    const outcome = missingExemplarsOutcome(vale, dir);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.exit_code).toBe(1);
    expect(outcome?.stderr).toContain('`docs/voice`');
    expect(outcome?.stderr).toContain('does not exist');
  });

  test('dotfiles and subdirectories are not anchors: an otherwise empty directory still fails', async () => {
    await mkdir(join(dir, 'docs', 'voice', 'drafts'), { recursive: true });
    await writeFile(join(dir, 'docs', 'voice', '.gitkeep'), '');
    const outcome = missingExemplarsOutcome(vale, dir);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.stderr).toContain('has no files in it');
  });

  test('one real file stands the pre-flight down', async () => {
    await mkdir(join(dir, 'docs', 'voice'), { recursive: true });
    await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'A sentence in my own voice.\n');
    expect(missingExemplarsOutcome(vale, dir)).toBeNull();
  });

  test('a file at the exemplars path is named for what it is, not reported missing', async () => {
    // "does not exist" would send the reader hunting a typo that isn't there.
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'voice'), 'a file where the directory should be\n');
    const outcome = missingExemplarsOutcome(vale, dir);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.stderr).toContain('is a file, not a directory');
    expect(outcome?.stderr).not.toContain('does not exist');
  });

  test('the default runner runs the pre-flight, so the tool never spawns', async () => {
    // The wiring, not the helper: no injected runner, so `runChecks` reaches the
    // real `defaultRunner`. If the pre-flight ever stopped gating the spawn, the
    // argv below would run, exit 0, and turn the slot green — a loud miss.
    const adapter = fakeAdapter({
      name: 'vale', slot: 'prose', options: { prose: { exemplars: 'docs/voice' } }, outputFile: 'prose.json',
      args: ['-e', 'console.log("SPAWNED")'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'prose' }], adapters: [adapter], config: null,
      json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.checks.find((c) => c.name === 'prose')).toMatchObject({ ok: false });
    expect(result.summary.checks.find((c) => c.name === 'prose')).not.toHaveProperty('argv');
    // The failure is persisted like any check output, so `triage` can read it.
    const persisted = await readFile(join(dir, '.check', 'prose.stderr.txt'), 'utf8');
    expect(persisted).toContain('voice exemplars');
  });

  test('a built-in that reaches no verdict prints its reason and keeps it beside the JSON artifact', async () => {
    // The real `security` path, fed the shape pnpm emits when the advisory
    // endpoint times out: exit 1, its own JSON `error` on stdout, silence on
    // stderr. A script file, not `-e`, so node never parses `--json` as its own.
    const payload = JSON.stringify({ error: { code: 23, message: 'The operation was aborted due to timeout' } });
    const fake = join(dir, 'fake-audit.mjs');
    await writeFile(fake, `console.log(${JSON.stringify(payload)}); process.exit(1);\n`);
    const adapter = fakeAdapter({
      name: 'pnpm-audit', slot: 'security', builtin: 'security', outputFile: 'security.json',
      command: process.execPath, args: [fake, '--json'],
    });
    const std = sink();
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'security' }], adapters: [adapter], config: null,
      json: false, stdout: std.out, stderr: std.out,
    });
    expect(result.exitCode).toBe(1);
    expect(result.summary.checks.find((c) => c.name === 'security')).toMatchObject({
      ok: false, exit_code: -1, output_file: 'security.json',
    });
    // A built-in records no argv, though this one spawned a process of its own.
    expect(result.summary.checks.find((c) => c.name === 'security')).not.toHaveProperty('argv');
    // The terminal says why, not only that.
    expect(std.lines.join('')).toContain('could not complete: The operation was aborted due to timeout');
    // stdout won as the JSON artifact — and the stderr reason survives beside it.
    expect(JSON.parse(await readFile(join(dir, '.check', 'security.json'), 'utf8'))).toMatchObject({ error: { code: 23 } });
    expect(await readFile(join(dir, '.check', 'security.stderr.txt'), 'utf8')).toContain('check-security:');
  });
});

/** A runner that records the `base` each check was handed. */
function baseRecorder(): { runner: CheckRunner; seen: (string | undefined)[] } {
  const seen: (string | undefined)[] = [];
  const runner: CheckRunner = (_r, ctx) => {
    seen.push(ctx.base);
    return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  };
  return { runner, seen };
}

describe.skipIf(!gitAvailable)('runChecks --changed base', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-base-'));
    gitIn(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.txt'), 'a\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'one');
    gitIn(dir, 'branch', 'develop');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'test' }];
  const adapters = [fakeAdapter({ name: 'vitest', slot: 'test', changedArgs: ['--changed', '{base}'] })];

  test('the runner gets the named base, then the config’s, then origin/main', async () => {
    gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const run = async (extra: { base?: { ref: string; from: string }; config?: { changedBase: string } }): Promise<(string | undefined)[]> => {
      const { runner, seen } = baseRecorder();
      await runChecks({ cwd: dir, slots, adapters, config: extra.config ?? null, runner, changed: true, json: true, stdout: sink().out, stderr: sink().out, ...(extra.base ? { base: extra.base } : {}) });
      return seen;
    };
    expect(await run({ base: { ref: 'develop', from: '--base' }, config: { changedBase: 'main' } })).toEqual(['develop']);
    expect(await run({ config: { changedBase: 'main' } })).toEqual(['main']);
    expect(await run({})).toEqual(['origin/main']);
  });

  test('off --changed, the runner gets no base', async () => {
    const { runner, seen } = baseRecorder();
    await runChecks({ cwd: dir, slots, adapters, config: { changedBase: 'develop' }, runner, json: true, stdout: sink().out, stderr: sink().out });
    expect(seen).toEqual([undefined]);
  });

  test('a defaulted origin/main that doesn’t resolve falls back to HEAD, with a warning (F26)', async () => {
    const { runner, seen } = baseRecorder();
    const err = sink();
    const result = await runChecks({ cwd: dir, slots, adapters, config: null, runner, changed: true, json: true, stdout: sink().out, stderr: err.out });
    expect(seen).toEqual(['HEAD']);
    expect(result.exitCode).toBe(0);
    expect(err.lines.join('')).toContain("--changed: origin/main doesn't resolve, so changes are measured from HEAD");
  });

  test('a configured base that doesn’t resolve throws before the run writes anything (F26)', async () => {
    const { runner, seen } = baseRecorder();
    await expect(
      runChecks({ cwd: dir, slots, adapters, config: { changedBase: 'nope' }, runner, changed: true, json: true, stdout: sink().out, stderr: sink().out }),
    ).rejects.toThrow("config changedBase 'nope' doesn't name a commit");
    expect(seen).toEqual([]);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('a changedBase that isn’t a non-empty string is a config error, --changed or not', async () => {
    for (const changedBase of ['', 7]) {
      // oxlint-disable-next-line no-await-in-loop -- shared cwd; sequential keeps each rejection attributable.
      await expect(
        runChecks({ cwd: dir, slots, adapters, config: { changedBase } as never, runner: baseRecorder().runner, json: true, stdout: sink().out, stderr: sink().out }),
      ).rejects.toThrow('changedBase must be a non-empty string');
    }
  });
});

/**
 * F11 and F12 through the real runner and a real spawn, with `PATH` held to
 * one scratch directory: a stand-in `shellcheck` there leaves a mark when it
 * runs, so a test can tell a refusal that fell back to it from one that
 * didn't. The chain is a Node-free pack's, mise then `PATH` (R6.1).
 */
describe('the default runner resolves a tool through its pin chain', () => {
  let root: string;
  let repo: string;
  let ran: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkride-pin-runner-'));
    repo = join(root, 'repo');
    ran = join(root, 'ran');
    const bin = join(root, 'bin');
    await mkdir(repo, { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, 'shellcheck'), `#!/bin/sh\necho ran > "${ran}"\necho '[]'\n`);
    await chmod(join(bin, 'shellcheck'), 0o755);
    vi.stubEnv('PATH', bin);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const shellcheck = fakeAdapter({ name: 'shellcheck', slot: 'lint', command: 'pnpm', args: ['exec', 'shellcheck', '-f', 'json1', 'run.sh'] });
  const resolved: ResolvedCheck = { slot: 'lint', optIn: false, adapter: shellcheck, skip: null };
  const context = (requirePins: boolean): Parameters<CheckRunner>[1] => ({
    cwd: repo, changed: false, pm: 'pnpm', repo, pins: ['mise', 'path'], requirePins,
  });

  test('F12: a tool nothing pins runs from PATH, and records argv and pin_source path', async () => {
    const outcome = await defaultRunner(resolved, context(false));
    expect(outcome).toMatchObject({ ok: true, exit_code: 0, argv: ['shellcheck', '-f', 'json1', 'run.sh'], pin_source: 'path' });
    expect(outcome).not.toHaveProperty('tool_version');
    expect(existsSync(ran)).toBe(true);
  });

  test('F12 under requirePins: the same tool fails with the mise use hint, and never runs', async () => {
    const outcome = await defaultRunner(resolved, context(true));
    expect(outcome).toMatchObject({ ok: false, exit_code: 1 });
    expect(outcome.stderr).toContain('shellcheck is not pinned; pin it with: mise use shellcheck@<version>');
    expect(outcome).not.toHaveProperty('argv');
    expect(existsSync(ran)).toBe(false);
  });

  test('F11: a tool mise.toml pins fails naming mise when mise is not on PATH, and never runs the PATH copy', async () => {
    await writeFile(join(repo, 'mise.toml'), '[tools]\nshellcheck = "0.11.0"\n');
    const outcome = await defaultRunner(resolved, context(false));
    expect(outcome).toMatchObject({ ok: false, exit_code: 1 });
    expect(outcome.stderr).toContain("`mise` isn't on PATH");
    expect(outcome).not.toHaveProperty('argv');
    expect(outcome).not.toHaveProperty('pin_source');
    expect(existsSync(ran)).toBe(false);
  });
});

/**
 * F42 through the real runner: `terraform validate` reads what `terraform
 * init` installs under `.terraform/`, so without that directory the check
 * fails naming `init -backend=false` for the CLI the repo runs, and nothing
 * spawns. Stand-in CLIs on a scratch `PATH` leave a mark when they run.
 */
describe('the default runner fails terraform validate before init (F42)', () => {
  let root: string;
  let repo: string;
  let ran: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkride-tf-setup-'));
    repo = join(root, 'repo');
    ran = join(root, 'ran');
    const bin = join(root, 'bin');
    await mkdir(repo, { recursive: true });
    await mkdir(bin);
    for (const cli of ['terraform', 'tofu']) {
      // oxlint-disable-next-line no-await-in-loop -- two stand-ins, written once per case.
      await writeFile(join(bin, cli), `#!/bin/sh\necho ${cli} > "${ran}"\necho '{"valid":true,"diagnostics":[]}'\n`);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await chmod(join(bin, cli), 0o755);
    }
    vi.stubEnv('PATH', bin);
    vi.stubEnv('TF_DATA_DIR', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const validate = PACKS.terraform.adapters.find((a) => a.name === 'terraform-validate') ?? null;
  const resolved: ResolvedCheck = { slot: 'types', optIn: false, adapter: validate, skip: null };
  const at = (): Parameters<CheckRunner>[1] => ({ cwd: repo, repo, changed: false, pm: 'pnpm', pins: PACKS.terraform.pins });

  test('without .terraform/, it fails naming terraform init -backend=false, and nothing runs', async () => {
    const outcome = await defaultRunner(resolved, at());
    expect(outcome).toMatchObject({ ok: false, exit_code: 1 });
    expect(outcome.stderr).toContain('terraform-validate reads .terraform/, which `terraform init -backend=false` writes');
    expect(outcome).not.toHaveProperty('argv');
    expect(existsSync(ran)).toBe(false);
  });

  test('where the repo runs OpenTofu, it names tofu init', async () => {
    await writeFile(join(repo, '.opentofu-version'), 'latest:^1.6\n');
    const outcome = await defaultRunner(resolved, at());
    expect(outcome.stderr).toContain('`tofu init -backend=false`');
    expect(existsSync(ran)).toBe(false);
  });

  test('once init has run, validate spawns the CLI', async () => {
    await mkdir(join(repo, '.terraform'));
    const outcome = await defaultRunner(resolved, at());
    expect(outcome).toMatchObject({ ok: true, exit_code: 0, argv: ['terraform', 'validate', '-json'], pin_source: 'path' });
    expect(await readFile(ran, 'utf8')).toBe('terraform\n');
  });

  test('TF_DATA_DIR moves the directory it looks for', async () => {
    vi.stubEnv('TF_DATA_DIR', 'state/tf');
    await mkdir(join(repo, '.terraform'));
    const missing = await defaultRunner(resolved, at());
    expect(missing.stderr).toContain('terraform-validate reads state/tf/');
    await mkdir(join(repo, 'state', 'tf'), { recursive: true });
    expect(await defaultRunner(resolved, at())).toMatchObject({ ok: true });
  });
});
