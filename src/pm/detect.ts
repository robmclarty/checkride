/**
 * Package-manager detection.
 *
 * Resolves which package manager a repo uses so the orchestrator can translate
 * each adapter's canonical `pnpm exec <tool>` invocation into that PM's form.
 * Resolution order: the declared `packageManager` field wins (it is the
 * author's explicit intent), then a lockfile, then a `pnpm` default. Every fs
 * touch is injectable so the logic is unit-testable without a real repo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const KNOWN: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/** Narrow a raw name to a known package manager. */
function isPackageManager(name: string): name is PackageManager {
  return KNOWN.has(name);
}

/** Lockfile → package manager, in resolution priority when several coexist. */
const LOCKFILES: readonly { file: string; pm: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
];

/**
 * Every lockfile name, without its package manager — a lockfile is also what
 * marks the top of a repository, which is where a tool search has to stop.
 */
export const LOCKFILE_NAMES: readonly string[] = LOCKFILES.map((l) => l.file);

/** Parse the `packageManager` field value (`"yarn@3.6.1"` → `'yarn'`), if known. */
function parseField(value: string | undefined): PackageManager | null {
  if (!value) return null;
  const name = value.split('@')[0]?.trim() ?? '';
  return isPackageManager(name) ? name : null;
}

/** Read the `packageManager` field from `cwd`'s package.json, or `undefined`. */
function readPackageManagerField(cwd: string): string | undefined {
  try {
    const pkg: { packageManager?: string } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.packageManager;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the package manager for `cwd`: the declared `packageManager` field,
 * else the first matching lockfile, else `pnpm`. `fileExists` and
 * `packageManagerField` are injectable for tests.
 */
export function detectPackageManager(
  input: {
    cwd?: string;
    fileExists?: (file: string) => boolean;
    packageManagerField?: () => string | undefined;
  } = {},
): PackageManager {
  const cwd = input.cwd ?? process.cwd();
  const fileExists = input.fileExists ?? ((file) => existsSync(join(cwd, file)));
  const readField = input.packageManagerField ?? (() => readPackageManagerField(cwd));

  const declared = parseField(readField());
  if (declared) return declared;

  for (const { file, pm } of LOCKFILES) {
    if (fileExists(file)) return pm;
  }
  return 'pnpm';
}
