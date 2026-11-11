import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../cli.js';
import { runCli } from '../cli.js';
import { DEFAULT_SUITE, flagOrVariable, listSuites, namedSuite, SUITE_ENV, suiteCommand, suiteFlags, suiteNamed } from '../suite.js';

function sink(): { write: (text: string) => boolean; text: () => string } {
  const lines: string[] = [];
  return { write: (text: string) => { lines.push(text); return true; }, text: () => lines.join('') };
}

/** A config whose one custom check, `probe`, exits with `code`. */
const probeConfig = (code: number): string =>
  JSON.stringify({ checks: { probe: { command: process.execPath, args: ['-e', `process.exit(${code})`] } } });

/** A config whose `format` fixer writes an empty `file`, so a test can see which suite's fixers ran. */
const fixerConfig = (file: string): string =>
  JSON.stringify({ checks: { format: { use: 'prettier', command: process.execPath, fixArgs: ['-e', `require('node:fs').writeFileSync('${file}', '')`] } } });

/** A baseline file holding `keys` under `lint`. */
const blob = (keys: string[]): string => `${JSON.stringify({ schema_version: 1, slots: { lint: keys } }, null, 2)}\n`;

describe('suiteNamed', () => {
  test('fixes a suite’s three paths from its name', () => {
    expect(suiteNamed('evals')).toEqual({
      name: 'evals',
      configFile: 'checkride.evals.config.json',
      baselineFile: 'checkride.evals.baseline.json',
      out: '.check/suites/evals',
    });
  });

  test('takes a lowercase word with digits and hyphens', () => {
    for (const name of ['a', 'evals', 'e2e', 'perf-nightly', 'x-1-y']) expect(suiteNamed(name).name).toBe(name);
  });

  test('refuses a name outside the grammar', () => {
    for (const name of ['Evals', '1st', '-evals', 'a_b', 'a.b', 'a/b', '../x', ' evals', 'évals']) {
      expect(() => suiteNamed(name), name).toThrow('invalid suite name');
    }
  });

  test('refuses the two names that would read as the default suite’s files', () => {
    expect(() => suiteNamed('config')).toThrow("invalid suite name 'config'");
    expect(() => suiteNamed('baseline')).toThrow("invalid suite name 'baseline'");
  });
});

describe('suiteFlags and suiteCommand', () => {
  test('a named suite’s command carries --suite, and the default suite’s is as typed', () => {
    const evals = suiteNamed('evals');
    expect(suiteFlags(evals)).toEqual(['--suite', 'evals']);
    expect(suiteFlags(DEFAULT_SUITE)).toEqual([]);
    expect(suiteCommand('checkride recover', evals)).toBe('checkride recover --suite evals');
    expect(suiteCommand('checkride baseline --versions', evals)).toBe('checkride baseline --versions --suite evals');
    expect(suiteCommand('checkride recover', DEFAULT_SUITE)).toBe('checkride recover');
  });
});

describe('the default suite and flagOrVariable', () => {
  test('the default suite is the three paths every release has used, with no name', () => {
    expect(DEFAULT_SUITE).toEqual({ configFile: 'checkride.config.json', baselineFile: 'checkride.baseline.json', out: '.check' });
  });

  test('the flag wins, an empty variable counts as unset, and each answer says what named it', () => {
    expect(flagOrVariable('--suite', 'evals', 'CHECKRIDE_SUITE', { CHECKRIDE_SUITE: 'perf' })).toEqual({ value: 'evals', from: '--suite' });
    expect(flagOrVariable('--suite', undefined, 'CHECKRIDE_SUITE', { CHECKRIDE_SUITE: 'perf' })).toEqual({ value: 'perf', from: 'CHECKRIDE_SUITE' });
    expect(flagOrVariable('--suite', undefined, 'CHECKRIDE_SUITE', { CHECKRIDE_SUITE: '' })).toBeNull();
    expect(flagOrVariable('--suite', undefined, 'CHECKRIDE_SUITE', {})).toBeNull();
  });
});

