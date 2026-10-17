import { describe, expect, test } from 'vitest';

import { goModRequiredVersion, goModTools } from '../go-mod.js';

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
