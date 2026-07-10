import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { Adapter } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import { resolveChecks } from '../config.js';
import type { ResolvedCheck } from '../config.js';
import type { CheckRunner, Out, RunFlags, Summary } from '../orchestrator.js';
import { fixInvocation, runChecks, runFix, runtimeArgs, selectChecks } from '../orchestrator.js';
import { detectPackageManager } from '../pm/index.js';

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

/** True while `pid` names a live process (signal 0 probes without delivering). */
function isAlive(pid: number): boolean {
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

/** A runner that emits a small JSON payload on stdout (for output-capture tests). */
const jsonRunner: CheckRunner = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: JSON.stringify({ analysis: { types: true } }), stderr: '' });

/** A runner that emits non-JSON text on stdout (persisted as `<slot>.stdout.txt`). */
const textRunner: CheckRunner = () =>
  Promise.resolve({ ok: true, exit_code: 0, stdout: 'not json output', stderr: '' });

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
      cwd: dir, slots: [{ name: 'attw', optIn: true }], adapters: [attw], config: null,
      include: ['attw'], runner: jsonRunner, json: true, stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks.find((c) => c.name === 'attw')).toMatchObject({ ok: true, output_file: 'attw.json' });
    expect(JSON.parse(await readFile(join(dir, '.check', 'attw.json'), 'utf8'))).toMatchObject({
      analysis: { types: true },
    });
  });
});

describe('runtimeArgs', () => {
  const withChanged = fakeAdapter({ name: 'vitest', slot: 'test', args: ['run'], changedArgs: ['--changed', 'main'] });
  const noChanged = fakeAdapter({ name: 'tsc', slot: 'types', args: ['--build'] });

  test('appends changedArgs under --changed', () => {
    expect(runtimeArgs(withChanged, true)).toEqual(['run', '--changed', 'main']);
  });
  test('leaves args untouched without --changed', () => {
    expect(runtimeArgs(withChanged, false)).toEqual(['run']);
  });
  test('adapters with no changedArgs are unaffected', () => {
    expect(runtimeArgs(noChanged, true)).toEqual(['--build']);
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

  test('--bail stops after the first failure', async () => {
    const failFirst = [{ name: 'lint' }, { name: 'types' }];
    const result = await runChecks({
      cwd: dir, slots: failFirst, adapters, config: null, runner: failLint, bail: true, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks).toHaveLength(1);
    expect(result.summary.checks[0]?.name).toBe('lint');
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
    const toolWrites: CheckRunner = async (_r, ctx) => {
      await writeFile(join(ctx.cwd, '.check', 'test.json'), JSON.stringify({ fresh: true }));
      return { ok: true, exit_code: 0, stdout: '', stderr: '' };
    };
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

  test('reports a spawn failure for a missing binary', async () => {
    const adapter = fakeAdapter({
      name: 'ghost', slot: 'ghost', command: 'checkride-no-such-binary-xyz', args: [],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'ghost' }], adapters: [adapter], config: null, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });
  });

  test('kills a check that exceeds the configured timeout', async () => {
    const adapter = fakeAdapter({
      name: 'hang', slot: 'hang', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'hang' }], adapters: [adapter], config: { timeout: 0.2 }, json: true,
      stdout: sink().out, stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });
    expect(await readFile(join(dir, '.check', 'hang.stderr.txt'), 'utf8')).toContain('timed out');
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
    try {
      const pm = detectPackageManager({ cwd: dir });
      expect(pm).toBe('npm');
      // The canonical `pnpm exec oxlint --fix` becomes `npx oxlint --fix`, the
      // same translation the run path applies via `translateExec` in `defaultRunner`.
      const adapter = fakeAdapter({ name: 'oxlint', slot: 'lint', command: 'pnpm', args: ['exec', 'oxlint'], fixArgs: ['exec', 'oxlint', '--fix'] });
      expect(fixInvocation(adapter, pm)).toEqual({ command: 'npx', args: ['oxlint', '--fix'] });
      // The default pnpm path stays byte-identical — no translation.
      expect(fixInvocation(adapter, 'pnpm')).toEqual({ command: 'pnpm', args: ['exec', 'oxlint', '--fix'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
