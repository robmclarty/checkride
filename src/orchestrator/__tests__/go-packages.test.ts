/**
 * A Go check names its packages through `{go-packages}` (R5.5): `./...` at a
 * module root, and `./<dir>/...` for each `use` directive at a `go.work` root,
 * expanded before anything spawns, so the runner, the summary's argv and
 * `fix` all see the patterns.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import type { CheckRunner, Out, SummaryCheck } from '../index.js';
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

/** Run git in `dir` as a fixed identity with signing off. */
function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
}

/**
 * A six-module workspace under `ws/`: a requires shared, b requires a, c
 * replaces a module with shared's directory, e requires a module the go.work
 * replaces with d's, and d and shared depend on nothing.
 */
const WORKSPACE: Record<string, string> = {
  'ws/go.work': 'go 1.24\n\nuse (\n\t./shared\n\t./a\n\t./b\n\t./c\n\t./d\n\t./e\n)\n\nreplace example.com/dee => ./d\n',
  'ws/shared/go.mod': 'module example.com/shared\n\ngo 1.24\n',
  'ws/shared/shared.go': 'package shared\n',
  'ws/a/go.mod': 'module example.com/a\n\ngo 1.24\n\nrequire example.com/shared v0.0.0\n',
  'ws/a/a.go': 'package a\n',
  'ws/b/go.mod': 'module example.com/b\n\ngo 1.24\n\nrequire (\n\texample.com/a v0.0.0\n)\n',
  'ws/b/b.go': 'package b\n',
  'ws/c/go.mod': 'module example.com/c\n\ngo 1.24\n\nrequire example.com/common v0.0.0\n\nreplace example.com/common => ../shared\n',
  'ws/c/c.go': 'package c\n',
  'ws/d/go.mod': 'module example.com/d\n\ngo 1.24\n',
  'ws/d/d.go': 'package d\n',
  'ws/e/go.mod': 'module example.com/e\n\ngo 1.24\n\nrequire example.com/dee v0.0.0\n',
  'ws/e/e.go': 'package e\n',
  'ws/README.md': 'the workspace\n',
  '.gitignore': '.check/\n',
};

const EVERY_MODULE = ['./shared/...', './a/...', './b/...', './c/...', './d/...', './e/...'];

/** A `ws` go target whose types, test and dead slots name the go pack's adapters. */
const WS_CONFIG: CheckrideConfig = {
  targets: { ws: { lang: 'go', root: 'ws', checks: { types: 'go-build', test: 'go-test', dead: 'deadcode' } } },
};

