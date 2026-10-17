import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { expandGoPackages, goModRequiredVersion, goModTools, goPackagePatterns, takesGoPackages } from '../go-mod.js';

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
