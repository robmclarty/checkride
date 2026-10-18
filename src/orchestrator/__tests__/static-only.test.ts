/**
 * `--static-only` in a run (R13.4, D26): selection skips each check that may
 * run the repo's code with a `static-only: <cause>` reason, a kept check whose
 * tool needs an install skips rather than fails, the defaults layer can vouch
 * for its own checks while the repo can't, an entry of the repo's that adds an
 * argument to a static row loses the mark (D79), the skip naming what the entry
 * did, a value is read as the tool's parser reads it (D81), and the run is
 * partial, so it records `run.static_only` and never ratchets.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import { loadConfig, resolveChecks } from '../../config.js';
import type { Out } from '../index.js';
import { runChecks } from '../index.js';
import { withStaticOnly } from '../select.js';

const quiet: Out = { write: () => true };

describe('withStaticOnly', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-static-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  /** The repo's checks with `config` and `defaults`, through the static filter, by slot. */
  async function filtered(config: CheckrideConfig, defaults: CheckrideConfig | null = null): Promise<Map<string, ResolvedCheck>> {
    const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, defaults, cwd: repo });
    return new Map((await withStaticOnly(resolved, repo)).map((c) => [c.slot, c]));
  }

  /** Write `path` under the repo, its directories included. */
  async function put(path: string, content = ''): Promise<void> {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }

  /** The skip reason of an `infra` terraform target's tflint check, through the static filter. */
  async function lintSkip(): Promise<string | null | undefined> {
    const config: CheckrideConfig = { targets: { infra: { lang: 'terraform', root: 'infra', checks: { lint: 'tflint' } } } };
    const checks = await withStaticOnly(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }), repo);
    return checks.find((c) => c.slot === 'lint' && c.target === 'infra')?.skip;
  }

  // F40
  test('a static check stays, and .oxlintrc.json declaring jsPlugins skips lint with the sniff’s reason', async () => {
    await writeFile(join(repo, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['./rules.js'] }));
    const checks = await filtered({ checks: { lint: { use: 'oxlint', args: ['exec', 'oxlint', '--format=json'] }, links: 'links', types: 'tsc' } });
    expect(checks.get('lint')?.skip).toBe('static-only: .oxlintrc.json sets jsPlugins, which loads code');
    expect(checks.get('links')?.skip).toBeNull();
    expect(checks.get('types')?.skip).toBe("static-only: tsc isn't a static check");
  });

  test("a repo's custom check, and an entry that swaps a static adapter's command, never qualify, the swap named", async () => {
    const checks = await filtered({
      checks: { licenses: { command: 'node', args: ['x.js'] }, docs: { use: 'markdownlint-cli2', command: 'node' }, types: { use: 'tsc', command: 'node' } },
    });
    expect(checks.get('licenses')?.skip).toBe("static-only: custom:licenses isn't a static check");
    expect(checks.get('docs')?.skip).toBe("static-only: markdownlint-cli2's entry swaps its command for node");
    // A row the registry never marks gives that as its cause, whatever the entry does.
    expect(checks.get('types')?.skip).toBe("static-only: tsc isn't a static check");
  });

  // D79: the repo's config is as untrusted as its code, and nearly every static tool takes a flag that loads some.
  test('an args or changedArgs override that adds an argument the row doesn’t carry never qualifies, the first such argument named', async () => {
    const checks = await filtered({
      checks: {
        format: { use: 'prettier', args: ['exec', 'prettier', '--plugin=./x.mjs', '--check', '.'] },
        spell: { use: 'cspell', changedArgs: ['--config', 'cspell.config.mjs'] },
      },
    });
    expect(checks.get('format')?.skip).toBe("static-only: prettier's entry adds --plugin=./x.mjs, an argument its registry row doesn't carry");
    expect(checks.get('spell')?.skip).toBe("static-only: cspell's entry adds --config, an argument its registry row doesn't carry");
  });

  test('an override that only drops or reorders the row’s arguments stays static, plain oxlint included', async () => {
    const checks = await filtered({
      checks: {
        lint: { use: 'oxlint', args: ['exec', 'oxlint', '--format=json'] },
        format: { use: 'prettier', args: ['exec', 'prettier', '.', '--check'] },
        docs: { use: 'markdownlint-cli2', args: [] },
      },
    });
    expect(checks.get('lint')?.skip).toBeNull();
    expect(checks.get('format')?.skip).toBeNull();
    expect(checks.get('docs')?.skip).toBeNull();
  });

  test('a preset the config extends that adds an argument drops the mark too', async () => {
    await put('presets/format.json', JSON.stringify({ checks: { format: { use: 'prettier', args: ['exec', 'prettier', '--plugin', './x.mjs', '--check', '.'] } } }));
    await put('checkride.config.json', JSON.stringify({ extends: './presets/format.json' }));
    const checks = await filtered(loadConfig(repo) ?? {});
    expect(checks.get('format')?.skip).toBe("static-only: prettier's entry adds --plugin, an argument its registry row doesn't carry");
  });

  test('a defaults entry that adds an argument keeps its static: true vouch, and without one drops the mark', async () => {
    const plugin = ['exec', 'prettier', '--plugin=./x.mjs', '--check', '.'];
    expect((await filtered({}, { checks: { format: { use: 'prettier', args: plugin, static: true } } })).get('format')).toMatchObject({ skip: null, origin: 'defaults' });
    expect((await filtered({}, { checks: { format: { use: 'prettier', args: plugin } } })).get('format')?.skip).toBe(
      "static-only: prettier's entry adds --plugin=./x.mjs, an argument its registry row doesn't carry",
    );
  });

  // D81: step 80's three probes, each a cspell.yaml whose import YAML reads as a script.
  test('a cspell.yaml importing a script however YAML writes it skips spell, and one importing a dictionary keeps it', async () => {
    for (const config of ['import: "./a #.mjs"\n', 'import: "./x.m\\\n  js"\n', 'import:\n  - ./dict.json\n# note\n  - ./x.mjs\n']) {
      await put('cspell.yaml', config);
      expect((await filtered({ checks: { spell: 'cspell' } })).get('spell')?.skip, config).toBe('static-only: cspell.yaml sets import, which loads code');
    }
    await put('cspell.yaml', 'import: ./dict.json # not ./x.js\n');
    expect((await filtered({ checks: { spell: 'cspell' } })).get('spell')?.skip).toBeNull();
  });

  test('the defaults layer vouches for its own checks with static: true', async () => {
    const defaults: CheckrideConfig = {
      checks: { licenses: { command: 'node', args: ['-e', ''], static: true }, types: { use: 'tsc', static: true }, audit: { command: 'node' } },
    };
    const checks = await filtered({}, defaults);
    expect(checks.get('licenses')).toMatchObject({ skip: null, origin: 'defaults' });
    expect(checks.get('types')).toMatchObject({ skip: null, origin: 'defaults' });
    expect(checks.get('audit')?.skip).toBe("static-only: custom:audit isn't a static check");
  });

  test('a check skipped for another reason keeps it, its adapter notwithstanding', async () => {
    const tsc = ADAPTERS.find((a) => a.name === 'tsc');
    if (tsc === undefined) throw new Error('no tsc row');
    const skipped: ResolvedCheck = { slot: 'types', optIn: false, adapter: tsc, skip: 'no changes under web', target: 'web', root: 'web' };
    expect(await withStaticOnly([skipped], repo)).toEqual([skipped]);
  });

  test('a check already skipped keeps its own reason, and a code config in another target’s directory doesn’t reach it', async () => {
    await mkdir(join(repo, 'web'));
    await mkdir(join(repo, 'api'));
    await writeFile(join(repo, 'api', 'prettier.config.js'), '');
    const checks = await withStaticOnly(
      resolveChecks({
        slots: SLOTS,
        adapters: ADAPTERS,
        config: { targets: { web: { lang: 'ts', root: 'web', checks: { format: 'prettier' } }, api: { lang: 'ts', root: 'api', checks: { format: 'prettier' } } } },
        cwd: repo,
      }),
      repo,
    );
    const format = (target: string): ResolvedCheck | undefined => checks.find((c) => c.slot === 'format' && c.target === target);
    expect(format('web')?.skip).toBeNull();
    expect(format('api')?.skip).toBe('static-only: api/prettier.config.js is code prettier would run');
    expect(checks.find((c) => c.slot === 'lint' && c.target === 'web')?.skip).toBe('no tool detected for slot');
  });

  describe('reads the disk under a check’s directory, as tflint walks it', () => {
    const plant = '.tflint.d/plugins/tflint-ruleset-terraform';

    test('a terraform-only .tflint.hcl keeps lint, and a plugin under a dependency directory tflint enters skips it', async () => {
      await put('infra/.tflint.hcl', 'plugin "terraform" {\n  enabled = true\n}\n');
      expect(await lintSkip()).toBeNull();
      await put(`infra/vendor/m/${plant}`);
      expect(await lintSkip()).toBe(`static-only: infra/vendor/m/${plant} is code tflint would run`);
    });

    test('a plugin git ignores still counts, since tflint never asks git', async () => {
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      await put('.gitignore', '.tflint.d/\n');
      await put(`infra/${plant}`);
      expect(await lintSkip()).toBe(`static-only: infra/${plant} is code tflint would run`);
    });

    test('a symlink in .tflint.d’s place counts, and so does a plugin under a root that is itself a symlink', async () => {
      await put(`elsewhere/${plant}`);
      await mkdir(join(repo, 'infra'));
      await symlink(join(repo, 'elsewhere', '.tflint.d'), join(repo, 'infra', '.tflint.d'));
      expect(await lintSkip()).toBe('static-only: infra/.tflint.d is code tflint would run');
      await rm(join(repo, 'infra'), { recursive: true });
      await symlink(join(repo, 'elsewhere'), join(repo, 'infra'));
      expect(await lintSkip()).toBe(`static-only: infra/${plant} is code tflint would run`);
    });
  });
});

