/**
 * The go pack's spawn environment, against the real Go toolchain (R6.4).
 *
 * A go target's checks run with Go's downloads switched off, whatever the
 * user's own environment says: a module missing from the module cache fails
 * fast, with no network call, and the run names `go mod download` (F1); a
 * `go.mod` that asks for a newer Go fails naming it rather than fetch it (F2);
 * and a vendored module still builds with an empty module cache, because the
 * pack leaves `GOFLAGS` alone (D54). The checks here are each target's own
 * `types` custom check, `go build -json`, which R6.4 covers like an adapter.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The config every case runs: an `api` go target whose `types` check is `go build -json`. */
const CONFIG = {
  targets: {
    api: {
      lang: 'go',
      root: 'api',
      checks: { types: { command: 'go', args: ['build', '-json', './...'], outputFile: 'types.jsonl' } },
    },
  },
};

/** The `go.sum` lines `go mod tidy` writes for golang.org/x/text v0.22.0. */
const TEXT_SUM = [
  'golang.org/x/text v0.22.0 h1:bofq7m3/HAFvbF51jz3Q9wLg3jkvSPuiZu/pD1XwgtM=',
  'golang.org/x/text v0.22.0/go.mod h1:YRoo4H8PVmsu+E3Ou7cqLVH8oXWIHVoX0jqUWALQhfY=',
  '',
].join('\n');

type Run = { code: number; stderr: string; ms: number; check: Record<string, unknown> | undefined };

describeWithToolchain('go')('the go pack spawn environment (R6.4)', () => {
  let dir: string;
  let cache: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-go-env-'));
    cache = join(dir, 'empty-module-cache');
    await mkdir(join(dir, 'api'), { recursive: true });
    await mkdir(cache);
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(CONFIG));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  };

  /**
   * Run `api:types` with an empty module cache and a user environment that
   * would download, so only the pack's variables keep it offline.
   */
  async function runTypes(): Promise<Run> {
    const env = { ...process.env, GOMODCACHE: cache, GOPROXY: 'https://proxy.golang.org', GOTOOLCHAIN: 'auto', GOFLAGS: '' };
    const start = Date.now();
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, '--only', 'api:types'], { cwd: dir, env }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Record<string, unknown>[] };
    return { code, stderr, ms: Date.now() - start, check: summary.checks.find((c) => c['name'] === 'api:types') };
  }

  // F1
  test('a module missing from the module cache fails fast, offline, and the run names go mod download', async () => {
    await put('api/go.mod', 'module example.com/api\n\ngo 1.24\n\nrequire golang.org/x/text v0.22.0\n');
    await put('api/go.sum', TEXT_SUM);
    await put('api/main.go', 'package main\n\nimport (\n\t"fmt"\n\n\t"golang.org/x/text/language"\n)\n\nfunc main() { fmt.Println(language.English) }\n');
    const run = await runTypes();
    expect(run.code).toBe(1);
    expect(run.check).toMatchObject({ ok: false, exit_code: 1, pack: 'go', output_file: 'api/types.jsonl' });
    expect(run.ms).toBeLessThan(30_000);
    expect(await readFile(join(dir, '.check', 'api', 'types.jsonl'), 'utf8')).toContain('module lookup disabled by GOPROXY=off');
    expect(run.stderr).toContain('run `go mod download` first');
  });

  // F2
  test('a go.mod that requires a newer Go fails naming that version, and nothing downloads', async () => {
    await put('api/go.mod', 'module example.com/api\n\ngo 1.99\n');
    await put('api/main.go', 'package main\n\nfunc main() {}\n');
    const run = await runTypes();
    expect(run.code).toBe(1);
    expect(run.check).toMatchObject({ ok: false, exit_code: 1 });
    const stderr = await readFile(join(dir, '.check', 'api', 'types.stderr.txt'), 'utf8');
    expect(stderr).toContain('go.mod requires go >= 1.99');
    expect(stderr).toContain('GOTOOLCHAIN=local');
  });

  // D54
  test('a vendored module builds with an empty module cache', async () => {
    await put('api/go.mod', 'module example.com/api\n\ngo 1.24\n\nrequire example.com/greet v1.0.0\n');
    await put('api/main.go', 'package main\n\nimport "example.com/greet"\n\nfunc main() { greet.Hello() }\n');
    await put('api/vendor/modules.txt', '# example.com/greet v1.0.0\n## explicit\nexample.com/greet\n');
    await put('api/vendor/example.com/greet/greet.go', 'package greet\n\n// Hello greets.\nfunc Hello() {}\n');
    const run = await runTypes();
    expect(run.check).toMatchObject({ ok: true, exit_code: 0 });
    expect(run.code).toBe(0);
  });
});
