import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { PackageManager } from '../pm/index.js';
import { detectPackageManager, isAvailableUnder, translateExec } from '../pm/index.js';

/** Build a detector whose only present files are the ones listed. */
function withFiles(present: string[], field?: string) {
  return detectPackageManager({
    fileExists: (file) => present.includes(file),
    packageManagerField: () => field,
  });
}

describe('detectPackageManager', () => {
  test('maps each lockfile to its package manager', () => {
    expect(withFiles(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(withFiles(['package-lock.json'])).toBe('npm');
    expect(withFiles(['yarn.lock'])).toBe('yarn');
    expect(withFiles(['bun.lock'])).toBe('bun');
    expect(withFiles(['bun.lockb'])).toBe('bun');
  });

  test('defaults to pnpm when no lockfile or field is present', () => {
    expect(withFiles([])).toBe('pnpm');
  });

  test('the packageManager field wins over a conflicting lockfile', () => {
    expect(withFiles(['pnpm-lock.yaml'], 'yarn@3.6.1')).toBe('yarn');
    expect(withFiles(['package-lock.json'], 'bun@1.1.0')).toBe('bun');
  });

  test('an unknown packageManager field falls through to the lockfile', () => {
    expect(withFiles(['yarn.lock'], 'deno@2.0.0')).toBe('yarn');
    expect(withFiles([], 'deno@2.0.0')).toBe('pnpm');
  });

  test('reads a real lockfile and the field from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-pm-'));
    try {
      await writeFile(join(dir, 'yarn.lock'), '');
      expect(detectPackageManager({ cwd: dir })).toBe('yarn');
      await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.1.0' }));
      expect(detectPackageManager({ cwd: dir })).toBe('bun');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('translateExec', () => {
  const execArgs = ['exec', 'oxlint', '--type-aware', '--format=json'];

  // pnpm narrates its dependency check on stdout ahead of the tool's own JSON
  // (`Already up to date` / `Done in Xms`) whenever no outer pnpm process has
  // already verified — which is exactly the `node dist/cli.js` case. The
  // override is the only form that suppresses it, and it must precede `exec`.
  const VERIFY_DEPS_OFF = '--config.verify-deps-before-run=false';

  test('keeps the pnpm exec prefix, prepending only the deps-check override', () => {
    expect(translateExec('pnpm', execArgs, 'pnpm')).toEqual({
      command: 'pnpm',
      args: [VERIFY_DEPS_OFF, ...execArgs],
    });
  });

  test('puts the override before exec, where pnpm reads it as its own', () => {
    // After `exec` it becomes the tool's argument and pnpm fails outright.
    const { args } = translateExec('pnpm', execArgs, 'pnpm');
    expect(args.indexOf(VERIFY_DEPS_OFF)).toBeLessThan(args.indexOf('exec'));
  });

  test('does not send the pnpm-only override to another package manager', () => {
    for (const pm of ['npm', 'yarn', 'bun'] satisfies PackageManager[]) {
      expect(translateExec('pnpm', execArgs, pm).args).not.toContain(VERIFY_DEPS_OFF);
    }
  });

  test('leaves pnpm subcommands that never verify deps alone', () => {
    // `audit` and `pack` do not run the dependency check, so the flag would be
    // noise in the invocation the user sees.
    for (const args of [['audit', '--json'], ['pack', '--dry-run', '--json']]) {
      expect(translateExec('pnpm', args, 'pnpm')).toEqual({ command: 'pnpm', args });
    }
  });

  test('rewrites the exec prefix per non-pnpm package manager', () => {
    const tool = ['oxlint', '--type-aware', '--format=json'];
    expect(translateExec('pnpm', execArgs, 'npm')).toEqual({ command: 'npx', args: ['--no-install', ...tool] });
    expect(translateExec('pnpm', execArgs, 'yarn')).toEqual({ command: 'yarn', args: tool });
    expect(translateExec('pnpm', execArgs, 'bun')).toEqual({ command: 'bunx', args: ['--no-install', ...tool] });
  });

  /**
   * `npx`/`bunx` install a missing package from the registry and run it, and a
   * spawned check has no TTY — the non-interactive case where neither prompts.
   * Without this flag the gate would silently fetch an unpinned `latest` for a
   * tool the repo never installed. `yarn` neither auto-installs nor takes the
   * flag, so it must not grow one.
   */
  test('the auto-installing launchers are told not to fetch', () => {
    for (const pm of ['npm', 'bun'] satisfies PackageManager[]) {
      expect(translateExec('pnpm', execArgs, pm).args[0]).toBe('--no-install');
    }
    expect(translateExec('pnpm', execArgs, 'yarn').args).not.toContain('--no-install');
  });

  test('leaves non-exec pnpm commands (audit) untranslated for every PM', () => {
    const audit = ['audit', '--audit-level=high', '--json'];
    for (const pm of ['pnpm', 'npm', 'yarn', 'bun'] satisfies PackageManager[]) {
      expect(translateExec('pnpm', audit, pm)).toEqual({ command: 'pnpm', args: audit });
    }
  });

  test('keeps the pnpm run prefix, prepending only the deps-check override', () => {
    // `pnpm run` verifies deps the same way `pnpm exec` does, so a script that
    // emits JSON needs the same protection.
    const run = ['run', 'build'];
    expect(translateExec('pnpm', run, 'pnpm')).toEqual({
      command: 'pnpm',
      args: [VERIFY_DEPS_OFF, ...run],
    });
  });

  test('rewrites the run launcher per non-pnpm PM, keeping the run keyword (D13)', () => {
    const run = ['run', 'build'];
    // Every PM spells it `<pm> run <script>` — only the launcher changes.
    expect(translateExec('pnpm', run, 'npm')).toEqual({ command: 'npm', args: run });
    expect(translateExec('pnpm', run, 'yarn')).toEqual({ command: 'yarn', args: run });
    expect(translateExec('pnpm', run, 'bun')).toEqual({ command: 'bun', args: run });
  });

  test('leaves a custom check command untranslated', () => {
    const args = ['scripts/check-licenses.mjs'];
    expect(translateExec('node', args, 'npm')).toEqual({ command: 'node', args });
  });
});

describe('isAvailableUnder', () => {
  test('pnpm audit is available only under pnpm', () => {
    const audit = ['audit', '--json'];
    expect(isAvailableUnder('pnpm', audit, 'pnpm')).toBe(true);
    expect(isAvailableUnder('pnpm', audit, 'npm')).toBe(false);
    expect(isAvailableUnder('pnpm', audit, 'yarn')).toBe(false);
    expect(isAvailableUnder('pnpm', audit, 'bun')).toBe(false);
  });

  test('pnpm pack (the pack slot) is available under pnpm and npm only', () => {
    const pack = ['pack', '--dry-run', '--json'];
    expect(isAvailableUnder('pnpm', pack, 'pnpm')).toBe(true);
    expect(isAvailableUnder('pnpm', pack, 'npm')).toBe(true);
    expect(isAvailableUnder('pnpm', pack, 'yarn')).toBe(false);
    expect(isAvailableUnder('pnpm', pack, 'bun')).toBe(false);
  });

  test('exec and custom commands are available under every PM', () => {
    expect(isAvailableUnder('pnpm', ['exec', 'oxlint'], 'npm')).toBe(true);
    expect(isAvailableUnder('node', ['script.mjs'], 'yarn')).toBe(true);
  });
});
