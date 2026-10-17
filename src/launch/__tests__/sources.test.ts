/**
 * The pieces each pin source reads with: the mise `[tools]` scanner, the
 * upward walk that stops at the repo root, the `PATH` lookup, and the
 * package manager a check's own directory declares.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { nearestPackageManager } from '../index.js';
import { loadPinsFile, miseDeclaration, miseToolKeys, miseToolVersions } from '../mise.js';
import { findOnPath } from '../path.js';
import { dirsUpTo } from '../walk.js';

/** Run `body` in a fresh temp directory, removed afterwards. */
async function inTemp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-sources-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('miseToolKeys reads the tools a mise config declares', () => {
  test('bare and quoted keys under [tools], whatever their value', () => {
    const keys = miseToolKeys(
      [
        '[tools]',
        'shellcheck = "0.11.0"',
        '"aqua:koalaman/shellcheck" = "0.11.0"',
        "'npm:checkride' = 'latest'",
        'rust = { version = "1.99.0", profile = "minimal" }',
        'go = "1.27"  # a trailing comment',
      ].join('\n'),
    );
    expect([...keys].toSorted()).toEqual(['aqua:koalaman/shellcheck', 'go', 'npm:checkride', 'rust', 'shellcheck']);
  });

  test('[tools.<key>] tables and top-level tools.<key> dotted keys', () => {
    const keys = miseToolKeys(['tools.shfmt = "3.14.1"', '', '[tools."github:robmclarty/checkride"]', 'version = "0.16.0"'].join('\n'));
    expect([...keys].toSorted()).toEqual(['github:robmclarty/checkride', 'shfmt']);
  });

  test('keys in other tables, and lines inside a value that spans lines, declare nothing', () => {
    const keys = miseToolKeys(
      [
        '[env]',
        'shellcheck = "not a tool"',
        '[tools]',
        'python = [',
        '  "3.12",',
        '  "3.14", # a comment with a ] in it',
        ']',
        'uv = "0.13.1"',
        '[settings]',
        'experimental = true',
        '[tools] # back again',
        'trivy = "0.76.0"',
      ].join('\n'),
    );
    expect([...keys].toSorted()).toEqual(['python', 'trivy', 'uv']);
  });

  test("reads this repo's own mise.toml", async () => {
    const text = await readFile(join(import.meta.dirname, '..', '..', '..', 'mise.toml'), 'utf8');
    const keys = miseToolKeys(text);
    for (const tool of ['go', 'rust', 'shellcheck', 'shfmt', 'opentofu', 'trivy']) expect(keys.has(tool), tool).toBe(true);
  });
});

describe('dirsUpTo walks from a directory to the repo root, and no further', () => {
  test('nearest first, the root included', () => {
    expect(dirsUpTo('/repo/apps/web', '/repo')).toEqual(['/repo/apps/web', '/repo/apps', '/repo']);
    expect(dirsUpTo('/repo', '/repo/')).toEqual(['/repo']);
  });

  test('a directory outside the repo is the only one searched', () => {
    expect(dirsUpTo('/elsewhere/x', '/repo')).toEqual(['/elsewhere/x']);
    expect(dirsUpTo('/repo-two', '/repo')).toEqual(['/repo-two']);
  });
});

describe('miseDeclaration finds the config that declares a tool', () => {
  test('the nearest config wins, .mise.toml counts, and the result names the file and key', () =>
    inTemp(async (repo) => {
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(join(repo, 'mise.toml'), '[tools]\nshellcheck = "0.10.0"\n');
      await writeFile(join(repo, 'scripts', '.mise.toml'), '[tools]\n"aqua:koalaman/shellcheck" = "0.11.0"\n');
      expect(miseDeclaration(join(repo, 'scripts'), repo, ['shellcheck', 'aqua:koalaman/shellcheck'])).toEqual({
        file: join('scripts', '.mise.toml'),
        id: 'aqua:koalaman/shellcheck',
      });
      expect(miseDeclaration(repo, repo, ['shellcheck'])).toEqual({ file: 'mise.toml', id: 'shellcheck' });
      expect(miseDeclaration(repo, repo, ['shfmt'])).toBeNull();
    }));
});

