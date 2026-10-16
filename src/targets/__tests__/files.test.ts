/**
 * R11.2: a file-list target's files, from git or a walk, kept by its
 * `include` (or the default globs and the shebang sniff) and dropped by its
 * `exclude`, with globs matched by the module's own matcher; and the `{files}`
 * argument they expand into.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { GitRunner } from '../../git.js';
import { argvBytes, expandFiles, globRegExp, isFileListPack, MAX_FILES_ARGV_BYTES, takesFiles, targetFiles } from '../files.js';

/** A git that fails the way an unsafe repo does. */
const failing: GitRunner = () => Promise.resolve({ ok: false, error: 'failed', detail: 'detected dubious ownership' });

/** A machine with no git at all. */
const missing: GitRunner = () => Promise.resolve({ ok: false, error: 'missing', detail: 'git not found on PATH' });

describe('globRegExp', () => {
  test.each([
    ['**/*.sh', 'a.sh', true],
    ['**/*.sh', 'bin/deep/a.sh', true],
    ['**/*.sh', 'a.shx', false],
    ['**/*.sh', 'a.bash', false],
    ['*.sh', 'a.sh', true],
    ['*.sh', 'bin/a.sh', false],
    ['bin/*', 'bin/run', true],
    ['bin/*', 'bin/sub/run', false],
    ['bin/**', 'bin/sub/run', true],
    ['bin/**/x', 'bin/x', true],
    ['bin/**/x', 'bin/a/b/x', true],
    ['a**b', 'aXXb', true],
    ['a**b', 'a/b', false],
    ['?.sh', 'a.sh', true],
    ['?.sh', 'ab.sh', false],
    ['?.sh', '/.sh', false],
    ['**/*.{sh,bash}', 'x/a.bash', true],
    ['**/*.{sh,bash}', 'x/a.zsh', false],
    ['{bin,{lib,etc}}/*', 'etc/a', true],
    ['{bin,{lib,etc}}/*', 'usr/a', false],
    ['a.sh', 'aXsh', false],
    ['[a].sh', '[a].sh', true],
    ['{a.sh', '{a.sh', true],
    ['a+(b).sh', 'a+(b).sh', true],
  ])('%s against %s is %s', (glob, path, matches) => {
    expect(globRegExp(glob).test(path)).toBe(matches);
  });
});

describe('the {files} argument', () => {
  test('expands to one argument per file, in place', () => {
    expect(expandFiles(['exec', 'shellcheck', '-f', 'json1', '{files}'], ['a.sh', 'b c.sh'])).toEqual([
      'exec', 'shellcheck', '-f', 'json1', 'a.sh', 'b c.sh',
    ]);
    expect(expandFiles(['-d', '{files}', '--'], [])).toEqual(['-d', '--']);
    expect(expandFiles(['--files={files}'], ['a.sh'])).toEqual(['--files={files}']);
  });

  test('marks the args that take it, and the packs whose adapters do', () => {
    expect(takesFiles(['-d', '{files}'])).toBe(true);
    expect(takesFiles(['-d', '.'])).toBe(false);
    expect(takesFiles(undefined)).toBe(false);
    expect(isFileListPack('bash')).toBe(true);
    expect(isFileListPack('ts')).toBe(false);
    expect(isFileListPack('repo')).toBe(false);
    expect(isFileListPack('cobol')).toBe(false);
  });

  test('counts an argv in bytes, each argument with its NUL', () => {
    expect(argvBytes(['ab', 'c'])).toBe(5);
    expect(argvBytes(['é'])).toBe(3);
    expect(MAX_FILES_ARGV_BYTES).toBe(200_000);
  });
});

