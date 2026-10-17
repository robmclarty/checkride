/**
 * The entry command (R6.6): how humans, the stop-hook gate, the AGENTS.md
 * stanza and the plugin skills run checkride in a repo.
 *
 * A repo whose root `package.json` has a `check` script runs it, as every
 * repo has since 0.1, and so does a root `package.json` without one, whose
 * definition of done `init` wires through that script. A repo with no
 * `package.json`, the binary-only case, runs the checkride its root
 * `mise.toml` pins (`npm:checkride`, or `github:robmclarty/checkride` once a
 * binary ships), and failing that the `checkride` on `PATH`, which nothing
 * pins and `doctor` reports as the harness unpinned (D40, D46).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from '../json.js';
import { miseDeclaration } from './mise.js';
import type { PackageManager } from './package-manager.js';
import { execCommand, runScript } from './translate.js';

/** How a repo runs checkride: its package manager's `check` script, mise's pinned copy, or the one on `PATH`. */
export type EntryCommand = { kind: 'script'; pm: PackageManager } | { kind: 'mise' } | { kind: 'path' };

/** An entry command, or a package manager standing for its `<pm> run check`, as callers from before entry commands pass. */
export type EntryLike = EntryCommand | PackageManager;

/** The `[tools]` keys that declare checkride in a `mise.toml` (D46). */
const CHECKRIDE_MISE_IDS: readonly string[] = ['npm:checkride', 'github:robmclarty/checkride'];

/** The script a repo's `package.json` defines done with. */
const CHECK_SCRIPT = 'check';

/** `entry` as an entry command, a bare package manager read as its `check` script. */
export function asEntry(entry: EntryLike): EntryCommand {
  return typeof entry === 'string' ? { kind: 'script', pm: entry } : entry;
}

/** The root `package.json`, parsed, or `null` when there is none or it isn't an object. */
function readPackageJson(repo: string, read: (path: string) => string | null): Record<string, unknown> | null {
  const text = read(join(repo, 'package.json'));
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A file's text, or `null` when it can't be read. */
function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The entry command for the repo at `repo`, whose package manager is `pm`
 * (R6.6). `read` reads a file's text, or `null`, so `doctor` can answer from
 * its injected environment.
 */
export function resolveEntry(repo: string, pm: PackageManager, read: (path: string) => string | null = readText): EntryCommand {
  const pkg = readPackageJson(repo, read);
  const scripts = pkg?.['scripts'];
  if (isRecord(scripts) && typeof scripts[CHECK_SCRIPT] === 'string') return { kind: 'script', pm };
  if (miseDeclaration(repo, repo, CHECKRIDE_MISE_IDS) !== null) return { kind: 'mise' };
  return pkg !== null ? { kind: 'script', pm } : { kind: 'path' };
}

/** The full check, as a person types it: `pnpm run check`, `mise exec -- checkride` or `checkride`. */
export function entryText(entry: EntryLike): string {
  const e = asEntry(entry);
  if (e.kind === 'script') return runScript(e.pm, CHECK_SCRIPT);
  return e.kind === 'mise' ? 'mise exec -- checkride' : 'checkride';
}

/**
 * A checkride subcommand, as a person or a hook script types it: `pnpm exec
 * checkride triage`, `mise exec -- checkride triage` or `checkride triage`.
 * `quiet` keeps a package manager's own narration off stdout, for a caller
 * that parses it.
 */
export function entryCheckride(entry: EntryLike, args: readonly string[], opts: { quiet?: boolean } = {}): string {
  const e = asEntry(entry);
  if (e.kind === 'script') return execCommand(e.pm, ['checkride', ...args], opts);
  return [e.kind === 'mise' ? 'mise exec -- checkride' : 'checkride', ...args].join(' ');
}

/**
 * The argv that runs the full check with `flags` appended: the `check` script,
 * with npm's `--` ahead of the flags, mise's pinned checkride, or the one on
 * `PATH`.
 */
export function entryArgv(entry: EntryLike, flags: readonly string[]): [string, ...string[]] {
  const e = asEntry(entry);
  if (e.kind === 'script') return [e.pm, 'run', CHECK_SCRIPT, ...(e.pm === 'npm' && flags.length > 0 ? ['--'] : []), ...flags];
  return e.kind === 'mise' ? ['mise', 'exec', '--', 'checkride', ...flags] : ['checkride', ...flags];
}
