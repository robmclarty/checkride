import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { GoWorkspace, WorkModule } from '../go-mod.js';
import { expandGoPackages, goImports, goModRequiredVersion, goModTools, goPackagePatterns, readGoWorkspace, takesGoPackages, withDependents } from '../go-mod.js';

/** A go.mod as `go get -tool` leaves it, with both directive forms and comments. */
const GO_MOD = [
  'module example.com/api',
  '',
  'go 1.24',
  '',
  'tool golang.org/x/vuln/cmd/govulncheck',
  '',
  'tool (',
  '\tgolang.org/x/tools/cmd/deadcode // reachability',
  '\t"honnef.co/go/tools/cmd/staticcheck"',
  ')',
  '',
  'require golang.org/x/text v0.22.0',
  '',
  'require (',
  '\tgolang.org/x/tools v0.30.0 // indirect',
  '\tgolang.org/x/tools/gopls v0.18.1 // indirect',
  '\thonnef.co/go/tools v0.6.1 // indirect',
  ')',
  '',
].join('\r\n');

describe('goModTools', () => {
  test('reads the one-line and block forms, with comments and quotes removed', () => {
    expect(goModTools(GO_MOD)).toEqual([
      'golang.org/x/vuln/cmd/govulncheck',
      'golang.org/x/tools/cmd/deadcode',
      'honnef.co/go/tools/cmd/staticcheck',
    ]);
  });

  test('reads a block whose opener sits against its verb', () => {
    expect(goModTools('module m\n\ntool(\n\tgolang.org/x/tools/cmd/deadcode\n)\n')).toEqual(['golang.org/x/tools/cmd/deadcode']);
  });

  test('ignores a commented-out directive and every other verb', () => {
    expect(goModTools('module m\n// tool golang.org/x/tools/cmd/deadcode\nrequire golang.org/x/tools v0.30.0\n')).toEqual([]);
  });

  test('a go.mod with no tool directive declares none', () => {
    expect(goModTools('module m\n\ngo 1.24\n')).toEqual([]);
  });
});

describe('goModRequiredVersion', () => {
  test('is the version required for the module whose path is the longest prefix of the package', () => {
    expect(goModRequiredVersion(GO_MOD, 'golang.org/x/tools/cmd/deadcode')).toBe('v0.30.0');
    expect(goModRequiredVersion(GO_MOD, 'golang.org/x/tools/gopls/internal/cmd')).toBe('v0.18.1');
    expect(goModRequiredVersion(GO_MOD, 'honnef.co/go/tools/cmd/staticcheck')).toBe('v0.6.1');
  });

  test('reads a one-line require too', () => {
    expect(goModRequiredVersion(GO_MOD, 'golang.org/x/text/language')).toBe('v0.22.0');
  });

  test('a module path must end at a path segment', () => {
    expect(goModRequiredVersion('module m\nrequire golang.org/x/to v1.0.0\n', 'golang.org/x/tools/cmd/deadcode')).toBeUndefined();
  });

  test('is undefined when nothing provides the package', () => {
    expect(goModRequiredVersion(GO_MOD, 'golang.org/x/vuln/cmd/govulncheck')).toBeUndefined();
  });
});

