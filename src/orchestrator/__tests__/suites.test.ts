import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../../adapters.js';
import type { Adapter } from '../../adapters.js';
import { runBaseline } from '../../baseline-command.js';
import type { Baseline } from '../../baseline/index.js';
import type { CheckrideConfig } from '../../config.js';
import { resolveChecks } from '../../config.js';
import { suiteNamed } from '../../suite.js';
import type { CheckRunner, Out, RunOptions } from '../index.js';
import { runChecks } from '../index.js';

function sink(): { out: Out; lines: string[] } {
  const lines: string[] = [];
  return { lines, out: { write: (text: string) => { lines.push(text); return true; } } };
}

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

type Finding = [string, string, string];

/** An oxlint `--format=json` payload from `[file, code, message]` triples. */
function oxlint(findings: Finding[]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })) });
}

/** A lint runner emitting the given findings; it fails when any are present. */
function lintRunner(findings: Finding[]): CheckRunner {
  return () => Promise.resolve({ ok: findings.length === 0, exit_code: findings.length === 0 ? 0 : 1, stdout: oxlint(findings), stderr: '' });
}

const A: Finding = ['a.ts', 'no-x', 'bad'];
const B: Finding = ['b.ts', 'no-y', 'worse'];
const KEY_A = 'a.ts:no-x:bad';
const KEY_B = 'b.ts:no-y:worse';

const EVALS = suiteNamed('evals');

/** A lint run of finding A under a newer copy of the tool than a baseline recorded. */
const moved: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout: oxlint([A]), stderr: '', pin_source: 'mise', tool_version: '2.14.0' });
const DEFAULT_FILE = 'checkride.baseline.json';

describe('resolveChecks for a named suite (declaredOnly)', () => {
  // Every detect file exists, so detection fills every slot it can.
  const everywhere = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => true };

  test('the default suite fills its slots by detection, and a named suite fills none', () => {
    const detected = resolveChecks({ ...everywhere, config: null }).filter((c) => c.adapter !== null);
    expect(detected.length).toBeGreaterThan(1);
    expect(resolveChecks({ ...everywhere, config: {}, suite: EVALS })).toEqual([]);
  });

  test('a named suite runs exactly the checks its config declares, with no built-in joining', () => {
    const config: CheckrideConfig = {
      checks: {
        lint: 'oxlint',
        evals: { command: 'node', args: ['evals.mjs'] },
        links: { use: 'links' },
        spell: false,
      },
    };
    const resolved = resolveChecks({ ...everywhere, config, suite: EVALS });
    expect(resolved.map((c) => c.slot).toSorted()).toEqual(['evals', 'links', 'lint']);
    expect(resolved.map((c) => `${c.slot}: ${c.origin}`).toSorted()).toEqual(['evals: custom', 'links: config', 'lint: config']);
    // The same config as the default suite's still detects the rest.
    expect(resolveChecks({ ...everywhere, config }).length).toBeGreaterThan(resolved.length);
  });

  test('order, timeout and optIn ride on a declared check as they do in the default suite', () => {
    const config: CheckrideConfig = {
      checks: {
        lint: { use: 'oxlint', timeout: 7, order: 'last' },
        evals: { command: 'node', order: 'first' },
        format: { use: 'prettier', optIn: true },
      },
    };
    const resolved = resolveChecks({ ...everywhere, config, suite: EVALS });
    expect(resolved.map((c) => c.slot)).toEqual(['evals', 'format', 'lint']);
    expect(resolved.find((c) => c.slot === 'lint')?.adapter?.timeout).toBe(7);
    expect(resolved.find((c) => c.slot === 'format')?.optIn).toBe(true);
  });

  test('a declared adapter the registry lacks stays as a skipped row, so the mistake shows', () => {
    const resolved = resolveChecks({ ...everywhere, config: { checks: { lint: 'no-such-linter' } }, suite: EVALS });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ slot: 'lint', adapter: null, skip: "configured adapter 'no-such-linter' is not in the registry" });
  });

  test('an entry that tunes a slot and names no tool is a config error, whatever detection would find', () => {
    const tuned: CheckrideConfig = { checks: { lint: { timeout: 5 } } };
    const message = 'invalid checkride.config.json: checks.lint names no tool: a suite runs exactly the checks its config declares';
    // A machine that would detect a linter, and one that would detect none, give the same answer.
    expect(() => resolveChecks({ ...everywhere, config: tuned, suite: EVALS })).toThrow(message);
    expect(() => resolveChecks({ slots: SLOTS, adapters: ADAPTERS, fileExists: () => false, config: tuned, suite: EVALS })).toThrow(message);
    // In the default suite the same entry tunes the detected tool, or sits out where there is none.
    expect(resolveChecks({ ...everywhere, config: tuned }).find((c) => c.slot === 'lint')?.adapter?.timeout).toBe(5);
    expect(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, fileExists: () => false, config: tuned }).find((c) => c.slot === 'lint')?.adapter).toBeNull();
  });

  test('tuning beside a tool another layer names is no error: the layers decide the check together', () => {
    const config: CheckrideConfig = {
      targets: { web: { lang: 'ts', root: 'web', checks: { lint: 'oxlint' } } },
      checks: { lint: { timeout: 9 } },
    };
    const resolved = resolveChecks({ ...everywhere, config, suite: EVALS });
    expect(resolved.map((c) => `${c.target}:${c.slot}`)).toEqual(['web:lint']);
    expect(resolved[0]?.adapter?.timeout).toBe(9);
  });

  test('a target left with tuning alone is the same config error', () => {
    const config: CheckrideConfig = {
      targets: { web: { lang: 'ts', root: 'web', checks: { lint: 'oxlint' } }, api: { lang: 'ts', root: 'api' } },
      checks: { lint: { timeout: 9 } },
    };
    expect(() => resolveChecks({ ...everywhere, config, suite: EVALS })).toThrow('checks.lint names no tool');
  });

  test('targets keep working: each target runs the checks its blocks declare, and unclaimed never joins', () => {
    const config: CheckrideConfig = {
      targets: { web: { lang: 'ts', root: 'web', checks: { lint: 'oxlint' } }, api: { lang: 'ts', root: 'api' } },
      checks: { evals: { command: 'node' } },
    };
    const resolved = resolveChecks({ ...everywhere, config, suite: EVALS });
    expect(resolved.map((c) => (c.target === undefined ? c.slot : `${c.target}:${c.slot}`)).toSorted()).toEqual(['evals', 'web:lint']);
  });
});

