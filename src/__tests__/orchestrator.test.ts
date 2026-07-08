import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { ResolvedCheck } from '../config.js';
import type { CheckRunner, Out, Summary } from '../orchestrator.js';
import { runChecks, runFix, runtimeArgs, selectChecks } from '../orchestrator.js';

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

const failLint: CheckRunner = (r) =>
  Promise.resolve({ ok: r.slot !== 'lint', exit_code: r.slot === 'lint' ? 1 : 0, stdout: '', stderr: '' });

const okRunner: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

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

  test('--only restricts to the named slots', () => {
    expect(selectChecks(resolved, { only: ['lint'] }).map((r) => r.slot)).toEqual(['lint']);
  });

  test('--skip removes a slot entirely', () => {
    expect(selectChecks(resolved, { skip: ['lint'] }).map((r) => r.slot)).toEqual(['types']);
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

  test('no-ops when nothing is fixable', async () => {
    const std = sink();
    const result = await runFix({
      cwd: '/tmp', slots: [{ name: 'types' }], adapters: [noFix], config: null, stderr: std.out,
    });
    expect(result.ran).toEqual([]);
    expect(std.lines.join('')).toContain('no active adapters');
  });
});
