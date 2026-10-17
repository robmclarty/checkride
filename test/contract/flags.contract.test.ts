/**
 * Contract: the CLI command and run-flag set (docs/contract.md §CLI).
 *
 * The promised run flags parse today and keep parsing; new flags are additive.
 * Removing or repurposing one is a breaking change (major-version decision +
 * a "Contract" CHANGELOG entry).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { GATE_SCRIPT_FILE } from '../../src/agent-setup/index.js';
import type { CliDeps } from '../../src/cli.js';
import { parseCliArgs, runCli } from '../../src/cli.js';

const BOOLEAN_FLAGS = ['bail', 'json', 'all', 'changed', 'discover', 'digest', 'strict'] as const;
const LIST_FLAGS = ['only', 'skip', 'include'] as const;

/** A stderr sink that records what was written, for asserting on the message. */
function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** A config whose one custom check, `probe`, exits with `code`. */
const probeConfig = (code: number): string =>
  JSON.stringify({ checks: { probe: { command: process.execPath, args: ['-e', `process.exit(${code})`] } } });

describe('CLI run flags', () => {
  test('every promised boolean flag parses', () => {
    for (const flag of BOOLEAN_FLAGS) {
      expect(parseCliArgs([`--${flag}`]).flags[flag]).toBe(true);
    }
  });

  test('every promised list flag parses to a string array', () => {
    for (const flag of LIST_FLAGS) {
      expect(parseCliArgs([`--${flag}`, 'a,b']).flags[flag]).toEqual(['a', 'b']);
    }
  });

  test('the promised commands are recognized', () => {
    for (const command of ['run', 'init', 'doctor', 'fix', 'baseline', 'recover', 'agent-setup', 'gate', 'triage', 'qa']) {
      expect(parseCliArgs([command]).command).toBe(command);
    }
  });

  test('--concurrency <n> parses to a positive integer', () => {
    expect(parseCliArgs(['--concurrency', '3']).flags.concurrency).toBe(3);
    // Absent → left undefined so the orchestrator applies its auto default.
    expect(parseCliArgs([]).flags.concurrency).toBeUndefined();
  });

  test('--concurrency rejects a non-positive-integer value (usage error, exit 2 at the CLI)', () => {
    for (const bad of ['0', '-1', 'x', '2.5']) {
      expect(() => parseCliArgs(['--concurrency', bad])).toThrow();
    }
  });

  test('a list flag that names nothing is rejected at parse time', () => {
    for (const flag of LIST_FLAGS) {
      for (const empty of ['', ',', '  ', ' , ']) {
        expect(() => parseCliArgs([`--${flag}`, empty])).toThrow(`--${flag}`);
      }
    }
    // Absent is still `null` — the caller's default applies, not an error.
    expect(parseCliArgs([]).flags.only).toBeNull();
  });

  test('an unknown run flag is rejected (usage error, exit 2 at the CLI)', () => {
    expect(() => parseCliArgs(['--no-such-flag'])).toThrow();
  });
});

/**
 * Contract: `--config <path>` and `CHECKRIDE_CONFIG` name the config file that
 * run, `doctor`, `fix` and `baseline` read in place of
 * `<cwd>/checkride.config.json`, and the flag beats the variable. A named file
 * that is missing is a usage error (exit 2), never a silent fall back to the
 * repo's own config.
 */
