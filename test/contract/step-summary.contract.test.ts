/**
 * Contract: the GitHub step summary (docs/contract.md §CLI, "`--summary
 * github` and `CHECKRIDE_SUMMARY`").
 *
 * A run asked for it appends a Markdown table to the file
 * `GITHUB_STEP_SUMMARY` names: a heading naming the suite, the verdict, the
 * base the baseline keys are counted against, and one row per check with its
 * status, time, new findings, and keys added and removed. The flag and the
 * variable that ask, the columns, the refusals, the append and the gate's
 * strip are promised; the exit code never moves. Changing a column breaks
 * every workflow that reads it (a "Contract" CHANGELOG entry).
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writeBaseline } from '../../src/baseline/index.js';
import { parseCliArgs, runCli } from '../../src/cli.js';
import { runGate } from '../../src/gate.js';

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** Two custom checks: `probe` passes, `deploy` fails with no baseline to mask it. */
const CONFIG = {
  checks: {
    probe: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    deploy: { command: process.execPath, args: ['-e', 'process.exit(1)'], order: 'last' },
    links: false,
  },
};

const HEADER = '| Check | Status | Time | New findings | Keys added | Keys removed |';
const RULE = '| --- | --- | ---: | ---: | ---: | ---: |';

describe('step summary (--summary github / CHECKRIDE_SUMMARY)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-step-summary-contract-'));
    file = join(dir, 'step-summary.md');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(CONFIG));
    git(dir, 'init', '-q');
    await writeBaseline(dir, { schema_version: 1, slots: { probe: ['a:rule:kept', 'a:rule:fixed'] } });
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'adopt');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(argv, { cwd: dir, stdout, stderr, env: { GITHUB_STEP_SUMMARY: file, CHECKRIDE_BASE: 'HEAD', ...env } });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  const table = (): Promise<string> => readFile(join(dir, 'step-summary.md'), 'utf8');

  test('--summary <value> parses to its raw value', () => {
    expect(parseCliArgs(['--summary', 'github']).summary).toBe('github');
  });

  test('the table: a heading naming the suite, the verdict, the base, and one row per check under the six columns', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { probe: ['a:rule:kept', 'b:rule:new'] } });
    const { code } = await cli(['--summary', 'github']);
    expect(code).toBe(1);
    const lines = (await table()).split('\n');
    expect(lines[0]).toBe('### checkride: default suite');
    expect(lines[2]).toMatch(/^\*\*✘ failed\*\*: 1 of 2 check\(s\) failed in /);
    expect(lines[4]).toMatch(/^Baseline against `HEAD` \([0-9a-f]{7}\): 1 key\(s\) added, 1 removed\.$/);
    expect(lines.slice(6, 8)).toEqual([HEADER, RULE]);
    expect(lines[8]).toMatch(/^\| `probe` \| ✔ pass \| \S+ \| 0 \| 1 \| 1 \|$/);
    expect(lines[9]).toMatch(/^\| `deploy` \| ✘ fail \| \S+ \| - \| 0 \| 0 \|$/);
    // The checks that sat out are named once beneath the table, not given rows.
    expect(lines[10]).toBe('');
    expect(lines[11]).toMatch(/^Skipped: `\S+`(, `\S+`)*\.$/);
  });

  test('CHECKRIDE_SUMMARY asks as the flag does, and an empty one counts as unset', async () => {
    await cli([], { CHECKRIDE_SUMMARY: 'github' });
    expect(await table()).toContain(HEADER);
    await rm(file);
    await cli([], { CHECKRIDE_SUMMARY: '' });
    await expect(table()).rejects.toThrow(/ENOENT/);
  });

  test('a second run appends its table beneath the first, each under its own heading', async () => {
    await cli(['--summary', 'github']);
    await cli(['--summary', 'github', '--only', 'probe']);
    const text = await table();
    expect(text.split('### checkride: default suite')).toHaveLength(3);
    expect(text).toContain('a partial run');
  });

  test('a base that can’t be read drops the two key columns and says why in their place', async () => {
    await cli(['--summary', 'github'], { CHECKRIDE_BASE: 'no-such-ref' });
    const text = await table();
    expect(text).toContain("Baseline keys not counted: the base `no-such-ref` can't be read ('no-such-ref' does not name a commit).");
    expect(text).toContain('| Check | Status | Time | New findings |\n| --- | --- | ---: | ---: |\n');
  });

  test('GITHUB_STEP_SUMMARY unset warns on stderr and writes nothing, and the exit code holds', async () => {
    const plain = await cli([]);
    const asked = await cli(['--summary', 'github'], { GITHUB_STEP_SUMMARY: '' });
    expect(asked.code).toBe(plain.code);
    expect(asked.stderr).toContain('--summary github: GITHUB_STEP_SUMMARY is not set, so no step summary is written');
    await expect(table()).rejects.toThrow(/ENOENT/);
  });

  test('a value other than github is exit 2, naming the accepted value, from the flag or the variable', async () => {
    expect(await cli(['--summary', 'markdown'])).toEqual({ code: 2, stdout: '', stderr: "checkride: invalid --summary 'markdown' (expected github)\n" });
    expect(await cli([], { CHECKRIDE_SUMMARY: 'markdown' })).toEqual({ code: 2, stdout: '', stderr: "checkride: invalid CHECKRIDE_SUMMARY 'markdown' (expected github)\n" });
  });

  test('fix and doctor refuse the flag with exit 2', async () => {
    expect(await cli(['fix', '--summary', 'github'])).toMatchObject({ code: 2, stderr: "checkride: fix doesn't take --summary: only a run has a verdict to summarize\n" });
    expect(await cli(['doctor', '--summary', 'github'])).toMatchObject({ code: 2, stderr: "checkride: doctor doesn't take --summary: only a run has a verdict to summarize\n" });
  });

  test('the gate strips CHECKRIDE_SUMMARY from the check it spawns', async () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    await runGate({
      cwd: dir, pm: 'pnpm', stdout: capture(), stderr: capture(), env: { PATH: '/usr/bin', CHECKRIDE_SUMMARY: 'github' },
      spawn: (_command, _args, options) => { seen.push(options.env); return Promise.resolve(0); },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('CHECKRIDE_SUMMARY');
  });
});
