/**
 * The python pack, run end to end against the real tools (R5.7).
 *
 * A uv project, a `src/` package with one test, locks ruff, mypy,
 * basedpyright and pytest as dev dependencies, and is checked from a python
 * target. Setup runs `uv sync` once, which fetches the wheels (C4 allows a
 * setup download), and each case links that environment into its own copy.
 * Clean, every check is green, each tool running from the environment at the
 * version `uv.lock` pins; ruff is detected by that pin, mypy and pytest by
 * their `pyproject.toml` tables. A ruff violation fails `lint`, a type error
 * fails `types` under mypy and under basedpyright, a run that collects no
 * tests fails `test` with pytest's exit 5 (F44), and a target with no
 * environment fails naming `uv sync` (F41).
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The tool versions every case runs, as the fixture's `uv.lock` pins them. */
const VERSIONS = { ruff: '0.17.1', mypy: '2.4.0', basedpyright: '1.40.2', pytest: '9.1.1' } as const;

const PYPROJECT = [
  '[project]',
  'name = "kit"',
  'version = "0.1.0"',
  'requires-python = ">=3.12"',
  'dependencies = []',
  '',
  '[dependency-groups]',
  `dev = [${Object.entries(VERSIONS).map(([pkg, version]) => `"${pkg}==${version}"`).join(', ')}]`,
  '',
  '[tool.mypy]',
  'check_untyped_defs = true',
  '',
  '[tool.pytest.ini_options]',
  'pythonpath = ["src"]',
  '',
].join('\n');

const LIB = 'def add_one(x: int) -> int:\n    return x + 1\n';
const TEST = 'from kit import add_one\n\n\ndef test_adds() -> None:\n    assert add_one(1) == 2\n';

const FILES: Record<string, string> = {
  'py/pyproject.toml': PYPROJECT,
  'py/src/kit/__init__.py': LIB,
  'py/tests/test_kit.py': TEST,
  'checkride.config.json': JSON.stringify({ targets: { app: { lang: 'python', root: 'py' } } }),
};

/** What each case's copy leaves out: the environment, which it links instead, and the tools' caches. */
const NOT_COPIED = new Set(['.venv', '.ruff_cache', '.mypy_cache', '.pytest_cache']);

type Check = Record<string, unknown>;

