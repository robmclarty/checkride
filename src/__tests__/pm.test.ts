import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { PackageManager } from '../pm/index.js';
import {
  detectPackageManager,
  execTool,
  execUsesGlobalCache,
  installCommand,
  isAvailableUnder,
  isPnPInstall,
  launchRefusal,
  resolveSlotTool,
  SPAWN_FAILED_MARKER,
  translateExec,
} from '../pm/index.js';

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

describe('execTool', () => {
  test('names the tool in an exec invocation', () => {
    expect(execTool('pnpm', ['exec', 'oxlint', '--type-aware'])).toBe('oxlint');
  });

  test('returns null for every invocation that has no tool to resolve', () => {
    expect(execTool('pnpm', ['audit', '--json'])).toBeNull(); // PM subcommand
    expect(execTool('pnpm', ['run', 'build'])).toBeNull(); // package script
    expect(execTool('node', ['scripts/check-licenses.mjs'])).toBeNull(); // custom check
    expect(execTool('pnpm', ['exec'])).toBeNull(); // malformed: exec with no tool
    expect(execTool('pnpm', [])).toBeNull();
  });

  /**
   * The pre-flight and `translateExec` must agree on what counts as a tool: a
   * prefix one treats as exec and the other does not would either refuse a
   * runnable check or spawn an unresolved one.
   */
  test('agrees with translateExec on which invocations are exec form', () => {
    const cases = [
      ['pnpm', ['exec', 'oxlint']],
      ['pnpm', ['audit', '--json']],
      ['pnpm', ['run', 'build']], // rewritten too, but to `npm run` — not a tool
      ['node', ['script.mjs']],
    ] as const;
    for (const [command, args] of cases) {
      // Under npm, the exec prefix is the only one that becomes `npx`.
      const viaLauncher = translateExec(command, args, 'npm').command === 'npx';
      expect(execTool(command, args) !== null, `${command} ${args.join(' ')}`).toBe(viaLauncher);
    }
  });
});

/** A tree whose only `node_modules/.bin` entries are the paths listed. */
function tree(present: string[]) {
  return (p: string) => present.includes(p);
}

describe('resolveSlotTool', () => {
  test('finds a tool in the starting directory', () => {
    const bin = join('/repo', 'node_modules', '.bin', 'oxlint');
    expect(resolveSlotTool('/repo', 'oxlint', tree([bin]))).toBe(bin);
  });

  /**
   * pnpm and npm both hoist a shared workspace tool's bin to the repo root, so
   * a check running in a package subdirectory has to walk up to find it.
   * Testing the starting directory alone reported every hoisted tool missing —
   * which is most repos using a workspace preset.
   */
  test('walks up to a tool hoisted to the workspace root', () => {
    const rootBin = join('/repo', 'node_modules', '.bin', 'oxlint');
    expect(resolveSlotTool('/repo/packages/web', 'oxlint', tree([rootBin]))).toBe(rootBin);
  });

  test('prefers the nearest copy over a hoisted one', () => {
    const near = join('/repo/packages/web', 'node_modules', '.bin', 'oxlint');
    const root = join('/repo', 'node_modules', '.bin', 'oxlint');
    expect(resolveSlotTool('/repo/packages/web', 'oxlint', tree([near, root]))).toBe(near);
  });

  test('returns null when no ancestor has the tool', () => {
    expect(resolveSlotTool('/repo/packages/web', 'oxlint', tree([]))).toBeNull();
  });

  test('terminates at the filesystem root rather than looping', () => {
    // A missing tool must walk to the top and stop; the guard is `dirname(dir) === dir`.
    expect(resolveSlotTool('/', 'oxlint', tree([]))).toBeNull();
  });

  /**
   * A stray install above the checkout is the launcher-cache defect by another
   * route: the slot would pass for whoever has that directory above their clone
   * and fail on the clean checkout. The search stops where the repo does.
   */
  test('does not accept a tool installed above the repo root', () => {
    const outside = join('/Users/dev', 'node_modules', '.bin', 'oxlint');
    const marker = join('/Users/dev/repo', '.git');
    expect(resolveSlotTool('/Users/dev/repo', 'oxlint', tree([outside, marker]))).toBeNull();
  });

  test('searches the repo root itself before stopping', () => {
    const rootBin = join('/repo', 'node_modules', '.bin', 'oxlint');
    expect(resolveSlotTool('/repo/packages/web', 'oxlint', tree([rootBin, join('/repo', '.git')]))).toBe(rootBin);
  });

  test('treats a lockfile as a root marker too, for a repo with no .git', () => {
    const outside = join('/Users/dev', 'node_modules', '.bin', 'oxlint');
    const marker = join('/Users/dev/repo', 'pnpm-lock.yaml');
    expect(resolveSlotTool('/Users/dev/repo', 'oxlint', tree([outside, marker]))).toBeNull();
  });

  test('does not confuse one tool for another', () => {
    const bin = join('/repo', 'node_modules', '.bin', 'oxlint');
    expect(resolveSlotTool('/repo', 'markdownlint-cli2', tree([bin]))).toBeNull();
  });
});

