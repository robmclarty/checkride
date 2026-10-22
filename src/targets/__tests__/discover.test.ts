/**
 * R11.4 for the packs that ship: ts targets from `package.json` and
 * `tsconfig.json` (a root that runs a ts tool of its own claiming every nested
 * package, and a workspace root that runs none proposing its packages), go targets from `go.work` and `go.mod`, rust
 * targets from `Cargo.toml`, python targets from the top-most Python
 * manifests, terraform targets from lock files and then the top-most `.tf`
 * directories left, one bash target where the shell files no other
 * target holds gather, names from roots with collisions numbered, and one
 * target at the root of the root's pack read as the implicit mode a repo
 * already runs in (D68). `discoverRun` applies them in memory (R13.2).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { declaredNote, discoverRun, discoverTargets, ignoreToolsRoot, isImplicit, rootRunsTsTool } from '../discover.js';
import { checkUnclaimed } from '../unclaimed.js';

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

  test('a root package.json that runs a ts tool proposes one ts target that claims every package, and the shell files under it', async () => {
    await put('package.json', 'tsconfig.json', 'packages/a/package.json', 'scripts/deploy.sh');
    const proposed = await discoverTargets(repo);
    expect(proposed).toEqual([{ name: 'app', lang: 'ts', root: '.' }]);
    expect(isImplicit(proposed, 'ts')).toBe(true);
  });

  test('a root pnpm-workspace.yaml that runs a ts tool proposes the root target too', async () => {
    await put('pnpm-workspace.yaml', 'vitest.config.ts', 'apps/web/package.json');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'ts', root: '.' }]);
  });

  test('a root package.json that runs no ts tool of its own proposes its packages, and the shell files then gather into a bash target', async () => {
    await put('package.json', 'pnpm-workspace.yaml', 'web/package.json', 'web/tsconfig.json', 'api/go.mod', 'scripts/deploy.sh');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'web', lang: 'ts', root: 'web' },
      { name: 'api', lang: 'go', root: 'api' },
      { name: 'scripts', lang: 'bash', root: 'scripts' },
    ]);
  });

  test('a root runs a ts tool when its package.json lists one, or the config names one, at the top level or for the ts pack', async () => {
    await put('web/package.json');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { checkride: '0.15.0' } }));
    expect(rootRunsTsTool(repo, null)).toBe(false);
    expect(rootRunsTsTool(repo, { checks: { lint: false, links: 'links' } })).toBe(false);
    expect(rootRunsTsTool(repo, { checks: { lint: 'oxlint' } })).toBe(true);
    expect(rootRunsTsTool(repo, { packs: { ts: { checks: { test: { use: 'vitest' } } } } })).toBe(true);
    await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { vitest: '5.0.3' } }));
    expect(rootRunsTsTool(repo, null)).toBe(true);
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'ts', root: '.' }]);
  });

  test('a tsconfig.json marks a ts project below the root as a package.json does', async () => {
    await put('web/tsconfig.json', 'web/src/tsconfig.worker.json', 'tools/gen/package.json');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'gen', lang: 'ts', root: 'tools/gen' },
      { name: 'web', lang: 'ts', root: 'web' },
    ]);
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

  /** A name that says what it checks, whatever order discovery found the roots in (#18). */
  test('targets whose names collide, or take a slot’s or a reserved name, take longer ones', async () => {
    await put('apps/web/package.json', 'libs/web/package.json', 'test/package.json', 'pkg/doc-snippets/package.json', 'x/My Lib/package.json');
    expect((await discoverTargets(repo)).map((t) => t.name)).toEqual(['apps-web', 'libs-web', 'pkg-doc-snippets', 'test-ts', 'my-lib']);
  });

  test('two roots of one name take the shortest trailing path that tells them apart, and a custom check’s name is taken', async () => {
    await put('services/api/infra/main.tf', 'services/api/infra/.terraform.lock.hcl', 'services/web/infra/main.tf', 'services/web/infra/.terraform.lock.hcl', 'tools/lint-all/package.json');
    expect((await discoverTargets(repo)).map((t) => t.name)).toEqual(['lint-all', 'api-infra', 'web-infra']);
    expect((await discoverTargets(repo, undefined, { checks: { 'lint-all': { command: 'true' } } })).map((t) => t.name)).toEqual(['tools-lint-all', 'api-infra', 'web-infra']);
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

  // Across a pack's two rules the inner root wins, and the outer one's markers stay unclaimed.
  test('a root go.mod above a go.work proposes the workspace alone, and shell files at the root then gather into a bash target', async () => {
    await write('go.mod', 'module example.com/app\n');
    await write('svc/go.work', 'go 1.24\n\nuse ./api\n');
    await write('svc/api/go.mod', 'module example.com/api\n');
    await write('build.sh', '#!/bin/sh\n');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'svc', lang: 'go', root: 'svc' },
      { name: 'shell', lang: 'bash', root: '.' },
    ]);
  });

  test('a root [package] above a [workspace] proposes the workspace alone', async () => {
    await write('Cargo.toml', '[package]\nname = "app"\n');
    await write('tools/Cargo.toml', '[workspace]\nmembers = ["gen"]\n');
    await write('tools/gen/Cargo.toml', '[package]\nname = "gen"\n');
    expect(await discoverTargets(repo)).toEqual([{ name: 'tools', lang: 'rust', root: 'tools' }]);
  });

  test('a cargo-fuzz harness is no root, so its crate is proposed and claims it', async () => {
    await write('Cargo.toml', '[package]\nname = "app"\n');
    // What `cargo fuzz init` writes, its own [workspace] included.
    await write('fuzz/Cargo.toml', '[package]\nname = "app-fuzz"\npublish = false\n\n[package.metadata]\ncargo-fuzz = true\n\n[workspace]\nmembers = ["."]\n');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'rust', root: '.' }]);
  });

  test('a root package.json that runs a ts tool beside a go.mod proposes both, each named by its pack (#18)', async () => {
    await write('package.json', '{}');
    await write('tsconfig.json', '{}');
    await write('go.mod', 'module example.com/app\n');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'ts', lang: 'ts', root: '.' },
      { name: 'go', lang: 'go', root: '.' },
    ]);
    // A directory that holds the pack's name keeps it, and the root target falls back to its pack after app.
    await write('go/pyproject.toml', '');
    expect((await discoverTargets(repo)).map((t) => t.name)).toEqual(['ts', 'app-go', 'go']);
  });
});

