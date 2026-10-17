/**
 * R10.3: a target is affected when a changed path lies under its root, and an
 * unaffected target's checks sit out with `no changes under <root>`.
 */

import { describe, expect, test } from 'vitest';

import { changedGoModules, changedUnder, noChangesReason, pathsUnder } from '../changed.js';

describe('changedUnder', () => {
  test('a path below the root affects it, at any depth', () => {
    expect(changedUnder(['apps/web/src/a.ts'], 'apps/web')).toBe(true);
    expect(changedUnder(['apps/web/package.json'], 'apps/web')).toBe(true);
  });

  test('a sibling whose name starts with the root does not', () => {
    expect(changedUnder(['apps/webby/a.ts', 'apps/web.md'], 'apps/web')).toBe(false);
  });

  test('a path above or beside the root does not', () => {
    expect(changedUnder(['apps/README.md', 'api/main.go', 'README.md'], 'apps/web')).toBe(false);
  });

  test('the root itself counts, as a submodule at a target root would show', () => {
    expect(changedUnder(['vendor/lib'], 'vendor/lib')).toBe(true);
  });

  test('every path lies under the repo root, and with none changed nothing is affected', () => {
    expect(changedUnder(['README.md'], '.')).toBe(true);
    expect(changedUnder([], '.')).toBe(false);
    expect(changedUnder([], 'apps/web')).toBe(false);
  });
});

describe('noChangesReason', () => {
  test('names the root, as the summary records it', () => {
    expect(noChangesReason('apps/api')).toBe('no changes under apps/api');
    expect(noChangesReason('.')).toBe('no changes under .');
  });
});

describe('changedGoModules (R10.4)', () => {
  const DIRS = ['.', 'svc', 'svc/inner', 'lib'];

  test('a path belongs to the deepest use directory it lies under', () => {
    expect(changedGoModules(DIRS, ['svc/inner/x.go'])).toEqual(new Set([2]));
    expect(changedGoModules(DIRS, ['svc/main.go', 'lib/l.go'])).toEqual(new Set([1, 3]));
    expect(changedGoModules(DIRS, ['root.go'])).toEqual(new Set([0]));
  });

  test('a path under no module is ignored', () => {
    expect(changedGoModules(['a', 'b'], ['README.md', 'docs/x.md'])).toEqual(new Set());
  });

  test('a change to go.work, go.work.sum or any go.mod moves the graph, so every module runs', () => {
    for (const path of ['go.work', 'go.work.sum', 'lib/go.mod', 'tools/go.mod']) expect(changedGoModules(DIRS, [path]), path).toBeNull();
  });
});

describe('pathsUnder', () => {
  test('keeps the paths under a root, made relative to it, and every path under the repo root', () => {
    expect(pathsUnder(['ws/a/a.go', 'ws2/x', 'web/b.ts'], 'ws')).toEqual(['a/a.go']);
    expect(pathsUnder(['a.go', 'x/y'], '.')).toEqual(['a.go', 'x/y']);
  });
});