describe('CLI config path (--config / CHECKRIDE_CONFIG)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-config-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const COMMANDS = [[], ['doctor'], ['fix'], ['baseline']] as const;

  function deps(stderr: CliDeps['stderr'], env: Record<string, string> = {}): CliDeps {
    return { cwd: dir, stdout: capture(), stderr, env };
  }

  test('--config <path> parses to its raw value', () => {
    expect(parseCliArgs(['--config', 'ci.json']).config).toBe('ci.json');
    expect(parseCliArgs([]).config).toBeUndefined();
  });

  for (const command of COMMANDS) {
    const label = command[0] ?? 'run';
    test(`${label}: a missing --config file exits 2, naming the flag`, async () => {
      const stderr = capture();
      expect(await runCli([...command, '--config', 'nope.json'], deps(stderr))).toBe(2);
      expect(stderr.text()).toContain('--config names a missing file');
    });

    test(`${label}: a missing CHECKRIDE_CONFIG file exits 2, naming the variable`, async () => {
      const stderr = capture();
      expect(await runCli([...command], deps(stderr, { CHECKRIDE_CONFIG: 'nope.json' }))).toBe(2);
      expect(stderr.text()).toContain('CHECKRIDE_CONFIG names a missing file');
    });
  }

  test('the named file replaces the repo’s config, and the flag beats the variable', async () => {
    await writeFile(join(dir, 'checkride.config.json'), probeConfig(1));
    await writeFile(join(dir, 'pass.json'), probeConfig(0));
    await writeFile(join(dir, 'fail.json'), probeConfig(1));
    expect(await runCli(['--only', 'probe', '--config', 'pass.json'], deps(capture()))).toBe(0);
    expect(await runCli(['--only', 'probe'], deps(capture(), { CHECKRIDE_CONFIG: 'pass.json' }))).toBe(0);
    expect(
      await runCli(['--only', 'probe', '--config', 'fail.json'], deps(capture(), { CHECKRIDE_CONFIG: 'pass.json' })),
    ).toBe(1);
  });
});

/** The summary a run wrote into the output directory `out`. */
async function summaryIn(out: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Contract: `--out <dir>` and `CHECKRIDE_OUT` move a run's artifacts (the
 * summary, the raw files and the digest) out of `<cwd>/.check`, and the flag
 * beats the variable. `baseline` takes the flag too and still writes
 * `checkride.baseline.json` at the repo root; `triage` and `qa` read from it;
 * `doctor` probes it. A flag passed with no directory is a usage error.
 */
describe('CLI output directory (--out / CHECKRIDE_OUT)', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-out-flag-'));
    outside = await mkdtemp(join(tmpdir(), 'checkride-out-flag-outside-'));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { probe: { command: process.execPath, args: ['-e', "console.log('probe ran'); process.exit(1)"] } },
    }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function deps(env: Record<string, string> = {}, stdout = capture()): CliDeps {
    return { cwd: dir, stdout, stderr: capture(), env };
  }

  test('--out <dir> parses to its raw value', () => {
    expect(parseCliArgs(['--out', 'artifacts']).out).toBe('artifacts');
    expect(parseCliArgs([]).out).toBeUndefined();
  });

  test('the summary, raw output and digest land in --out, which run.out records, and .check/ stays empty', async () => {
    const out = join(outside, 'a');
    expect(await runCli(['--only', 'probe', '--digest', '--out', out], deps())).toBe(1);
    for (const file of ['summary.json', 'probe.stdout.txt', 'digest.md']) expect(existsSync(join(out, file)), file).toBe(true);
    expect((await summaryIn(out))['run']).toEqual({ partial: true, only: ['probe'], out });
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('CHECKRIDE_OUT does the same, a relative path resolves against the working directory, and the flag beats it', async () => {
    expect(await runCli(['--only', 'probe'], deps({ CHECKRIDE_OUT: 'from-var' }))).toBe(1);
    expect((await summaryIn(join(dir, 'from-var')))['run']).toMatchObject({ out: join(dir, 'from-var') });
    expect(await runCli(['--only', 'probe', '--out', 'from-flag'], deps({ CHECKRIDE_OUT: 'from-var-2' }))).toBe(1);
    expect(existsSync(join(dir, 'from-flag', 'summary.json'))).toBe(true);
    expect(existsSync(join(dir, 'from-var-2'))).toBe(false);
  });

  test('--out with no directory is a usage error; an empty variable counts as unset', async () => {
    expect(await runCli(['--only', 'probe', '--out', ''], deps())).toBe(2);
    expect(await runCli(['--only', 'probe'], deps({ CHECKRIDE_OUT: '' }))).toBe(1);
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(true);
  });

  test('baseline --out writes its artifacts there and checkride.baseline.json at the repo root', async () => {
    expect(await runCli(['baseline', '--out', outside], deps())).toBe(0);
    expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(true);
    expect(existsSync(join(outside, 'summary.json'))).toBe(true);
    expect(existsSync(join(outside, 'checkride.baseline.json'))).toBe(false);
  });

  test('triage and qa take --out and name that directory; doctor takes it and probes it', async () => {
    expect(await runCli(['--only', 'probe', '--out', outside], deps())).toBe(1);
    const qa = capture();
    expect(await runCli(['qa', '--out', outside], deps({}, qa))).toBe(0);
    expect(qa.text()).toContain(`\`${outside}/summary.json\``);
    const triaged = capture();
    expect(await runCli(['triage', '--out', outside], deps({}, triaged))).toBe(0);
    expect(triaged.text()).toContain(`${outside}/`);
    const doctor = capture();
    await runCli(['doctor', '--json', '--out', outside], deps({}, doctor));
    const report = JSON.parse(doctor.text()) as { checks: { name: string; status: string }[] };
    expect(report.checks.find((c) => c.name === outside)).toMatchObject({ status: 'ok' });
  }, 30_000);
});

