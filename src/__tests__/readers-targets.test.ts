/**
 * The readers in a multi-target run: the digest, `triage` and `qa` find a
 * target's artifacts under `<out>/<target>/`, a `.jsonl` artifact among the
 * candidates, and name each target's check `<target>:<slot>`.
 */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckRunner, Out } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';
import { qaExtract, renderQa } from '../qa/index.js';
import type { SpawnOutcome, TriageEnv } from '../triage/index.js';
import { renderTriage, triage } from '../triage/index.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

const RUN_END_ISO = '2026-07-24T02:15:16.214Z';
const RUN_DURATION_MS = 90_000;
const FRESH_MTIME = Date.parse(RUN_END_ISO) - RUN_DURATION_MS + 1000;

/** A summary check entry of a target, as a multi-target run writes it. */
function targetCheck(target: string, slot: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${target}:${slot}`, target, slot, pack: 'ts', cwd: `apps/${target}`, adapter: slot, description: slot,
    ok: true, exit_code: 0, duration_ms: 10, output_file: null, ...over,
  };
}

/** A schema-1 multi-target summary over `checks`. */
function summaryOf(checks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema_version: 1, timestamp: RUN_END_ISO, ok: checks.every((c) => c['ok'] !== false),
    checks_run: checks.length, total_duration_ms: RUN_DURATION_MS, run: { partial: false },
    targets: [{ name: 'web', pack: 'ts', root: 'apps/web' }, { name: 'api', pack: 'ts', root: 'apps/api' }],
    checks,
  };
}

/** A runner whose web lint reports one oxlint error and whose api tests fail; the rest pass. */
const failingTwo: CheckRunner = (r) => {
  if (r.target === 'web' && r.slot === 'lint') {
    const diagnostics = [{ filename: 'src/a.ts', code: 'no-x', message: 'bad', severity: 'error' }];
    return Promise.resolve({ ok: false, exit_code: 1, stdout: JSON.stringify({ diagnostics }), stderr: '' });
  }
  if (r.target === 'api' && r.slot === 'test') return Promise.resolve({ ok: false, exit_code: 1, stdout: 'FAIL api spec\n', stderr: '' });
  return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
};

/** A fallow dead-code report with `total` issues and no findings listed. */
const dead = (total: number): string =>
  JSON.stringify({ kind: 'dead-code', schema_version: 7, total_issues: total, entry_points: { total: 3 }, summary: { total_issues: total }, unused_exports: [] });

describe('the readers in a multi-target run', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-readers-targets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Write `files` under `.check/`, each fresh for the summary's run. */
  const lay = async (files: Record<string, string>): Promise<void> => {
    for (const [path, text] of Object.entries(files)) {
      const abs = join(dir, '.check', path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
      await utimes(abs, new Date(FRESH_MTIME), new Date(FRESH_MTIME));
    }
  };

  test('the digest names each failing target check and points at its own directory', async () => {
    const config = {
      targets: { web: { lang: 'ts' as const, root: 'apps/web', checks: { lint: 'oxlint' } }, api: { lang: 'ts' as const, root: 'apps/api', checks: { test: 'vitest' } } },
      checks: { links: false as const },
    };
    await runChecks({ cwd: dir, config, runner: failingTwo, baseline: null, digest: true, only: ['web:lint', 'api:test'], stderr: sink().out });
    const digest = await readFile(join(dir, '.check', 'digest.md'), 'utf8');
    expect(digest).toContain('## web:lint — oxlint\n\nRaw: `.check/web/lint.json` — 1 finding(s)');
    expect(digest).toContain('- apps/web/src/a.ts:no-x:bad');
    expect(digest).toContain('## api:test — vitest\n\nRaw: `.check/api/test.stdout.txt`');
  });

  test('triage names each target check and finds its raw output under its directory, a .jsonl one included', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    await lay({
      'summary.json': JSON.stringify(summaryOf([
        targetCheck('web', 'types', { ok: false, exit_code: 1, output_file: 'web/types.jsonl' }),
        targetCheck('api', 'test', { ok: false, exit_code: 1 }),
        targetCheck('api', 'lint'),
      ])),
      'web/types.jsonl': '{"Action":"build-fail"}\n{"Action":"done"}\n',
      'api/test.stdout.txt': 'FAIL\n',
    });
    const spawned: SpawnOutcome = { code: 1, signal: null, stdout: '', stderr: '', error: null };
    const env: TriageEnv = { now: () => FRESH_MTIME - 1000, timeoutMs: 1000, spawn: () => Promise.resolve(spawned) };
    const report = await triage(dir, env);
    expect(report.failing.map((r) => [r.slot, r.raw?.chosen.file])).toEqual([
      ['web:types', 'web/types.jsonl'],
      ['api:test', 'api/test.stdout.txt'],
    ]);
    expect(renderTriage(report)).toContain('`.check/web/types.jsonl`');
  });

  test('qa reads each target’s artifact under its directory, and names its section for the check', async () => {
    await lay({
      'summary.json': JSON.stringify(summaryOf([targetCheck('web', 'dead'), targetCheck('api', 'dead')])),
      'web/dead.json': dead(0),
      'api/dead.json': dead(0),
    });
    const report = await qaExtract(dir, () => Date.parse(RUN_END_ISO) + 60_000);
    const deadRows = report.ledger.filter((e) => e.slot === 'dead');
    expect(deadRows.map((e) => [e.name, e.artifact, e.problem, e.ranThisRun])).toEqual([
      ['web:dead', 'web/dead.json', null, true],
      ['api:dead', 'api/dead.json', null, true],
    ]);
    expect(report.folds.map((f) => f.name)).toEqual(['web:dead', 'api:dead']);
    // The opt-in slots no target ran stay a single row at the root.
    expect(report.ledger.find((e) => e.slot === 'mutation')).toMatchObject({ name: 'mutation', artifact: 'mutation.json', problem: 'absent' });
    const text = renderQa(report);
    expect(text).toContain('| `.check/web/dead.json` |');
    expect(text).toContain('## web:dead');
    expect(text).toContain('## api:dead');
  });

  test("a go target's dead check points at its raw output, since qa reads only fallow's report, and names deadcode when it sat out", async () => {
    await lay({
      'summary.json': JSON.stringify(summaryOf([
        targetCheck('api', 'dead', { pack: 'go', adapter: 'deadcode', cwd: 'svc/api' }),
        targetCheck('web', 'dead', { pack: 'go', adapter: null, cwd: 'svc/web', skipped: true, exit_code: null, reason: 'no tool detected for slot' }),
      ])),
      'api/dead.stdout.txt': 'main.go:3:6: unreachable func: unused\n',
    });
    const report = await qaExtract(dir, () => Date.parse(RUN_END_ISO) + 60_000);
    expect(report.ledger.find((e) => e.name === 'api:dead')?.remedy).toBe(
      "qa reads only fallow's report, and api:dead ran deadcode, which writes none: read its raw output, `api/dead.stdout.txt` in the output directory.",
    );
    const skipped = report.ledger.find((e) => e.name === 'web:dead')?.remedy ?? '';
    expect(skipped).toBe(
      "qa reads only fallow's report, which no go tool writes. web:dead found no tool; add deadcode (declare it in go.mod with `go get -tool golang.org/x/tools/cmd/deadcode`, or name it in checkride.config.json), then read its raw output in the output directory.",
    );
  });
});
