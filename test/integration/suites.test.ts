/**
 * Named suites end to end: one repo, its default suite and a suite named
 * `evals`, run through the CLI with a real spawn. Each suite has its own
 * config, its own baseline and its own output directory, and nothing one
 * suite's run does reaches the other's.
 *
 * The linter is a stand-in: a Node script that prints the findings a JSON
 * file lists, in oxlint's `--format=json` shape, under oxlint's adapter name,
 * so its findings key into a baseline as the real tool's do.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

type Finding = readonly [file: string, code: string, message: string];

const FAKE_OXLINT = [
  "import { readFileSync } from 'node:fs';",
  "const findings = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
  'process.stdout.write(JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })) }));',
  'process.exit(findings.length > 0 ? 1 : 0);',
  '',
].join('\n');

/** A config whose one check is the stand-in linter, reading the findings `file` lists. */
const lintConfig = (file: string): string =>
  JSON.stringify({ checks: { lint: { use: 'oxlint', command: process.execPath, args: ['fake-oxlint.mjs', file], outputFile: null } } });

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

describe('a default suite and a named suite in one repo', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-suites-e2e-'));
    await writeFile(join(dir, 'fake-oxlint.mjs'), FAKE_OXLINT);
    await writeFile(join(dir, 'checkride.config.json'), lintConfig('default.findings.json'));
    await writeFile(join(dir, 'checkride.evals.config.json'), lintConfig('evals.findings.json'));
    await findings('default', [['a.ts', 'no-x', 'bad'], ['b.ts', 'no-y', 'worse']]);
    await findings('evals', [['e.ts', 'no-e', 'eval'], ['f.ts', 'no-f', 'flaky']]);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const findings = (suite: string, list: readonly Finding[]): Promise<void> => writeFile(join(dir, `${suite}.findings.json`), JSON.stringify(list));
  const text = (...path: string[]): Promise<string> => readFile(join(dir, ...path), 'utf8');
  const json = async (...path: string[]): Promise<Record<string, unknown>> => JSON.parse(await text(...path)) as Record<string, unknown>;
  const keys = async (file: string): Promise<string[]> => ((await json(file))['slots'] as Record<string, string[]>)['lint'] ?? [];
  const lintOf = async (...path: string[]): Promise<Record<string, unknown> | undefined> =>
    ((await json(...path, 'summary.json'))['checks'] as Record<string, unknown>[]).find((c) => c['name'] === 'lint');

  async function cli(...argv: string[]): Promise<{ code: number; stderr: string }> {
    const stderr = capture();
    const code = await runCli(argv, { cwd: dir, stdout: capture(), stderr, env: {} });
    return { code, stderr: stderr.text() };
  }

  /** Every file under `.check/suites/`, relative to it, with its contents. */
  async function suiteOutput(): Promise<Record<string, string>> {
    const root = join(dir, '.check', 'suites');
    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((f) => f.isFile());
    const entries = await Promise.all(files.map(async (f) => [join(f.parentPath, f.name).slice(root.length + 1), await readFile(join(f.parentPath, f.name), 'utf8')] as const));
    return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
  }

  test('each suite keeps its own output and its own baseline through capture, ratchet and a new finding', async () => {
    // Before any baseline, both are red, each on its own findings and in its own directory.
    expect((await cli()).code).toBe(1);
    expect((await cli('--suite', 'evals')).code).toBe(1);
    expect((await json('.check', 'summary.json'))['suite']).toBeUndefined();
    expect((await json('.check', 'suites', 'evals', 'summary.json'))['suite']).toBe('evals');
    expect(await text('.check', 'lint.stdout.txt')).toContain('a.ts');
    expect(await text('.check', 'suites', 'evals', 'lint.stdout.txt')).toContain('e.ts');
    expect(await text('.check', 'suites', 'evals', 'lint.stdout.txt')).not.toContain('a.ts');

    // Each capture writes its own file with its own keys.
    expect((await cli('baseline')).stderr).toContain('baseline: wrote checkride.baseline.json — 2 finding(s) across lint');
    expect(existsSync(join(dir, 'checkride.evals.baseline.json'))).toBe(false);
    expect((await cli('baseline', '--suite', 'evals')).stderr).toContain('baseline: wrote checkride.evals.baseline.json — 2 finding(s) across lint');
    expect(await keys('checkride.baseline.json')).toEqual(['a.ts:no-x:bad', 'b.ts:no-y:worse']);
    expect(await keys('checkride.evals.baseline.json')).toEqual(['e.ts:no-e:eval', 'f.ts:no-f:flaky']);

    // Both green now, each masked by its own file.
    expect((await cli()).code).toBe(0);
    expect((await cli('--suite', 'evals')).code).toBe(0);
    expect(await lintOf('.check')).toMatchObject({ ok: true, baselined: 2 });
    expect(await lintOf('.check', 'suites', 'evals')).toMatchObject({ ok: true, baselined: 2 });

    // A fix in the evals suite ratchets its file, and nothing of the default suite's moves.
    const defaultBaseline = await text('checkride.baseline.json');
    const defaultSummary = await text('.check', 'summary.json');
    await findings('evals', [['e.ts', 'no-e', 'eval']]);
    const evalsRun = await cli('--suite', 'evals');
    expect(evalsRun.code).toBe(0);
    expect(evalsRun.stderr).toContain('baseline: ratcheted checkride.evals.baseline.json to 1 grandfathered finding(s)');
    expect(await keys('checkride.evals.baseline.json')).toEqual(['e.ts:no-e:eval']);
    expect(await text('checkride.baseline.json')).toBe(defaultBaseline);
    expect(await text('.check', 'summary.json')).toBe(defaultSummary);

    // A fix in the default suite ratchets its file, and nothing of the evals suite's moves.
    const evalsBaseline = await text('checkride.evals.baseline.json');
    const evalsOutput = await suiteOutput();
    await findings('default', [['a.ts', 'no-x', 'bad']]);
    const defaultRun = await cli();
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.stderr).toContain('baseline: ratcheted checkride.baseline.json to 1 grandfathered finding(s)');
    expect(await keys('checkride.baseline.json')).toEqual(['a.ts:no-x:bad']);
    expect(await text('checkride.evals.baseline.json')).toBe(evalsBaseline);
    expect(await suiteOutput()).toEqual(evalsOutput);

    // A new finding in the evals suite turns it red, and the default suite stays green.
    await findings('evals', [['e.ts', 'no-e', 'eval'], ['g.ts', 'no-g', 'new']]);
    expect((await cli('--suite', 'evals')).code).toBe(1);
    expect(await lintOf('.check', 'suites', 'evals')).toMatchObject({ ok: false, baselined: 1, new_count: 1, new: ['g.ts:no-g:new'] });
    expect((await cli()).code).toBe(0);
    expect(await keys('checkride.baseline.json')).toEqual(['a.ts:no-x:bad']);
    expect(await keys('checkride.evals.baseline.json')).toEqual(['e.ts:no-e:eval']);
  }, 60_000);
});