/** A custom check that exits with `code`, as a config entry. */
const exits = (code: number): unknown => ({ command: process.execPath, args: ['-e', `process.exit(${code})`] });

/**
 * Contract: `--defaults <path>` and `CHECKRIDE_DEFAULTS` name a defaults layer
 * that run and `doctor` read below detection (R13.1). It fills only a slot the
 * repo's config and detection leave empty, recorded as `origin: "defaults"`
 * and tagged `[defaults]`, and the summary records the file as `run.defaults`.
 * The flag beats the variable. A missing file, or one that declares
 * `targets`, is exit 2 naming the file, and a run with it never ratchets the
 * baseline.
 */
describe('CLI defaults layer (--defaults / CHECKRIDE_DEFAULTS)', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-defaults-flag-'));
    outside = await mkdtemp(join(tmpdir(), 'checkride-defaults-flag-outside-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function deps(stderr: CliDeps['stderr'] = capture(), env: Record<string, string> = {}, stdout = capture()): CliDeps {
    return { cwd: dir, stdout, stderr, env };
  }

  /** Write a defaults file outside the repo and return its path. */
  async function defaultsFile(name: string, body: unknown): Promise<string> {
    const path = join(outside, name);
    await writeFile(path, JSON.stringify(body));
    return path;
  }

  test('--defaults <path> parses to its raw value', () => {
    expect(parseCliArgs(['--defaults', 'agent.json']).defaults).toBe('agent.json');
    expect(parseCliArgs([]).defaults).toBeUndefined();
  });

  for (const command of [[], ['doctor']] as const) {
    const label = command[0] ?? 'run';
    test(`${label}: a missing --defaults file exits 2, naming the flag`, async () => {
      const stderr = capture();
      expect(await runCli([...command, '--defaults', 'nope.json'], deps(stderr))).toBe(2);
      expect(stderr.text()).toContain('--defaults names a missing file');
    });

    test(`${label}: a missing CHECKRIDE_DEFAULTS file exits 2, naming the variable`, async () => {
      const stderr = capture();
      expect(await runCli([...command], deps(stderr, { CHECKRIDE_DEFAULTS: 'nope.json' }))).toBe(2);
      expect(stderr.text()).toContain('CHECKRIDE_DEFAULTS names a missing file');
    });
  }

  test('the file fills a slot the repo leaves empty, marked defaults, and run.defaults records it', async () => {
    const path = await defaultsFile('defaults.json', { checks: { lint: exits(0) } });
    const stdout = capture();
    expect(await runCli(['--only', 'lint', '--defaults', path, '--json'], deps(capture(), {}, stdout))).toBe(0);
    const summary = JSON.parse(stdout.text()) as { run: Record<string, unknown>; checks: { name: string; origin?: string }[] };
    expect(summary.run).toEqual({ partial: true, only: ['lint'], defaults: path });
    expect(summary.checks.find((c) => c.name === 'lint')).toMatchObject({ origin: 'defaults', ok: true });
    const stderr = capture();
    await runCli(['--only', 'lint', '--defaults', path], deps(stderr));
    expect(stderr.text()).toMatch(/lint .*\[defaults\]/);
  });

  test('CHECKRIDE_DEFAULTS does the same, and the flag beats it', async () => {
    const pass = await defaultsFile('pass.json', { checks: { lint: exits(0) } });
    const fail = await defaultsFile('fail.json', { checks: { lint: exits(1) } });
    expect(await runCli(['--only', 'lint'], deps(capture(), { CHECKRIDE_DEFAULTS: fail }))).toBe(1);
    expect(await runCli(['--only', 'lint', '--defaults', pass], deps(capture(), { CHECKRIDE_DEFAULTS: fail }))).toBe(0);
  });

  test('the repo’s own entry beats the file, and keeps its own origin', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { lint: exits(0) } }));
    const path = await defaultsFile('defaults.json', { checks: { lint: exits(1) } });
    const stdout = capture();
    expect(await runCli(['--only', 'lint', '--defaults', path, '--json'], deps(capture(), {}, stdout))).toBe(0);
    expect((JSON.parse(stdout.text()) as { checks: { origin?: string }[] }).checks[0]?.origin).toBe('config');
  });

  test('a defaults file that declares targets exits 2, naming the file, before anything is written (F36)', async () => {
    const path = await defaultsFile('defaults.json', { targets: { app: { lang: 'ts', root: '.' } } });
    const stderr = capture();
    expect(await runCli(['--defaults', path], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain(`invalid ${path}: a defaults file can't declare targets`);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('a run with --defaults masks with the baseline but never prunes it, wherever the file sits', async () => {
    const report = JSON.stringify({ diagnostics: [{ filename: 'a.ts', code: 'no-x', message: 'bad', severity: 'error' }] });
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        lint: { name: 'oxlint', command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(report)}); process.exit(1)`], outputFile: 'lint.json' },
      },
    }));
    const baseline = `${JSON.stringify({ schema_version: 1, slots: { lint: ['a.ts:no-x:bad', 'b.ts:no-y:worse'] } }, null, 2)}\n`;
    await writeFile(join(dir, 'checkride.baseline.json'), baseline);
    await writeFile(join(dir, 'defaults.json'), '{}');
    const stderr = capture();
    expect(await runCli(['--defaults', 'defaults.json'], deps(stderr))).toBe(0);
    expect(stderr.text()).toContain('not ratcheted, because a run with --defaults never writes checkride.baseline.json');
    expect(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).toBe(baseline);
  });
});

/**
 * Contract: `--pins <mise.toml>` and `CHECKRIDE_PINS` name an override pin
 * file (R13.3). The summary records it as `run.pins`, the flag beats the
 * variable, a missing file or an entry with no version is exit 2 naming the
 * file, and `doctor` refuses the flag rather than ignore it.
 */
describe('CLI override pins (--pins / CHECKRIDE_PINS)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-pins-flag-'));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { probe: { command: process.execPath, args: ['-e', ''] } } }));
    await writeFile(join(dir, 'pins.toml'), '[tools]\nshellcheck = "0.11.0"\n');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deps = (stderr = capture(), env: Record<string, string> = {}, stdout = capture()): CliDeps => ({ cwd: dir, stdout, stderr, env });

  test('--pins <mise.toml> parses to its raw value', () => {
    expect(parseCliArgs(['--pins', 'agent.toml']).pins).toBe('agent.toml');
    expect(parseCliArgs([]).pins).toBeUndefined();
  });

  test('run.pins records the file, from the flag or the variable', async () => {
    const stdout = capture();
    expect(await runCli(['--only', 'probe', '--pins', 'pins.toml', '--json'], deps(capture(), {}, stdout))).toBe(0);
    expect((JSON.parse(stdout.text()) as { run: unknown }).run).toEqual({ partial: true, only: ['probe'], pins: join(dir, 'pins.toml') });
    const fromVar = capture();
    expect(await runCli(['--only', 'probe', '--json'], deps(capture(), { CHECKRIDE_PINS: 'pins.toml' }, fromVar))).toBe(0);
    expect((JSON.parse(fromVar.text()) as { run: { pins?: string } }).run.pins).toBe(join(dir, 'pins.toml'));
  });

  test('a missing file, or an entry with no version, exits 2 naming the file, and the flag beats the variable', async () => {
    const missing = capture();
    expect(await runCli(['--pins', 'nope.toml'], deps(missing))).toBe(2);
    expect(missing.text()).toContain('--pins names a missing file');
    const variable = capture();
    expect(await runCli([], deps(variable, { CHECKRIDE_PINS: 'nope.toml' }))).toBe(2);
    expect(variable.text()).toContain('CHECKRIDE_PINS names a missing file');
    await writeFile(join(dir, 'bad.toml'), '[tools]\nshellcheck = 11\n');
    const bad = capture();
    expect(await runCli(['--pins', 'bad.toml'], deps(bad))).toBe(2);
    expect(bad.text()).toContain(`invalid ${join(dir, 'bad.toml')}: [tools] shellcheck must be a version string`);
    expect(await runCli(['--only', 'probe', '--pins', 'pins.toml'], deps(capture(), { CHECKRIDE_PINS: 'bad.toml' }))).toBe(0);
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(true);
  });

  test('doctor refuses --pins rather than probe copies the run wouldn’t use', async () => {
    const stderr = capture();
    expect(await runCli(['doctor', '--pins', 'pins.toml'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("--pins applies to a run; doctor doesn't read it yet");
  });
});

/**
 * Contract: `--discover` checks the targets the repo's files propose, applied
 * in memory (R13.2). The summary marks each `discovered: true` and records
 * `run.discover`; nothing is written; a config that declares `targets` is exit
 * 2 (F37); and a top-level slot entry no root target can take is dropped with
 * a note on stderr.
 */
describe('CLI run-time discovery (--discover)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-discover-flag-'));
    for (const path of ['web/package.json', 'scripts/deploy.sh']) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), path.endsWith('.sh') ? '#!/bin/sh\n' : '{}');
    }
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const config = { checks: { lint: false, probe: { command: process.execPath, args: ['-e', ''] } } };

  test('the proposed targets run as declared, marked discovered, and nothing is written', async () => {
    const text = `${JSON.stringify(config)}\n`;
    await writeFile(join(dir, 'checkride.config.json'), text);
    const stdout = capture();
    const stderr = capture();
    expect(await runCli(['--discover', '--json'], { cwd: dir, stdout, stderr, env: {} })).toBe(0);
    const summary = JSON.parse(stdout.text()) as { run: Record<string, unknown>; targets: unknown[]; checks: { name: string }[] };
    expect(summary.run).toEqual({ partial: false, discover: true });
    expect(summary.targets).toEqual([
      { name: 'web', pack: 'ts', root: 'web', discovered: true },
      { name: 'scripts', pack: 'bash', root: 'scripts', discovered: true },
    ]);
    expect(summary.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['web:lint', 'scripts:lint', 'probe']));
    expect(stderr.text()).toContain('--discover: dropped checks.lint');
    expect(await readFile(join(dir, 'checkride.config.json'), 'utf8')).toBe(text);
    expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(false);
  });

  // F37
  test('a config that declares targets exits 2 before anything is written', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { web: { lang: 'ts', root: 'web' } } }));
    const stderr = capture();
    expect(await runCli(['--discover'], { cwd: dir, stdout: capture(), stderr, env: {} })).toBe(2);
    expect(stderr.text()).toContain('--discover runs only where the config declares no targets');
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('doctor --discover reports the discovered mode', async () => {
    const stdout = capture();
    await runCli(['doctor', '--discover', '--json'], { cwd: dir, stdout, stderr: capture(), env: {} });
    const report = JSON.parse(stdout.text()) as { mode: string; targets: { name: string }[] };
    expect(report.mode).toBe('multi-target');
    expect(report.targets.map((t) => t.name)).toEqual(['web', 'scripts']);
  }, 30_000);
});

/**
 * A custom check that passes only when its one `changedArgs` argument, `{base}`
 * expanded, is the ref it expects.
 */
const baseProbe = (expected: string): unknown => ({
  command: process.execPath,
  args: ['-e', `process.exit(process.argv[1] === ${JSON.stringify(expected)} ? 0 : 1)`],
  changedArgs: ['{base}'],
});

/**
 * Contract: `--changed` measures from one base ref (docs/contract.md §CLI).
 * `--base <ref>` names it, then `CHECKRIDE_BASE`, then config `changedBase`,
 * then `origin/main` when it resolves, then `HEAD`, and `{base}` in a check's
 * `changedArgs` expands to it. A named base that doesn't resolve is exit 2; a
 * defaulted `origin/main` that doesn't falls back to `HEAD` with a warning (F26).
 */
describe('CLI changed base (--base / CHECKRIDE_BASE)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-base-flag-'));
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=contract', '-c', 'user.email=contract@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' });
    };
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { develop: baseProbe('develop'), head: baseProbe('HEAD'), configured: baseProbe('configured') },
    }));
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'contract');
    git('branch', 'develop');
    git('branch', 'configured');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr'], env: Record<string, string> = {}): CliDeps {
    return { cwd: dir, stdout: capture(), stderr, env };
  }

  test('--base <ref> parses to its raw value', () => {
    expect(parseCliArgs(['--changed', '--base', 'origin/develop']).base).toBe('origin/develop');
    expect(parseCliArgs([]).base).toBeUndefined();
  });

  test('{base} expands to the named base, and the flag beats the variable', async () => {
    expect(await runCli(['--changed', '--only', 'develop', '--base', 'develop'], deps(capture()))).toBe(0);
    expect(await runCli(['--changed', '--only', 'develop'], deps(capture(), { CHECKRIDE_BASE: 'develop' }))).toBe(0);
    expect(await runCli(['--changed', '--only', 'develop', '--base', 'develop'], deps(capture(), { CHECKRIDE_BASE: 'nope' }))).toBe(0);
  });

  test('the config’s changedBase applies when neither the flag nor the variable names one', async () => {
    const config = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ ...config, changedBase: 'configured' }));
    expect(await runCli(['--changed', '--only', 'configured'], deps(capture()))).toBe(0);
    expect(await runCli(['--changed', '--only', 'develop'], deps(capture(), { CHECKRIDE_BASE: 'develop' }))).toBe(0);
  });

  test('a named base that doesn’t resolve exits 2, naming what named it (F26)', async () => {
    const flag = capture();
    expect(await runCli(['--changed', '--base', 'nope'], deps(flag))).toBe(2);
    expect(flag.text()).toContain("--base 'nope' doesn't name a commit");
    const variable = capture();
    expect(await runCli(['--changed'], deps(variable, { CHECKRIDE_BASE: 'nope' }))).toBe(2);
    expect(variable.text()).toContain("CHECKRIDE_BASE 'nope' doesn't name a commit");
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('--base with no ref is a usage error', async () => {
    expect(await runCli(['--changed', '--base', ''], deps(capture()))).toBe(2);
  });

  test('with nothing named and no origin/main, the base falls back to HEAD with a warning (F26)', async () => {
    const stderr = capture();
    expect(await runCli(['--changed', '--only', 'head'], deps(stderr))).toBe(0);
    expect(stderr.text()).toContain("--changed: origin/main doesn't resolve, so changes are measured from HEAD");
  });

  test('with nothing named and a resolvable origin/main, the base is origin/main, as in 0.13', async () => {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir, stdio: 'ignore' });
    const config = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, unknown> };
    config.checks['origin'] = baseProbe('origin/main');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(config));
    const stderr = capture();
    expect(await runCli(['--changed', '--only', 'origin'], deps(stderr))).toBe(0);
    expect(stderr.text()).not.toContain('measured from HEAD');
  });
});

/**
 * Contract: an unknown slot name in `--only`/`--skip`/`--include` is a usage
 * error (exit 2), never a silent no-op. A typo that disables the gate is the
 * worst vacuous green in a definition-of-done check. The error names the bad
 * slot and the valid set (catalogue slots + config custom-check names).
 */
describe('CLI slot-selection validation', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-flags-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  for (const flag of LIST_FLAGS) {
    test(`an unknown slot in --${flag} exits 2, naming it and the valid set`, async () => {
      const stderr = capture();
      expect(await runCli([`--${flag}`, 'lints'], deps(stderr))).toBe(2);
      expect(stderr.text()).toContain("'lints'"); // the unknown slot
      expect(stderr.text()).toContain('types'); // and the valid set
    });
  }

  test('a valid slot name is accepted (not rejected as unknown)', async () => {
    // No adapter is detected here, so `lint` sits out and the run is a warned
    // vacuous green (exit 0) — the point is the name is not a usage error.
    expect(await runCli(['--only', 'lint'], deps(capture()))).toBe(0);
  });

  test('the valid set includes config custom-check names', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { licenses: { command: 'node', args: ['-e', ''] } },
    }));
    const stderr = capture();
    expect(await runCli(['--only', 'nope'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('licenses');
  });

  /**
   * A list flag that names nothing is the same class of mistake as a typo, and
   * `--only` is the dangerous one: it used to parse to `[]`, which is truthy,
   * so every check was filtered out and the run exited 0 having verified
   * nothing. The two empty spellings also disagreed — `--only ''` ran the whole
   * pipeline, `--only ,` ran none of it. Both are exit 2 now.
   */
  for (const flag of LIST_FLAGS) {
    for (const empty of ['', ',', '  ', ' , ']) {
      test(`--${flag} ${JSON.stringify(empty)} names nothing and exits 2`, async () => {
        const stderr = capture();
        expect(await runCli([`--${flag}`, empty], deps(stderr))).toBe(2);
        expect(stderr.text()).toContain(`--${flag}`);
      });
    }
  }

  test('an empty selection is rejected before any .check/ side effect', async () => {
    expect(await runCli(['--only', ','], deps(capture()))).toBe(2);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });
});

/**
 * Contract: `init`/`agent-setup` take `--hook <a,b>` to select which agent
 * hooks to write (default: all), `--no-hook` as the write-none escape, and
 * `--remove-hook <a,b>` to tear installed ones back out. An unknown hook name is
 * a usage error (exit 2) naming the valid set, for either selecting flag.
 */
describe('CLI hook selection (--hook / --no-hook / --remove-hook)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hook-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  test('--hook gate is accepted on agent-setup and init', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(await runCli(['init', '--hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
  });

  test('an unknown hook name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--hook', 'bogus', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'bogus'");
    expect(stderr.text()).toContain('gate');
  });

  test('--no-hook still parses (the escape hatch is unchanged)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--no-hook', '--dry-run'], deps(capture()))).toBe(0);
  });

  test('--remove-hook is accepted on agent-setup and init, alone and with --no-hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--remove-hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(await runCli(['init', '--remove-hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(
      await runCli(['agent-setup', '--no-hook', '--remove-hook', 'gate', '--dry-run'], deps(capture())),
    ).toBe(0);
  });

  test('an unknown --remove-hook name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--remove-hook', 'bogus', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'bogus'");
    expect(stderr.text()).toContain('gate');
  });

  /** Writing and removing the same hook has no coherent reading; say so rather than pick one. */
  test('naming one hook in both flags is a usage error', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(
      await runCli(['agent-setup', '--hook', 'gate', '--remove-hook', 'gate', '--dry-run'], deps(stderr)),
    ).toBe(2);
    expect(stderr.text()).toContain('--remove-hook');
  });
});

/**
 * Contract: `init`/`agent-setup` take `--harness <a,b>` to select which agent
 * harnesses to write hooks for (default: claude, plus any the repo shows
 * evidence of). An unknown name is a usage error (exit 2) naming the valid set,
 * the same rule `--hook` follows.
 */
describe('CLI harness selection (--harness)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-harness-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  test('every promised harness is accepted, alone and together', async () => {
    // Each case gets its own repo: `init` probes by running the checks, so two
    // sharing a cwd would race in `.check/`.
    const cases = ['claude', 'cursor', 'claude,cursor'].flatMap((value) =>
      ['agent-setup', 'init'].map((command) => [command, '--harness', value, '--dry-run']),
    );
    const codes = await Promise.all(
      cases.map(async (argv) => {
        const cwd = await mkdtemp(join(tmpdir(), 'checkride-harness-case-'));
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'x' }));
        try {
          return await runCli(argv, { cwd, stdout: { write: () => true }, stderr: capture() });
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }),
    );
    expect(codes).toEqual(cases.map(() => 0));
  }, 30000);

  test('an unknown harness name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--harness', 'windsurf', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'windsurf'");
    expect(stderr.text()).toContain('claude');
    expect(stderr.text()).toContain('cursor');
  });

  test('gate answers one harness at a time; a list is a usage error', async () => {
    expect(await runCli(['gate', '--harness', 'claude,cursor'], deps(capture()))).toBe(2);
  });
});

/**
 * Contract: checkride owns the AGENTS.md stanza and only the stanza
 * (docs/contract.md §CLI). A stanza edited since checkride wrote it stops the
 * run — exit 2, nothing written — instead of being silently overwritten;
 * `--force` overrides, on both `init` and `agent-setup`.
 */
describe('AGENTS.md stanza ownership (--force)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-stanza-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  /** Wire the repo, then customize inside the markers the way a consumer would. */
  async function customizeStanza(): Promise<string> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    await runCli(['agent-setup', '--no-hook'], deps(capture()));
    const custom = (await readFile(join(dir, 'AGENTS.md'), 'utf8')).replace(
      '### Baseline',
      '### This repo\n\nThe generated migrations are exempt.\n\n### Baseline',
    );
    await writeFile(join(dir, 'AGENTS.md'), custom);
    return custom;
  }

  test('an edited stanza stops agent-setup: exit 2, file intact, hooks unwritten', async () => {
    const custom = await customizeStanza();
    const stderr = capture();
    expect(await runCli(['agent-setup'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('--force');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(custom);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  test('--force refreshes it, on agent-setup and on init', async () => {
    const custom = await customizeStanza();
    expect(await runCli(['agent-setup', '--no-hook', '--force'], deps(capture()))).toBe(0);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).not.toBe(custom);
    expect(await runCli(['init', '--no-hook', '--force'], deps(capture()))).toBe(0);
  }, 30000);

  test('an untouched stanza refreshes without --force', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--no-hook'], deps(capture()))).toBe(0);
    expect(await runCli(['agent-setup', '--no-hook'], deps(capture()))).toBe(0);
  });

  /**
   * Contract: `hooks` manages hooks and touches nothing else (docs/contract.md
   * §CLI). The stanza guard above is exactly what it must not inherit — an
   * edited AGENTS.md is not a reason a repo cannot remove a hook.
   */
  test('`hooks` works on a repo whose stanza would stop agent-setup', async () => {
    const custom = await customizeStanza();
    expect(await runCli(['hooks', 'add', 'gate'], deps(capture()))).toBe(0);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
    expect(await runCli(['hooks', 'remove', 'gate'], deps(capture()))).toBe(0);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
    // Untouched throughout — the whole point of the separate command.
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(custom);
  });

  test('`hooks remove` requires an explicit list, and `hooks` rejects a bad action', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['hooks', 'add'], deps(capture()))).toBe(0);
    const stderr = capture();
    expect(await runCli(['hooks', 'remove'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('name the hooks to remove');
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
    expect(await runCli(['hooks', 'sideways'], deps(capture()))).toBe(2);
  });
});

/**
 * Contract: `recover` and its flags (docs/contract.md §CLI). List mode is a
 * reader; apply writes the baseline as a working-tree edit and never mutates
 * git state. Exit codes are 0 and 2 only — environment failures (no git, not a
 * repository) are 2 with a `recover:`-prefixed message, never a parse
 * rejection, and nothing here is ever a check failure (1).
 */
describe('CLI recover flags', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-contract-recover-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const deps = (stderr: { write: (t: string) => boolean }): CliDeps => ({ cwd: dir, stdout: capture(), stderr });

  test('every promised flag parses (a rejection would print the usage pointer)', async () => {
    for (const argv of [
      ['recover', '--json'],
      ['recover', '--depth', '5'],
      ['recover', '--pick', 'union', '--dry-run'],
      ['recover', '--pick', 'abcd1234', '--exact', '--dry-run'],
    ]) {
      const stderr = capture();
      // A bare temp dir: the run fails on environment (exit 2), not parsing.
      // oxlint-disable-next-line no-await-in-loop -- shared cwd; sequential keeps the per-argv assertion messages attributable.
      expect(await runCli(argv, deps(stderr)), argv.join(' ')).toBe(2);
      expect(stderr.text(), argv.join(' ')).not.toContain('Run `checkride --help`');
    }
  });

  test('usage errors are exit 2', async () => {
    for (const argv of [
      ['recover', '--garbage'],
      ['recover', 'stray-positional'],
      ['recover', '--depth', '0'],
      ['recover', '--depth', 'x'],
      ['recover', '--exact'],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- shared cwd; sequential keeps the per-argv assertion messages attributable.
      expect(await runCli(argv, deps(capture())), argv.join(' ')).toBe(2);
    }
  });
});