describe('isPnPInstall', () => {
  test('detects each generation of the PnP manifest', () => {
    for (const f of ['.pnp.cjs', '.pnp.js', '.pnp.data.json']) {
      expect(isPnPInstall('/repo', tree([join('/repo', f)])), f).toBe(true);
    }
  });

  test('is false for a node_modules install', () => {
    expect(isPnPInstall('/repo', tree([join('/repo', 'node_modules', '.bin', 'oxlint')]))).toBe(false);
  });

  test('does not walk up — PnP is per-project', () => {
    // A parent's .pnp.cjs says nothing about how this project is installed.
    expect(isPnPInstall('/repo/packages/web', tree([join('/repo', '.pnp.cjs')]))).toBe(false);
  });
});

describe('installCommand', () => {
  test('spells the dev-dependency install per PM', () => {
    expect(installCommand('pnpm', 'oxlint')).toBe('pnpm add -D oxlint');
    expect(installCommand('npm', 'oxlint')).toBe('npm install -D oxlint');
    expect(installCommand('yarn', 'oxlint')).toBe('yarn add -D oxlint');
    // bun spells the dev flag lowercase; `-D` means something else there.
    expect(installCommand('bun', 'oxlint')).toBe('bun add -d oxlint');
  });
});

describe('execUsesGlobalCache', () => {
  /**
   * The pre-flight is scoped to the launchers that can supply a tool this repo
   * never declared. Keeping that set in lockstep with the `--no-install` table
   * is the point: a PM that needs the flag has a cache to fall back on, and one
   * with a cache but no pre-flight is the hole this all exists to close.
   */
  test('is exactly the set of launchers told not to fetch', () => {
    for (const pm of ['pnpm', 'npm', 'yarn', 'bun'] satisfies PackageManager[]) {
      const noInstall = translateExec('pnpm', ['exec', 'oxlint'], pm).args.includes('--no-install');
      expect(execUsesGlobalCache(pm), `${pm} disagrees with its exec flags`).toBe(noInstall);
    }
  });

  test('exempts the managers that resolve from the project tree only', () => {
    // pnpm exec and yarn have no launcher cache — and Yarn PnP has no
    // node_modules/.bin at all, so pre-flighting it would fail every slot.
    expect(execUsesGlobalCache('pnpm')).toBe(false);
    expect(execUsesGlobalCache('yarn')).toBe(false);
  });
});

/**
 * Refusals — the package manager declining to start the script at all.
 *
 * These matter because they are indistinguishable from a failing test by exit
 * code alone: pnpm answers an `engines.node` mismatch with exit 1, exactly as a
 * red pipeline does. The whole value is in the two directions being right — a
 * refusal recognized, and a genuine red never mistaken for one.
 */
describe('launchRefusal', () => {
  /** Verbatim from pnpm 11 running a script in a repo whose engines exclude the running Node. */
  const PNPM_ENGINE = [
    '[ERR_PNPM_UNSUPPORTED_ENGINE] Unsupported environment (bad pnpm and/or Node.js version)',
    '',
    'Your Node version is incompatible with "/repo".',
    '',
    'Expected version: >=22 <23',
    'Got: v24.15.0',
  ].join('\n');

  test('the reported bug: pnpm refusing an engines.node mismatch', () => {
    expect(launchRefusal(PNPM_ENGINE)?.cause).toContain('engines');
  });

  test.each([
    ['npm under engine-strict', 'npm error code EBADENGINE'],
    ['npm, older spelling', 'npm ERR! code EBADENGINE'],
    ['pnpm with no such script', 'ERR_PNPM_NO_SCRIPT  Missing script: check'],
    ['npm with no such script', 'npm error Missing script: "check"'],
    ['pnpm with no manifest', 'ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND'],
    ['corepack failing to verify', 'Error: Cannot find matching keyid: {"signatures":[]}'],
    ['the launcher missing entirely', `${SPAWN_FAILED_MARKER} \`pnpm\`: spawn pnpm ENOENT`],
  ])('recognizes %s', (_name, output) => {
    expect(launchRefusal(output)).not.toBeNull();
  });

  /**
   * npm prints `EBADENGINE` as a *warning* and runs the script anyway unless
   * `engine-strict` is set, and a stale `engines` field somewhere in a
   * dependency tree is common. Matching the bare code would reclassify a real
   * red as an environment problem — telling someone their machine is broken
   * while their code is what failed, which is worse than the bug this fixes.
   */
  test('npm’s EBADENGINE warning is not a refusal — the script ran', () => {
    expect(launchRefusal('npm warn EBADENGINE Unsupported engine {\n')).toBeNull();
  });

  test('ordinary tool failure is not a refusal', () => {
    expect(launchRefusal('src/a.ts(3,1): error TS2345: Argument of type ...\n')).toBeNull();
    expect(launchRefusal('FAIL src/__tests__/a.test.ts > adds\nExpected 2, got 3\n')).toBeNull();
    expect(launchRefusal('')).toBeNull();
  });

  test('names a cause that completes “the gate could not run — …”', () => {
    const refusal = launchRefusal(PNPM_ENGINE);
    expect(refusal?.cause[0]).toBe(refusal?.cause[0]?.toLowerCase());
    expect(refusal?.cause.endsWith('.')).toBe(false);
  });
});