describeWithToolchain('python')('the python pack', () => {
  let template: string;
  let dir: string;

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'checkride-python-pack-template-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(dirname(join(template, rel)), { recursive: true });
      await writeFile(join(template, rel), content);
    }
    const sync = spawnSync('uv', ['sync', '--directory', join(template, 'py')], { encoding: 'utf8', timeout: 170_000 });
    if (sync.status !== 0) throw new Error(`uv sync failed:\n${sync.stderr}`);
  });
  afterAll(async () => { await rm(template, { recursive: true, force: true }); });

  beforeEach(async (context) => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-python-pack-'));
    await cp(template, dir, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
    await symlink(join(template, 'py', '.venv'), join(dir, 'py', '.venv'));
    context.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  });

  const put = (rel: string, content: string): Promise<void> => writeFile(join(dir, rel), content);

  async function run(...args: string[]): Promise<{ code: number; stderr: string; checks: Map<string, Check> }> {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Check[] };
    return { code, stderr, checks: new Map(summary.checks.map((c) => [String(c['name']), c])) };
  }

  test('a clean project is green, each tool running from the environment at the version uv.lock pins', async () => {
    const { code, checks, stderr } = await run('--only', 'app', '--include', 'app:format');
    expect(code, stderr).toBe(0);
    expect(checks.get('app:lint')).toMatchObject({
      ok: true,
      adapter: 'ruff',
      detected_by: 'py/uv.lock: ruff',
      pin_source: 'uv-lock',
      tool_version: VERSIONS.ruff,
      argv: ['.venv/bin/ruff', 'check', '--no-cache', '--output-format=json', '.'],
      output_file: 'app/lint.json',
    });
    expect(checks.get('app:format')).toMatchObject({ ok: true, adapter: 'ruff-format', pin_source: 'uv-lock' });
    expect(checks.get('app:types')).toMatchObject({
      ok: true,
      adapter: 'mypy',
      detected_by: 'pyproject.toml: [tool.mypy]',
      pin_source: 'uv-lock',
      tool_version: VERSIONS.mypy,
    });
    // A clean mypy prints only a blank line, so it leaves no artifact, JSON lines or text.
    expect(checks.get('app:types')).toMatchObject({ output_file: null });
    expect(existsSync(join(dir, '.check', 'app', 'types.jsonl'))).toBe(false);
    expect(checks.get('app:test')).toMatchObject({
      ok: true,
      adapter: 'pytest',
      detected_by: 'pyproject.toml: [tool.pytest.ini_options]',
      tool_version: VERSIONS.pytest,
    });
  });

  test('a ruff violation fails app:lint, its findings captured as JSON', async () => {
    await put('py/src/kit/__init__.py', `import os\n\n\n${LIB}`);
    const { code, checks } = await run('--only', 'app:lint');
    expect(code).toBe(1);
    expect(checks.get('app:lint')).toMatchObject({ ok: false, exit_code: 1, output_file: 'app/lint.json' });
    const findings = JSON.parse(await readFile(join(dir, '.check', 'app', 'lint.json'), 'utf8')) as { code: string }[];
    expect(findings.map((f) => f.code)).toEqual(['F401']);
  });

  test('a type error fails app:types under mypy, its errors captured as JSON lines', async () => {
    await put('py/src/kit/__init__.py', 'def add_one(x: int) -> int:\n    return "one"\n');
    const { code, checks } = await run('--only', 'app:types');
    expect(code).toBe(1);
    expect(checks.get('app:types')).toMatchObject({ ok: false, exit_code: 1, output_file: 'app/types.jsonl' });
    expect(await readFile(join(dir, '.check', 'app', 'types.jsonl'), 'utf8')).toContain('"code": "return-value"');
  });

  test('basedpyright fills types where the config names it, and fails on the same error', async () => {
    await put('checkride.config.json', JSON.stringify({ targets: { app: { lang: 'python', root: 'py', checks: { types: 'basedpyright' } } } }));
    const clean = await run('--only', 'app:types');
    expect(clean.code, clean.stderr).toBe(0);
    expect(clean.checks.get('app:types')).toMatchObject({ ok: true, adapter: 'basedpyright', tool_version: VERSIONS.basedpyright, output_file: 'app/types.json' });
    await put('py/src/kit/__init__.py', 'def add_one(x: int) -> int:\n    return "one"\n');
    const { code, checks } = await run('--only', 'app:types');
    expect(code).toBe(1);
    expect(checks.get('app:types')).toMatchObject({ ok: false, exit_code: 1 });
    expect(await readFile(join(dir, '.check', 'app', 'types.json'), 'utf8')).toContain('reportReturnType');
  });

  test('a failing test fails app:test', async () => {
    await put('py/tests/test_kit.py', TEST.replace('== 2', '== 3'));
    const { code, checks } = await run('--only', 'app:test');
    expect(code).toBe(1);
    expect(checks.get('app:test')).toMatchObject({ ok: false, exit_code: 1 });
  });

  // F44: no tests collected is a red test slot, never a vacuous green.
  test('a run that collects no tests fails app:test with pytest’s exit 5', async () => {
    await rm(join(dir, 'py', 'tests'), { recursive: true });
    const { code, checks } = await run('--only', 'app:test');
    expect(code).toBe(1);
    expect(checks.get('app:test')).toMatchObject({ ok: false, exit_code: 5 });
  });

  // F41: a tool uv.lock pins never falls back to another copy.
  test('a target with no environment fails naming uv sync, and nothing downloads', async () => {
    await rm(join(dir, 'py', '.venv'));
    const { code, checks } = await run('--only', 'app:lint');
    expect(code).toBe(1);
    expect(checks.get('app:lint')).toMatchObject({ ok: false });
    expect(await readFile(join(dir, '.check', 'app', 'lint.stderr.txt'), 'utf8')).toContain('uv sync');
  });
});
