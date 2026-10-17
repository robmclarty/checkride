import { describe, expect, test } from 'vitest';

import { offlineHint, packEnv } from '../index.js';

describe('packEnv (R6.4)', () => {
  test('a go check fails rather than download a toolchain or a module, and leaves GOFLAGS alone (D54)', () => {
    expect(packEnv('go')).toEqual({ GOTOOLCHAIN: 'local', GOPROXY: 'off' });
  });

  test('a network check keeps the variables that pin a toolchain, and drops the ones that block downloads', () => {
    expect(packEnv('go', true)).toEqual({ GOTOOLCHAIN: 'local' });
  });

  test('a check of a pack that sets none, or of no pack, sets none', () => {
    for (const pack of ['ts', 'repo', 'bash', undefined]) expect(packEnv(pack), String(pack)).toEqual({});
  });
});

describe('offlineHint', () => {
  test("names go mod download when GOPROXY=off stopped a module lookup, in go build -json's stdout or go's stderr", () => {
    // Go 1.27.2, `go build -json ./...` with an empty module cache.
    const stdout = '{"ImportPath":"golang.org/x/text/language","Action":"build-output","Output":"main.go:6:2: module lookup disabled by GOPROXY=off\\n"}\n';
    expect(offlineHint({ stdout, stderr: 'go: downloading golang.org/x/text v0.22.0\n' })).toContain('run `go mod download` first');
    expect(offlineHint({ stdout: '', stderr: 'main.go:6:2: module lookup disabled by GOPROXY=off\n' })).toContain('go mod download');
  });

  test('says nothing for any other failure', () => {
    expect(offlineHint({ stdout: '', stderr: 'go: go.mod requires go >= 1.99 (running go 1.27.2; GOTOOLCHAIN=local)\n' })).toBeNull();
    expect(offlineHint({ stdout: 'main.go:4:14: cannot use "nope" as int value\n', stderr: '' })).toBeNull();
  });
});
