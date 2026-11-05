/**
 * The odin pack, run end to end against the real compiler.
 *
 * Three Odin packages, a program at `app/` with one test, a library it
 * imports at `kit/`, and a library nested in the program's directory at
 * `app/internal/`, are checked as three odin targets, the compiler pinned by
 * the repo's own `mise.toml` at the release this repo's dev `mise.toml`
 * pins. Clean, every check is green and records `pin_source: "mise"` with
 * that release; the unused-procedure vet names the program's package and
 * sits each library out with its reason. A vet error fails `lint`, an
 * uncalled procedure fails `dead`, a failing `@(test)` fails `test`, and a
 * syntax error, which stops the compiler before it checks anything, is a
 * run the baseline neither masks nor prunes with. `--discover` proposes one
 * target per directory holding `.odin` files, the nested one included.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');

/** The Odin release this repo's `mise.toml` pins, so installed on any machine the odin cases run on. */
async function devOdin(): Promise<string> {
  const version = /^odin\s*=\s*"([^"]+)"/m.exec(await readFile(join(ROOT, 'mise.toml'), 'utf8'))?.[1];
  if (version === undefined) throw new Error('mise.toml pins no odin');
  return version;
}

const KIT = 'package kit\n\nadd :: proc(a, b: int) -> int {\n\treturn a + b\n}\n';
const APP = 'package app\n\nimport "core:fmt"\nimport kit "../kit"\n\nmain :: proc() {\n\tfmt.println(twice(2))\n}\n\ntwice :: proc(n: int) -> int {\n\treturn kit.add(n, n)\n}\n';
const APP_TEST = '#+test\npackage app\n\nimport "core:testing"\n\n@(test)\ntwice_doubles :: proc(t: ^testing.T) {\n\ttesting.expect(t, twice(2) == 4)\n}\n';
const INTERNAL = 'package internal\n\nVERSION :: "0.1.0"\n';

const CONFIG = {
  targets: {
    app: { lang: 'odin', root: 'app' },
    internal: { lang: 'odin', root: 'app/internal' },
    kit: { lang: 'odin', root: 'kit' },
  },
};

type Check = Record<string, unknown>;
type Summary = { checks: Check[]; targets?: Record<string, unknown>[] };

