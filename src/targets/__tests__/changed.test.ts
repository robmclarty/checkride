/**
 * R10.3: a target is affected when a changed path lies under its root, and an
 * unaffected target's checks sit out with `no changes under <root>`.
 */

import { describe, expect, test } from 'vitest';

import { changedUnder, noChangesReason } from '../changed.js';

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
