import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkSmoke, enumerateExports, scanValueExports } from '../smoke.js';
import type { SmokeSpawn } from '../smoke.js';

describe('scanValueExports', () => {
  test('collects declared function/const/class/enum value exports', () => {
    const dts = [
      'export declare function bar(): void;',
      'export declare const foo: number;',
      'export declare class Baz {}',
      'export declare abstract class Qux {}',
      'export declare enum Color { Red, Green }',
    ].join('\n');
    expect(scanValueExports(dts)).toEqual(['Baz', 'Color', 'Qux', 'bar', 'foo']);
  });

  test('excludes type-only exports (type alias, interface, export type)', () => {
    const dts = [
      'export declare const live: number;',
      'export type Alias = string;',
      'export interface Shape { x: number }',
      'export type { OnlyType } from "./types.js";',
    ].join('\n');
    expect(scanValueExports(dts)).toEqual(['live']);
  });

  test('collects aliased and re-exported names, dropping `type` specifiers', () => {
    const dts = [
      'export { foo as bar, plain } from "./impl.js";',
      'export { type TypeOnly, alsoValue } from "./impl.js";',
    ].join('\n');
    expect(scanValueExports(dts)).toEqual(['alsoValue', 'bar', 'plain']);
  });

  test('excludes const enums (no runtime object) and namespace-nested exports', () => {
    const dts = [
      'export declare const enum Inlined { A, B }',
      'export declare namespace NS {',
      '  export const inner: number;',
      '}',
      'export declare const kept: number;',
    ].join('\n');
    expect(scanValueExports(dts)).toEqual(['kept']);
  });

  test('ignores an `export` that appears only inside a comment', () => {
    const dts = ['/** @example export declare function fake(): void; */', 'export declare const real: number;'].join('\n');
    expect(scanValueExports(dts)).toEqual(['real']);
  });
});

describe('enumerateExports', () => {
  test('enumerates literal exports subpaths with self-reference specifiers', () => {
    const { targets, skipped } = enumerateExports({
      name: '@scope/lib',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './sub': './dist/sub.js',
      },
    });
    expect(skipped).toEqual([]);
    expect(targets.map((t) => [t.subpath, t.specifier])).toEqual([
      ['.', '@scope/lib'],
      ['./sub', '@scope/lib/sub'],
    ]);
    expect(targets[0]?.importFile).toBe('dist/index.js');
    expect(targets[0]?.typesFile).toBe('dist/index.d.ts');
  });

  test('skips and counts wildcard and null subpaths', () => {
    const { targets, skipped } = enumerateExports({
      name: 'lib',
      exports: {
        './features/*': './dist/features/*.js',
        './blocked': null,
        '.': './dist/index.js',
      },
    });
    expect(targets.map((t) => t.subpath)).toEqual(['.']);
    expect(skipped).toEqual([
      { subpath: './features/*', reason: 'wildcard subpath' },
      { subpath: './blocked', reason: 'null (blocked) subpath' },
    ]);
  });

  test('flags a dual package (explicit require condition) for a require probe', () => {
    const { targets } = enumerateExports({
      name: 'lib',
      exports: { '.': { import: './dist/index.js', require: './dist/index.cjs', types: './dist/index.d.ts' } },
    });
    expect(targets[0]?.hasRequire).toBe(true);
    expect(targets[0]?.requireFile).toBe('dist/index.cjs');
  });

  test('a bare-string export is single-format — never require-probed', () => {
    const { targets } = enumerateExports({ name: 'lib', exports: { '.': './dist/index.js' } });
    expect(targets[0]?.hasRequire).toBe(false);
    expect(targets[0]?.requireFile).toBeNull();
  });

  test('falls back to `main` when there is no exports field', () => {
    const { targets } = enumerateExports({ name: 'lib', main: './dist/index.js', types: './dist/index.d.ts' });
    expect(targets).toEqual([
      { subpath: '.', specifier: null, importFile: 'dist/index.js', requireFile: null, typesFile: 'dist/index.d.ts', hasRequire: false },
    ]);
  });

  test('treats a conditions-only exports object as the `.` subpath', () => {
    const { targets } = enumerateExports({ name: 'lib', exports: { import: './dist/index.js', types: './dist/index.d.ts' } });
    expect(targets.map((t) => t.subpath)).toEqual(['.']);
    expect(targets[0]?.specifier).toBe('lib');
  });
});

