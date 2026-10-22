/**
 * The go pack, run end to end against the real tools (R5.5).
 *
 * A module with golangci-lint configured and deadcode and staticcheck declared
 * as `go.mod` tools is checked from a go target. Clean, every check is green,
 * deadcode resolves through the `tool` directive at the version `go.mod`
 * requires, and nothing is written into the checkout. Each plant fails the
 * check S4 names for it, a workspace root names each module it uses, and
 * staticcheck fills `lint` when a `tool` directive pins it and no
 * golangci-lint config does. Setup fetches the tools' modules once, which C4
 * allows; the checks themselves run offline.
 */

import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { setupStep } from '../helpers/setup.js';
import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The tools the module declares, at the versions their rows were checked against. */
const GO_TOOLS = ['golang.org/x/tools/cmd/deadcode@v0.52.0', 'honnef.co/go/tools/cmd/staticcheck@v0.8.2'];

const MAIN = 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(greet("go")) }\n\nfunc greet(name string) string { return "hello, " + name }\n';
const MAIN_TEST = 'package main\n\nimport "testing"\n\nfunc TestGreet(t *testing.T) {\n\tif greet("go") != "hello, go" {\n\t\tt.Fatal("wrong greeting")\n\t}\n}\n';

/** The release of the go this machine's PATH runs, as `go env GOVERSION` names it without its `go`, which a check run here records. */
/** A main package whose `init` makes `n` unchecked `os.Setenv` calls, one errcheck and one gosec finding each. */
function setenvs(n: number): string {
  return `package main\n\nimport "os"\n\nfunc init() {\n${Array.from({ length: n }, (_, i) => `\tos.Setenv("K${i}", "v")`).join('\n')}\n}\n`;
}

