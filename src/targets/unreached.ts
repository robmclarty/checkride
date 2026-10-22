/**
 * The ts configs no check reaches (#12). A workspace root that only installs
 * tools, with a `tsconfig.base.json` and no `tsconfig.json`, its packages each
 * holding their own, is one ts target at `.` whose `types` finds no tool, and
 * whose `test` finds none when vitest is only the packages' dependency. The run
 * said "only N of M checks ran", but nothing said that 17 nested
 * `tsconfig.json` files went unchecked, so an agent reading the active checks
 * believed TypeScript was covered. This names them, beside the run's coverage
 * line, in `doctor` and in what `init` writes, and fails nothing.
 *
 * "Reached" is read coarsely: a target whose slot found a tool reaches every
 * config under it. Reading a solution tsconfig's `references` or a vitest
 * `projects` list would take a JSONC and a TypeScript reader, so a root
 * `tsconfig.json` that names only some packages still reads as reaching all.
 */

import { posix } from 'node:path';

import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import { PACKS } from '../packs/index.js';
import { excluded, globRegExp } from './files.js';
import { isWithin, repoFiles } from './markers.js';

/** A ts target as this reads it: its name (`null` for the implicit one), its root, and the watched slots it found no tool for. */
export type TsTarget = { readonly name: string | null; readonly root: string; readonly empty: readonly string[] };

/** A slot of a ts target with no tool, and the config files under the target that a tool for it would read. */
export type Unreached = { check: string; root: string; slot: string; files: string[] };

/** The slots whose configs sit in each package of a workspace, and what a reader calls them. */
const WATCHED: Readonly<Record<string, string>> = { types: 'tsconfig.json file(s)', test: 'test config(s)' };

/** The files the ts pack's tools for `slot` detect by name: `tsconfig.json` for types, the vitest and jest configs for test. */
function detectNames(slot: string): ReadonlySet<string> {
  return new Set(PACKS.ts.adapters.filter((a) => a.slot === slot).flatMap((a) => a.detect));
}

/**
 * Each slot of `targets` with no tool whose configs sit below the target's
 * root, outside every deeper ts target's, in path order. A file a glob in
 * `ignore` matches is left out, as `unclaimed` leaves one out. A run with no
 * such slot reads no file list.
 */
export async function findUnreached(repo: string, targets: readonly TsTarget[], ignore: readonly string[] = [], git: GitRunner = realGit(repo)): Promise<Unreached[]> {
  const gaps = targets.flatMap((t) => t.empty.filter((slot) => Object.hasOwn(WATCHED, slot)).map((slot) => ({ target: t, slot })));
  if (gaps.length === 0) return [];
  const globs = ignore.map(globRegExp);
  const files = (await repoFiles(repo, git)).filter((f) => !excluded(f, globs));
  return gaps.flatMap(({ target, slot }) => {
    const deeper = targets.filter((t) => t.root !== target.root && isWithin(t.root, target.root));
    const names = detectNames(slot);
    const found = files.filter((f) => names.has(posix.basename(f)) && isNested(posix.dirname(f), target.root, deeper));
    return found.length === 0 ? [] : [{ check: target.name === null ? slot : `${target.name}:${slot}`, root: target.root, slot, files: found }];
  });
}

/** Whether `dir` lies below `root`, not at it, and in no deeper target's root. */
function isNested(dir: string, root: string, deeper: readonly TsTarget[]): boolean {
  return dir !== root && isWithin(dir, root) && !deeper.some((t) => isWithin(dir, t.root));
}

/** How a gap is fixed: a root config that reaches the packages, or a target for each. */
const REMEDIES: Readonly<Record<string, (root: string) => string>> = {
  types: (root) => `add a tsconfig.json at \`${root}\` whose \`references\` name them, each of them \`composite\`, or declare a ts target for each package`,
  test: (root) => `add a vitest config at \`${root}\` whose \`projects\` name them, with vitest a devDependency there, or declare a ts target for each package`,
};

/** The line a run, `doctor` and `init` print for a gap: what goes unchecked, the first file, and the fix. */
export function unreachedLine(u: Unreached): string {
  const [first = '', ...rest] = u.files;
  const more = rest.length > 0 ? `, and ${rest.length} more` : '';
  return `${u.check} has no tool under \`${u.root}\`, so ${u.files.length} nested ${WATCHED[u.slot] ?? 'config(s)'} go unchecked (${first}${more}): ${REMEDIES[u.slot]?.(u.root) ?? 'give the slot a tool'}`;
}

/** A gap as the AGENTS.md stanza names it: the check, and how many configs it leaves unchecked where. */
export function unreachedNote(u: Unreached): string {
  return `\`${u.check}\` (${u.files.length} nested ${WATCHED[u.slot] ?? 'config(s)'} under \`${u.root}\`)`;
}