describe('runChecks --static-only', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-static-run-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  test('a kept check whose tool needs an install skips, the run is partial, and run.static_only says so', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { 'markdownlint-cli2': '0.23.3' } }));
    await writeFile(join(repo, 'README.md'), '# readme\n');
    const result = await runChecks({
      cwd: repo,
      staticOnly: true,
      config: { checks: { docs: 'markdownlint-cli2', links: 'links' } },
      only: ['docs', 'links'],
      stdout: quiet,
      stderr: quiet,
    });
    const docs = result.summary.checks.find((c) => c.name === 'docs');
    expect(docs).toMatchObject({ skipped: true, ok: true, exit_code: null, origin: 'config' });
    expect(docs?.reason).toMatch(/^static-only: needs an install \(the `docs` slot needs `markdownlint-cli2`, which is not installed in this project\)$/);
    expect(result.summary.checks.find((c) => c.name === 'links')).toMatchObject({ ok: true });
    expect(result.summary.checks.find((c) => c.name === 'links')).not.toHaveProperty('skipped');
    expect(result.summary.run).toMatchObject({ partial: true, static_only: true });
    expect(result.exitCode).toBe(0);
  });

  test("a repo's prettier --plugin override skips format, though prettier is a static check", async () => {
    await writeFile(join(repo, 'README.md'), '# readme\n');
    const result = await runChecks({
      cwd: repo,
      staticOnly: true,
      config: { checks: { format: { use: 'prettier', args: ['exec', 'prettier', '--plugin', './x.mjs', '--check', '.'] }, links: 'links' } },
      only: ['format', 'links'],
      stdout: quiet,
      stderr: quiet,
    });
    expect(result.summary.checks.find((c) => c.name === 'format')).toMatchObject({
      skipped: true,
      ok: true,
      reason: "static-only: prettier's entry adds --plugin, an argument its registry row doesn't carry",
    });
    expect(result.summary.checks.find((c) => c.name === 'links')).toMatchObject({ ok: true });
    expect(result.exitCode).toBe(0);
  });

  test('without it, the same missing tool fails the check, as it always has', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { 'markdownlint-cli2': '0.23.3' } }));
    const result = await runChecks({ cwd: repo, config: { checks: { docs: 'markdownlint-cli2' } }, only: ['docs'], stdout: quiet, stderr: quiet });
    expect(result.summary.checks.find((c) => c.name === 'docs')).toMatchObject({ ok: false });
    expect(result.summary.checks.find((c) => c.name === 'docs')).not.toHaveProperty('skipped');
    expect(result.summary.run).not.toHaveProperty('static_only');
  });
});