describe('findOnPath', () => {
  test('finds the first executable file, in PATH order', () =>
    inTemp(async (dir) => {
      for (const sub of ['a', 'b']) {
        await mkdir(join(dir, sub));
        await writeFile(join(dir, sub, 'tool'), '#!/bin/sh\n');
        await chmod(join(dir, sub, 'tool'), 0o755);
      }
      expect(findOnPath('tool', { PATH: `${join(dir, 'a')}:${join(dir, 'b')}` })).toBe(join(dir, 'a', 'tool'));
    }));

  test('skips a file that is not executable, a directory, and an empty entry', () =>
    inTemp(async (dir) => {
      await mkdir(join(dir, 'plain'));
      await writeFile(join(dir, 'plain', 'tool'), '');
      await mkdir(join(dir, 'dirs', 'tool'), { recursive: true });
      expect(findOnPath('tool', { PATH: `${join(dir, 'plain')}::${join(dir, 'dirs')}` })).toBeNull();
      expect(findOnPath('tool', {})).toBeNull();
    }));
});

describe('nearestPackageManager', () => {
  test("a target with its own lockfile runs under it, and one without runs under the root's", () =>
    inTemp(async (repo) => {
      await writeFile(join(repo, 'pnpm-lock.yaml'), '');
      await mkdir(join(repo, 'apps', 'legacy'), { recursive: true });
      await mkdir(join(repo, 'apps', 'web', 'src'), { recursive: true });
      await writeFile(join(repo, 'apps', 'legacy', 'package-lock.json'), '{}');
      expect(nearestPackageManager(join(repo, 'apps', 'legacy'), repo)).toBe('npm');
      expect(nearestPackageManager(join(repo, 'apps', 'web', 'src'), repo)).toBe('pnpm');
      expect(nearestPackageManager(repo, repo)).toBe('pnpm');
    }));

  test("a packageManager field declares as a lockfile does, and nothing above the repo counts", () =>
    inTemp(async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'tools'), { recursive: true });
      await writeFile(join(dir, 'yarn.lock'), '');
      await writeFile(join(repo, 'tools', 'package.json'), JSON.stringify({ packageManager: 'bun@1.2.0' }));
      expect(nearestPackageManager(join(repo, 'tools'), repo)).toBe('bun');
      expect(nearestPackageManager(repo, repo)).toBe('pnpm');
    }));
});

describe('miseToolVersions reads what a --pins file pins (R13.3)', () => {
  test('a string, or an inline table’s version, under [tools] or as a dotted key, comments aside', () => {
    const text = [
      'tools.shfmt = "3.14.1" # dotted',
      '[env]',
      'FOO = "bar"',
      '[tools]',
      '# a comment',
      'shellcheck = "0.11.0"',
      '"aqua:rvben/rumdl" = { version = \'0.2.79\', os = ["linux"] }',
      'go = { os = ["macos"], version = "1.27" }',
    ].join('\n');
    expect(miseToolVersions(text)).toEqual(new Map([['shfmt', '3.14.1'], ['shellcheck', '0.11.0'], ['aqua:rvben/rumdl', '0.2.79'], ['go', '1.27']]));
  });

  test.each([
    ['[tools]\nnode = ["20", "22"]', '[tools] node must be a version string or an inline table with a version (got ["20", "22"])'],
    ['[tools]\nnode = { os = ["linux"] }', '[tools] node must be a version string or an inline table with a version'],
    ['[tools]\nnode = ""', '[tools] node must be a version string'],
    ['[tools.node]\nversion = "22"', '[tools.node] is a table: pin it as node = "<version>" under [tools]'],
  ])('anything else is a problem: %s', (text, problem) => {
    const read = miseToolVersions(text);
    expect(read).toHaveProperty('problem');
    expect('problem' in read ? read.problem : '').toContain(problem);
  });

  test('loadPinsFile names the file in its error', () =>
    inTemp(async (dir) => {
      const path = join(dir, 'pins.toml');
      await writeFile(path, '[tools]\nnode = 22\n');
      expect(() => loadPinsFile(path)).toThrow(`invalid ${path}: [tools] node must be a version string`);
      expect(() => loadPinsFile(join(dir, 'gone.toml'))).toThrow(`invalid ${join(dir, 'gone.toml')}:`);
      await writeFile(path, '[tools]\nnode = "22"\n');
      expect(loadPinsFile(path)).toEqual(new Map([['node', '22']]));
    }));
});