describe('listSuites and namedSuite', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-suite-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('lists each checkride.<name>.config.json in name order, and nothing else', async () => {
    for (const file of [
      'checkride.perf.config.json',
      'checkride.evals.config.json',
      'checkride.config.json',
      'checkride.evals.baseline.json',
      'checkride.config.config.json',
      'checkride.Bad.config.json',
      'checkride.a.b.config.json',
    ]) {
      await writeFile(join(dir, file), '{}');
    }
    expect(listSuites(dir)).toEqual(['evals', 'perf']);
  });

  test('lists none in a directory that holds none, or that is missing', () => {
    expect(listSuites(dir)).toEqual([]);
    expect(listSuites(join(dir, 'nope'))).toEqual([]);
  });

  test('names no suite without the flag or the variable, and an empty variable counts as unset', () => {
    expect(namedSuite(dir, undefined, { env: {} })).toBe(DEFAULT_SUITE);
    expect(namedSuite(dir, undefined, { env: { [SUITE_ENV]: '' } })).toBe(DEFAULT_SUITE);
  });

  test('reads the flag, else the variable, and the flag wins', async () => {
    await writeFile(join(dir, 'checkride.evals.config.json'), '{}');
    await writeFile(join(dir, 'checkride.perf.config.json'), '{}');
    expect(namedSuite(dir, 'evals', { env: {} }).name).toBe('evals');
    expect(namedSuite(dir, undefined, { env: { [SUITE_ENV]: 'perf' } }).name).toBe('perf');
    expect(namedSuite(dir, 'evals', { env: { [SUITE_ENV]: 'perf' } }).name).toBe('evals');
  });

  test('a flag with no name is a usage error, never the default suite', () => {
    expect(() => namedSuite(dir, '', { env: {} })).toThrow('--suite was passed with no name');
  });

  test('a missing config names the path it looked for and the suites that exist', async () => {
    await writeFile(join(dir, 'checkride.perf.config.json'), '{}');
    await writeFile(join(dir, 'checkride.docs.config.json'), '{}');
    expect(() => namedSuite(dir, 'evals', { env: {} })).toThrow(
      `--suite names 'evals', which has no config: ${join(dir, 'checkride.evals.config.json')} is missing; the suites here are docs, perf`,
    );
  });

  test('a missing config says so when the repo holds no suite, and names the variable that asked', () => {
    expect(() => namedSuite(dir, undefined, { env: { [SUITE_ENV]: 'evals' } })).toThrow(
      `CHECKRIDE_SUITE names 'evals', which has no config: ${join(dir, 'checkride.evals.config.json')} is missing; there are no suites here`,
    );
  });

  test('refuses a named config or a defaults layer beside it', async () => {
    await writeFile(join(dir, 'checkride.evals.config.json'), '{}');
    expect(() => namedSuite(dir, 'evals', { env: {}, conflicts: ['--config'] })).toThrow("--suite can't be combined with --config: a suite's name already names its config");
    expect(() => namedSuite(dir, 'evals', { env: {}, conflicts: ['CHECKRIDE_DEFAULTS'] })).toThrow("--suite can't be combined with CHECKRIDE_DEFAULTS: a suite runs exactly the checks its config declares");
    expect(() => namedSuite(dir, 'evals', { env: {}, conflicts: ['--discover'] })).toThrow("--suite can't be combined with --discover: a suite runs exactly the checks its config declares, and discovery declares none");
    expect(() => namedSuite(dir, 'evals', { env: {}, conflicts: ['--config in the check script'] })).toThrow("--suite can't be combined with --config in the check script: a suite's name already names its config");
  });
});

