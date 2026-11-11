/**
 * GitHub annotations end to end: a git work tree with a failing linter and a
 * failing custom command, run through the CLI with a real spawn and a real
 * git. Each of the linter's findings becomes an `::error` at its place, named
 * from the git top level, and the command, which checkride can't parse, one
 * with no file.
 *
 * The linter is a stand-in: a Node script that prints findings in oxlint's
 * `--format=json` shape, under oxlint's adapter name, so the run reads them
 * through oxlint's parser. One sits in a file above the work tree.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

const FAKE_OXLINT = [
  'const diagnostics = [',
  "  { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: \"'x' is declared but never used.\\nhelp: remove it\", severity: 'error', labels: [{ span: { line: 3, column: 7 } }] },",
  "  { filename: 'src/b,c.ts', code: 'no-debugger', message: '\\u001B[1m100% sure\\u001B[0m: a debugger statement', severity: 'error', labels: [{ span: { line: 12 } }] },",
  "  { filename: '../../outside.ts', message: 'a file above the work tree', severity: 'error', labels: [{ span: { line: 1, column: 1 } }] },",
  '];',
  'process.stdout.write(JSON.stringify({ diagnostics }));',
  'process.exit(1);',
  '',
].join('\n');

const FAKE_DEPLOY = [
  "console.error('\\u001B[31merror\\u001B[0m: service \"api\" has no healthcheck');",
  "console.error('1 problem found');",
  'process.exit(3);',
  '',
].join('\n');

const CONFIG = {
  checks: {
    lint: { use: 'oxlint', command: process.execPath, args: ['fake-oxlint.mjs'] },
    deploy: { command: process.execPath, args: ['fake-deploy.mjs'], order: 'last' },
    links: false,
  },
};

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** The repo's files in `dir`, a directory of the work tree. */
async function repoIn(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'fake-oxlint.mjs'), FAKE_OXLINT);
  // The files the linter names: an annotation carries `file` only for one on disk.
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'a.ts'), '');
  await writeFile(join(dir, 'src', 'b,c.ts'), '');
  await writeFile(join(dir, 'fake-deploy.mjs'), FAKE_DEPLOY);
  await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(CONFIG));
}

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(argv, { cwd, stdout, stderr, env: {} });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Is a real git usable here? The suite skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('a red run with --annotate github, in a git work tree', () => {
  let top: string;
  beforeEach(async () => {
    top = await mkdtemp(join(tmpdir(), 'checkride-annotations-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: top, stdio: 'pipe' });
  });
  afterEach(async () => { await rm(top, { recursive: true, force: true }); });

  test('writes exactly one line per gating finding and one for the command, below the report', async () => {
    await repoIn(top);
    const { code, stdout, stderr } = await cli(top, '--annotate', 'github');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    const lines = [
      "::error file=src/a.ts,line=3,col=7,title=lint%3A eslint(no-unused-vars)::'x' is declared but never used.",
      '::error file=src/b%2Cc.ts,line=12,title=lint%3A no-debugger::100%25 sure: a debugger statement',
      '::error title=lint::a file above the work tree',
      '::error title=deploy::error: service "api" has no healthcheck',
    ];
    expect(stderr.split('\n').filter((line) => line.startsWith('::'))).toEqual(lines);
    expect(stderr.endsWith(`report: .check/summary.json\n\n${lines.join('\n')}\n`)).toBe(true);
    // The report above them is the one a plain run prints.
    expect(stderr).toContain("src/a.ts:3:7  'x' is declared but never used.  [eslint(no-unused-vars)]");
    expect(stderr).toContain('full output: .check/deploy.stderr.txt');
    // The summary knows nothing of them.
    expect(await readFile(join(top, '.check', 'summary.json'), 'utf8')).not.toContain('::error');
  });

  test('from a subdirectory of the work tree, each path is named from the top level, and --json keeps stdout pure', async () => {
    const cwd = join(top, 'services', 'api');
    await repoIn(cwd);
    await writeFile(join(top, 'outside.ts'), '');
    const { code, stdout, stderr } = await cli(cwd, '--annotate', 'github', '--json');
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { ok: boolean }).ok).toBe(false);
    expect(stderr).toBe([
      "::error file=services/api/src/a.ts,line=3,col=7,title=lint%3A eslint(no-unused-vars)::'x' is declared but never used.",
      '::error file=services/api/src/b%2Cc.ts,line=12,title=lint%3A no-debugger::100%25 sure: a debugger statement',
      // Two levels up from services/api is the top level itself, so this file is in the work tree here.
      '::error file=outside.ts,line=1,col=1,title=lint::a file above the work tree',
      '::error title=deploy::error: service "api" has no healthcheck',
      '',
    ].join('\n'));
  });

  test('without the flag, the same run writes none', async () => {
    await repoIn(top);
    const { code, stderr } = await cli(top);
    expect(code).toBe(1);
    expect(stderr).not.toContain('::error');
  });
});