describe('runChecks for a named suite', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-suites-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];
  const config: CheckrideConfig = { checks: { lint: 'oxlint' } };

  const run = (over: Partial<RunOptions>, stderr = sink().out) =>
    runChecks({ cwd: dir, slots, adapters, config, json: false, stdout: sink().out, stderr, ...over });
  const write = (file: string, keys: string[]): Promise<void> =>
    writeFile(join(dir, file), `${JSON.stringify({ schema_version: 1, slots: { lint: keys } })}\n`);
  const keys = async (file: string): Promise<string[] | undefined> =>
    (JSON.parse(await readFile(join(dir, file), 'utf8')) as Baseline).slots['lint'];

  test('the summary names the suite, and a run of the default suite carries no such field', async () => {
    const suite = await run({ suite: EVALS, runner: lintRunner([]) });
    expect(suite.summary.suite).toBe('evals');
    const written = JSON.parse(await readFile(join(dir, '.check', 'suites', 'evals', 'summary.json'), 'utf8')) as Record<string, unknown>;
    expect(written['suite']).toBe('evals');
    // After total_duration_ms and before run, where the head of the file says what the run was.
    expect(Object.keys(written).slice(0, 7)).toEqual(['schema_version', 'timestamp', 'ok', 'checks_run', 'total_duration_ms', 'suite', 'run']);

    const whole = await run({ runner: lintRunner([]) });
    expect(Object.keys(whole.summary)).not.toContain('suite');
    expect(Object.keys(JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as object)).toEqual(
      ['schema_version', 'timestamp', 'ok', 'checks_run', 'total_duration_ms', 'run', 'checks'],
    );
  });

  test('writes under .check/suites/<name>/, names that directory in its report, and expands {out} to it', async () => {
    const std = sink();
    let outArg: string | undefined;
    const runner: CheckRunner = (_r, ctx) => { outArg = ctx.out; return lintRunner([])(_r, ctx); };
    await run({ suite: EVALS, runner }, std.out);
    expect(existsSync(join(dir, '.check', 'suites', 'evals', 'lint.json'))).toBe(true);
    expect(existsSync(join(dir, '.check', 'lint.json'))).toBe(false);
    expect(std.lines.join('')).toContain('\nRunning 1 check(s) of suite evals...\n');
    expect(std.lines.join('')).toContain('report: .check/suites/evals/summary.json');
    expect(outArg).toBe('.check/suites/evals');
  });

  test("a red check's excerpt points into the suite's own output directory", async () => {
    const std = sink();
    await run({ suite: EVALS, runner: lintRunner([A]) }, std.out);
    expect(std.lines.join('')).toContain('           a.ts  bad  [no-x]\n           full output: .check/suites/evals/lint.json\n');
  });

  test('masks with its own baseline, never the default suite’s', async () => {
    await write(DEFAULT_FILE, [KEY_A]);
    // The default suite grandfathers A; the suite has no baseline, so A is new there.
    expect((await run({ runner: lintRunner([A]) })).ok).toBe(true);
    expect((await run({ suite: EVALS, runner: lintRunner([A]) })).ok).toBe(false);
    await write(EVALS.baselineFile, [KEY_B]);
    expect((await run({ suite: EVALS, runner: lintRunner([B]) })).ok).toBe(true);
    expect((await run({ runner: lintRunner([B]) })).ok).toBe(false);
  });

  test('a full suite run ratchets its own file and leaves the default suite’s byte for byte', async () => {
    await write(DEFAULT_FILE, [KEY_A, KEY_B]);
    await write(EVALS.baselineFile, [KEY_A, KEY_B]);
    const before = await readFile(join(dir, DEFAULT_FILE), 'utf8');
    const std = sink();
    await run({ suite: EVALS, runner: lintRunner([A]) }, std.out);
    expect(await keys(EVALS.baselineFile)).toEqual([KEY_A]);
    expect(await readFile(join(dir, DEFAULT_FILE), 'utf8')).toBe(before);
    expect(std.lines.join('')).toContain('baseline: ratcheted checkride.evals.baseline.json to 1 grandfathered finding(s)');
  });

  test('a full run of the default suite ratchets its own file and leaves the suite’s byte for byte', async () => {
    await write(DEFAULT_FILE, [KEY_A, KEY_B]);
    await write(EVALS.baselineFile, [KEY_A, KEY_B]);
    const before = await readFile(join(dir, EVALS.baselineFile), 'utf8');
    const std = sink();
    await run({ runner: lintRunner([A]) }, std.out);
    expect(await keys(DEFAULT_FILE)).toEqual([KEY_A]);
    expect(await readFile(join(dir, EVALS.baselineFile), 'utf8')).toBe(before);
    expect(std.lines.join('')).toContain('baseline: ratcheted checkride.baseline.json to 1 grandfathered finding(s)');
  });

  test('a partial suite run never ratchets, under the rules of the default suite', async () => {
    await write(EVALS.baselineFile, [KEY_A, KEY_B]);
    const std = sink();
    await run({ suite: EVALS, only: ['lint'], runner: lintRunner([A]) }, std.out);
    expect(await keys(EVALS.baselineFile)).toEqual([KEY_A, KEY_B]);
    expect(std.lines.join('')).toContain('not ratcheted, because a run with --only sees only part of the pipeline');
  });

  test('--out wins for the directory, and one inside the repo still ratchets the suite’s file', async () => {
    await write(EVALS.baselineFile, [KEY_A, KEY_B]);
    await run({ suite: EVALS, out: join(dir, 'build', 'evals'), runner: lintRunner([A]) });
    expect(existsSync(join(dir, 'build', 'evals', 'summary.json'))).toBe(true);
    expect(existsSync(join(dir, '.check'))).toBe(false);
    expect(await keys(EVALS.baselineFile)).toEqual([KEY_A]);
  });

  test('an --out outside the repo makes a suite run a consumer run, which never ratchets', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-suites-out-'));
    try {
      await write(EVALS.baselineFile, [KEY_A, KEY_B]);
      const std = sink();
      await run({ suite: EVALS, out: outside, runner: lintRunner([A]) }, std.out);
      expect(await keys(EVALS.baselineFile)).toEqual([KEY_A, KEY_B]);
      expect(std.lines.join('')).toContain('not ratcheted, because a run with --out outside the repo never writes checkride.evals.baseline.json');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('an unparseable suite baseline is named by its own file, with the suite’s recover command', async () => {
    await writeFile(join(dir, EVALS.baselineFile), '<<<<<<< HEAD\n');
    const std = sink();
    await run({ suite: EVALS, runner: lintRunner([A]) }, std.out);
    expect(std.lines.join('')).toContain('baseline: checkride.evals.baseline.json is present but unparseable');
    expect(std.lines.join('')).toContain('See `checkride recover --suite evals`.');
  });

  test('a drift notice names the suite’s own baseline --versions', async () => {
    await writeFile(join(dir, EVALS.baselineFile), JSON.stringify({ schema_version: 1, slots: { lint: [KEY_A, KEY_B] }, captured_with: { lint: { pin_source: 'mise', tool_version: '2.11.4' } } }));
    const named = sink();
    await run({ suite: EVALS, runner: moved }, named.out);
    expect(named.lines.join('')).toContain('record it with `checkride baseline --versions --suite evals`, which adds no key.');

    await writeFile(join(dir, DEFAULT_FILE), JSON.stringify({ schema_version: 1, slots: { lint: [KEY_A, KEY_B] }, captured_with: { lint: { pin_source: 'mise', tool_version: '2.11.4' } } }));
    const whole = sink();
    await run({ runner: moved }, whole.out);
    expect(whole.lines.join('')).toContain('record it with `checkride baseline --versions`, which adds no key.');
  });

  test('with no config given, a suite’s run loads its own config file, and a config error names it by its short name', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { lint: false } }));
    await writeFile(join(dir, EVALS.configFile), JSON.stringify({ checks: { lint: 'oxlint' } }));
    const result = await runChecks({ cwd: dir, slots, adapters, suite: EVALS, runner: lintRunner([]), json: true, stdout: sink().out, stderr: sink().out });
    expect(result.summary.checks.map((c) => [c.name, c.skipped === true])).toEqual([['lint', false]]);

    await writeFile(join(dir, EVALS.configFile), JSON.stringify({ checks: { lint: { timeout: 5 } } }));
    await expect(runChecks({ cwd: dir, slots, adapters, suite: EVALS, runner: lintRunner([]), json: true, stdout: sink().out, stderr: sink().out })).rejects.toThrow(
      /^invalid checkride\.evals\.config\.json: checks\.lint names no tool/,
    );
  });

  test('a built-in is handed its suite’s own scratch directory, the default suite’s included', async () => {
    const seen: (string | undefined)[] = [];
    const runner: CheckRunner = (_r, ctx) => { seen.push(ctx.scratch); return lintRunner([])(_r, ctx); };
    await run({ suite: EVALS, runner });
    await run({ runner });
    expect(seen).toEqual(['.check/suites/evals', '.check']);
  });

  test('a capture writes the suite’s file and reads no other', async () => {
    await write(DEFAULT_FILE, [KEY_B]);
    const before = await readFile(join(dir, DEFAULT_FILE), 'utf8');
    const std = sink();
    await runBaseline({ cwd: dir, slots, adapters, config, suite: EVALS, runner: lintRunner([A]), stdout: sink().out, stderr: std.out });
    expect(await keys(EVALS.baselineFile)).toEqual([KEY_A]);
    expect(await readFile(join(dir, DEFAULT_FILE), 'utf8')).toBe(before);
    expect(std.lines.join('')).toContain('baseline: wrote checkride.evals.baseline.json — 1 finding(s) across lint');
    expect(existsSync(join(dir, '.check', 'suites', 'evals', 'summary.json'))).toBe(true);
  });

  test('a narrowed capture keeps the other checks of the suite’s own file', async () => {
    await writeFile(join(dir, EVALS.baselineFile), JSON.stringify({ schema_version: 1, slots: { lint: [KEY_B], spell: ['kept'] } }));
    await runBaseline({ cwd: dir, slots, adapters, config, suite: EVALS, only: ['lint'], runner: lintRunner([A]), stdout: sink().out, stderr: sink().out });
    const written = JSON.parse(await readFile(join(dir, EVALS.baselineFile), 'utf8')) as Baseline;
    expect(written.slots).toEqual({ lint: [KEY_A], spell: ['kept'] });
    expect(existsSync(join(dir, DEFAULT_FILE))).toBe(false);
  });
});

