/**
 * The `unclaimed` slot in a run: active in multi-target mode, where it writes
 * `<out>/unclaimed.json` and fails on a marker no target claims (F9), and
 * inactive without targets, where it's absent from `checks`, `--all`
 * included, unless a token names it, which records one skipped entry (D53).
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckrideConfig } from '../../config.js';
import type { CheckRunner, Out } from '../index.js';
import { runChecks } from '../index.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

const targets: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web' } } };

/** A runner whose every check passes with nothing to say. */
const passing: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

describe('the unclaimed check in a run', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-unclaimed-run-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (...paths: string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), '{}');
    }
  };
  const run = (config: CheckrideConfig | null, flags: { only?: string[]; include?: string[]; all?: boolean; out?: string } = {}, err = sink()) =>
    runChecks({ cwd: dir, config, baseline: null, stderr: err.out, ...flags });

  test('with targets, a fully claimed repo passes and still writes its report', async () => {
    await put('apps/web/package.json');
    const result = await run(targets, { only: ['unclaimed'] });
    expect(result.summary.checks[0]).toMatchObject({
      name: 'unclaimed', slot: 'unclaimed', pack: 'repo', ok: true, exit_code: 0, output_file: 'unclaimed.json', origin: 'built-in',
    });
    expect(JSON.parse(await readFile(join(dir, '.check', 'unclaimed.json'), 'utf8'))).toEqual({ unclaimed: [] });
  });

  test('a new package outside every target fails unclaimed with exit 1 and a suggested target (F9)', async () => {
    await put('apps/web/package.json', 'tools/x/package.json');
    const err = sink();
    const result = await run(targets, { only: ['unclaimed'], out: 'artifacts' }, err);
    expect(result.exitCode).toBe(1);
    expect(result.summary.checks[0]).toMatchObject({ name: 'unclaimed', ok: false, exit_code: 1, output_file: 'unclaimed.json' });
    expect(JSON.parse(await readFile(join(dir, 'artifacts', 'unclaimed.json'), 'utf8'))).toEqual({
      unclaimed: [{ path: 'tools/x/package.json', kind: 'ts', suggest: { name: 'x', lang: 'ts', root: 'tools/x' } }],
    });
    expect(await readFile(join(dir, 'artifacts', 'unclaimed.stderr.txt'), 'utf8')).toContain('tools/x/package.json marks ts code');
  });

  test('honors unclaimed.ignore, and leaves out the output directory it writes into', async () => {
    await put('apps/web/package.json', 'tools/x/package.json', 'artifacts/web/package.json');
    const result = await run({ ...targets, unclaimed: { ignore: ['tools/x'] } }, { only: ['unclaimed'], out: 'artifacts' });
    expect(result.summary.checks[0]).toMatchObject({ ok: true });
  });

  test('without targets it sits out every run, --all included, and adds nothing to the summary', async () => {
    await put('package.json', 'tools/x/package.json');
    for (const flags of [{}, { all: true }]) {
      // Only the summary's names matter, so nothing spawns.
      const result = await runChecks({ cwd: dir, config: { checks: { links: false } }, baseline: null, stderr: sink().out, runner: passing, ...flags });
      expect(result.summary.checks.map((c) => c.name)).not.toContain('unclaimed');
    }
    expect(existsSync(join(dir, '.check', 'unclaimed.json'))).toBe(false);
  });

  test('without targets, naming it records one skipped entry with its reason', async () => {
    for (const flags of [{ only: ['unclaimed'] }, { include: ['unclaimed'] }]) {
      const result = await run(null, flags);
      const named = result.summary.checks.filter((c) => c.name === 'unclaimed');
      expect(named).toEqual([
        expect.objectContaining({ skipped: true, ok: true, exit_code: null, adapter: null, reason: 'runs only when checkride.config.json declares targets' }),
      ]);
    }
  });

  test("a repo's own custom check named unclaimed fills the slot and runs, with or without targets", async () => {
    const custom = { command: 'node', args: ['-e', 'process.exit(0)'] };
    const result = await run({ checks: { unclaimed: custom } }, { only: ['unclaimed'] });
    expect(result.summary.checks[0]).toMatchObject({ name: 'unclaimed', adapter: 'custom:unclaimed', origin: 'config', ok: true, exit_code: 0 });
  });
});
