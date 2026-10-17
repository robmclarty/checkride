/**
 * Capture and the `failOnOutput` verdict (S9): what a check's stdout becomes in
 * the output directory under R11.1, and how a tool that reports findings by
 * printing them, then exits 0, still fails its check (F13, F14).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import type { CheckRunner, Out, RunResult } from '../index.js';
import { runChecks } from '../index.js';

/** Real `go build -json` events, one per line; the tool's bytes, which capture must not touch. */
const JSONL = [
  '{"ImportPath":"example.com/demo","Action":"build-output","Output":"# example.com/demo\\n"}',
  '{"ImportPath":"example.com/demo","Action":"build-fail"}',
  '',
].join('\n');

/** JSON lines with a text line between them: the tool's own output, so it's kept whole as text. */
const MIXED = '{"Action":"start"}\nok  \texample.com/demo\t0.004s\n{"Action":"pass"}\n';

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

function sink(): { out: Out; lines: string[] } {
  const lines: string[] = [];
  return { lines, out: { write: (text: string) => { lines.push(text); return true; } } };
}

/** A runner that prints `stdout` and exits `exit_code` for every check. */
function prints(stdout: string, exit_code = 0): CheckRunner {
  return () => Promise.resolve({ ok: exit_code === 0, exit_code, stdout, stderr: '' });
}

describe('capture (R11.1)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-capture-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Run one adapter in the `types` slot over `runner`, returning the run and its check's entry. */
  async function runTypes(adapter: Partial<Adapter>, runner: CheckRunner): Promise<{ result: RunResult; stderr: string }> {
    const std = sink();
    const result = await runChecks({
      cwd: dir,
      slots: [{ name: 'types' }],
      adapters: [fakeAdapter({ name: 'go-build', slot: 'types', ...adapter })],
      runner,
      json: false,
      stdout: sink().out,
      stderr: std.out,
    });
    return { result, stderr: std.lines.join('') };
  }

  const read = (file: string): Promise<string> => readFile(join(dir, '.check', file), 'utf8');

  test('a declared .json file takes one JSON value', async () => {
    const { result } = await runTypes({ outputFile: 'types.json' }, prints('{"errors":[]}\n'));
    expect(result.summary.checks[0]).toMatchObject({ name: 'types', ok: true, output_file: 'types.json' });
    expect(await read('types.json')).toBe('{"errors":[]}\n');
  });

  test('a declared .jsonl file takes JSON lines, byte for byte', async () => {
    const { result } = await runTypes({ outputFile: 'types.jsonl' }, prints(JSONL, 1));
    expect(result.summary.checks[0]).toMatchObject({ name: 'types', ok: false, exit_code: 1, output_file: 'types.jsonl' });
    expect(await read('types.jsonl')).toBe(JSONL);
    expect(existsSync(join(dir, '.check', 'types.stdout.txt'))).toBe(false);
  });

  test('a declared .jsonl file drops a launcher preamble and keeps the rest verbatim', async () => {
    const { result } = await runTypes({ outputFile: 'types.jsonl' }, prints(`Already up to date\n${JSONL}`));
    expect(result.summary.checks[0]?.output_file).toBe('types.jsonl');
    expect(await read('types.jsonl')).toBe(JSONL);
  });

  // F13
  test('JSON lines mixed with text are captured as stdout text, byte-identical', async () => {
    const { result } = await runTypes({ outputFile: 'types.jsonl' }, prints(MIXED));
    expect(result.summary.checks[0]?.output_file).toBeNull();
    expect(await read('types.stdout.txt')).toBe(MIXED);
    expect(existsSync(join(dir, '.check', 'types.jsonl'))).toBe(false);
  });

  test('a declared .json file does not take JSON lines', async () => {
    const { result } = await runTypes({ outputFile: 'types.json' }, prints('{"a":1}\nnot json\n'));
    expect(result.summary.checks[0]?.output_file).toBeNull();
    expect(await read('types.stdout.txt')).toBe('{"a":1}\nnot json\n');
  });

  // D45
  test('a custom check without an outputFile keeps JSON lines as stdout text', async () => {
    const result = await runChecks({
      cwd: dir,
      slots: [],
      adapters: [],
      config: { checks: { gotest: { command: 'go', args: ['test', '-json', './...'] } } },
      runner: prints(JSONL),
      json: true,
      stdout: sink().out,
      stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ name: 'gotest', ok: true, output_file: null });
    expect(await read('gotest.stdout.txt')).toBe(JSONL);
    expect(existsSync(join(dir, '.check', 'gotest.jsonl'))).toBe(false);
  });

  test('a custom check that declares a .jsonl file gets JSON-lines capture', async () => {
    const result = await runChecks({
      cwd: dir,
      slots: [],
      adapters: [],
      config: { checks: { gotest: { command: 'go', args: ['test', '-json', './...'], outputFile: 'gotest.jsonl' } } },
      runner: prints(JSONL),
      json: true,
      stdout: sink().out,
      stderr: sink().out,
    });
    expect(result.summary.checks[0]).toMatchObject({ name: 'gotest', output_file: 'gotest.jsonl' });
    expect(await read('gotest.jsonl')).toBe(JSONL);
  });

  test('a re-run clears the slot\'s stale .jsonl file', async () => {
    await runTypes({ outputFile: 'types.jsonl' }, prints(JSONL));
    expect(existsSync(join(dir, '.check', 'types.jsonl'))).toBe(true);
    await runTypes({ outputFile: 'types.jsonl' }, prints(''));
    expect(existsSync(join(dir, '.check', 'types.jsonl'))).toBe(false);
  });
});

describe('the failOnOutput verdict', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-fail-on-output-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Run a `gofmt -l`-shaped adapter in the `format` slot over `runner`. */
  async function runFormat(runner: CheckRunner, failOnOutput = true): Promise<{ result: RunResult; stderr: string }> {
    const std = sink();
    const result = await runChecks({
      cwd: dir,
      slots: [{ name: 'format' }],
      adapters: [fakeAdapter({ name: 'gofmt', slot: 'format', command: 'gofmt', args: ['-l', '.'], failOnOutput })],
      runner,
      json: false,
      stdout: sink().out,
      stderr: std.out,
    });
    return { result, stderr: std.lines.join('') };
  }

  // F14
  test('a tool that exits 0 with stdout fails, keeping exit_code 0 and naming why', async () => {
    const { result, stderr } = await runFormat(prints('main.go\nutil/strings.go\n'));
    expect(result.summary.checks[0]).toMatchObject({
      name: 'format',
      adapter: 'gofmt',
      ok: false,
      reason: 'gofmt exited 0 but reported findings on stdout',
      exit_code: 0,
      output_file: null,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(await readFile(join(dir, '.check', 'format.stdout.txt'), 'utf8')).toBe('main.go\nutil/strings.go\n');
    expect(stderr).toContain('gofmt exited 0 but reported findings on stdout');
  });

  test('whitespace-only stdout on exit 0 passes, with no reason', async () => {
    const { result } = await runFormat(prints(' \n\n'));
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
    expect(result.summary.checks[0]).not.toHaveProperty('reason');
  });

  test('a non-zero exit fails on its own, with no failOnOutput reason', async () => {
    const { result } = await runFormat(prints('main.go:1:1: expected package\n', 2));
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: 2 });
    expect(result.summary.checks[0]).not.toHaveProperty('reason');
  });

  test('an adapter without failOnOutput passes on exit 0 whatever it prints', async () => {
    const { result } = await runFormat(prints('main.go\n'), false);
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
    expect(result.summary.checks[0]).not.toHaveProperty('reason');
  });
});
