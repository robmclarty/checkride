/**
 * Whether the copy of a tool `PATH` holds is a Nix dev shell's, and so pinned.
 *
 * A repo's own Nix files, a flake and its lock, a `shell.nix`, devenv, devbox
 * or flox, fix every store path its shell puts on `PATH`, so a tool from
 * there is as pinned as one a lockfile installs. `nix develop`, `nix-shell`,
 * nix-direnv and devenv put a `bin` inside the store on `PATH` itself; devbox
 * and flox put a profile inside the repo that links into the store. A user's
 * profile (`~/.nix-profile/bin`, `/run/current-system/sw/bin`) links into the
 * store too, but it's the machine's, not the repo's, so its copy stays
 * unpinned (D12): a `PATH` entry is judged as written, never resolved. The
 * version is read off the store path, never asked of the tool (D13).
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { dirsUpTo } from './walk.js';

/** The files whose presence, from a check's directory up to the repo root, declares a Nix environment. */
const NIX_MARKERS: readonly string[] = ['flake.nix', 'flake.lock', 'shell.nix', 'default.nix', 'devenv.nix', 'devbox.json', '.flox'];

/** The default store, where `NIX_STORE_DIR` doesn't name another. */
const DEFAULT_STORE = '/nix/store';

/** An output other than `out` suffixes a store entry's name, as `shellcheck-0.10.0-bin` does; it isn't part of the version. */
const OUTPUT_SUFFIX = /-(?:bin|dev|lib|man|doc|info|static|debug)$/;

/** Where a copy was found from: the check's directory, the repo root, and the environment whose `PATH` was searched. */
export type NixQuery = { cwd: string; repo: string; env: Readonly<Record<string, string | undefined>> };

/** `path` with its links resolved, or `null` when it can't be. */
function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether `path` lies strictly inside `dir`. */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Whether `path` lies inside `dir` as given or as resolved, since a store or repo can be reached through a link (macOS's `/var` is `/private/var`). */
function withinEither(dir: string, path: string): boolean {
  const resolved = real(dir);
  return within(dir, path) || (resolved !== null && within(resolved, path));
}

/** Whether a Nix environment is declared between `cwd` and the repo root. */
function declaresNix(cwd: string, repo: string): boolean {
  return dirsUpTo(cwd, repo).some((dir) => NIX_MARKERS.some((marker) => existsSync(join(dir, marker))));
}

/**
 * The version a store entry's name carries, as Nix's `parseDrvName` splits
 * `<name>-<version>`: the version starts after the first `-` not followed by
 * a letter, so `golangci-lint-2.11.4` is `2.11.4` and `python3-3.12.8` is
 * `3.12.8`. `null` for a name with none, such as a profile's.
 */
export function drvVersion(entry: string): string | null {
  const name = entry.replace(/^[0-9a-z]{32}-/, '');
  const version = /-([^A-Za-z].*)$/.exec(name)?.[1]?.replace(OUTPUT_SUFFIX, '');
  return version === undefined || version === '' ? null : version;
}

/** The store entry `found` resolves into, its first path segment under the store, or `null` when it resolves outside it. */
function storeEntry(store: string, found: string): string | null {
  const target = real(found);
  const root = real(store);
  if (target === null || root === null || !within(root, target)) return null;
  return relative(root, target).split(sep)[0] ?? null;
}

/**
 * `found`, the copy of a tool `PATH` holds, as a Nix dev shell's: `{ version? }`
 * when the repo declares a Nix environment, the `PATH` entry it came from is
 * one a shell puts there (inside the store, or a profile inside the repo), and
 * it resolves into the store; `null` otherwise, the copy then unpinned.
 */
export function nixCopy(found: string, at: NixQuery): { version?: string } | null {
  const store = at.env['NIX_STORE_DIR'] ?? DEFAULT_STORE;
  const dir = dirname(found);
  if (!isAbsolute(found) || !(withinEither(store, dir) || withinEither(at.repo, dir))) return null;
  const entry = storeEntry(store, found);
  if (entry === null || !declaresNix(at.cwd, at.repo)) return null;
  const version = drvVersion(entry);
  return version === null ? {} : { version };
}
