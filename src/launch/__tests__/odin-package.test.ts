import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { expandOdinPackage, noOdinPackageReason, noOdinProgramReason, odinPackage, takesOdinPackage } from '../odin-package.js';

/** Write `files` (relative path to content) into a fresh directory, run `body` on it, and remove it. */
async function withDir(files: Record<string, string>, body: (dir: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-odin-package-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(dir, rel, '..'), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('odinPackage', () => {
  test('reads the clause past comments, blank lines and file tags, and sees a main procedure', () =>
    withDir(
      {
        'app.odin': '// The game.\n\n/* a block\n   /* nested */ comment */\n#+build darwin, linux\npackage app\n\nimport "core:fmt"\n\nmain :: proc() {\n\tfmt.println("hi")\n}\n',
      },
      (dir) => { expect(odinPackage(dir)).toEqual({ name: 'app', program: true }); },
    ));

  test('a package with no main procedure is a library, a commented-out or quoted main not counting', () =>
    withDir(
      {
        'kit.odin': 'package kit\n\n// main :: proc() {}\n/* main :: proc() {} */\nadd :: proc(a, b: int) -> int {\n\treturn a + b\n}\n',
        'strings.odin': 'package kit\n\nNOTE :: "main :: proc() lives elsewhere"\nQUOTE :: `main :: proc()`\n',
      },
      (dir) => { expect(odinPackage(dir)).toEqual({ name: 'kit', program: false }); },
    ));

  test('the first file in name order with a clause names the package, and a subdirectory is another package', () =>
    withDir(
      {
        'b.odin': 'package game\n',
        'a.odin': '// no clause yet: a comment-only file\n',
        'sub/sub.odin': 'package sub\n\nmain :: proc() {}\n',
      },
      (dir) => { expect(odinPackage(dir)).toEqual({ name: 'game', program: false }); },
    ));

  test('a directory with no Odin source, or none that declares a package, has no package', () =>
    withDir({ 'README.md': '# not odin\n', 'notes.odin': '// just a comment\n' }, (dir) => {
      expect(odinPackage(dir)).toBeNull();
      expect(odinPackage(join(dir, 'missing'))).toBeNull();
    }));

  test('a rune or string holding a comment marker opens no comment', () =>
    withDir(
      { 'q.odin': "package q\n\nSLASH :: '/'\nURL :: \"https://example.com/*not-a-comment\"\nmain :: proc() {}\n" },
      (dir) => { expect(odinPackage(dir)).toEqual({ name: 'q', program: true }); },
    ));
});

describe('expandOdinPackage', () => {
  test('replaces the token inside an argument, and says which argument lists carry one', () => {
    expect(takesOdinPackage(['check', '.', '-vet-packages:{odin-package}'])).toBe(true);
    expect(takesOdinPackage(['check', '.'])).toBe(false);
    expect(takesOdinPackage(undefined)).toBe(false);
    expect(expandOdinPackage(['check', '.', '-vet-packages:{odin-package}', '-json-errors'], 'app')).toEqual(['check', '.', '-vet-packages:app', '-json-errors']);
  });

  test('names each skip by the root it was read at', () => {
    expect(noOdinPackageReason('tools/gen')).toBe('no package clause in tools/gen');
    expect(noOdinProgramReason('kit')).toBe('no main procedure in kit: unused procedures are vetted from a program');
  });
});
