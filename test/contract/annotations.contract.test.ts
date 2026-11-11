/**
 * Contract: GitHub Actions annotations (docs/contract.md §CLI,
 * "`--annotate github` and `CHECKRIDE_ANNOTATE`").
 *
 * A run asked for them writes one workflow command per finding of a red
 * check to stderr, below its report: the flag and the variable that ask, the
 * three line shapes, the cap of ten and its notice, and where they land are
 * promised. Nothing else about the run changes, a green run writes none, and
 * the gate strips the variable. Changing a line's shape breaks every workflow
 * that reads them (a major-version decision + a "Contract" CHANGELOG entry).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { parseCliArgs, runCli } from '../../src/cli.js';
import { runGate } from '../../src/gate.js';

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** A stand-in linter: `COUNT` findings in oxlint's `--format=json` shape, the first with a column and the second without. */
const FAKE_OXLINT = [
  'const count = Number(process.env.COUNT ?? 2);',
  "const diagnostics = Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, code: 'no-x', message: `bad ${i + 1}: 100%`, severity: 'error', labels: [{ span: i === 1 ? { line: 2 } : { line: i + 1, column: 3 } }] }));",
  'process.stdout.write(JSON.stringify({ diagnostics }));',
  'process.exit(count === 0 ? 0 : 1);',
  '',
].join('\n');

/** The annotation lines in what a run wrote to stderr. */
function annotations(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.startsWith('::'));
}

/** The checks of the summary in `dir`, each without its duration. */
async function summaryChecks(dir: string): Promise<unknown> {
  const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Record<string, unknown>[] };
  return summary.checks.map((c) => ({ ...c, duration_ms: 0 }));
}

const CONFIG = {
  checks: {
    lint: { use: 'oxlint', command: process.execPath, args: ['fake-oxlint.mjs'] },
    deploy: { command: process.execPath, args: ['-e', 'console.error("no healthcheck"); process.exit(3)'], order: 'last' },
    links: false,
  },
};

