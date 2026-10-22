/**
 * The ts configs no check reaches (#12): a workspace root that only installs
 * tools has no `tsconfig.json` of its own and no vitest, so its one ts target
 * runs neither `types` nor `test`, while each package holds both configs.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../../adapters.js';
import { resolveChecks, tsTargets } from '../../config.js';
import type { GitRunner } from '../../git.js';
import { findUnreached, unreachedLine, unreachedNote } from '../index.js';

/** A git that fails, so a test proves the file list is never asked for. */
const unasked: GitRunner = () => Promise.reject(new Error('the file list was read'));

describe('findUnreached', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-unreached-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const put = async (...paths: string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), '{}');
    }
  };

  /** The tooling-only workspace root the issue describes: oxlint at the root, configs in each package. */
  const workspace = (): Promise<void> =>
    put('package.json', '.oxlintrc.json', 'tsconfig.base.json', 'packages/a/tsconfig.json', 'packages/a/vitest.config.ts', 'packages/b/tsconfig.json', 'node_modules/x/tsconfig.json');

  test('names each slot with no tool and the nested configs a tool for it would read', async () => {
    await workspace();
    const found = await findUnreached(repo, [{ name: null, root: '.', empty: ['types', 'test'] }]);
    expect(found).toEqual([
      { check: 'types', root: '.', slot: 'types', files: ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'] },
      { check: 'test', root: '.', slot: 'test', files: ['packages/a/vitest.config.ts'] },
    ]);
    expect(unreachedLine(found[0] ?? { check: '', root: '', slot: '', files: [] })).toBe(
      'types has no tool under `.`, so 2 nested tsconfig.json file(s) go unchecked (packages/a/tsconfig.json, and 1 more): add a tsconfig.json at `.` whose `references` name them, each of them `composite`, or declare a ts target for each package',
    );
    expect(unreachedNote(found[1] ?? { check: '', root: '', slot: '', files: [] })).toBe('`test` (1 nested test config(s) under `.`)');
  });

  test('leaves out a deeper ts target’s configs and the ones an ignore glob matches, and reads nothing with no gap', async () => {
    await workspace();
    const targets = [{ name: 'app', root: '.', empty: ['types'] }, { name: 'a', root: 'packages/a', empty: [] }];
    expect((await findUnreached(repo, targets))[0]).toMatchObject({ check: 'app:types', files: ['packages/b/tsconfig.json'] });
    expect(await findUnreached(repo, [{ name: null, root: '.', empty: ['types'] }], ['packages/*/tsconfig.json'])).toEqual([]);
    expect(await findUnreached(repo, [{ name: null, root: '.', empty: [] }], [], unasked)).toEqual([]);
  });

  /** The ts targets a run under `config` resolves, as `tsTargets` reads them. */
  const resolve = (config: Parameters<typeof resolveChecks>[0]['config']) => tsTargets(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }));

  test('a ts root with no tool for types is a gap, and one switched off isn’t', async () => {
    await workspace();
    expect(resolve(null)).toEqual([{ name: null, root: '.', empty: expect.arrayContaining(['types', 'test']) as unknown }]);
    expect(resolve({ checks: { types: false } })[0]?.empty).not.toContain('types');
  });
});
