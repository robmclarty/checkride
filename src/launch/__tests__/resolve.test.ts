import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { Launch, PackageManager } from '../index.js';
import { installCommand, launchCheck, launchFix } from '../index.js';

/** An exec-form invocation of a tool no ancestor directory can plausibly hold. */
const ABSENT = ['exec', 'checkride-nonexistent-tool'];

/** The refusal message, or `null` when the launcher would spawn. */
function refusalOf(launch: Launch): string | null {
  return 'refusal' in launch ? launch.refusal : null;
}

/**
 * The pre-flight that keeps a launcher's per-user cache from deciding a slot's
 * verdict. `--no-install` stops the fetch but not the cache, so without this a
 * tool the repo never declared passes on a machine holding a stray copy and
 * fails on a clean checkout — the CI runner.
 */
describe('launchCheck refuses a tool the project never installed', () => {
  test('refuses the slot when the tool is not in the local tree', () => {
    expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm: 'npm' }))).not.toBeNull();
  });

  test('names the slot, the tool, and the PM-correct install command', () => {
    const refusal = refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm: 'npm' })) ?? '';
    expect(refusal).toContain('`lint` slot');
    expect(refusal).toContain('checkride-nonexistent-tool');
    expect(refusal).toContain('npm install -D checkride-nonexistent-tool');
    // The raw launcher error ("npx canceled due to missing packages") named
    // none of this, which is what a consumer's CI digest used to be handed.
    expect(refusal).toContain('node_modules/.bin/checkride-nonexistent-tool');
  });

  /**
   * The executable isn't always the package: `npm install -D tsc` installs an
   * unrelated package, and `typescript` is the one that provides `tsc`.
   */
  test('installs the package that provides the tool, not the tool by name', () => {
    const refusal = refusalOf(launchCheck('types', 'pnpm', ['exec', 'tsc', '--build'], { cwd: '/repo', pm: 'bun' })) ?? '';
    expect(refusal).toContain('looked for: node_modules/.bin/tsc');
    expect(refusal).toContain('bun add -d typescript');
    expect(installCommand('npm', 'ast-grep')).toBe('npm install -D @ast-grep/cli');
    expect(installCommand('pnpm', 'stryker')).toBe('pnpm add -D @stryker-mutator/core');
  });

  test('lets the check spawn once the tool resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-preflight-'));
    try {
      const bin = join(dir, 'node_modules', '.bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'checkride-nonexistent-tool'), '');
      expect(launchCheck('lint', 'pnpm', ABSENT, { cwd: dir, pm: 'npm' })).toEqual({
        command: 'npx',
        args: ['--no-install', 'checkride-nonexistent-tool'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Scoped to the launchers with a cache to fall back on. `pnpm exec` and
   * `yarn` resolve from the project tree already, and Yarn PnP has no
   * `node_modules/.bin` at all — pre-flighting it would fail every slot on a
   * repo where every tool is genuinely available.
   */
  test('does not pre-flight the managers that resolve from the tree only', () => {
    for (const pm of ['pnpm', 'yarn'] satisfies PackageManager[]) {
      expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm }))).toBeNull();
    }
  });

  test('pre-flights both cache-backed launchers', () => {
    for (const pm of ['npm', 'bun'] satisfies PackageManager[]) {
      expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm }))).not.toBeNull();
    }
  });

  test('ignores invocations that have no tool to resolve', () => {
    // A custom check's own command, a PM subcommand, and a package script all
    // resolve themselves; only `pnpm exec <tool>` is pre-flighted.
    const cases: [string, string[]][] = [
      ['node', ['scripts/check-licenses.mjs']],
      ['pnpm', ['audit', '--json']],
      ['pnpm', ['run', 'build']],
    ];
    for (const [command, args] of cases) {
      expect(refusalOf(launchCheck('lint', command, args, { cwd: '/repo', pm: 'npm' }))).toBeNull();
    }
  });
});

describe('launchCheck builds the argv through the js-lockfile source', () => {
  const ctx = { cwd: '/repo' };

  test('keeps the pnpm exec prefix, adding only the deps-check override', () => {
    expect(launchCheck('lint', 'pnpm', ['exec', 'oxlint'], { ...ctx, pm: 'pnpm' })).toEqual({
      command: 'pnpm',
      args: ['--config.verify-deps-before-run=false', 'exec', 'oxlint'],
    });
  });

  test('swaps the launcher for the detected manager', () => {
    expect(launchCheck('build', 'pnpm', ['run', 'build'], { ...ctx, pm: 'yarn' })).toEqual({ command: 'yarn', args: ['run', 'build'] });
    expect(launchCheck('lint', 'pnpm', ['exec', 'oxlint'], { ...ctx, pm: 'yarn' })).toEqual({ command: 'yarn', args: ['oxlint'] });
  });

  test('spawns any other command as written', () => {
    expect(launchCheck('licenses', 'node', ['scripts/check-licenses.mjs'], { ...ctx, pm: 'npm' })).toEqual({
      command: 'node',
      args: ['scripts/check-licenses.mjs'],
    });
  });
});

describe('launchFix', () => {
  test('runs the fix on the copy the check runs', () => {
    expect(launchFix('pnpm', ['exec', 'oxlint', '--fix'], 'bun')).toEqual({
      command: 'bunx',
      args: ['--no-install', 'oxlint', '--fix'],
    });
  });

  /** A fix runs with the terminal attached, and 0.13 never pre-flighted it. */
  test('never refuses, even for a tool the project never installed', () => {
    expect(launchFix('pnpm', ABSENT, 'npm')).toEqual({ command: 'npx', args: ['--no-install', 'checkride-nonexistent-tool'] });
  });
});
