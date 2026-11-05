/**
 * A check names the Odin package at its root through `{odin-package}`: the
 * name is read from the package clause of the `.odin` files there and
 * expanded before anything spawns, so the runner and the summary's argv see
 * it; a root with no package clause, or a package with no `main` procedure
 * (whose unused procedures the vet can't judge), skips the check with its
 * reason.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import type { CheckRunner, Out, RunResult } from '../index.js';
import { runChecks, runFix } from '../index.js';

function sink(): Out {
  return { write: () => true };
}

/** A custom check that vets the package at the repo root for unused procedures. */
const VET = {
  command: 'odin',
  args: ['check', '.', '-vet-unused-procedures', '-vet-packages:{odin-package}', '-json-errors'],
  description: 'unused procedures',
};

const CONFIG: CheckrideConfig = { checks: { vet: VET } };

describe('{odin-package}', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-odin-package-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  };

  /** Run the config, returning the result and the args the runner was handed, by check name. */
  async function run(): Promise<{ result: RunResult; seen: Map<string, readonly string[]> }> {
    const seen = new Map<string, readonly string[]>();
    const runner: CheckRunner = (r: ResolvedCheck) => {
      seen.set(r.slot, r.adapter?.args ?? []);
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    const result = await runChecks({ cwd: dir, config: CONFIG, runner, baseline: null, only: ['vet'], json: true, stdout: sink(), stderr: sink() });
    return { result, seen };
  }

  test('a program names its package inside the argument, and the summary argv carries it', async () => {
    await put('main.odin', '// entry\npackage app\n\nmain :: proc() {}\n');
    await put('util.odin', 'package app\n\nhelp :: proc() {}\n');
    const { result, seen } = await run();
    expect(seen.get('vet')).toEqual(['check', '.', '-vet-unused-procedures', '-vet-packages:app', '-json-errors']);
    const vet = result.summary.checks.find((c) => c.name === 'vet');
    expect(vet).toMatchObject({ ok: true });
    expect(vet?.skipped).toBeFalsy();
    expect(result.summary.checks_run).toBe(1);
  });

  test('a library, with no main procedure, sits the check out with the reason', async () => {
    await put('kit.odin', 'package kit\n\nadd :: proc(a, b: int) -> int { return a + b }\n');
    const { result, seen } = await run();
    expect(seen.has('vet')).toBe(false);
    expect(result.summary.checks.find((c) => c.name === 'vet')).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'no main procedure in .: unused procedures are vetted from a program',
      exit_code: null,
    });
    expect(result.summary.checks_run).toBe(0);
  });

  test('a root whose files declare no package sits the check out too', async () => {
    await put('README.md', '# nothing to vet\n');
    const { result, seen } = await run();
    expect(seen.has('vet')).toBe(false);
    expect(result.summary.checks.find((c) => c.name === 'vet')).toMatchObject({ skipped: true, reason: 'no package clause in .' });
  });

  test('fix hands its fixer the same name', async () => {
    await put('main.odin', 'package tool\n\nmain :: proc() {}\n');
    const fixing: CheckrideConfig = { checks: { vet: { ...VET, fixArgs: ['fix', '-vet-packages:{odin-package}'] } } };
    const fixArgs: (readonly string[] | undefined)[] = [];
    await runFix({
      cwd: dir, config: fixing, stderr: sink(),
      fixRunner: (adapter) => { fixArgs.push(adapter.fixArgs); return Promise.resolve({ ok: true, exit_code: 0 }); },
    });
    expect(fixArgs).toEqual([['fix', '-vet-packages:tool']]);
  });
});
