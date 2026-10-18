import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { normalizePypiName, projectEnvironment, uvLockDeclaration, uvLockVersions } from '../uv.js';

/**
 * The lock uv 0.13.1 writes for a project that needs numpy and allows Python
 * 3.10 on: a forked resolution, locking numpy at three versions, each under
 * its own markers. Trimmed to the keys the source reads and the arrays
 * around them.
 */
const FORKED = [
  'version = 1',
  'revision = 5',
  'requires-python = ">=3.10"',
  'resolution-markers = [',
  '    "python_full_version >= \'3.12\'",',
  '    "python_full_version == \'3.11.*\'",',
  '    "python_full_version < \'3.11\'",',
  ']',
  '',
  '[[package]]',
  'name = "fork"',
  'version = "0.1.0"',
  'source = { virtual = "." }',
  'dependencies = [',
  '    { name = "numpy", version = "2.2.6", source = { registry = "https://pypi.org/simple" }, marker = "python_full_version < \'3.11\'" },',
  ']',
  '',
  '[package.metadata]',
  'requires-dist = [{ name = "numpy" }]',
  '',
  '[[package]]',
  'name = "numpy"',
  'version = "2.2.6"',
  'source = { registry = "https://pypi.org/simple" }',
  'resolution-markers = [',
  '    "python_full_version < \'3.11\'",',
  ']',
  '',
  '[[package]]',
  'name = "numpy"',
  'version = "2.4.6"',
  'source = { registry = "https://pypi.org/simple" }',
  'resolution-markers = [',
  '    "python_full_version == \'3.11.*\'",',
  ']',
  '',
  '[[package]]',
  'name = "numpy"',
  'version = "2.5.4"',
  'source = { registry = "https://pypi.org/simple" }',
  'resolution-markers = [',
  '    "python_full_version >= \'3.12\'",',
  ']',
  '',
].join('\n');

describe('normalizePypiName (PEP 503)', () => {
  test('lowercases a name and folds each run of -, _ and . into one -', () => {
    expect(normalizePypiName('PyTest')).toBe('pytest');
    expect(normalizePypiName('typing_extensions')).toBe('typing-extensions');
    expect(normalizePypiName('Zope.Interface')).toBe('zope-interface');
    expect(normalizePypiName('a-_.b')).toBe('a-b');
  });
});

describe('uvLockVersions', () => {
  test('lists a package by its normalized name, with every version a forked resolution locks', () => {
    expect(uvLockVersions(FORKED, 'NumPy')).toEqual({ listed: true, versions: ['2.2.6', '2.4.6', '2.5.4'] });
    expect(uvLockVersions(FORKED, 'Fork')).toEqual({ listed: true, versions: ['0.1.0'] });
  });

  test("doesn't list a package the lock only names inside another table's arrays or sub-tables", () => {
    const text = [
      '[[package]]',
      'name = "demo"',
      'version = "0.1.0"',
      'dependencies = [',
      '    { name = "ruff" },',
      ']',
      '',
      '[package.metadata]',
      'name = "ruff"',
      '',
    ].join('\n');
    expect(uvLockVersions(text, 'ruff')).toEqual({ listed: false, versions: [] });
    expect(uvLockVersions(text, 'demo')).toEqual({ listed: true, versions: ['0.1.0'] });
  });

  test('a listed package can lock no version of its own, and a top-level key is never a package', () => {
    expect(uvLockVersions('version = 1\n\n[[package]]\nname = "local"\nsource = { directory = "vendor/local" }\n', 'local')).toEqual({
      listed: true,
      versions: [],
    });
    expect(uvLockVersions('name = "ruff"\nversion = "1"\n', 'ruff')).toEqual({ listed: false, versions: [] });
  });
});

/** Run `body` against a fresh scratch repo, removed afterwards. */
async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'checkride-uv-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'py'), { recursive: true });
  try {
    await body(repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('uvLockDeclaration', () => {
  test('names the lock relative to the repo, and the directory that holds it', () =>
    withRepo(async (repo) => {
      await writeFile(join(repo, 'py', 'uv.lock'), FORKED);
      expect(uvLockDeclaration(join(repo, 'py'), repo, 'fork')).toEqual({ file: 'py/uv.lock', dir: join(repo, 'py'), version: '0.1.0' });
    }));

  test("records no version where a forked resolution locks several, since any may be the one installed", () =>
    withRepo(async (repo) => {
      await writeFile(join(repo, 'uv.lock'), FORKED);
      expect(uvLockDeclaration(join(repo, 'py'), repo, 'numpy')).toEqual({ file: 'uv.lock', dir: repo });
    }));

  test('declares nothing without a lock, or for a package the lock leaves out', () =>
    withRepo(async (repo) => {
      expect(uvLockDeclaration(repo, repo, 'numpy')).toBeNull();
      await writeFile(join(repo, 'uv.lock'), FORKED);
      expect(uvLockDeclaration(repo, repo, 'ruff')).toBeNull();
    }));
});

describe('projectEnvironment', () => {
  test("is the .venv beside the lock, unless UV_PROJECT_ENVIRONMENT names another, from the lock's directory", () => {
    expect(projectEnvironment('/repo/py', {})).toBe('/repo/py/.venv');
    expect(projectEnvironment('/repo/py', { UV_PROJECT_ENVIRONMENT: '' })).toBe('/repo/py/.venv');
    expect(projectEnvironment('/repo/py', { UV_PROJECT_ENVIRONMENT: 'envs/dev' })).toBe('/repo/py/envs/dev');
    expect(projectEnvironment('/repo/py', { UV_PROJECT_ENVIRONMENT: '/opt/venv' })).toBe('/opt/venv');
  });
});