/** Every file under `root`, relative to it, with its contents. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const entries = await Promise.all(
    files.filter((f) => f.isFile()).map(async (f) => [join(f.parentPath, f.name).slice(root.length + 1), await readFile(join(f.parentPath, f.name), 'utf8')] as const),
  );
  return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
}

/** A config declaring a ts target of each name, rooted at a directory of that name, each with its own lint. */
function targetsConfig(names: string[]): CheckrideConfig {
  return { targets: Object.fromEntries(names.map((name) => [name, { lang: 'ts' as const, root: name, checks: { lint: 'oxlint' } }])) };
}

describe('the default suite and .check/suites/', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-suites-dir-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const slots = [{ name: 'lint' }];
  const adapters = [fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' })];
  const quiet = { json: true, stdout: sink().out, stderr: sink().out };

  test('a default run leaves every suite’s output as it was', async () => {
    await runChecks({ cwd: dir, slots, adapters, config: { checks: { lint: 'oxlint' } }, suite: EVALS, runner: lintRunner([A]), ...quiet });
    const suites = join(dir, '.check', 'suites');
    const before = await snapshot(suites);
    expect(Object.keys(before)).toEqual(['evals/lint.json', 'evals/summary.json']);

    await runChecks({ cwd: dir, slots, adapters, config: null, runner: lintRunner([B]), ...quiet });
    await runChecks({ cwd: dir, slots, adapters, config: null, runner: lintRunner([]), ...quiet });
    expect(await snapshot(suites)).toEqual(before);
  });

  test('a default run that drops a target clears that target’s directory and never the suites’', async () => {
    for (const name of ['web', 'api']) await mkdir(join(dir, name), { recursive: true });
    const ts = { slots: SLOTS, adapters: ADAPTERS, only: ['lint'] };
    await runChecks({ cwd: dir, ...ts, config: targetsConfig(['web', 'api']), runner: lintRunner([A]), ...quiet });
    await runChecks({ cwd: dir, slots, adapters, config: { checks: { lint: 'oxlint' } }, suite: EVALS, runner: lintRunner([A]), ...quiet });
    expect(existsSync(join(dir, '.check', 'api'))).toBe(true);
    const before = await snapshot(join(dir, '.check', 'suites'));

    await runChecks({ cwd: dir, ...ts, config: targetsConfig(['web']), runner: lintRunner([A]), ...quiet });
    expect(existsSync(join(dir, '.check', 'api'))).toBe(false);
    expect(await snapshot(join(dir, '.check', 'suites'))).toEqual(before);
  });

  test('a built-in’s scratch is the suite’s own, through the real runner, and the default suite’s stays where it was', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-fixture', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'index.js'), 'export const foo = 1;\n');
    await writeFile(join(dir, 'dist', 'index.d.ts'), 'export declare const foo: number;\n');
    const smoke: CheckrideConfig = { checks: { smoke: { use: 'smoke' } } };

    const suite = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: smoke, suite: EVALS, ...quiet });
    expect(suite.summary.checks.map((c) => [c.name, c.ok])).toEqual([['smoke', true]]);
    expect(existsSync(join(dir, '.check', 'suites', 'evals', 'smoke-probe.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.check', 'smoke-probe.mjs'))).toBe(false);

    const whole = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: smoke, only: ['smoke'], ...quiet });
    expect(whole.summary.checks.find((c) => c.name === 'smoke')?.ok).toBe(true);
    expect(existsSync(join(dir, '.check', 'smoke-probe.mjs'))).toBe(true);
  }, 30_000);

  test('a suite run leaves the default suite’s output as it was', async () => {
    await runChecks({ cwd: dir, slots, adapters, config: null, runner: lintRunner([B]), ...quiet });
    const before = await snapshot(join(dir, '.check'));
    await runChecks({ cwd: dir, slots, adapters, config: { checks: { lint: 'oxlint' } }, suite: EVALS, runner: lintRunner([A]), ...quiet });
    const after = await snapshot(join(dir, '.check'));
    expect(Object.fromEntries(Object.entries(after).filter(([file]) => !file.startsWith('suites/')))).toEqual(before);
  });
});
