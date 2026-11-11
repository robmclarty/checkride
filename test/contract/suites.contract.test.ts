/**
 * Contract: named suites (docs/contract.md §CLI, "`--suite <name>` and
 * `CHECKRIDE_SUITE` name a suite").
 *
 * A suite's name fixes three paths, `checkride.<name>.config.json`,
 * `checkride.<name>.baseline.json` and `.check/suites/<name>/`; its run
 * carries `suite` in the summary and runs exactly the checks its config
 * declares; and none of it changes a run of the default suite. All of it is
 * additive: a break here is a version decision, not a test edit.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { parseCliArgs, runCli } from '../../src/cli.js';
import type { GateSpawn } from '../../src/gate.js';
import { runGate } from '../../src/gate.js';
import { SUITE_ENV, suiteNamed } from '../../src/suite.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema: object = JSON.parse(readFileSync(join(here, '..', '..', 'schema', 'checkride.summary.schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** A config whose one custom check, `probe`, exits with `code`. */
const probeConfig = (code: number): string =>
  JSON.stringify({ checks: { probe: { command: process.execPath, args: ['-e', `process.exit(${code})`] } } });

describe('named suites', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-suites-contract-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.evals.config.json'), probeConfig(0));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr'] = capture(), env: Record<string, string> = {}, stdout: CliDeps['stdout'] = capture()): CliDeps {
    return { cwd: dir, stdout, stderr, env };
  }

  async function summaryIn(...out: string[]): Promise<Record<string, unknown>> {
    const summary = JSON.parse(await readFile(join(dir, ...out, 'summary.json'), 'utf8')) as Record<string, unknown>;
    const valid = validate(summary);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    return summary;
  }

  test('--suite <name> parses to its raw value, and the variable is CHECKRIDE_SUITE', () => {
    expect(parseCliArgs(['--suite', 'evals']).suite).toBe('evals');
    expect(parseCliArgs([]).suite).toBeUndefined();
    expect(SUITE_ENV).toBe('CHECKRIDE_SUITE');
  });

  test('a suite’s name fixes its config, its baseline and its output directory', () => {
    expect(suiteNamed('evals')).toEqual({
      name: 'evals',
      configFile: 'checkride.evals.config.json',
      baselineFile: 'checkride.evals.baseline.json',
      out: '.check/suites/evals',
    });
  });

  test('a suite run reads its config, writes .check/suites/<name>/, and its summary validates with suite', async () => {
    const stderr = capture();
    expect(await runCli(['--suite', 'evals'], deps(stderr))).toBe(0);
    const summary = await summaryIn('.check', 'suites', 'evals');
    expect(summary['suite']).toBe('evals');
    expect(summary['run']).toEqual({ partial: false });
    expect(stderr.text()).toContain('Running 1 check(s) of suite evals...');
    expect(stderr.text()).toContain('report: .check/suites/evals/summary.json');
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(false);
  });

  test('CHECKRIDE_SUITE does the same, the flag beats it, and an empty variable counts as unset', async () => {
    await writeFile(join(dir, 'checkride.red.config.json'), probeConfig(1));
    expect(await runCli([], deps(capture(), { CHECKRIDE_SUITE: 'red' }))).toBe(1);
    expect((await summaryIn('.check', 'suites', 'red'))['suite']).toBe('red');
    expect(await runCli(['--suite', 'evals'], deps(capture(), { CHECKRIDE_SUITE: 'red' }))).toBe(0);
    expect(await runCli([], deps(capture(), { CHECKRIDE_SUITE: '' }))).toBe(0);
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(true);
  });

  test('a run of the default suite carries no suite field', async () => {
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    expect(await runCli(['--only', 'probe'], deps())).toBe(0);
    expect(Object.keys(await summaryIn('.check'))).not.toContain('suite');
  });

  test('a suite runs exactly the checks its config declares: detection fills no slot and no built-in joins', async () => {
    // A README makes `links` run in the default suite, and oxlint's config would detect `lint`.
    await writeFile(join(dir, 'README.md'), '# contract\n');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    await runCli(['--suite', 'evals'], deps());
    const named = (await summaryIn('.check', 'suites', 'evals'))['checks'] as { name: string }[];
    expect(named.map((c) => c.name)).toEqual(['probe']);

    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    await runCli([], deps());
    const whole = (await summaryIn('.check'))['checks'] as { name: string }[];
    expect(whole.map((c) => c.name)).toEqual(expect.arrayContaining(['probe', 'links', 'lint']));
  });

  test('the usage errors exit 2 before anything is written', async () => {
    await writeFile(join(dir, 'other.json'), probeConfig(0));
    const cases: readonly (readonly [string[], string])[] = [
      [['--suite', 'Evals'], 'invalid suite name'],
      [['--suite', '1st'], 'invalid suite name'],
      [['--suite', 'config'], 'invalid suite name'],
      [['--suite', 'baseline'], 'invalid suite name'],
      [['--suite', ''], '--suite was passed with no name'],
      [['--suite', 'perf'], `${join(dir, 'checkride.perf.config.json')} is missing; the suites here are evals`],
      [['--suite', 'evals', '--config', 'other.json'], "--suite can't be combined with --config"],
      [['--suite', 'evals', '--defaults', 'other.json'], "--suite can't be combined with --defaults"],
      [['--suite', 'evals', '--discover'], "--suite can't be combined with --discover"],
      [['doctor', '--suite', 'evals', '--discover'], "--suite can't be combined with --discover"],
    ];
    for (const [argv, message] of cases) {
      const stderr = capture();
      expect(await runCli(argv, deps(stderr)), argv.join(' ')).toBe(2);
      expect(stderr.text()).toContain(message);
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('a repo with no suite says so', async () => {
    await rm(join(dir, 'checkride.evals.config.json'));
    const stderr = capture();
    expect(await runCli(['--suite', 'evals'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('there are no suites here');
  });

  test('--out wins for the directory', async () => {
    expect(await runCli(['--suite', 'evals', '--out', 'elsewhere'], deps())).toBe(0);
    expect((await summaryIn('elsewhere'))['suite']).toBe('evals');
    expect(existsSync(join(dir, '.check', 'suites'))).toBe(false);
  });

  test('baseline --suite writes checkride.<name>.baseline.json, and never the default suite’s file', async () => {
    const stderr = capture();
    expect(await runCli(['baseline', '--suite', 'evals'], deps(stderr))).toBe(0);
    expect(stderr.text()).toContain('baseline: wrote checkride.evals.baseline.json');
    expect(JSON.parse(await readFile(join(dir, 'checkride.evals.baseline.json'), 'utf8'))).toEqual({ schema_version: 1, slots: {} });
    expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(false);
  });

  test('a bare baseline never writes a suite’s file', async () => {
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    expect(await runCli(['baseline'], deps())).toBe(0);
    expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(true);
    expect(existsSync(join(dir, 'checkride.evals.baseline.json'))).toBe(false);
  });

  test('every command that takes --suite refuses a suite with no config, and the rest refuse the flag', async () => {
    for (const command of [[], ['fix'], ['doctor'], ['baseline'], ['baseline', '--versions'], ['baseline', 'diff'], ['recover'], ['triage'], ['qa']]) {
      const stderr = capture();
      expect(await runCli([...command, '--suite', 'perf'], deps(stderr)), command.join(' ')).toBe(2);
      expect(stderr.text(), command.join(' ')).toContain("--suite names 'perf', which has no config");
    }
    for (const command of [['init'], ['agent-setup'], ['hooks', 'add'], ['target', 'add', 'web', '--lang', 'ts', '--root', '.']]) {
      const stderr = capture();
      expect(await runCli([...command, '--suite', 'evals'], deps(stderr)), command.join(' ')).toBe(2);
      expect(stderr.text(), command.join(' ')).toContain("Unknown option '--suite'");
    }
  });

  test('doctor lists the suites on one row, and doctor --suite reports the suite alone', async () => {
    await writeFile(join(dir, 'checkride.perf.config.json'), probeConfig(0));
    type Report = { suite?: string; checks: { name: string; found: string | null; required: boolean }[] };
    const doctor = async (...argv: string[]): Promise<Report> => {
      const stdout = capture();
      await runCli(['doctor', '--json', ...argv], deps(capture(), {}, stdout));
      return JSON.parse(stdout.text()) as Report;
    };
    expect((await doctor()).checks.find((c) => c.name === 'suites')).toMatchObject({ found: 'evals, perf', required: false });
    const evals = await doctor('--suite', 'evals');
    expect(evals.suite).toBe('evals');
    expect(evals.checks.find((c) => c.name === 'suites')).toBeUndefined();
    expect(evals.checks.find((c) => c.name === '.check/suites/evals')).toBeDefined();
  });

  test('a target can’t be named suites, in a config or through target add', async () => {
    await mkdir(join(dir, 'web'));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { suites: { lang: 'ts', root: 'web' } } }));
    const stderr = capture();
    expect(await runCli([], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("target name 'suites' is reserved: named suites write their artifacts in .check/suites/");

    await rm(join(dir, 'checkride.config.json'));
    const added = capture();
    expect(await runCli(['target', 'add', 'suites', '--lang', 'ts', '--root', 'web'], deps(added))).toBe(2);
    expect(added.text()).toContain("target name 'suites' is reserved");
    expect(existsSync(join(dir, 'checkride.config.json'))).toBe(false);
  });

  test('a config error names the suite’s config by its short file name', async () => {
    await writeFile(join(dir, 'checkride.evals.config.json'), JSON.stringify({ checks: { lint: { timeout: 5 } } }));
    const stderr = capture();
    expect(await runCli(['--suite', 'evals'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('checkride: invalid checkride.evals.config.json: checks.lint names no tool');
  });

  test('suiteNamed is exported from the package root, and a programmatic run of a suite loads its config', async () => {
    const api = await import('../../src/index.js');
    const suite: import('../../src/index.js').Suite = api.suiteNamed('evals');
    expect(suite).toEqual(suiteNamed('evals'));
    const result = await api.runChecks({ cwd: dir, suite, json: true, stdout: capture(), stderr: capture() });
    expect(result.summary.suite).toBe('evals');
    expect(result.summary.checks.map((c) => c.name)).toEqual(['probe']);
  });

  test('a default run leaves .check/suites/ as it was', async () => {
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    await runCli(['--suite', 'evals'], deps());
    const before = await readFile(join(dir, '.check', 'suites', 'evals', 'summary.json'), 'utf8');
    await runCli([], deps());
    await runCli(['baseline'], deps());
    expect(await readFile(join(dir, '.check', 'suites', 'evals', 'summary.json'), 'utf8')).toBe(before);
  });
});

describe('gate and named suites', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-suites-gate-contract-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    await writeFile(join(dir, 'checkride.evals.config.json'), '{}');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const pinEnv = { exists: () => false, read: () => null, list: () => [], home: () => '/home/dev', running: () => '24.9.0', variable: () => undefined };
  type Seen = { args: readonly string[]; env: Record<string, string | undefined> };
  const recording = (seen: Seen[]): GateSpawn => (_command, args, opts) => { seen.push({ args, env: opts.env }); return Promise.resolve(0); };
  const gate = (seen: Seen[], over: Parameters<typeof runGate>[0] = {}) =>
    runGate({ cwd: dir, pm: 'pnpm', spawn: recording(seen), stdout: capture(), stderr: capture(), env: { PATH: '/usr/bin', CHECKRIDE_SUITE: 'evals' }, pinEnv, ...over });

  test('a bare gate strips CHECKRIDE_SUITE and passes no --suite: the hook gates the default suite', async () => {
    const seen: Seen[] = [];
    await gate(seen);
    expect(seen).toEqual([{ args: ['run', 'check', '--strict', '--digest'], env: { PATH: '/usr/bin' } }]);
  });

  test('gate --suite passes the suite to the check as a flag, never through the environment', async () => {
    const seen: Seen[] = [];
    await gate(seen, { suite: 'evals' });
    expect(seen).toEqual([{ args: ['run', 'check', '--strict', '--digest', '--suite', 'evals'], env: { PATH: '/usr/bin' } }]);
  });

  test('gate --suite with no such suite blocks in the harness’s protocol: a decision body for Claude Code, a followup_message and exit 0 for Cursor', async () => {
    const claude = capture();
    expect(await runCli(['gate', '--suite', 'perf'], { cwd: dir, stdout: claude, stderr: capture(), env: {} })).toBe(2);
    expect(JSON.parse(claude.text())).toMatchObject({ decision: 'block', reason: expect.stringContaining("--suite names 'perf', which has no config") as unknown });

    const cursor = capture();
    const stderr = capture();
    expect(await runCli(['gate', '--harness', 'cursor', '--suite', 'perf'], { cwd: dir, stdout: cursor, stderr, env: {} })).toBe(0);
    expect(Object.keys(JSON.parse(cursor.text()) as object)).toEqual(['followup_message']);
    expect(stderr.text()).toBe('');
  });

  test('the gate command reads the flag alone, so a stray variable never selects a suite', async () => {
    // A missing suite would exit 2 were the variable read; the gate runs the default suite instead.
    const stderr = capture();
    const code = await runCli(['gate', '--if-dirty'], { cwd: dir, stdout: capture(), stderr, env: { CHECKRIDE_SUITE: 'nope' } });
    expect(code).toBe(0);
    expect(stderr.text()).toBe('');
  });
});
