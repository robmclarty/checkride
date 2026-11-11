/**
 * A red check says why in the terminal, end to end: one repo with a failing
 * linter and a failing custom command, run through the CLI with a real spawn.
 * The linter's findings are listed beneath its status line, the command's
 * last lines beneath its own, and each names the file that holds the rest.
 *
 * The linter is a stand-in: a Node script that prints seven findings in
 * oxlint's `--format=json` shape, under oxlint's adapter name, so the run
 * reads them through oxlint's parser.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

const FAKE_OXLINT = [
  "const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];",
  "const diagnostics = names.map((name, i) => ({ filename: `src/${name}.ts`, code: `no-${name}`, message: `bad ${name}`, severity: 'error', labels: [{ span: { line: i + 1, column: 2 } }] }));",
  'process.stdout.write(JSON.stringify({ diagnostics }));',
  'process.exit(1);',
  '',
].join('\n');

/** Prints one line on stdout, then eleven on stderr: colour, a blank line, and one line past 200 characters. */
const FAKE_DEPLOY = [
  "console.log('loaded 3 services');",
  "for (let i = 1; i <= 6; i += 1) console.error(`warning ${i}`);",
  "console.error('\\u001B[31merror\\u001B[0m: service \"api\" has no healthcheck');",
  "console.error('');",
  "console.error('  at manifests/api.yaml:14');",
  "console.error('x'.repeat(300));",
  "console.error('1 problem found');",
  'process.exit(3);',
  '',
].join('\n');

const CONFIG = {
  checks: {
    lint: { use: 'oxlint', command: process.execPath, args: ['fake-oxlint.mjs'] },
    deploy: { command: process.execPath, args: ['fake-deploy.mjs'] },
    links: false,
  },
};

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** The lines printed beneath `slot`'s red status line, up to the next line that isn't indented beneath it. */
function beneath(stderr: string, slot: string): string[] {
  const all = stderr.split('\n');
  const status = all.findIndex((line) => line.startsWith(`  ✘ ${slot} `));
  expect(status, `the red status line of ${slot}`).toBeGreaterThan(-1);
  const rest = all.slice(status + 1);
  const end = rest.findIndex((line) => !line.startsWith('           '));
  return rest.slice(0, end === -1 ? rest.length : end).map((line) => line.slice(11));
}

describe('a red run in the terminal', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-excerpt-'));
    await writeFile(join(dir, 'fake-oxlint.mjs'), FAKE_OXLINT);
    await writeFile(join(dir, 'fake-deploy.mjs'), FAKE_DEPLOY);
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(CONFIG));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(argv, { cwd: dir, stdout, stderr, env: {} });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  test('each red check prints an excerpt of its cause and the file that holds the rest', async () => {
    const { code, stdout, stderr } = await cli();
    expect(code).toBe(1);
    expect(stdout).toBe('');

    expect(beneath(stderr, 'lint')).toEqual([
      'src/a.ts:1:2  bad a  [no-a]',
      'src/b.ts:2:2  bad b  [no-b]',
      'src/c.ts:3:2  bad c  [no-c]',
      'src/d.ts:4:2  bad d  [no-d]',
      'src/e.ts:5:2  bad e  [no-e]',
      '… and 2 more',
      'full output: .check/lint.json',
    ]);
    // Both streams hold something, so both are shown, and stdout's one line leaves stderr seven.
    expect(beneath(stderr, 'deploy')).toEqual([
      'stderr:',
      '  warning 4',
      '  warning 5',
      '  warning 6',
      '  error: service "api" has no healthcheck',
      '    at manifests/api.yaml:14',
      `  ${'x'.repeat(199)}…`,
      '  1 problem found',
      'stdout:',
      '  loaded 3 services',
      'full output: .check/deploy.stdout.txt, .check/deploy.stderr.txt',
    ]);

    // Each pointer names a file the run wrote, holding what the excerpt left out.
    expect(await readFile(join(dir, '.check', 'lint.json'), 'utf8')).toContain('src/g.ts');
    const whole = await readFile(join(dir, '.check', 'deploy.stderr.txt'), 'utf8');
    expect(whole).toContain('warning 1\n');
    expect(whole).toContain('\u001B[31merror\u001B[0m');
    expect(whole).toContain('x'.repeat(300));
    expect(await readFile(join(dir, '.check', 'deploy.stdout.txt'), 'utf8')).toBe('loaded 3 services\n');
  });

  test('--json prints the summary alone, and the summary holds no excerpt', async () => {
    const { code, stdout, stderr } = await cli('--json');
    expect(code).toBe(1);
    expect(stderr).toBe('');
    expect(stdout).not.toContain('full output:');
    expect(stdout).not.toContain('healthcheck');
    const summary = JSON.parse(stdout) as { checks: Record<string, unknown>[] };
    const deploy = summary.checks.find((c) => c['name'] === 'deploy');
    expect(deploy).toMatchObject({ ok: false, exit_code: 3, output_file: null });
    expect(deploy).not.toHaveProperty('reason');
  });
});