function goRelease(): string {
  return execFileSync('go', ['env', 'GOVERSION'], { encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim().replace(/^go/, '');
}

type Check = Record<string, unknown>;
type Run = { code: number; stderr: string; checks: Map<string, Check> };

describeWithToolchain('go')('the go pack', () => {
  let template: string;
  let dir: string;

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'checkride-go-pack-template-'));
    const api = join(template, 'api');
    await mkdir(api, { recursive: true });
    await writeFile(join(api, 'go.mod'), 'module example.com/api\n\ngo 1.24\n');
    await writeFile(join(api, 'main.go'), MAIN);
    await writeFile(join(api, 'main_test.go'), MAIN_TEST);
    await writeFile(join(api, '.golangci.yml'), 'version: "2"\n');
    // Setup may download; the checks never do.
    await setupStep('go', ['get', '-tool', ...GO_TOOLS], { cwd: api });
    await setupStep('go', ['mod', 'download'], { cwd: api });
    await writeFile(join(template, 'checkride.config.json'), JSON.stringify({ targets: { api: { lang: 'go', root: 'api' } } }));
  }, 300_000);
  afterAll(async () => { await rm(template, { recursive: true, force: true }); });

  beforeEach(async (context) => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-go-pack-'));
    await cp(template, dir, { recursive: true });
    context.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  };

  async function run(...args: string[]): Promise<Run> {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Check[] };
    return { code, stderr, checks: new Map(summary.checks.map((c) => [String(c['name']), c])) };
  }

  test('a clean module is green, each tool resolving through its pin, and nothing lands in the checkout', async () => {
    const before = (await readdir(join(dir, 'api'))).toSorted();
    const { code, checks, stderr } = await run('--only', 'api', '--include', 'api:format');
    expect(code, stderr).toBe(0);
    expect(checks.get('api:types')).toMatchObject({
      ok: true, adapter: 'go-build', argv: ['go', 'build', '-o', '/dev/null', '-json', './...'],
    });
    expect(checks.get('api:format')).toMatchObject({ ok: true, adapter: 'gofmt' });
    // golangci-lint type-checks through the go its PATH finds, and records that go's release.
    expect(checks.get('api:lint')).toMatchObject({ ok: true, adapter: 'golangci-lint', output_file: 'api/lint.json', toolchain_version: goRelease() });
    expect(checks.get('api:dead')).toMatchObject({
      ok: true,
      adapter: 'deadcode',
      detected_by: 'api/go.mod: golang.org/x/tools/cmd/deadcode',
      pin_source: 'go-mod-tool',
      tool_version: 'v0.52.0',
      argv: ['go', 'tool', 'deadcode', '-test', './...'],
    });
    expect(checks.get('api:test')).toMatchObject({ ok: true, adapter: 'go-test', output_file: 'api/test.jsonl' });
    expect((await readdir(join(dir, 'api'))).toSorted()).toEqual(before);
  });

  // S4: a Go compile error fails api:types.
  test('a compile error fails api:types, its events captured as JSON lines', async () => {
    await put('api/broken.go', 'package main\n\nvar n int = "nope"\n');
    const { code, checks } = await run('--only', 'api:types');
    expect(code).toBe(1);
    expect(checks.get('api:types')).toMatchObject({ ok: false, exit_code: 1, output_file: 'api/types.jsonl' });
    expect(await readFile(join(dir, '.check', 'api', 'types.jsonl'), 'utf8')).toContain('"Action":"build-fail"');
  });

  // S4: an ignored error return fails api:lint.
  test('an ignored error return fails api:lint', async () => {
    await put('api/remove.go', 'package main\n\nimport "os"\n\nfunc init() { os.Remove("x") }\n');
    const { code, checks } = await run('--only', 'api:lint');
    expect(code).toBe(1);
    expect(checks.get('api:lint')).toMatchObject({ ok: false, output_file: 'api/lint.json' });
    const report = JSON.parse(await readFile(join(dir, '.check', 'api', 'lint.json'), 'utf8')) as { Issues: { FromLinter: string }[] };
    expect(report.Issues.map((i) => i.FromLinter)).toContain('errcheck');
  });

  /**
   * golangci-lint shows 3 issues with one message and one a line unless told
   * not to (#10), and a key with no line grandfathers as many as it was
   * captured with (#14): four identical unchecked calls, each flagged by
   * errcheck and gosec, are eight findings under two keys counted four, and
   * a fifth call is new under both.
   */
  test('every issue golangci-lint finds reaches the baseline, counted, and one more fails', async () => {
    await put('api/.golangci.yml', 'version: "2"\nlinters:\n  enable:\n    - gosec\n');
    await put('api/env.go', setenvs(4));
    const captured = await run('baseline');
    expect(captured.code, captured.stderr).toBe(0);
    const baseline = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as { slots: Record<string, string[]>; counts?: Record<string, Record<string, number>> };
    const keys = baseline.slots['api:lint'] ?? [];
    expect(keys.map((k) => k.split(':')[1])).toEqual(['errcheck', 'gosec']);
    expect(baseline.counts?.['api:lint']).toEqual(Object.fromEntries(keys.map((k) => [k, 4])));
    expect((await run('--only', 'api:lint')).checks.get('api:lint')).toMatchObject({ ok: true, baselined: 8 });

    await put('api/env.go', setenvs(5));
    const { code, checks, stderr } = await run('--only', 'api:lint');
    expect(code).toBe(1);
    expect(checks.get('api:lint')).toMatchObject({ ok: false, baselined: 8, new_count: 2, new: keys });
    expect(stderr).toContain(`${keys[0] ?? ''} (5 found, 4 grandfathered)`);
  });

  // S4: a failing Go test fails api:test.
  test('a failing test fails api:test', async () => {
    await put('api/main_test.go', MAIN_TEST.replace('"hello, go"', '"goodbye"'));
    const { code, checks } = await run('--only', 'api:test');
    expect(code).toBe(1);
    expect(checks.get('api:test')).toMatchObject({ ok: false, exit_code: 1, output_file: 'api/test.jsonl' });
  });

  test('an unformatted file fails api:format, which gofmt -l reports with exit 0', async () => {
    await put('api/ugly.go', 'package main\nfunc  ugly( ) {}\n');
    const { checks, stderr } = await run('--only', 'api:format');
    expect(checks.get('api:format')).toMatchObject({
      ok: false, exit_code: 0, reason: 'gofmt exited 0 but reported findings on stdout',
    });
    expect(stderr).toContain('gofmt exited 0 but reported findings on stdout');
    expect(await readFile(join(dir, '.check', 'api', 'format.stdout.txt'), 'utf8')).toBe('ugly.go\n');
  });

  test('an unreachable function fails api:dead, which deadcode reports with exit 0', async () => {
    await put('api/orphan.go', 'package main\n\nfunc orphan() int { return 1 }\n');
    const { checks } = await run('--only', 'api:dead');
    expect(checks.get('api:dead')).toMatchObject({ ok: false, exit_code: 0, reason: 'deadcode exited 0 but reported findings on stdout' });
    expect(await readFile(join(dir, '.check', 'api', 'dead.stdout.txt'), 'utf8')).toContain('unreachable func: orphan');
  });

  test('with no golangci-lint config, a staticcheck tool directive fills lint, captured as JSON lines', async () => {
    await rm(join(dir, 'api', '.golangci.yml'));
    await put('api/orphan.go', 'package main\n\nfunc orphan() int { return 1 }\n');
    const { checks } = await run('--only', 'api:lint');
    expect(checks.get('api:lint')).toMatchObject({
      ok: false,
      adapter: 'staticcheck',
      detected_by: 'api/go.mod: honnef.co/go/tools/cmd/staticcheck',
      pin_source: 'go-mod-tool',
      tool_version: 'v0.8.2',
      output_file: 'api/lint.jsonl',
    });
    expect(await readFile(join(dir, '.check', 'api', 'lint.jsonl'), 'utf8')).toContain('"code":"U1000"');
  });

  test('a workspace root names each module it uses, and golangci-lint reads them all', async () => {
    const ws = join(dir, 'ws');
    for (const name of ['a', 'b']) {
      await put(`ws/${name}/go.mod`, `module example.com/${name}\n\ngo 1.24\n`);
      await put(`ws/${name}/${name}.go`, `package ${name}\n\nimport "os"\n\n// Run runs.\nfunc Run() { os.Remove("${name}") }\n`);
    }
    await put('ws/go.work', 'go 1.24\n\nuse (\n\t./a\n\t./b\n)\n');
    await put('ws/.golangci.yml', 'version: "2"\n');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { api: { lang: 'go', root: 'api' }, ws: { lang: 'go', root: 'ws' } } }));
    const { checks } = await run('--only', 'ws:types,ws:lint');
    expect(checks.get('ws:types')).toMatchObject({ ok: true, argv: ['go', 'build', '-o', '/dev/null', '-json', './a/...', './b/...'] });
    const lint = JSON.parse(await readFile(join(ws, '..', '.check', 'ws', 'lint.json'), 'utf8')) as { Issues: { Pos: { Filename: string } }[] };
    expect(lint.Issues.map((i) => i.Pos.Filename).toSorted()).toEqual(['a/a.go', 'b/b.go']);
    expect(checks.get('ws:lint')).toMatchObject({ ok: false });
  });

  test('under --changed, a change to a module also builds the modules that import it with no require', async () => {
    await rm(dir, { recursive: true, force: true });
    await cp(join(here, '..', '..', 'examples', 'go-workspace'), dir, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
    };
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // api calls greet.Hello, and its go.mod requires nothing: go.work resolves the import.
    const greet = join(dir, 'greet', 'greet.go');
    await writeFile(greet, (await readFile(greet, 'utf8')).replace('func Hello(', 'func Greet('));
    const { code, checks, stderr } = await run('--changed', '--base', 'HEAD', '--only', 'shop:types');
    expect(code, stderr).toBe(1);
    expect(checks.get('shop:types')).toMatchObject({ ok: false, narrowed: { units: ['./greet/...', './api/...'], total: 2 } });
  });
});
