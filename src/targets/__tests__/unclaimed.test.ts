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

  test("reports the markers of packs that haven't shipped, which no target can claim yet, with a hint to ignore them", async () => {
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
    const red = await checkUnclaimed(repo, { targets: [root], ignore: ['svc', 'infra', 'py'] });
    expect(red.stderr).toContain('unclaimed: crates/a/Cargo.toml marks rust code that no rust target checks.');
    expect(red.stderr).toContain('no rust pack ships yet, so list it in unclaimed.ignore until one does');
  });

  test('suggests a target for the markers of a pack that ships', async () => {
    await put('svc/go.mod');
    const red = await checkUnclaimed(repo, { targets: [root] });
    expect(red.stderr).toContain('unclaimed: svc/go.mod marks go code that no go target checks.');
    expect(red.stderr).toContain('claim it: "svc": { "lang": "go", "root": "svc" } under targets, or list it in unclaimed.ignore');
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

  test('suggests a name no slot, target or earlier suggestion takes', async () => {
    await put('a/lint/package.json', 'b/web/package.json', 'c/gen/package.json', 'd/gen/package.json', 'e/gen/package.json');
    await put('f/My_Tool.v2/package.json', 'g/42go/package.json', 'h/___/package.json');
    const names = (await findUnclaimed(repo, { targets: [{ ...web, root: 'apps/web' }] })).map((u) => u.suggest.name);
    expect(names).toEqual(['lint-ts', 'web-ts', 'gen', 'gen-ts', 'gen-2', 'my-tool-v2', 'go', 'ts']);
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
