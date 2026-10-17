/**
 * Discovery (R11.4): the targets a repo's own files propose, for existing-mode
 * `init` and, later, `--discover`. It reads markers as `unclaimed` does, from
 * the files git lists, and proposes targets only for packs that ship; each
 * pack's release adds its rule.
 *
 * - A root `package.json` or `pnpm-workspace.yaml` proposes one `ts` target at
 *   the root, which claims every nested `package.json`. Otherwise each
 *   top-most `package.json` proposes its own.
 * - Shell files R11.2's defaults keep, outside every other proposed target's
 *   root, propose one `bash` target at the deepest directory holding them
 *   all, named `scripts` when that's `scripts` and `shell` otherwise.
 *
 * A target is named after its root's last segment, `.` becoming `app`, with
 * a number added when another target, a slot or a reserved name holds it. One
 * ts target at the root and nothing else is the implicit mode a repo already
 * runs in, which writes no `targets` block.
 */

import { join, posix } from 'node:path';

import { SLOTS } from '../adapters.js';
import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import { PACKS } from '../packs/index.js';
import { isDefaultShellFile } from './files.js';
import { isWithin, numbered, repoFiles, slugName } from './markers.js';
import { RESERVED_SLOTS } from './resolve.js';

/** A target discovery proposes. */
export type ProposedTarget = { name: string; lang: string; root: string };

/** Names a proposed target can't take: the slots', and the ones V2 reserves. */
const TAKEN: readonly string[] = [...SLOTS.map((s) => s.name), ...RESERVED_SLOTS, 'doc-snippets'];

/** The ts roots: the repo root when it holds a `package.json` or `pnpm-workspace.yaml`, else each top-most `package.json` directory. */
function tsRoots(files: readonly string[]): string[] {
  if (files.includes('package.json') || files.includes('pnpm-workspace.yaml')) return ['.'];
  const dirs = files.filter((f) => posix.basename(f) === 'package.json').map((f) => posix.dirname(f));
  return dirs.filter((dir) => !dirs.some((other) => other !== dir && isWithin(dir, other)));
}

/** The deepest directory every one of `dirs` lies under, `.` for the root. */
function commonAncestor(dirs: readonly string[]): string {
  const [first = [], ...rest] = dirs.map((d) => (d === '.' ? [] : d.split('/')));
  let depth = 0;
  while (depth < first.length && rest.every((parts) => parts[depth] === first[depth])) depth += 1;
  return depth === 0 ? '.' : first.slice(0, depth).join('/');
}

/** The bash root: where the shell files outside every root in `taken` gather, or `null` when there are none. */
function bashRoot(repo: string, files: readonly string[], taken: readonly string[]): string | null {
  const shell = files.filter((f) => !taken.some((root) => isWithin(posix.dirname(f), root)) && isDefaultShellFile(f, join(repo, f)));
  return shell.length === 0 ? null : commonAncestor(shell.map((f) => posix.dirname(f)));
}

/** `targets` named per R11.4: each after its root, the bash one by its rule, a number added on a collision. */
function named(targets: readonly { lang: string; root: string }[]): ProposedTarget[] {
  const taken = new Set(TAKEN);
  return targets.map(({ lang, root }) => {
    const base = lang === PACKS.bash.name ? (root === 'scripts' ? 'scripts' : 'shell') : (root === '.' ? 'app' : slugName(root)) || lang;
    const name = taken.has(base) ? numbered(base, taken) : base;
    taken.add(name);
    return { name, lang, root };
  });
}

/** The targets the repo at `repo` proposes (R11.4), ts first, in root order. */
export async function discoverTargets(repo: string, git: GitRunner = realGit(repo)): Promise<ProposedTarget[]> {
  const files = await repoFiles(repo, git);
  const ts = tsRoots(files).toSorted().map((root) => ({ lang: PACKS.ts.name, root }));
  const bash = bashRoot(repo, files, ts.map((t) => t.root));
  return named([...ts, ...(bash === null ? [] : [{ lang: PACKS.bash.name, root: bash }])]);
}

/** True when `proposed` is the implicit mode the repo runs in without targets: none, or one ts target at the root. */
export function isImplicit(proposed: readonly ProposedTarget[]): boolean {
  const [only, ...rest] = proposed;
  return only === undefined || (rest.length === 0 && only.root === '.' && only.lang === PACKS.ts.name);
}
