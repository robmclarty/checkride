/**
 * R11.4 for the packs that ship: ts targets from `package.json` (a root one
 * claiming every nested package), go targets from `go.work` and `go.mod`, rust
 * targets from `Cargo.toml`, one bash target where the shell files no other
 * target holds gather, names from roots with collisions numbered, and one
 * target at the root of the root's pack read as the implicit mode a repo
 * already runs in (D68). `discoverRun` applies them in memory (R13.2).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { declaredNote, discoverRun, discoverTargets, isImplicit } from '../discover.js';

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
    expect(isImplicit(proposed, 'ts')).toBe(true);
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
    expect(isImplicit(proposed, 'ts')).toBe(false);
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
    expect(isImplicit([], 'ts')).toBe(true);
  });

  test('a lone root target is the implicit one only when its pack is the one the root marks', () => {
    expect(isImplicit([{ name: 'shell', lang: 'bash', root: '.' }], 'ts')).toBe(false);
    expect(isImplicit([{ name: 'web', lang: 'ts', root: 'web' }], 'ts')).toBe(false);
    expect(isImplicit([{ name: 'app', lang: 'go', root: '.' }], 'go')).toBe(true);
    expect(isImplicit([{ name: 'app', lang: 'go', root: '.' }], 'ts')).toBe(false);
  });
});

describe('discoverTargets for go and rust (D68)', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-discover-go-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const write = async (path: string, text = ''): Promise<void> => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  };

  test('a go.work proposes one target claiming the modules under it and the ones its use names; a go.mod outside proposes its own', async () => {
    await write('services/go.work', 'go 1.24\n\nuse (\n\t./api\n\t../tools\n)\n');
    await write('services/api/go.mod', 'module example.com/api\n');
    await write('services/worker/go.mod', 'module example.com/worker\n');
    await write('tools/go.mod', 'module example.com/tools\n');
    await write('cli/go.mod', 'module example.com/cli\n');
    await write('cli/internal/gen/go.mod', 'module example.com/gen\n');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'cli', lang: 'go', root: 'cli' },
      { name: 'services', lang: 'go', root: 'services' },
    ]);
  });

  test('a root module claims one whose directory sorts before the root, and an unreadable go.work claims only what sits under it', async () => {
    await write('go.mod', 'module example.com/app\n');
    await write('-legacy/go.mod', 'module example.com/legacy\n');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'go', root: '.' }]);
    await rm(join(repo, 'go.mod'));
    await write('svc/go.work', 'go 1.24\n\nuse ../tools\n');
    await write('tools/go.mod', 'go 1.24\n');
    expect((await discoverTargets(repo)).map((t) => t.root)).toEqual(['-legacy', 'svc', 'tools']);
  });

  test('a Cargo workspace proposes one target claiming its members; a crate outside it proposes its own', async () => {
    await write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    await write('crates/core/Cargo.toml', '[package]\nname = "core"\n');
    await write('other/Cargo.toml', '[package] # standalone\nname = "other"\n');
    await write('other/nested/Cargo.toml', '[package]\nname = "nested"\n');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'rust', root: '.' }]);
    await rm(join(repo, 'Cargo.toml'));
    expect(await discoverTargets(repo)).toEqual([
      { name: 'core', lang: 'rust', root: 'crates/core' },
      { name: 'other', lang: 'rust', root: 'other' },
    ]);
  });

  test('a manifest with neither table proposes nothing, and shell files inside a go target stay its own', async () => {
    await write('odd/Cargo.toml', '# workspace\n');
    await write('go.mod', 'module example.com/app\n');
    await write('scripts/deploy.sh', '#!/bin/sh\n');
    const proposed = await discoverTargets(repo);
    expect(proposed).toEqual([{ name: 'app', lang: 'go', root: '.' }]);
    expect(isImplicit(proposed, 'go')).toBe(true);
  });

  test('a root package.json beside a go.mod proposes both, and the second root target takes a number', async () => {
    await write('package.json', '{}');
    await write('go.mod', 'module example.com/app\n');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'app', lang: 'ts', root: '.' },
      { name: 'app-2', lang: 'go', root: '.' },
    ]);
  });
});

describe('discoverRun (R13.2)', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-discover-run-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const write = async (path: string, text = '{}'): Promise<void> => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  };
  const baseline = { schema_version: 1, slots: { lint: ['a.ts:no-x:bad'], docs: ['README.md:MD001:x'] } };

  test('declares the proposed targets in memory, the root target taking the slot entries and the baseline’s', async () => {
    await write('package.json');
    await write('services/api/go.mod', 'module example.com/api\n');
    const found = await discoverRun(repo, { checks: { lint: false, links: false } }, baseline);
    expect(found.config).toEqual({
      targets: { app: { lang: 'ts', root: '.', checks: { lint: false } }, api: { lang: 'go', root: 'services/api' } },
      checks: { links: false },
    });
    expect(found.targets.map((t) => t.name)).toEqual(['app', 'api']);
    expect(found.baseline?.slots).toEqual({ 'app:lint': ['a.ts:no-x:bad'], docs: ['README.md:MD001:x'] });
    expect(found.dropped).toEqual([]);
  });

  test('with no root target the slot entries are dropped, and the baseline keeps its names', async () => {
    await write('web/package.json');
    await write('api/go.mod', 'module example.com/api\n');
    const found = await discoverRun(repo, { checks: { lint: 'oxlint' } }, baseline);
    expect(found.dropped).toEqual(['lint']);
    expect(found.baseline).toEqual(baseline);
  });

  test('only the implicit target changes nothing', async () => {
    await write('go.mod', 'module example.com/app\n');
    const config = { checks: { lint: 'staticcheck' } };
    expect(await discoverRun(repo, config, null)).toEqual({ config, targets: [], declared: [], dropped: [], baseline: null });
  });

  // F37 (D73)
  test('a config that declares targets keeps them and discovers nothing, naming them', async () => {
    await write('web/package.json');
    await write('api/go.mod', 'module example.com/api\n');
    const config = { targets: { site: { lang: 'ts', root: 'web' } }, checks: { lint: false } };
    expect(await discoverRun(repo, config, baseline)).toEqual({ config, targets: [], declared: ['site'], dropped: [], baseline });
  });

  test('the note names the declared targets as the reason', () => {
    expect(declaredNote(['web', 'api'])).toBe('--discover: the config declares its targets (web, api), so they stand in for discovery');
  });
});