describeWithToolchain('odin')('the odin pack', () => {
  let dir: string;
  let odin: string;

  beforeEach(async (context) => {
    odin = await devOdin();
    // The compiler prints each path as it resolved it, so the repo root is
    // its real path too, and a finding's file is named from it.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'checkride-odin-pack-')));
    const files: Record<string, string> = {
      'app/main.odin': APP,
      'app/app_test.odin': APP_TEST,
      'app/internal/internal.odin': INTERNAL,
      'kit/kit.odin': KIT,
      'mise.toml': `[tools]\nodin = "${odin}"\n`,
      'checkride.config.json': JSON.stringify(CONFIG),
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    context.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  });

  const put = (rel: string, content: string): Promise<void> => writeFile(join(dir, rel), content);

  async function run(...args: string[]): Promise<{ code: number; stderr: string; summary: Summary; checks: Map<string, Check> }> {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Summary;
    return { code, stderr, summary, checks: new Map(summary.checks.map((c) => [String(c['name']), c])) };
  }

  test('a clean repo is green, every row the compiler mise pins, the unused-procedure vet naming the program and sitting each library out', async () => {
    const { code, checks, stderr } = await run();
    expect(code, stderr).toBe(0);
    expect(checks.get('app:types')).toMatchObject({ ok: true, adapter: 'odin-check', pin_source: 'mise', tool_version: odin, output_file: null });
    expect(checks.get('app:types')?.['detected_by']).toBeUndefined();
    expect(checks.get('app:types')?.['argv']).toEqual(expect.arrayContaining(['mise', 'exec', '--', 'odin', 'check', '.', '-no-entry-point', '-json-errors']));
    expect(checks.get('app:lint')).toMatchObject({ ok: true, adapter: 'odin-vet', pin_source: 'mise' });
    expect(checks.get('app:lint')?.['argv']).toEqual(expect.arrayContaining(['-vet', '-warnings-as-errors']));
    expect(checks.get('app:dead')).toMatchObject({ ok: true, adapter: 'odin-unused', exit_code: 0 });
    expect(checks.get('app:dead')?.['argv']).toEqual(expect.arrayContaining(['-vet-unused-procedures', '-vet-packages:app']));
    expect(checks.get('app:test')).toMatchObject({ ok: true, adapter: 'odin-test', pin_source: 'mise', tool_version: odin });
    // A library has no program to vet unused procedures from.
    for (const target of ['kit', 'internal']) {
      expect(checks.get(`${target}:dead`), target).toMatchObject({ ok: true, skipped: true, reason: `no main procedure in ${target === 'kit' ? 'kit' : 'app/internal'}: unused procedures are vetted from a program` });
      expect(checks.get(`${target}:types`), target).toMatchObject({ ok: true, exit_code: 0 });
      // No @(test) procedure: the package still builds and links, and passes.
      expect(checks.get(`${target}:test`), target).toMatchObject({ ok: true, exit_code: 0 });
    }
    expect(checks.get('unclaimed')).toMatchObject({ ok: true });
  });

  test('a vet error fails app:lint, its errors captured as the JSON the compiler printed, while app:types stays green', async () => {
    await put('app/main.odin', APP.replace('import "core:fmt"\n', 'import "core:fmt"\nimport "core:os"\n'));
    const { code, checks } = await run('--only', 'app:lint,app:types');
    expect(code).toBe(1);
    expect(checks.get('app:lint')).toMatchObject({ ok: false, exit_code: 1, output_file: null });
    expect(checks.get('app:types')).toMatchObject({ ok: true });
    const errors = JSON.parse(await readFile(join(dir, '.check', 'app', 'lint.stderr.txt'), 'utf8')) as { errors: { msgs: string[] }[] };
    expect(errors.errors.map((e) => e.msgs[0])).toEqual(["'os' declared but not used"]);
  });

  test('a procedure nothing calls fails app:dead', async () => {
    await put('app/main.odin', `${APP}\nspare :: proc() {}\n`);
    const { code, checks } = await run('--only', 'app:dead');
    expect(code).toBe(1);
    expect(checks.get('app:dead')).toMatchObject({ ok: false, exit_code: 1 });
    expect(await readFile(join(dir, '.check', 'app', 'dead.stderr.txt'), 'utf8')).toContain("'spare' declared but not used");
  });

  test('a failing test fails app:test', async () => {
    await put('app/app_test.odin', APP_TEST.replace('== 4', '== 5'));
    const { code, checks } = await run('--only', 'app:test');
    expect(code).toBe(1);
    expect(checks.get('app:test')).toMatchObject({ ok: false, exit_code: 1 });
  });

  test('a syntax error is a run that stopped short, which the baseline neither masks nor prunes with', async () => {
    const captured = await run('baseline');
    expect(captured.code, captured.stderr).toBe(0);
    await put('app/main.odin', 'package app\n\nbroken :: proc( {\n');
    const { code, checks } = await run('--only', 'app:types');
    expect(code).toBe(1);
    expect(checks.get('app:types')).toMatchObject({ ok: false, exit_code: 1 });
    expect(checks.get('app:types')?.['reason']).toMatch(/^odin stopped short at `app\/main\.odin\(3:\d+\) Syntax Error: .+`, so the baseline neither masked its findings nor pruned its keys$/);
  });

  test('--discover proposes one target per directory holding .odin files, the nested package included', async () => {
    await put('checkride.config.json', '{}');
    const { code, summary, stderr } = await run('--discover');
    expect(code, stderr).toBe(0);
    expect(summary.targets).toEqual([
      { name: 'app', pack: 'odin', root: 'app', discovered: true },
      { name: 'internal', pack: 'odin', root: 'app/internal', discovered: true },
      { name: 'kit', pack: 'odin', root: 'kit', discovered: true },
    ]);
  });
});