describe('runCli --suite and CHECKRIDE_SUITE', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-cli-suite-'));
    await writeFile(join(dir, 'checkride.evals.config.json'), probeConfig(0));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deps = (env: Record<string, string> = {}, stderr = sink(), stdout = sink()): CliDeps => ({ cwd: dir, stdout, stderr, env });
  const summary = (...path: string[]): { suite?: string; checks: { name: string }[]; run: Record<string, unknown> } =>
    JSON.parse(readFileSync(join(dir, ...path, 'summary.json'), 'utf8'));

  /** The hint on doctor's baseline row, for the suite `argv` names. */
  const hint = async (...argv: string[]): Promise<string | null | undefined> => {
    const out = sink();
    await runCli(['doctor', '--json', ...argv], deps({}, sink(), out));
    return (JSON.parse(out.text()) as { checks: { name: string; hint: string | null }[] }).checks.find((c) => c.name === 'baseline')?.hint;
  };

  test('runs the suite’s config into .check/suites/<name>/ and names it in the summary and the header', async () => {
    const err = sink();
    expect(await runCli(['--suite', 'evals'], deps({}, err))).toBe(0);
    const written = summary('.check', 'suites', 'evals');
    expect(written.suite).toBe('evals');
    expect(written.checks.map((c) => c.name)).toEqual(['probe']);
    // The suite's name fixes its config and directory, so the run records neither as a path it was pointed at.
    expect(written.run).toEqual({ partial: false });
    expect(err.text()).toContain('Running 1 check(s) of suite evals...');
    expect(err.text()).toContain('report: .check/suites/evals/summary.json');
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(false);
  });

  test('CHECKRIDE_SUITE names the suite, an empty one counts as unset, and the flag wins', async () => {
    await writeFile(join(dir, 'checkride.red.config.json'), probeConfig(1));
    expect(await runCli([], deps({ CHECKRIDE_SUITE: 'red' }))).toBe(1);
    expect(summary('.check', 'suites', 'red').suite).toBe('red');
    expect(await runCli(['--suite', 'evals'], deps({ CHECKRIDE_SUITE: 'red' }))).toBe(0);
    expect(await runCli(['--json'], deps({ CHECKRIDE_SUITE: '' }))).toBe(0);
    expect(summary('.check').suite).toBeUndefined();
  });

  test('a run of the default suite carries no suite field and an unchanged header', async () => {
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    const err = sink();
    expect(await runCli(['--only', 'probe'], deps({}, err))).toBe(0);
    expect(Object.keys(summary('.check'))).not.toContain('suite');
    expect(err.text()).toContain('\nRunning 1 check(s)...\n');
  });

  test('a name outside the grammar, a reserved name and a missing config are usage errors', async () => {
    for (const [argv, message] of [
      [['--suite', 'Evals'], 'invalid suite name "Evals"'],
      [['--suite', 'config'], "invalid suite name 'config'"],
      [['--suite', 'baseline'], "invalid suite name 'baseline'"],
      [['--suite', ''], '--suite was passed with no name'],
      [['--suite', 'perf'], `${join(dir, 'checkride.perf.config.json')} is missing; the suites here are evals`],
    ] as const) {
      const err = sink();
      expect(await runCli([...argv], deps({}, err)), argv.join(' ')).toBe(2);
      expect(err.text()).toContain(message);
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('--suite with --config or --defaults is a usage error, by flag or by variable', async () => {
    await writeFile(join(dir, 'other.json'), probeConfig(0));
    for (const [argv, env, message] of [
      [['--suite', 'evals', '--config', 'other.json'], {}, "--suite can't be combined with --config"],
      [['--suite', 'evals', '--defaults', 'other.json'], {}, "--suite can't be combined with --defaults"],
      [['--suite', 'evals'], { CHECKRIDE_CONFIG: 'other.json' }, "--suite can't be combined with CHECKRIDE_CONFIG"],
      [['--config', 'other.json'], { CHECKRIDE_SUITE: 'evals' }, "CHECKRIDE_SUITE can't be combined with --config"],
      [['doctor', '--suite', 'evals', '--defaults', 'other.json'], {}, "--suite can't be combined with --defaults"],
      [['fix', '--suite', 'evals', '--config', 'other.json'], {}, "--suite can't be combined with --config"],
      [['baseline', '--suite', 'evals', '--config', 'other.json'], {}, "--suite can't be combined with --config"],
    ] as const) {
      const err = sink();
      expect(await runCli([...argv], deps({ ...env }, err)), argv.join(' ')).toBe(2);
      expect(err.text()).toContain(message);
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('--suite with --discover is a usage error, on the run and on doctor', async () => {
    for (const argv of [['--suite', 'evals', '--discover'], ['doctor', '--suite', 'evals', '--discover'], ['--discover']]) {
      const err = sink();
      const env = argv.includes('--suite') ? {} : { CHECKRIDE_SUITE: 'evals' };
      expect(await runCli(argv, deps(env, err)), argv.join(' ')).toBe(2);
      expect(err.text()).toContain("can't be combined with --discover: a suite runs exactly the checks its config declares, and discovery declares none");
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
    // Without a suite, --discover is what it was.
    expect(await runCli(['--discover', '--json'], deps())).toBe(0);
  });

  test('a config error in a suite names the file by its short name, as the default suite’s does', async () => {
    await writeFile(join(dir, 'checkride.evals.config.json'), JSON.stringify({ checks: { lint: { timeout: 5 } } }));
    for (const argv of [['--suite', 'evals'], ['doctor', '--suite', 'evals'], ['fix', '--suite', 'evals'], ['baseline', '--suite', 'evals']]) {
      const err = sink();
      expect(await runCli(argv, deps({}, err)), argv.join(' ')).toBe(2);
      expect(err.text()).toBe('checkride: invalid checkride.evals.config.json: checks.lint names no tool: a suite runs exactly the checks its config declares, so give it a "use" or a "command"\n');
    }
    await writeFile(join(dir, 'checkride.evals.config.json'), '{ not json');
    const err = sink();
    expect(await runCli(['--suite', 'evals'], deps({}, err))).toBe(2);
    expect(err.text()).toContain('invalid checkride.evals.config.json:');
    expect(err.text()).not.toContain(dir);
  });

  test('gate --suite with a name it can’t gate answers in the hook’s protocol, never as a usage error', async () => {
    const claudeOut = sink();
    const claudeErr = sink();
    expect(await runCli(['gate', '--suite', 'perf'], deps({}, claudeErr, claudeOut))).toBe(2);
    const blocked = JSON.parse(claudeOut.text()) as { decision: string; reason: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain("--suite names 'perf', which has no config");
    expect(claudeErr.text()).not.toContain('Run `checkride --help` for usage');

    const cursorOut = sink();
    const cursorErr = sink();
    expect(await runCli(['gate', '--harness', 'cursor', '--suite', 'Bad'], deps({}, cursorErr, cursorOut))).toBe(0);
    expect((JSON.parse(cursorOut.text()) as { followup_message: string }).followup_message).toContain('invalid suite name "Bad"');
    expect(cursorErr.text()).toBe('');
  });

  test('triage --suite refuses, itself, what would make its run a usage error', async () => {
    const env = sink();
    expect(await runCli(['triage', '--suite', 'evals'], deps({ CHECKRIDE_CONFIG: 'ci.json' }, env))).toBe(2);
    expect(env.text()).toBe("checkride: --suite can't be combined with CHECKRIDE_CONFIG: a suite's name already names its config\n");

    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride --defaults shared.json' } }));
    const script = sink();
    expect(await runCli(['triage', '--suite', 'evals'], deps({}, script))).toBe(2);
    expect(script.text()).toContain("--suite can't be combined with --defaults in the check script");
    // qa starts no run, so neither stops it.
    expect(await runCli(['qa', '--suite', 'evals'], deps({ CHECKRIDE_CONFIG: 'ci.json' }))).toBe(0);
  });

  test('qa --suite names the suite’s config and command in what it says of an artifact no run produces', async () => {
    await runCli(['--suite', 'evals'], deps());
    const out = sink();
    expect(await runCli(['qa', '--suite', 'evals'], deps({}, sink(), out))).toBe(0);
    expect(out.text()).toContain('is not named in `checkride.evals.config.json`, so no `checkride --suite evals` run produces it');
    expect(out.text()).toContain('Add `"mutation": { "use": "stryker" }` to `checkride.evals.config.json`, then run `checkride --suite evals`.');
    expect(out.text()).not.toContain('`checkride.config.json`');

    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    await runCli(['--only', 'probe'], deps());
    const whole = sink();
    await runCli(['qa'], deps({}, sink(), whole));
    expect(whole.text()).toContain('is not named in `checkride.config.json`, so no `checkride` run produces it');
    expect(whole.text()).not.toContain('--suite');
  });

  test('doctor --suite sends an unparseable suite baseline to the suite’s own recover', async () => {
    await writeFile(join(dir, 'checkride.evals.baseline.json'), '<<<<<<< HEAD\n');
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n');
    expect(await hint('--suite', 'evals')).toContain('Run `checkride recover --suite evals` to rebuild it');
    expect(await hint()).toContain('Run `checkride recover` to rebuild it');
  });

  test('baseline’s errors under a suite name the suite’s own recover and baseline', async () => {
    const absent = sink();
    expect(await runCli(['baseline', '--versions', '--suite', 'evals'], deps({}, absent))).toBe(2);
    expect(absent.text()).toContain("there's no checkride.evals.baseline.json to re-record; capture one with `checkride baseline --suite evals`");

    await writeFile(join(dir, 'checkride.evals.baseline.json'), '<<<<<<< HEAD\n');
    const mangled = sink();
    expect(await runCli(['baseline', '--versions', '--suite', 'evals'], deps({}, mangled))).toBe(2);
    expect(mangled.text()).toContain('restore it with `checkride recover --suite evals`');
    const narrowed = sink();
    expect(await runCli(['baseline', '--only', 'probe', '--suite', 'evals'], deps({}, narrowed))).toBe(2);
    expect(narrowed.text()).toContain('restore it with `checkride recover --suite evals`, or capture every check with `checkride baseline --suite evals`');

    // The default suite's say what they said.
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(0));
    const whole = sink();
    expect(await runCli(['baseline', '--versions'], deps({}, whole))).toBe(2);
    expect(whole.text()).toContain('capture one with `checkride baseline`\n');
  });

  test('--out wins for the directory, and the run is still the suite’s', async () => {
    expect(await runCli(['--suite', 'evals', '--out', 'elsewhere'], deps())).toBe(0);
    expect(summary('elsewhere').suite).toBe('evals');
    expect(summary('elsewhere').run).toEqual({ partial: false, out: join(dir, 'elsewhere') });
    expect(existsSync(join(dir, '.check', 'suites'))).toBe(false);
  });

  test('init, hooks, agent-setup and target add take no --suite', async () => {
    for (const argv of [['init', '--suite', 'evals'], ['hooks', 'add', '--suite', 'evals'], ['agent-setup', '--suite', 'evals'], ['target', 'add', 'web', '--lang', 'ts', '--root', '.', '--suite', 'evals']]) {
      const err = sink();
      expect(await runCli(argv, deps({}, err)), argv.join(' ')).toBe(2);
      expect(err.text()).toContain("Unknown option '--suite'");
    }
  });

  test('fix --suite runs the suite’s fixers, and the default suite’s are left alone', async () => {
    await writeFile(join(dir, 'checkride.config.json'), fixerConfig('default.fixed'));
    await writeFile(join(dir, 'checkride.evals.config.json'), fixerConfig('evals.fixed'));
    expect(await runCli(['fix', '--suite', 'evals'], deps())).toBe(0);
    expect(existsSync(join(dir, 'evals.fixed'))).toBe(true);
    expect(existsSync(join(dir, 'default.fixed'))).toBe(false);
  });

  test('doctor lists the suites it finds on one row, and doctor --suite reports on the suite alone', async () => {
    await writeFile(join(dir, 'checkride.perf.config.json'), probeConfig(0));
    await writeFile(join(dir, 'checkride.evals.baseline.json'), JSON.stringify({ schema_version: 1, slots: { probe: ['k1', 'k2'] } }));
    type Report = { suite?: string; checks: { name: string; category: string; found: string | null; required: boolean }[] };
    const report = async (...argv: string[]): Promise<Report> => {
      const out = sink();
      await runCli(['doctor', '--json', ...argv], deps({}, sink(), out));
      return JSON.parse(out.text()) as Report;
    };

    const whole = await report();
    expect(whole.suite).toBeUndefined();
    expect(whole.checks.find((c) => c.name === 'suites')).toMatchObject({ category: 'workspace', found: 'evals, perf', required: false });
    // The suite's baseline is not the default suite's.
    expect(whole.checks.find((c) => c.name === 'baseline')).toBeUndefined();

    const evals = await report('--suite', 'evals');
    expect(evals.suite).toBe('evals');
    expect(evals.checks.filter((c) => c.category === 'tool').map((c) => c.name)).toEqual(['custom:probe (probe)']);
    expect(evals.checks.find((c) => c.name === 'baseline')?.found).toBe('2 grandfathered finding(s)');
    expect(evals.checks.find((c) => c.name === '.check/suites/evals')).toBeDefined();
    expect(evals.checks.find((c) => c.name === 'suites')).toBeUndefined();
  });

  test('doctor reports no suites row in a repo that holds none', async () => {
    await rm(join(dir, 'checkride.evals.config.json'));
    const out = sink();
    await runCli(['doctor', '--json'], deps({}, sink(), out));
    expect((JSON.parse(out.text()) as { checks: { name: string }[] }).checks.find((c) => c.name === 'suites')).toBeUndefined();
  });

  test('qa --suite reads the suite’s output directory', async () => {
    await runCli(['--suite', 'evals'], deps());
    const out = sink();
    expect(await runCli(['qa', '--suite', 'evals'], deps({}, sink(), out))).toBe(0);
    expect(out.text()).toContain('.check/suites/evals');
  });

  test('triage, qa and recover refuse a suite with no config', async () => {
    for (const command of ['triage', 'qa', 'recover']) {
      const err = sink();
      expect(await runCli([command, '--suite', 'perf'], deps({}, err)), command).toBe(2);
      expect(err.text()).toContain("--suite names 'perf', which has no config");
    }
  });
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe.skipIf(!hasGit())('baseline and recover with --suite, against real git', () => {
  let dir: string;
  const deps = (stdout = sink(), stderr = sink()): CliDeps => ({ cwd: dir, stdout, stderr, env: {} });
  const read = (file: string): { slots: Record<string, string[]> } => JSON.parse(readFileSync(join(dir, file), 'utf8'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-suite-git-'));
    git(dir, 'init', '-q');
    await writeFile(join(dir, 'checkride.evals.config.json'), probeConfig(0));
    await writeFile(join(dir, 'checkride.baseline.json'), blob(['default-1', 'default-2']));
    await writeFile(join(dir, 'checkride.evals.baseline.json'), blob(['evals-1', 'evals-2']));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'adopt both suites');
    // A merge drops a key from each file.
    await writeFile(join(dir, 'checkride.baseline.json'), blob(['default-1']));
    await writeFile(join(dir, 'checkride.evals.baseline.json'), blob(['evals-1']));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('baseline diff --suite diffs the suite’s file, and a bare one the default suite’s', async () => {
    const evals = sink();
    expect(await runCli(['baseline', 'diff', '--json', '--suite', 'evals'], deps(evals))).toBe(0);
    expect(JSON.parse(evals.text())).toMatchObject({ removed: { lint: ['evals-2'] }, removed_count: 1, added_count: 0 });
    const whole = sink();
    expect(await runCli(['baseline', 'diff', '--json'], deps(whole))).toBe(0);
    expect(JSON.parse(whole.text())).toMatchObject({ removed: { lint: ['default-2'] }, removed_count: 1 });
  });

  test('recover --suite lists and restores from the suite file’s own history, leaving the default suite’s alone', async () => {
    const listing = sink();
    expect(await runCli(['recover', '--suite', 'evals'], deps(listing))).toBe(0);
    expect(listing.text()).toContain('- file: `checkride.evals.baseline.json` — present, 1 key(s)');
    expect(listing.text()).toContain('Apply: `checkride recover --suite evals --pick <#>` by number');
    const miss = sink();
    expect(await runCli(['recover', '--suite', 'evals', '--pick', 'abcd'], deps(sink(), miss))).toBe(2);
    expect(miss.text()).toContain('(run `checkride recover --suite evals` to list them)');

    const err = sink();
    expect(await runCli(['recover', '--suite', 'evals', '--pick', 'union'], deps(sink(), err))).toBe(0);
    expect(err.text()).toContain('recover: wrote checkride.evals.baseline.json — +1 key(s) restored');
    expect(read('checkride.evals.baseline.json').slots['lint']).toEqual(['evals-1', 'evals-2']);
    expect(read('checkride.baseline.json').slots['lint']).toEqual(['default-1']);
  });

  test('a bare recover restores the default suite’s file and leaves the suite’s alone', async () => {
    const listing = sink();
    await runCli(['recover'], deps(listing));
    expect(listing.text()).toContain('Apply: `checkride recover --pick <#>` by number');
    const miss = sink();
    await runCli(['recover', '--pick', 'abcd'], deps(sink(), miss));
    expect(miss.text()).toContain('(run `checkride recover` to list them)');
    expect(await runCli(['recover', '--pick', 'union'], deps())).toBe(0);
    expect(read('checkride.baseline.json').slots['lint']).toEqual(['default-1', 'default-2']);
    expect(read('checkride.evals.baseline.json').slots['lint']).toEqual(['evals-1']);
  });

  test('baseline --suite captures into the suite’s file and leaves the default suite’s as it was', async () => {
    const err = sink();
    expect(await runCli(['baseline', '--suite', 'evals'], deps(sink(), err))).toBe(0);
    expect(err.text()).toContain('baseline: wrote checkride.evals.baseline.json');
    // The probe adds no key, so the capture holds none.
    expect(read('checkride.evals.baseline.json').slots).toEqual({});
    expect(read('checkride.baseline.json').slots['lint']).toEqual(['default-1']);
  });
});