describe('targetFiles', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-files-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const put = async (path: string, content = ''): Promise<void> => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
  };

  test('by default keeps .sh, .bash and extensionless shell scripts, relative to the root and sorted', async () => {
    await put('scripts/z.sh');
    await put('scripts/lib/a.bash');
    await put('scripts/bin/deploy', '#!/usr/bin/env bash\necho hi\n');
    await put('scripts/bin/build', '#!/bin/sh\n');
    await put('scripts/bin/legacy', '#! /bin/bash -e\r\n');
    await put('scripts/bin/opts', '#!/usr/bin/env -S dash -e\n');
    await put('scripts/bin/korn', '#!/usr/local/bin/ksh\n');
    await put('scripts/bin/zsh', '#!/bin/zsh\n');
    await put('scripts/bin/bashful', '#!/bin/bashful\n');
    await put('scripts/bin/notes', 'just text\n');
    await put('scripts/tool.py', '#!/usr/bin/env bash\n');
    await put('scripts/.envrc', '#!/bin/bash\n');
    await put('outside.sh');
    expect(await targetFiles(repo, { name: 'scripts', root: 'scripts' })).toEqual([
      '.envrc', 'bin/build', 'bin/deploy', 'bin/korn', 'bin/legacy', 'bin/opts', 'lib/a.bash', 'z.sh',
    ]);
  });

  test('outside git, the walk skips .git, node_modules, target and vendor', async () => {
    for (const dir of ['.git', 'node_modules', 'target', 'vendor', 'src']) await put(`${dir}/x.sh`);
    expect(await targetFiles(repo, { name: 'all', root: '.' })).toEqual(['src/x.sh']);
  });

  test('an include replaces the default, sniff and all, and an exclude drops a file or a whole directory', async () => {
    await put('a.sh');
    await put('bin/run', '#!/bin/bash\n');
    await put('bin/run.sh');
    await put('third_party/x/y.sh');
    await put('gen/a.sh');
    expect(await targetFiles(repo, { name: 't', root: '.', include: ['bin/*'] })).toEqual(['bin/run', 'bin/run.sh']);
    expect(await targetFiles(repo, { name: 't', root: '.', exclude: ['third_party', 'gen/*.sh', 'bin/run.sh'] })).toEqual([
      'a.sh', 'bin/run',
    ]);
  });

  test('keeps only files: a directory named like a script, a dangling link and a link to a directory are dropped', async () => {
    await put('ok.sh');
    await mkdir(join(repo, 'dir.sh'));
    await symlink(join(repo, 'missing.sh'), join(repo, 'dangling.sh'));
    await symlink(join(repo, 'dir.sh'), join(repo, 'linked.sh'));
    await symlink(join(repo, 'ok.sh'), join(repo, 'alias.sh'));
    expect(await targetFiles(repo, { name: 't', root: '.' })).toEqual(['alias.sh', 'ok.sh']);
  });

  test('in a git repo, lists tracked and untracked files but never ignored or deleted ones', async () => {
    git('init', '-q');
    await put('.gitignore', 'build/\n*.gen.sh\n');
    await put('scripts/tracked.sh');
    await put('scripts/gone.sh');
    await put('scripts/build/out.sh');
    await put('scripts/x.gen.sh');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await rm(join(repo, 'scripts/gone.sh'));
    await put('scripts/new.sh');
    expect(await targetFiles(repo, { name: 'scripts', root: 'scripts' })).toEqual(['new.sh', 'tracked.sh']);
  });

  test('a git failure other than a missing git or repo stops the run rather than list another way', async () => {
    await expect(targetFiles(repo, { name: 'scripts', root: '.' }, failing)).rejects.toThrow(
      "can't list the files of target 'scripts': detected dubious ownership",
    );
    await put('a.sh');
    expect(await targetFiles(repo, { name: 'scripts', root: '.' }, missing)).toEqual(['a.sh']);
  });

  test('matches nothing in an empty root', async () => {
    await mkdir(join(repo, 'empty'));
    expect(await targetFiles(repo, { name: 'e', root: 'empty' })).toEqual([]);
  });
});
