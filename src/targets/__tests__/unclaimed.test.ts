/**
 * R11.3: a toolchain marker is claimed by a target of its pack rooted at its
 * directory or above it; every other marker is reported with the target that
 * would claim it, apart from the directories no marker is reported from, the
 * output directory and `unclaimed.ignore`.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { GitRunner } from '../../git.js';
import type { Claimant } from '../unclaimed.js';
import { checkUnclaimed, findUnclaimed } from '../unclaimed.js';

/** A git that fails the way an unsafe repo does. */
const unsafe: GitRunner = () => Promise.resolve({ ok: false, error: 'failed', detail: 'detected dubious ownership' });

const web: Claimant = { name: 'web', pack: 'ts', root: 'apps/web' };
const root: Claimant = { name: 'app', pack: 'ts', root: '.' };

describe('findUnclaimed', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-unclaimed-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const put = async (...paths: string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), '{}');
    }
  };

  test('a target of the pack at the marker or above it claims it, a workspace package included', async () => {
    await put('package.json', 'packages/a/package.json', 'packages/a/tsconfig.json', 'apps/web/package.json');
    expect(await findUnclaimed(repo, { targets: [root] })).toEqual([]);
    expect(await findUnclaimed(repo, { targets: [web, { name: 'pkgs', pack: 'ts', root: 'packages' }] })).toEqual([
      { path: 'package.json', kind: 'ts', suggest: { name: 'app', lang: 'ts', root: '.' } },
    ]);
  });

  test('a target of another pack claims nothing, and a sibling whose name starts like the root is outside it', async () => {
    await put('scripts/package.json', 'apps/webby/package.json');
    const found = await findUnclaimed(repo, { targets: [{ name: 'scripts', pack: 'bash', root: 'scripts' }, web] });
    expect(found).toEqual([
      { path: 'apps/webby/package.json', kind: 'ts', suggest: { name: 'webby', lang: 'ts', root: 'apps/webby' } },
      { path: 'scripts/package.json', kind: 'ts', suggest: { name: 'scripts-ts', lang: 'ts', root: 'scripts' } },
    ]);
  });

  test('each marker file is reported, tsconfig.json beside package.json too', async () => {
    await put('tools/x/package.json', 'tools/x/tsconfig.json', 'tools/x/README.md');
    expect((await findUnclaimed(repo, { targets: [web] })).map((u) => u.path)).toEqual(['tools/x/package.json', 'tools/x/tsconfig.json']);
  });

  test('reports the markers of every pack R11.3 names, each kind by its file, a .tf file by its glob', async () => {
    await put('svc/go.mod', 'svc/go.work', 'crates/a/Cargo.toml', 'py/pyproject.toml', 'py/setup.cfg', 'py/setup.py');
    await put('infra/main.tf', 'infra/.terraform.lock.hcl', 'infra/notes.tfvars');
    const found = await findUnclaimed(repo, { targets: [root] });
    expect(found.map((u) => [u.path, u.kind])).toEqual([
      ['crates/a/Cargo.toml', 'rust'],
      ['infra/.terraform.lock.hcl', 'terraform'],
      ['infra/main.tf', 'terraform'],
      ['py/pyproject.toml', 'python'],
      ['py/setup.cfg', 'python'],
      ['py/setup.py', 'python'],
      ['svc/go.mod', 'go'],
      ['svc/go.work', 'go'],
    ]);
    const red = await checkUnclaimed(repo, { targets: [root], ignore: ['svc', 'py', 'crates'] });
    expect(red.stderr).toContain('unclaimed: infra/.terraform.lock.hcl marks terraform code that no terraform target checks.');
    expect(red.stderr).toContain('claim it: "infra": { "lang": "terraform", "root": "infra" } under targets, or list it in unclaimed.ignore');
    expect(await findUnclaimed(repo, { targets: [{ name: 'infra', pack: 'terraform', root: 'infra' }], ignore: ['svc', 'py', 'crates'] })).toEqual([]);
  });

  // F43: a .tf directory outside every terraform target fails and suggests one.
  test('the .tf files of one directory share one suggested target, and its remedy prints once, after them all', async () => {
    await put('envs/prod/.terraform.lock.hcl', 'envs/prod/main.tf', 'modules/vpc/main.tf', 'modules/vpc/sub/x.tf', 'modules/vpc/variables.tf');
    const prod: Claimant = { name: 'prod', pack: 'terraform', root: 'envs/prod' };
    const found = await findUnclaimed(repo, { targets: [prod] });
    expect(found).toEqual([
      { path: 'modules/vpc/main.tf', kind: 'terraform', suggest: { name: 'vpc', lang: 'terraform', root: 'modules/vpc' } },
      { path: 'modules/vpc/sub/x.tf', kind: 'terraform', suggest: { name: 'sub', lang: 'terraform', root: 'modules/vpc/sub' } },
      { path: 'modules/vpc/variables.tf', kind: 'terraform', suggest: { name: 'vpc', lang: 'terraform', root: 'modules/vpc' } },
    ]);
    const red = await checkUnclaimed(repo, { targets: [prod] });
    expect(red).toMatchObject({ ok: false, exit_code: 1 });
    expect(red.stderr.split('\n')).toEqual([
      'unclaimed: modules/vpc/main.tf marks terraform code that no terraform target checks.',
      'unclaimed: modules/vpc/variables.tf marks terraform code that no terraform target checks.',
      '  claim it: "vpc": { "lang": "terraform", "root": "modules/vpc" } under targets, or list it in unclaimed.ignore',
      'unclaimed: modules/vpc/sub/x.tf marks terraform code that no terraform target checks.',
      '  claim it: "sub": { "lang": "terraform", "root": "modules/vpc/sub" } under targets, or list it in unclaimed.ignore',
      '',
    ]);
    expect(await findUnclaimed(repo, { targets: [prod, { name: 'modules', pack: 'terraform', root: 'modules' }] })).toEqual([]);
  });

  /** Terraform's targets nest (#20), so a target above one is a fix, which switches the inner one's walked slots off. */
  test('.tf files above a terraform target suggest a target that holds it, switching its recursive slots off', async () => {
    await put('main.tf', 'envs/dev/.terraform.lock.hcl', 'envs/dev/main.tf');
    const dev: Claimant = { name: 'dev', pack: 'terraform', root: 'envs/dev' };
    const red = await checkUnclaimed(repo, { targets: [dev] });
    expect(red.stderr).toContain('  claim it: "app": { "lang": "terraform", "root": "." } under targets, switching format, lint, security off in dev, which it would hold, or list it in unclaimed.ignore');
  });

  test('suggests a target for the markers of a pack that ships', async () => {
    await put('svc/go.mod');
    const red = await checkUnclaimed(repo, { targets: [root] });
    expect(red.stderr).toContain('unclaimed: svc/go.mod marks go code that no go target checks.');
    expect(red.stderr).toContain('claim it: "svc": { "lang": "go", "root": "svc" } under targets, or list it in unclaimed.ignore');
  });

  test('suggests a python target for a pyproject.toml, now that the python pack ships', async () => {
    await put('py/pyproject.toml');
    const red = await checkUnclaimed(repo, { targets: [root] });
    expect(red.stderr).toContain('unclaimed: py/pyproject.toml marks python code that no python target checks.');
    expect(red.stderr).toContain('claim it: "py": { "lang": "python", "root": "py" } under targets, or list it in unclaimed.ignore');
  });

  test('a python target claims the manifests at and under its root, a uv workspace member included', async () => {
    await put('py/pyproject.toml', 'py/packages/core/pyproject.toml', 'py/legacy/setup.py', 'tools/setup.cfg');
    const found = await findUnclaimed(repo, { targets: [{ name: 'py', pack: 'python', root: 'py' }] });
    expect(found.map((u) => u.path)).toEqual(['tools/setup.cfg']);
  });

  test('never reports installed dependencies, build output, environments, test data or checkride’s own artifacts', async () => {
    await put(
      'node_modules/a/package.json',
      'apps/web/node_modules/b/package.json',
      'vendor/c/package.json',
      'target/d/package.json',
      '.venv/e/package.json',
      '.terraform/f/package.json',
      '.check/g/package.json',
      'apps/web/.check/doc-snippets/tsconfig.json',
      'pkg/testdata/h/package.json',
      'test/fixtures/i/package.json',
      'packages/j/test/fixtures/k/tsconfig.json',
    );
    expect(await findUnclaimed(repo, { targets: [web] })).toEqual([]);
  });

  test('leaves out the output directory, when it sits inside the repo, and every path an ignore glob matches', async () => {
    await put('out/web/package.json', 'tools/legacy/a/package.json', 'tools/gen/package.json', 'tools/keep/package.json');
    const found = await findUnclaimed(repo, { targets: [web], out: join(repo, 'out'), ignore: ['tools/legacy', 'tools/{gen,x}/*.json'] });
    expect(found.map((u) => u.path)).toEqual(['tools/keep/package.json']);
    expect((await findUnclaimed(repo, { targets: [web], out: 'out' })).map((u) => u.path)).not.toContain('out/web/package.json');
    expect((await findUnclaimed(repo, { targets: [web], out: tmpdir() })).map((u) => u.path)).toContain('out/web/package.json');
  });

  /** The rule discovery names its targets by (#18). */
  test('suggests a name no slot, target, custom check or other suggestion takes, longer for each that collides', async () => {
    await put('a/lint/package.json', 'b/web/package.json', 'c/gen/package.json', 'd/gen/package.json', 'e/gen/package.json');
    await put('f/My_Tool.v2/package.json', 'g/42go/package.json', 'h/___/package.json', 'i/codegen/package.json');
    const names = (await findUnclaimed(repo, { targets: [{ ...web, root: 'apps/web' }], taken: ['codegen'] })).map((u) => u.suggest.name);
    expect(names).toEqual(['a-lint', 'b-web', 'c-gen', 'd-gen', 'e-gen', 'my-tool-v2', 'go', 'ts', 'i-codegen']);
  });

  test('in a git repo, an ignored marker is never reported, and an untracked one is', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), 'build/\n');
    await put('build/package.json', 'tools/new/package.json');
    expect((await findUnclaimed(repo, { targets: [web] })).map((u) => u.path)).toEqual(['tools/new/package.json']);
  });

  test('the check writes its report, passes on a fully claimed repo, and fails naming what to add', async () => {
    await put('apps/web/package.json');
    expect(await checkUnclaimed(repo, { targets: [web] })).toEqual({ ok: true, exit_code: 0, stdout: '{\n  "unclaimed": []\n}\n', stderr: '' });
    await put('tools/gen/package.json');
    const red = await checkUnclaimed(repo, { targets: [web] });
    expect(red).toMatchObject({ ok: false, exit_code: 1 });
    expect(JSON.parse(red.stdout)).toEqual({
      unclaimed: [{ path: 'tools/gen/package.json', kind: 'ts', suggest: { name: 'gen', lang: 'ts', root: 'tools/gen' } }],
    });
    expect(red.stderr).toContain('unclaimed: tools/gen/package.json marks ts code that no ts target checks.');
    expect(red.stderr).toContain('claim it: "gen": { "lang": "ts", "root": "tools/gen" } under targets, or list it in unclaimed.ignore');
  });

  test("a repo whose files can't be listed fails as checking nothing", async () => {
    expect(await checkUnclaimed(repo, { targets: [web] }, unsafe)).toEqual({
      ok: false,
      exit_code: -1,
      stdout: '',
      stderr: "check-unclaimed: can't list the files of the repo: detected dubious ownership\n",
    });
  });
});
