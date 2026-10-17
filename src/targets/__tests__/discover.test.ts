/**
 * R11.4 for the packs that ship: ts targets from `package.json` (a root one
 * claiming every nested package), one bash target where the shell files no
 * other target holds gather, names from roots with collisions numbered, and
 * one ts target at the root read as the implicit mode a repo already runs in.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discoverTargets, isImplicit } from '../discover.js';

describe('discoverTargets', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-discover-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const put = async (...paths: string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), path.endsWith('run') ? '#!/usr/bin/env bash\n' : '{}');
    }
  };

  test('a root package.json proposes one ts target that claims every package, and the shell files under it', async () => {
    await put('package.json', 'packages/a/package.json', 'scripts/deploy.sh');
    const proposed = await discoverTargets(repo);
    expect(proposed).toEqual([{ name: 'app', lang: 'ts', root: '.' }]);
    expect(isImplicit(proposed)).toBe(true);
  });

  test('a root pnpm-workspace.yaml proposes the root target too', async () => {
    await put('pnpm-workspace.yaml', 'apps/web/package.json');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'ts', root: '.' }]);
  });

  test('without one, each top-most package.json proposes a target, and the shell files outside them gather into one bash target', async () => {
    await put('apps/web/package.json', 'apps/web/node/inner/package.json', 'libs/ui/package.json', 'scripts/deploy.sh', 'scripts/ci/run', 'apps/web/build.sh');
    const proposed = await discoverTargets(repo);
    expect(proposed).toEqual([
      { name: 'web', lang: 'ts', root: 'apps/web' },
      { name: 'ui', lang: 'ts', root: 'libs/ui' },
      { name: 'scripts', lang: 'bash', root: 'scripts' },
    ]);
    expect(isImplicit(proposed)).toBe(false);
  });

  test('scattered shell files propose one bash target at their deepest common directory, named shell', async () => {
    await put('tools/a/x.sh', 'tools/b/y.bash');
    expect(await discoverTargets(repo)).toEqual([{ name: 'shell', lang: 'bash', root: 'tools' }]);
    await put('ci/run');
    expect(await discoverTargets(repo)).toEqual([{ name: 'shell', lang: 'bash', root: '.' }]);
  });

  test('a name a slot, a reserved name or an earlier target holds gets a number', async () => {
    await put('apps/web/package.json', 'libs/web/package.json', 'test/package.json', 'pkg/doc-snippets/package.json', 'x/My Lib/package.json');
    expect((await discoverTargets(repo)).map((t) => t.name)).toEqual(['web', 'web-2', 'doc-snippets-2', 'test-2', 'my-lib']);
  });

  test('reads no marker from installed dependencies or test fixtures, and finds nothing in an empty repo', async () => {
    await put('node_modules/a/package.json', 'test/fixtures/b/package.json', 'vendor/c.sh');
    expect(await discoverTargets(repo)).toEqual([]);
    expect(isImplicit([])).toBe(true);
  });

  test('a lone root target of another pack isn’t the implicit one', () => {
    expect(isImplicit([{ name: 'shell', lang: 'bash', root: '.' }])).toBe(false);
    expect(isImplicit([{ name: 'web', lang: 'ts', root: 'web' }])).toBe(false);
  });
});