/** A real `node` spawner, mirroring the orchestrator's `spawnCheck` capture. */
const realSpawn: SmokeSpawn = (command, args, cwd) =>
  new Promise((resolve) => {
    const proc = nodeSpawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (err) => resolve({ ok: false, exit_code: -1, stdout, stderr: err.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, exit_code: code ?? -1, stdout, stderr }));
  });

describe('checkSmoke (real subprocess)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-smoke-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a self-referencing ESM fixture package with a dist entry + its `.d.ts`. */
  async function fixture(pkg: Record<string, unknown>, files: Record<string, string>): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module', ...pkg }));
    await Promise.all(
      Object.entries(files).map(async ([rel, content]) => {
        await mkdir(join(dir, rel, '..'), { recursive: true });
        await writeFile(join(dir, rel), content);
      }),
    );
  }

  const healthyExports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };

  test('passes when the built module loads and its scanned value exports are live', async () => {
    await fixture(
      { name: 'smoke-ok', exports: healthyExports },
      {
        'dist/index.js': 'export const foo = 1;\nexport function bar() {}\nexport class Baz {}\n',
        'dist/index.d.ts':
          'export declare const foo: number;\nexport declare function bar(): void;\nexport declare class Baz {}\nexport interface Ignored { x: number }\n',
      },
    );
    const outcome = await checkSmoke({ cwd: dir, spawn: realSpawn });
    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; results: { subpath: string; ok: boolean }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual([{ subpath: '.', ok: true, errors: [] }]);
  });

  test('fails when a module throws on import', async () => {
    await fixture(
      { name: 'smoke-throw', exports: healthyExports },
      { 'dist/index.js': "throw new Error('boom on load');\nexport const foo = 1;\n", 'dist/index.d.ts': 'export declare const foo: number;\n' },
    );
    const outcome = await checkSmoke({ cwd: dir, spawn: realSpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(1);
    expect(outcome.stderr).toContain('import failed');
    expect(outcome.stderr).toContain('boom on load');
  });

  test('fails when a declared value export is missing at runtime', async () => {
    await fixture(
      { name: 'smoke-missing', exports: healthyExports },
      {
        'dist/index.js': 'export const foo = 1;\n',
        'dist/index.d.ts': 'export declare const foo: number;\nexport declare function gone(): void;\n',
      },
    );
    const outcome = await checkSmoke({ cwd: dir, spawn: realSpawn });
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('missing value export(s): gone');
  });

  test('ignores type-only exports (an interface need not exist at runtime)', async () => {
    await fixture(
      { name: 'smoke-types', exports: healthyExports },
      {
        'dist/index.js': 'export const foo = 1;\n',
        'dist/index.d.ts': 'export declare const foo: number;\nexport interface Shape { x: number }\nexport type Alias = string;\n',
      },
    );
    const outcome = await checkSmoke({ cwd: dir, spawn: realSpawn });
    expect(outcome.ok).toBe(true);
  });

  test('fails with a "did build run?" hint when the dist artifact is absent (never spawns)', async () => {
    await fixture({ name: 'smoke-no-dist', exports: healthyExports }, {});
    let spawned = false;
    const spy: SmokeSpawn = (...args) => {
      spawned = true;
      return realSpawn(...args);
    };
    const outcome = await checkSmoke({ cwd: dir, spawn: spy });
    expect(spawned).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('dist/index.js');
    expect(outcome.stderr).toContain('did `build` run?');
  });
});