/** Run `body` against a fresh directory holding `files`, removed afterwards. */
async function withRoot(files: Record<string, string>, body: (root: string) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'checkride-go-patterns-'));
  try {
    for (const [rel, content] of Object.entries(files)) await writeFile(join(root, rel), content);
    body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('goPackagePatterns', () => {
  test('a module root names ./...', () =>
    withRoot({ 'go.mod': 'module m\n' }, (root) => { expect(goPackagePatterns(root)).toEqual(['./...']); }));

  test('a go.work root names each use directory, one-line and block, in order', () =>
    withRoot({ 'go.work': 'go 1.24\n\nuse ./api\n\nuse (\n\t"./lib" // shared\n\t.\n\t../shared/\n)\n' }, (root) => {
      expect(goPackagePatterns(root)).toEqual(['./api/...', './lib/...', './...', '../shared/...']);
    }));

  test('a go.work with no use falls back to ./...', () =>
    withRoot({ 'go.work': 'go 1.24\n' }, (root) => { expect(goPackagePatterns(root)).toEqual(['./...']); }));
});

describe('expandGoPackages', () => {
  test('replaces the placeholder with one argument per pattern, and nothing else', () => {
    expect(takesGoPackages(['run', '{go-packages}'])).toBe(true);
    expect(takesGoPackages(['-l', '.'])).toBe(false);
    expect(takesGoPackages(undefined)).toBe(false);
    expect(expandGoPackages(['test', '-json', '{go-packages}'], ['./a/...', './b/...'])).toEqual(['test', '-json', './a/...', './b/...']);
  });
});

describe('readGoWorkspace', () => {
  const WORK = {
    'go.work': 'go 1.24\n\nuse (\n\t./a\n\t./b\n)\n\nreplace example.com/x => ./b\n',
  };

  test('reads each used module, its requires and its local replaces, in use order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkride-go-ws-'));
    try {
      await mkdir(join(root, 'a'));
      await mkdir(join(root, 'b'));
      await writeFile(join(root, 'go.work'), WORK['go.work']);
      await writeFile(join(root, 'a', 'go.mod'), 'module example.com/a\n\nrequire (\n\texample.com/x v1.0.0\n)\n\nreplace example.com/y v1.0.0 => ../b\n');
      await writeFile(join(root, 'b', 'go.mod'), 'module example.com/b\n');
      const ws = readGoWorkspace(root);
      expect(ws).toEqual({
        modules: [
          { dir: 'a', path: 'example.com/a', requires: ['example.com/x'], replacedBy: ['b'] },
          { dir: 'b', path: 'example.com/b', requires: [], replacedBy: [] },
        ],
        replaces: new Map([['example.com/x', 'b']]),
      });
      if (ws === null || ws === 'unreadable') throw new Error('no workspace');
      expect(withDependents(ws, new Set([1]))).toEqual([0, 1]);
      expect(withDependents(ws, new Set([0]))).toEqual([0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('is null at a module root, and unreadable when a used module has no go.mod or a block never closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkride-go-ws-'));
    try {
      await writeFile(join(root, 'go.mod'), 'module m\n');
      expect(readGoWorkspace(root)).toBeNull();
      await writeFile(join(root, 'go.work'), 'go 1.24\n\nuse ./missing\n');
      expect(readGoWorkspace(root)).toBe('unreadable');
      await writeFile(join(root, 'go.work'), 'go 1.24\n\nuse (\n\t.\n');
      expect(readGoWorkspace(root)).toBe('unreadable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('goImports', () => {
  test('reads single and grouped declarations, with names, dots, blanks and raw strings', () => {
    const source = [
      '// Package api serves.',
      '//go:build linux',
      '',
      'package api // the api',
      '',
      'import "fmt"',
      'import str "strings"',
      'import (',
      '\t"os" // the os',
      '\t. "example.com/dot"',
      '\t_ "example.com/blank"',
      '\t/* a block',
      '\t   comment */',
      '\traw `example.com/raw`',
      ')',
      'import ("example.com/a"; "example.com/b")',
      '',
      'func main() {}',
    ].join('\n');
    expect(goImports(source)).toEqual([
      'fmt', 'strings', 'os', 'example.com/dot', 'example.com/blank', 'example.com/raw', 'example.com/a', 'example.com/b',
    ]);
  });

  test('stops at the first declaration that is not an import, and reads no import inside a comment or a string', () => {
    const source = [
      'package main',
      '/* import "example.com/commented" */',
      'import "example.com/real"',
      'var s = "import \\"example.com/string\\""',
      'import "example.com/late"',
    ].join('\n');
    expect(goImports(source)).toEqual(['example.com/real']);
  });

  test('a file with no package clause declares none', () => {
    expect(goImports('import "fmt"\n')).toEqual([]);
    expect(goImports('')).toEqual([]);
  });
});

/** A workspace module with no `require` or `replace`. */
function mod(dir: string, path: string): WorkModule {
  return { dir, path, requires: [], replacedBy: [] };
}

/** A workspace of `modules` whose `go.work` replaces nothing. */
function workspace(...modules: WorkModule[]): GoWorkspace {
  return { modules, replaces: new Map() };
}

/** An import lookup that answers from `byDir`, and records each module it was asked about. */
function lookup(byDir: Record<string, readonly string[] | null>, asked: string[] = []): (m: WorkModule) => readonly string[] | null {
  return (m) => {
    asked.push(m.dir);
    return Object.hasOwn(byDir, m.dir) ? (byDir[m.dir] ?? null) : [];
  };
}

describe('withDependents: imports', () => {

  test('an import is an edge to the module with the longest matching path, so a root module gets none from a nested one', () => {
    const ws = workspace(mod('.', 'example.com/shop'), mod('api', 'example.com/shop/api'), mod('web', 'example.com/shop/web'));
    const imports = lookup({ web: ['example.com/shop/api/handlers'] });
    expect(withDependents(ws, new Set([1]), imports)).toEqual([1, 2]);
    expect(withDependents(ws, new Set([0]), imports)).toEqual([0]);
  });

  test('a package directory named like a module directory belongs to the module whose path holds it', () => {
    const ws = workspace(mod('greet', 'example.com/greet'), mod('api', 'example.com/api'), mod('web', 'example.com/web'));
    const imports = lookup({ web: ['example.com/api/greet'] });
    expect(withDependents(ws, new Set([0]), imports)).toEqual([0]);
    expect(withDependents(ws, new Set([1]), imports)).toEqual([1, 2]);
  });

  test('a module whose imports cannot be read depends on every module, and each module is asked at most once', () => {
    const ws = workspace(mod('a', 'example.com/a'), mod('b', 'example.com/b'), mod('c', 'example.com/c'));
    const asked: string[] = [];
    expect(withDependents(ws, new Set([0]), lookup({ c: null }, asked))).toEqual([0, 2]);
    expect(asked.toSorted()).toEqual(['b', 'c']);
  });

  test('without a lookup, only go.mod and go.work make edges', () => {
    const ws = workspace(mod('a', 'example.com/a'), { ...mod('b', 'example.com/b'), requires: ['example.com/a'] });
    expect(withDependents(ws, new Set([0]))).toEqual([0, 1]);
    expect(withDependents(ws, new Set([1]))).toEqual([1]);
  });
});