describe('{go-packages} under --changed (R10.4)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-go-narrow-'));
    git(dir, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(WORKSPACE)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Change `rel` and run `--changed` against main, returning each check's summary entry and the args its runner was handed. */
  async function changing(...rels: string[]): Promise<{ checks: Map<string, SummaryCheck>; args: Map<string, readonly string[]> }> {
    for (const rel of rels) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), `// changed ${rel}\n`, { flag: 'a' });
    }
    const args = new Map<string, readonly string[]>();
    const runner: CheckRunner = (r) => {
      args.set(`${r.target ?? ''}:${r.slot}`, r.adapter?.args ?? []);
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    const result = await runChecks({
      cwd: dir, config: WS_CONFIG, runner, baseline: null, changed: true, base: { ref: 'main', from: '--base' },
      only: ['ws'], json: true, stdout: sink(), stderr: sink(),
    });
    return { checks: new Map(result.summary.checks.map((c) => [c.name, c])), args };
  }

  // F33
  test('a leaf change runs that module alone, records narrowed, and deadcode still runs everything', async () => {
    const { checks, args } = await changing('ws/b/b.go');
    expect(args.get('ws:types')?.slice(-1)).toEqual(['./b/...']);
    expect(args.get('ws:test')).toEqual(['test', '-json', './b/...']);
    expect(checks.get('ws:types')?.narrowed).toEqual({ units: ['./b/...'], total: 6 });
    expect(checks.get('ws:test')?.narrowed).toEqual({ units: ['./b/...'], total: 6 });
    expect(args.get('ws:dead')).toEqual(['exec', 'deadcode', '-test', ...EVERY_MODULE]);
    expect(checks.get('ws:dead')).not.toHaveProperty('narrowed');
  });

  // F33
  test("a shared module's change runs it and every module that depends on it, transitively, through requires and replaces", async () => {
    const { checks, args } = await changing('ws/shared/shared.go');
    expect(args.get('ws:test')).toEqual(['test', '-json', './shared/...', './a/...', './b/...', './c/...']);
    expect(checks.get('ws:test')?.narrowed).toEqual({ units: ['./shared/...', './a/...', './b/...', './c/...'], total: 6 });
  });

  test("a go.work replace makes a module depend on the one whose directory it names", async () => {
    const { args } = await changing('ws/d/d.go');
    expect(args.get('ws:test')).toEqual(['test', '-json', './d/...', './e/...']);
  });

  test('two changed modules run both, in go.work order', async () => {
    const { args } = await changing('ws/e/e.go', 'ws/a/a.go');
    expect(args.get('ws:test')).toEqual(['test', '-json', './a/...', './b/...', './e/...']);
  });

  // F34, and the other files that move the module graph.
  test.each(['ws/go.work', 'ws/go.work.sum', 'ws/c/go.mod'])('a change to %s runs every module, and records nothing narrowed', async (rel) => {
    const { checks, args } = await changing(rel);
    expect(args.get('ws:test')).toEqual(['test', '-json', ...EVERY_MODULE]);
    expect(checks.get('ws:test')).not.toHaveProperty('narrowed');
  });

  test('a workspace file it cannot parse runs every module', async () => {
    await writeFile(join(dir, 'ws/e/go.mod'), 'module example.com/e\n\nrequire (\n\texample.com/dee v0.0.0\n');
    git(dir, 'commit', '-q', '-am', 'an unclosed block');
    const { checks, args } = await changing('ws/b/b.go');
    expect(args.get('ws:test')).toEqual(['test', '-json', ...EVERY_MODULE]);
    expect(checks.get('ws:test')).not.toHaveProperty('narrowed');
  });

  test('a change outside every module skips the narrowing checks with their reason, and runs the rest', async () => {
    const { checks, args } = await changing('ws/README.md');
    for (const name of ['ws:types', 'ws:test']) {
      expect(checks.get(name)).toMatchObject({ skipped: true, ok: true, reason: 'no Go module changed under ws' });
    }
    expect(args.has('ws:test')).toBe(false);
    expect(args.get('ws:dead')).toEqual(['exec', 'deadcode', '-test', ...EVERY_MODULE]);
  });

  test('when git cannot list the changed paths, as outside a repository, every module runs', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'checkride-go-nogit-'));
    try {
      for (const [rel, content] of Object.entries(WORKSPACE)) {
        await mkdir(dirname(join(bare, rel)), { recursive: true });
        await writeFile(join(bare, rel), content);
      }
      const args = new Map<string, readonly string[]>();
      const result = await runChecks({
        cwd: bare, config: WS_CONFIG, baseline: null, changed: true, only: ['ws:test'], json: true, stdout: sink(), stderr: sink(),
        runner: (r) => { args.set(r.slot, r.adapter?.args ?? []); return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); },
      });
      expect(args.get('test')).toEqual(['test', '-json', ...EVERY_MODULE]);
      expect(result.summary.checks.find((c) => c.name === 'ws:test')).not.toHaveProperty('narrowed');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('a single module has nothing to narrow', async () => {
    await writeFile(join(dir, 'checkride.config.json'), '{}');
    await mkdir(join(dir, 'api'), { recursive: true });
    await writeFile(join(dir, 'api/go.mod'), 'module example.com/api\n\ngo 1.24\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'api');
    await writeFile(join(dir, 'api/main.go'), 'package main\n');
    const args = new Map<string, readonly string[]>();
    const result = await runChecks({
      cwd: dir,
      config: { targets: { api: { lang: 'go', root: 'api', checks: { test: 'go-test' } } } },
      runner: (r) => { args.set(r.slot, r.adapter?.args ?? []); return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); },
      baseline: null, changed: true, base: { ref: 'main', from: '--base' }, only: ['api:test'], json: true, stdout: sink(), stderr: sink(),
    });
    expect(args.get('test')).toEqual(['test', '-json', './...']);
    expect(result.summary.checks.find((c) => c.name === 'api:test')).not.toHaveProperty('narrowed');
  });
});