describe('discoverTargets for python', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-discover-py-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const write = async (path: string): Promise<void> => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), '');
  };

  test('each top-most pyproject.toml, setup.cfg or setup.py directory proposes a target that claims the nested ones', async () => {
    await write('pyproject.toml');
    await write('packages/core/pyproject.toml');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'python', root: '.' }]);
    expect(isImplicit(await discoverTargets(repo), 'python')).toBe(true);
    await rm(join(repo, 'pyproject.toml'));
    await write('legacy/setup.py');
    await write('legacy/setup.cfg');
    await write('tools/gen/setup.cfg');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'legacy', lang: 'python', root: 'legacy' },
      { name: 'core', lang: 'python', root: 'packages/core' },
      { name: 'gen', lang: 'python', root: 'tools/gen' },
    ]);
  });

  test('reads no marker from a virtual environment, and a python root beside a ts root proposes both', async () => {
    await write('.venv/lib/site/pyproject.toml');
    expect(await discoverTargets(repo)).toEqual([]);
    await write('package.json');
    await write('tsconfig.json');
    await write('pyproject.toml');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'ts', lang: 'ts', root: '.' },
      { name: 'python', lang: 'python', root: '.' },
    ]);
  });

  test('each lock file proposes a terraform root module that claims the .tf directories under it, then each top-most .tf directory left proposes one more', async () => {
    for (const path of ['envs/prod/.terraform.lock.hcl', 'envs/prod/main.tf', 'envs/prod/net/vpc.tf', 'envs/stage/.terraform.lock.hcl', 'envs/stage/main.tf']) {
      await write(path);
    }
    for (const path of ['modules/vpc/main.tf', 'modules/vpc/variables.tf', 'modules/vpc/nested/x.tf', 'modules/s3/main.tf', 'shared/locals.tf']) await write(path);
    // Never read: what `init` installs under .terraform/, and a tfvars file, which marks nothing.
    await write('envs/prod/.terraform/modules/vpc/main.tf');
    await write('vars/prod.tfvars');
    expect(await discoverTargets(repo)).toEqual([
      { name: 'prod', lang: 'terraform', root: 'envs/prod' },
      { name: 'stage', lang: 'terraform', root: 'envs/stage' },
      { name: 's3', lang: 'terraform', root: 'modules/s3' },
      { name: 'vpc', lang: 'terraform', root: 'modules/vpc' },
      { name: 'shared', lang: 'terraform', root: 'shared' },
    ]);
  });

  /**
   * A root module below another, with its own lock file, is one the outer
   * target's validate never reads, so it takes a target of its own, which
   * runs validate alone: the outer one's fmt, tflint and trivy walk it (#20).
   */
  test('a lock file below another root module proposes a nested target that only validates', async () => {
    for (const path of ['infra/.terraform.lock.hcl', 'infra/main.tf', 'infra/registry/.terraform.lock.hcl', 'infra/registry/main.tf', 'infra/net/vpc.tf']) await write(path);
    expect(await discoverTargets(repo)).toEqual([
      { name: 'infra', lang: 'terraform', root: 'infra' },
      { name: 'registry', lang: 'terraform', root: 'infra/registry', checks: { format: false, lint: false, security: false } },
    ]);
  });

  test('a lock file below a .tf directory proposes the root module alone, leaving the .tf files above it unclaimed', async () => {
    for (const path of ['main.tf', 'envs/dev/.terraform.lock.hcl', 'envs/dev/main.tf']) await write(path);
    expect(await discoverTargets(repo)).toEqual([{ name: 'dev', lang: 'terraform', root: 'envs/dev' }]);
  });

  test('a lock file at the root claims every .tf file under it, which is the implicit terraform mode, and a .tf root without one is too', async () => {
    await write('.terraform.lock.hcl');
    await write('main.tf');
    await write('modules/vpc/main.tf');
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'terraform', root: '.' }]);
    expect(isImplicit(await discoverTargets(repo), 'terraform')).toBe(true);
    await rm(join(repo, '.terraform.lock.hcl'));
    expect(await discoverTargets(repo)).toEqual([{ name: 'app', lang: 'terraform', root: '.' }]);
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
    await write('tsconfig.json');
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

  test("nested roots of one pack declare the inner one, and unclaimed says why the outer one can't be claimed", async () => {
    await write('go.mod', 'module example.com/app\n');
    await write('svc/go.work', 'go 1.24\n\nuse ./api\n');
    await write('svc/api/go.mod', 'module example.com/api\n');
    const found = await discoverRun(repo, { checks: { lint: 'golangci-lint' } }, null);
    expect(found.targets.map((t) => [t.name, t.pack, t.root])).toEqual([['svc', 'go', 'svc']]);
    expect(found.dropped).toEqual(['lint']);
    const outcome = await checkUnclaimed(repo, { targets: found.targets });
    expect(outcome).toMatchObject({ ok: false, exit_code: 1 });
    expect(outcome.stderr).toBe(
      'unclaimed: go.mod marks go code that no go target checks.\n' +
        "  no go target can claim it: one rooted at . would hold the go target svc at svc, and two targets of one pack can't nest; list it in unclaimed.ignore\n",
    );
  });

  test('a root package.json that runs no ts tool goes in unclaimed.ignore, so unclaimed holds', async () => {
    await write('package.json', JSON.stringify({ devDependencies: { checkride: '0.15.0' } }));
    await write('web/package.json');
    await write('api/go.mod', 'module example.com/api\n');
    const found = await discoverRun(repo, { unclaimed: { ignore: ['tools/**'] } }, null);
    expect(found.targets.map((t) => [t.name, t.pack, t.root])).toEqual([['web', 'ts', 'web'], ['api', 'go', 'api']]);
    expect(found.config?.['unclaimed']).toEqual({ ignore: ['tools/**', 'package.json'] });
    const outcome = await checkUnclaimed(repo, { targets: found.targets, ignore: ['tools/**', 'package.json'] });
    expect(outcome).toMatchObject({ ok: true });
  });

  test('ignoreToolsRoot leaves a config alone where a ts target sits at the root, or nothing is declared', async () => {
    await write('package.json');
    const rooted = { targets: { app: { lang: 'ts', root: '.' }, api: { lang: 'go', root: 'api' } } };
    expect(ignoreToolsRoot(rooted, repo)).toEqual({ config: rooted, changes: [] });
    expect(ignoreToolsRoot({ checks: {} }, repo)).toEqual({ config: { checks: {} }, changes: [] });
  });

  test('the note names the declared targets as the reason', () => {
    expect(declaredNote(['web', 'api'])).toBe('--discover: the config declares its targets (web, api), so they stand in for discovery');
  });
});
