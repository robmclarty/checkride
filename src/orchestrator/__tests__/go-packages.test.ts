/**
 * A Go check names its packages through `{go-packages}` (R5.5): `./...` at a
 * module root, and `./<dir>/...` for each `use` directive at a `go.work` root,
 * expanded before anything spawns, so the runner, the summary's argv and
 * `fix` all see the patterns.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import type { CheckRunner, Out } from '../index.js';
import { runChecks, runFix } from '../index.js';

function sink(): Out {
  return { write: () => true };
}

/** An `api` go target whose types, lint and test slots name the go pack's adapters. */
const CONFIG: CheckrideConfig = {
  targets: { api: { lang: 'go', root: 'api', checks: { types: 'go-build', lint: 'golangci-lint', test: 'go-test' } } },
};

describe('{go-packages}', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-go-packages-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  };

  /** Run the config, returning the args each check's runner was handed, by check name. */
  async function argsSeen(): Promise<Map<string, readonly string[]>> {
    const seen = new Map<string, readonly string[]>();
    const runner: CheckRunner = (r: ResolvedCheck) => {
      seen.set(`${r.target ?? ''}:${r.slot}`, r.adapter?.args ?? []);
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    await runChecks({ cwd: dir, config: CONFIG, runner, only: ['api'], json: true, stdout: sink(), stderr: sink() });
    return seen;
  }

  test('a module root names ./...', async () => {
    await put('api/go.mod', 'module example.com/api\n\ngo 1.24\n');
    const seen = await argsSeen();
    expect(seen.get('api:types')).toEqual(['build', '-o', '/dev/null', '-json', './...']);
    expect(seen.get('api:test')).toEqual(['test', '-json', './...']);
    expect(seen.get('api:lint')?.slice(-1)).toEqual(['./...']);
  });

  test('a go.work root names each module it uses, in its order', async () => {
    await put('api/go.work', 'go 1.24\n\nuse ./svc\n\nuse (\n\t./lib // shared\n\t.\n)\n');
    const seen = await argsSeen();
    expect(seen.get('api:types')).toEqual(['build', '-o', '/dev/null', '-json', './svc/...', './lib/...', './...']);
  });

  test('fix hands its fixer the same patterns', async () => {
    await put('api/go.work', 'go 1.24\n\nuse (\n\t./a\n\t./b\n)\n');
    const fixArgs: (readonly string[] | undefined)[] = [];
    await runFix({
      cwd: dir, config: CONFIG, stderr: sink(),
      fixRunner: (adapter) => { fixArgs.push(adapter.fixArgs); return Promise.resolve({ ok: true, exit_code: 0 }); },
    });
    expect(fixArgs).toEqual([['exec', 'golangci-lint', 'run', '--fix', '--allow-serial-runners', './a/...', './b/...']]);
  });
});