/**
 * examples/go-workspace's shape: `api` imports `greet` with no `require`,
 * which go.work resolves on its own, and `web` imports it only from a test.
 * `greet/tools` is a module of its own that go.work never uses, so what it
 * imports is no edge of `greet`'s.
 */
const SHOP: Record<string, string> = {
  'go.work': 'go 1.24\n\nuse (\n\t./greet\n\t./api\n\t./web\n)\n',
  'greet/go.mod': 'module example.com/shop/greet\n\ngo 1.24\n',
  'greet/greet.go': 'package greet\n\n// Hello greets name.\nfunc Hello(name string) string { return name }\n',
  'greet/tools/go.mod': 'module example.com/shop/greet/tools\n\ngo 1.24\n',
  'greet/tools/tools.go': 'package tools\n\nimport (\n\t"example.com/shop/api"\n\t_ "example.com/shop/web"\n)\n',
  'api/go.mod': 'module example.com/shop/api\n\ngo 1.24\n',
  'api/main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/shop/greet"\n)\n\nfunc main() { fmt.Println(greet.Hello("gopher")) }\n',
  'web/go.mod': 'module example.com/shop/web\n\ngo 1.24\n',
  'web/web.go': 'package web\n',
  'web/web_test.go': 'package web_test\n\nimport (\n\t"testing"\n\n\tg "example.com/shop/greet"\n)\n\nfunc TestHello(t *testing.T) { _ = g.Hello("x") }\n',
  '.gitignore': '.check/\n',
};

describe('{go-packages} under --changed: the imports go.work resolves (R10.4)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-go-imports-'));
    git(dir, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(SHOP)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Change `rel` and run `shop:test` under `--changed` against main, returning its args and summary entry. */
  async function changing(rel: string): Promise<{ args: readonly string[] | undefined; entry: SummaryCheck | undefined }> {
    await writeFile(join(dir, rel), '// changed\n', { flag: 'a' });
    let args: readonly string[] | undefined;
    const result = await runChecks({
      cwd: dir,
      config: { targets: { shop: { lang: 'go', root: '.', checks: { test: 'go-test' } } } },
      runner: (r) => { args = r.adapter?.args; return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' }); },
      baseline: null, changed: true, base: { ref: 'main', from: '--base' }, only: ['shop:test'], json: true, stdout: sink(), stderr: sink(),
    });
    return { args, entry: result.summary.checks.find((c) => c.name === 'shop:test') };
  }

  test('a change to greet runs every module that imports it, with no require, and from a _test.go alone', async () => {
    const { args, entry } = await changing('greet/greet.go');
    expect(args).toEqual(['test', '-json', './greet/...', './api/...', './web/...']);
    expect(entry?.narrowed).toEqual({ units: ['./greet/...', './api/...', './web/...'], total: 3 });
  });

  test("a nested go.mod's imports are its own module's, so a change to api runs api alone", async () => {
    const { args } = await changing('api/main.go');
    expect(args).toEqual(['test', '-json', './api/...']);
  });

  test('a .go file that cannot be read makes its module depend on every module', async () => {
    await symlink('nowhere.go', join(dir, 'web/broken.go'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'a dangling link');
    const { args } = await changing('api/main.go');
    expect(args).toEqual(['test', '-json', './api/...', './web/...']);
  });
});
