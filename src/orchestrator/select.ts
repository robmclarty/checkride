/**
 * Which resolved checks a run touches: the only/skip/include selection by
 * token (R5.2's grammar, in `../targets/`), the usage-error guard that
 * rejects a selection naming nothing a check answers to, the `--changed`
 * skip of targets nothing changed under, and the file lists a file-list
 * target's checks run over. Shared by `runChecks` and `runFix`.
 */

import type { Adapter } from '../adapters.js';
import type { ResolvedCheck } from '../config.js';
import type { GitRunner } from '../git.js';
import type { Target } from '../targets/index.js';
import {
  argvBytes,
  changedUnder,
  checkName,
  expandFiles,
  isFileListPack,
  MAX_FILES_ARGV_BYTES,
  namedBy,
  NO_FILES_REASON,
  noChangesReason,
  selectedBy,
  takesFiles,
  targetFiles,
  tokenProblem,
} from '../targets/index.js';
import type { RunFlags } from './types.js';

/**
 * Only/skip/opt-in selection by token: a slot or custom-check name, a target,
 * or `<target>:<slot>`.
 * An opt-in check runs when `--all` is given, when an `--include` token selects
 * it, when it was explicitly configured in `checks` (`r.explicit`), or when an
 * `--only` token names it — naming a slot is opting in. An inactive slot runs
 * only when an `--only` or `--include` token names it. A target token names no
 * slot, so `--only web` leaves `web`'s opt-in slots out unless one of the others
 * lets them in. `--skip` narrows `--only` too, so `--only web --skip web:test`
 * runs every check of `web` but its tests.
 */
export function selectChecks(resolved: readonly ResolvedCheck[], flags: RunFlags): ResolvedCheck[] {
  const skip = flags.skip ?? [];
  const sel: Selection = { only: flags.only ?? null, include: flags.include ?? [], all: flags.all ?? false };
  return resolved.filter((r) => !selectedBy(skip, r) && inSelection(r, sel));
}

/** The selection flags, with their defaults applied. */
type Selection = { only: readonly string[] | null; include: readonly string[]; all: boolean };

/** True when `r` runs whether or not it's opt-in: it isn't, or `--all`, its config entry or an `--include` token opts it in. */
function optedIn(r: ResolvedCheck, sel: Selection): boolean {
  return !r.optIn || sel.all || r.explicit === true || selectedBy(sel.include, r);
}

/** True when `sel` selects `r`, `--skip` aside. An inactive slot sits out every run, `--all` included, unless named. */
function inSelection(r: ResolvedCheck, sel: Selection): boolean {
  if (r.inactive === true) return namedBy(sel.only ?? [], r) || namedBy(sel.include, r);
  if (sel.only === null) return optedIn(r, sel);
  return selectedBy(sel.only, r) && (optedIn(r, sel) || namedBy(sel.only, r));
}

/**
 * Under `--changed` in multi-target mode, skip each check of a target with no
 * changed path under its root, with `no changes under <root>` (R10.3). The
 * checks keep their places, so each still prints and records its skipped row.
 * `changed` is the run's changed paths, relative to the repo root, or `null`
 * to skip nothing: off `--changed`, in implicit mode, or when git couldn't
 * list them. Repo-scope and top-level checks always run, and a check that
 * resolution already skipped keeps its own reason.
 */
export function skipUnchanged(selected: readonly ResolvedCheck[], changed: readonly string[] | null): ResolvedCheck[] {
  if (changed === null) return [...selected];
  return selected.map((r) => {
    if (r.target === undefined || r.root === undefined || r.skip !== null) return r;
    return changedUnder(changed, r.root) ? r : { ...r, skip: noChangesReason(r.root) };
  });
}

/** The file-list target `r` runs over, or `null` when it isn't an active check of one that takes `{files}`. */
function fileListTarget(r: ResolvedCheck, targets: readonly Target[]): Target | null {
  if (r.skip !== null || r.adapter === null || r.target === undefined) return null;
  if (!takesFiles(r.adapter.args) && !takesFiles(r.adapter.fixArgs)) return null;
  const target = targets.find((t) => t.name === r.target);
  return target !== undefined && isFileListPack(target.pack) ? target : null;
}

