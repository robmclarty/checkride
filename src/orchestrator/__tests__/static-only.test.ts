/**
 * `--static-only` in a run (R13.4, D26): selection skips each check that may
 * run the repo's code with a `static-only: <cause>` reason, a kept check whose
 * tool needs an install skips rather than fails, the defaults layer can vouch
 * for its own checks while the repo can't, and the run is partial, so it
 * records `run.static_only` and never ratchets.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import { resolveChecks } from '../../config.js';
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

  // F40
  test('a static check stays, and .oxlintrc.json declaring jsPlugins skips lint with the sniff’s reason', async () => {
    await writeFile(join(repo, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['./rules.js'] }));
    const checks = await filtered({ checks: { lint: { use: 'oxlint', args: ['exec', 'oxlint', '--format=json'] }, links: 'links', types: 'tsc' } });
    expect(checks.get('lint')?.skip).toBe('static-only: .oxlintrc.json sets jsPlugins, which loads code');
    expect(checks.get('links')?.skip).toBeNull();
    expect(checks.get('types')?.skip).toBe("static-only: tsc isn't a static check");
  });

  test("a repo's custom check, and an entry that swaps a static adapter's command, never qualify", async () => {
    const checks = await filtered({ checks: { licenses: { command: 'node', args: ['x.js'] }, docs: { use: 'markdownlint-cli2', command: 'node' } } });
    expect(checks.get('licenses')?.skip).toBe("static-only: custom:licenses isn't a static check");
    expect(checks.get('docs')?.skip).toBe("static-only: markdownlint-cli2 isn't a static check");
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

  test('without it, the same missing tool fails the check, as it always has', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ devDependencies: { 'markdownlint-cli2': '0.23.3' } }));
    const result = await runChecks({ cwd: repo, config: { checks: { docs: 'markdownlint-cli2' } }, only: ['docs'], stdout: quiet, stderr: quiet });
    expect(result.summary.checks.find((c) => c.name === 'docs')).toMatchObject({ ok: false });
    expect(result.summary.checks.find((c) => c.name === 'docs')).not.toHaveProperty('skipped');
    expect(result.summary.run).not.toHaveProperty('static_only');
  });
});