describe('annotations (--annotate github / CHECKRIDE_ANNOTATE)', () => {
  let dir: string;
  const saved = process.env['COUNT'];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-annotate-contract-'));
    await writeFile(join(dir, 'fake-oxlint.mjs'), FAKE_OXLINT);
    // The files the findings name: an annotation carries `file` only for one on disk.
    await mkdir(join(dir, 'src'));
    await Promise.all(Array.from({ length: 12 }, (_, i) => writeFile(join(dir, 'src', `f${i + 1}.ts`), '')));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(CONFIG));
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['COUNT'];
    else process.env['COUNT'] = saved;
    await rm(dir, { recursive: true, force: true });
  });

  async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(argv, { cwd: dir, stdout, stderr, env });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  const LINES = [
    '::error file=src/f1.ts,line=1,col=3,title=lint%3A no-x::bad 1: 100%25',
    '::error file=src/f2.ts,line=2,title=lint%3A no-x::bad 2: 100%25',
    '::error title=deploy::no healthcheck',
  ];

  test('--annotate <value> parses to its raw value', () => {
    expect(parseCliArgs(['--annotate', 'github']).annotate).toBe('github');
  });

  test('the three line shapes: a finding at its place, one with no column, and a check with nothing to point at', async () => {
    const { code, stdout, stderr } = await cli(['--annotate', 'github']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(annotations(stderr)).toEqual(LINES);
    // On stderr, last, below the report's footer.
    expect(stderr.endsWith(`report: .check/summary.json\n\n${LINES.join('\n')}\n`)).toBe(true);
  });

  test('CHECKRIDE_ANNOTATE asks as the flag does, an empty one counts as unset, and neither asking writes none', async () => {
    expect(annotations((await cli([], { CHECKRIDE_ANNOTATE: 'github' })).stderr)).toEqual(LINES);
    expect(annotations((await cli([], { CHECKRIDE_ANNOTATE: '' })).stderr)).toEqual([]);
    expect(annotations((await cli([], { GITHUB_ACTIONS: 'true' })).stderr)).toEqual([]);
  });

  test('a value other than github is exit 2, naming the accepted value, from the flag or the variable', async () => {
    expect(await cli(['--annotate', 'gitlab'])).toEqual({ code: 2, stdout: '', stderr: "checkride: invalid --annotate 'gitlab' (expected github)\n" });
    expect(await cli([], { CHECKRIDE_ANNOTATE: 'gitlab' })).toEqual({ code: 2, stdout: '', stderr: "checkride: invalid CHECKRIDE_ANNOTATE 'gitlab' (expected github)\n" });
  });

  test('under --json, stdout is the summary alone and the annotations are all of stderr', async () => {
    const { code, stdout, stderr } = await cli(['--annotate', 'github', '--json']);
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { ok: boolean }).ok).toBe(false);
    expect(stderr).toBe(`${LINES.join('\n')}\n`);
  });

  test('the run is otherwise the same: its exit code and its summary’s checks', async () => {
    const plain = await cli([]);
    const before = await summaryChecks(dir);
    const asked = await cli(['--annotate', 'github']);
    expect(asked.code).toBe(plain.code);
    expect(await summaryChecks(dir)).toEqual(before);
  });

  test('at most ten errors, in the run’s order, then one notice counting the rest and naming the summary', async () => {
    process.env['COUNT'] = '12';
    const lines = annotations((await cli(['--annotate', 'github'])).stderr);
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 10).every((line) => line.startsWith('::error file=src/f'))).toBe(true);
    expect(lines[10]).toBe('::notice title=checkride::3 more finding(s) not annotated; see .check/summary.json');
  });

  test('a green run writes none', async () => {
    process.env['COUNT'] = '0';
    const { code, stderr } = await cli(['--annotate', 'github', '--only', 'lint']);
    expect(code).toBe(0);
    expect(stderr).not.toContain('::');
  });

  test('fix and doctor refuse the flag with exit 2, and the commands with their own flags don’t know it', async () => {
    expect((await cli(['fix', '--annotate', 'github'])).stderr).toBe("checkride: fix doesn't take --annotate: only a run has findings to annotate\n");
    expect((await cli(['doctor', '--annotate', 'github'])).stderr).toBe("checkride: doctor doesn't take --annotate: only a run has findings to annotate\n");
    for (const command of ['fix', 'doctor', 'baseline', 'recover', 'gate', 'triage', 'qa']) {
      // oxlint-disable-next-line no-await-in-loop -- each command is one short run, asserted in turn.
      expect((await cli([command, '--annotate', 'github'])).code, command).toBe(2);
    }
  });

  test('fix, doctor and baseline ignore a stray CHECKRIDE_ANNOTATE without a word, whatever it holds', async () => {
    const env = { CHECKRIDE_ANNOTATE: 'gitlab' };
    process.env['COUNT'] = '0';
    const runs = [await cli(['fix', '--only', 'deploy'], env), await cli(['doctor'], env), await cli(['baseline', '--only', 'lint'], env)];
    expect(runs[0]?.code).toBe(0);
    expect(runs[2]?.code).toBe(0);
    for (const { code, stdout, stderr } of runs) {
      expect(code).not.toBe(2);
      expect(`${stdout}${stderr}`).not.toMatch(/CHECKRIDE_ANNOTATE|::error/);
    }
  }, 30_000);

  test('under --digest the digest stays the last thing printed, and the annotations sit between the footer and it', async () => {
    const { stderr } = await cli(['--annotate', 'github', '--digest']);
    const digest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
    expect(stderr.endsWith(`report: .check/summary.json\ndigest: .check/digest.md\n\n${LINES.join('\n')}\n\n${digest}\n`)).toBe(true);
  });

  test('a finding whose file is not on disk, and a line or column below 1, keep the annotation and lose the property', async () => {
    await rm(join(dir, 'src', 'f1.ts'));
    await writeFile(join(dir, 'fake-oxlint.mjs'), FAKE_OXLINT.replace('{ line: 2 }', '{ line: 0, column: 0 }'));
    expect(annotations((await cli(['--annotate', 'github', '--only', 'lint'])).stderr)).toEqual([
      '::error title=lint%3A no-x::bad 1: 100%25',
      '::error file=src/f2.ts,title=lint%3A no-x::bad 2: 100%25',
    ]);
  });

  test('the gate strips CHECKRIDE_ANNOTATE from the check it spawns', async () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    await runGate({
      cwd: dir, pm: 'pnpm', stdout: capture(), stderr: capture(), env: { PATH: '/usr/bin', CHECKRIDE_ANNOTATE: 'github' },
      spawn: (_command, _args, options) => { seen.push(options.env); return Promise.resolve(0); },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('CHECKRIDE_ANNOTATE');
  });
});