/**
 * `adapter` with `files` in place of each `{files}` in its args and fix args.
 * A list that pushes either argv past {@link MAX_FILES_ARGV_BYTES} throws, a
 * usage error raised before anything spawns, since the OS would refuse the
 * spawn and splitting the list would split the verdict.
 */
function withFiles(name: string, adapter: Adapter, files: readonly string[], target: Target): Adapter {
  const args = expandFiles(adapter.args, files);
  const fixArgs = adapter.fixArgs === undefined ? undefined : expandFiles(adapter.fixArgs, files);
  const bytes = Math.max(argvBytes([adapter.command, ...args]), argvBytes([adapter.command, ...(fixArgs ?? [])]));
  if (bytes > MAX_FILES_ARGV_BYTES) {
    throw new Error(
      `${name} would run over ${files.length} files, an argv of ${bytes} bytes, past the limit of ${MAX_FILES_ARGV_BYTES} bytes: narrow targets.${target.name}.include, or leave files out with targets.${target.name}.exclude`,
    );
  }
  return { ...adapter, args, ...(fixArgs !== undefined ? { fixArgs } : {}) };
}

/**
 * Hand each check of a file-list target its files (R11.2): every `{files}`
 * argument becomes the target's file list, one argument per file, so the
 * summary's `argv` names each file the check read. A target whose list is
 * empty skips its checks with `no files matched`, since a lint over no files
 * verifies nothing and fails nothing. A list too long for one argv throws.
 * Each target's list is read once, and only for a check that will run, so a
 * check `--changed` or resolution already skipped reads none. `targets` is
 * `null` in implicit mode, which has no file-list target.
 */
export async function withFileLists(
  selected: readonly ResolvedCheck[],
  repo: string,
  targets: readonly Target[] | null,
  git?: GitRunner,
): Promise<ResolvedCheck[]> {
  if (targets === null) return [...selected];
  const lists = new Map<string, Promise<string[]>>();
  const listOf = (target: Target): Promise<string[]> => {
    const list = lists.get(target.name) ?? targetFiles(repo, target, git);
    lists.set(target.name, list);
    return list;
  };
  return Promise.all(
    selected.map(async (r) => {
      const target = fileListTarget(r, targets);
      if (target === null || r.adapter === null) return r;
      const files = await listOf(target);
      if (files.length === 0) return { ...r, skip: NO_FILES_REASON };
      return { ...r, adapter: withFiles(checkName(r), r.adapter, files, target) };
    }),
  );
}

/**
 * Reject bad selections in `--only`/`--skip`/`--include`. A typo like
 * `--only lints` would otherwise slip through `selectChecks` as a filter that matched
 * nothing, silently disabling the gate — the worst kind of vacuous green in a
 * definition-of-done check. It is a usage error instead (thrown here, surfaced
 * as exit 2 at the CLI). The valid set is every token a resolved check answers
 * to: the catalogue slots, any config custom-check names, and in multi-target
 * mode the target names and each `<target>:<slot>`.
 *
 * A *present but empty* list is rejected for the same reason. `[]` is truthy,
 * so `selectChecks` reads it as "match nothing" rather than "no filter", and an
 * empty `only` selects zero checks. The CLI already rejects `--only ,` when it
 * parses (see `parseList`); this covers the programmatic API, where a caller can
 * hand `runChecks` an array it computed. `selectChecks` itself is left alone —
 * it is exported public surface, and the error belongs before it runs.
 */
export function validateSelection(resolved: readonly ResolvedCheck[], flags: RunFlags): void {
  for (const flag of ['only', 'skip', 'include'] as const) {
    const problem = tokenProblem(resolved, `--${flag}`, flags[flag]);
    if (problem !== null) throw new Error(problem);
  }
}
