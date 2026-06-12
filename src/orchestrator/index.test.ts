import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters/index.js';
import type { ResolvedCheck } from '../config/index.js';
import type { CheckRunner, Out, Summary } from './index.js';
import { runChecks, runFix, runtimeArgs, selectChecks } from './index.js';

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
});

describe('runFix', () => {
  const fixable = fakeAdapter({ name: 'oxlint', slot: 'lint', fixArgs: ['exec', 'oxlint', '--fix'] });
  const noFix = fakeAdapter({ name: 'tsc', slot: 'types' });

  test('runs fix only for active adapters that expose fixArgs', async () => {
    const ran: string[] = [];
    const result = await runFix({
      cwd: '/tmp', slots: [{ name: 'lint' }, { name: 'types' }], adapters: [fixable, noFix],
      config: null, stderr: sink().out,
      fixRunner: (a) => { ran.push(a.name); return Promise.resolve({ ok: true, exit_code: 0 }); },
    });
    expect(ran).toEqual(['oxlint']);
    expect(result).toMatchObject({ ok: true, exitCode: 0, ran: ['oxlint'] });
  });

  test('reports failure when a fix command fails', async () => {
    const result = await runFix({
      cwd: '/tmp', slots: [{ name: 'lint' }], adapters: [fixable], config: null, stderr: sink().out,
      fixRunner: () => Promise.resolve({ ok: false, exit_code: 2 }),
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
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
