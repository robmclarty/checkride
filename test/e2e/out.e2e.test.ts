/**
 * The output directory end to end, through the built CLI (S16).
 *
 * `--out` exists so a consumer can run checkride twice over one checkout, the
 * base branch's config and the PR's, at the same time, without either run
 * clearing or overwriting the other's artifacts (F28). And a run that writes
 * outside the repo is not the repo's own gate, so it must never prune the
 * committed baseline, while `checkride baseline` stays the repo's explicit
 * write wherever its artifacts go (F27).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

type Run = { code: number; stdout: string; stderr: string };

async function checkride(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP('node', [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A custom check that waits `ms`, so two runs' checks overlap, then prints `text` and exits `code`. */
function slowCheck(ms: number, text: string, code: number): unknown {
  return {
    command: process.execPath,
    args: ['-e', `setTimeout(() => { console.log(${text}); process.exit(${code}); }, ${ms})`],
  };
}

type Summary = { run: Record<string, unknown>; checks: { name: string; ok: boolean; skipped?: boolean }[] };

async function summaryIn(dir: string): Promise<Summary> {
  return JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as Summary;
}

describe('two runs at once with different --out values (F28)', () => {
  let dir: string;
  beforeEach(async () => {
    // Real, because a relative --out resolves against the child's working
    // directory, which is the real path (macOS's /var is /private/var).
    dir = await realpath(await mkdtemp(join(tmpdir(), 'checkride-e2e-out-')));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        alpha: slowCheck(400, "'alpha'", 0),
        beta: slowCheck(400, "'beta'", 0),
        // Both runs run `shared`, and it fails, so both clear, write and
        // digest the same slot's files at the same moment.
        shared: slowCheck(300, "'shared ' + process.env.RUN", 1),
      },
    }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('each run’s artifact set is complete, its own, and names its own directory', async () => {
    const [a, b] = await Promise.all([
      checkride(dir, ['--only', 'alpha,shared', '--digest', '--out', 'out-a'], { RUN: 'A' }),
      checkride(dir, ['--only', 'beta,shared', '--digest', '--out', 'out-b'], { RUN: 'B' }),
    ]);
    expect([a.code, b.code]).toEqual([1, 1]);
    expect(a.stderr).toContain('report: out-a/summary.json');
    expect(b.stderr).toContain('report: out-b/summary.json');

    for (const [label, own, other, run] of [['out-a', 'alpha', 'beta', 'A'], ['out-b', 'beta', 'alpha', 'B']] as const) {
      const out = join(dir, label);
      const summary = await summaryIn(out);
      expect(summary.run).toEqual({ partial: true, only: [own, 'shared'], out });
      const ran = summary.checks.filter((c) => c.skipped !== true).map((c) => c.name);
      expect(ran.toSorted()).toEqual([own, 'shared'].toSorted());
      expect(await readFile(join(out, `${own}.stdout.txt`), 'utf8')).toBe(`${own}\n`);
      expect(await readFile(join(out, 'shared.stdout.txt'), 'utf8')).toBe(`shared ${run}\n`);
      expect(existsSync(join(out, `${other}.stdout.txt`))).toBe(false);
      const digest = await readFile(join(out, 'digest.md'), 'utf8');
      expect(digest).toContain(`Raw: \`${label}/shared.stdout.txt\``);
    }
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });
});

/** An oxlint `--format=json` payload with one error, the way a real lint run reports it. */
const ONE_ERROR = JSON.stringify({
  diagnostics: [{ filename: 'a.ts', code: 'no-x', message: 'bad', severity: 'error' }],
});
const KEY_A = 'a.ts:no-x:bad';
const KEY_FIXED = 'b.ts:no-y:worse';

describe('an --out outside the repo and the baseline (F27)', () => {
  let dir: string;
  let outside: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-out-base-'));
    outside = await mkdtemp(join(tmpdir(), 'checkride-e2e-out-elsewhere-'));
    // A custom check named `oxlint` fills `lint`, so the baseline keys its
    // findings the way it keys oxlint's.
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        lint: {
          name: 'oxlint',
          command: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(ONE_ERROR)}); process.exit(1)`],
          outputFile: 'lint.json',
        },
      },
    }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const baselineFile = (): string => join(dir, 'checkride.baseline.json');
  const grandfathered = `${JSON.stringify({ schema_version: 1, slots: { lint: [KEY_A, KEY_FIXED] } }, null, 2)}\n`;

  test('a full run writing outside the repo masks with the baseline but never prunes it', async () => {
    await writeFile(baselineFile(), grandfathered);
    const consumer = await checkride(dir, ['--out', outside]);
    expect(consumer.code).toBe(0);
    expect(consumer.stderr).toContain('not ratcheted, because a run with --out outside the repo');
    expect(await readFile(baselineFile(), 'utf8')).toBe(grandfathered);
    expect((await summaryIn(outside)).run).toEqual({ partial: false, out: outside });

    // The same run without --out is the repo's own, and prunes the fixed key.
    expect((await checkride(dir, [])).code).toBe(0);
    const pruned = JSON.parse(await readFile(baselineFile(), 'utf8')) as { slots: Record<string, string[]> };
    expect(pruned.slots['lint']).toEqual([KEY_A]);
  });

  test('baseline --out writes its artifacts outside and checkride.baseline.json at the repo root', async () => {
    const result = await checkride(dir, ['baseline', '--out', outside]);
    expect(result.code).toBe(0);
    const written = JSON.parse(await readFile(baselineFile(), 'utf8')) as { slots: Record<string, string[]> };
    expect(written.slots['lint']).toEqual([KEY_A]);
    expect(existsSync(join(outside, 'lint.json'))).toBe(true);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });
});
