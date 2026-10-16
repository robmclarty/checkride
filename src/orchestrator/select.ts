/**
 * Which resolved checks a run touches: the only/skip/include selection by
 * token (R5.2's grammar, in `../targets/`), the usage-error guard that
 * rejects a selection naming nothing a check answers to, and the `--changed`
 * skip of targets nothing changed under. Shared by `runChecks` and `runFix`.
 */

import type { ResolvedCheck } from '../config.js';
import { changedUnder, namedBy, noChangesReason, selectedBy, tokenProblem } from '../targets/index.js';
import type { RunFlags } from './types.js';

/**
 * Only/skip/opt-in selection by token: a slot or custom-check name, a target,
 * or `<target>:<slot>`.
 * An opt-in check runs when `--all` is given, when an `--include` token selects
 * it, when it was explicitly configured in `checks` (`r.explicit`), or when an
 * `--only` token names it — naming a slot is opting in. A target token names no
 * slot, so `--only web` leaves `web`'s opt-in slots out unless one of the others
 * lets them in. `--skip` narrows `--only` too, so `--only web --skip web:test`
 * runs every check of `web` but its tests.
 */
export function selectChecks(resolved: readonly ResolvedCheck[], flags: RunFlags): ResolvedCheck[] {
  const only = flags.only ?? null;
  const skip = flags.skip ?? [];
  const include = flags.include ?? [];
  const all = flags.all ?? false;
  return resolved.filter((r) => {
    if (selectedBy(skip, r)) return false;
    const optedIn = !r.optIn || all || r.explicit === true || selectedBy(include, r);
    if (only) return selectedBy(only, r) && (optedIn || namedBy(only, r));
    return optedIn;
  });
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
