/**
 * Which resolved checks a run touches: the only/skip/include selection by slot
 * name, and the usage-error guard that rejects a selection naming a slot that
 * does not exist. Shared by `runChecks` and `runFix`.
 */

import type { ResolvedCheck } from '../config.js';
import type { RunFlags } from './types.js';

/**
 * Only/skip/opt-in selection by slot name.
 * An opt-in slot runs when `--all`/`--include` names it, or when it was
 * explicitly configured in `checks` (`r.explicit`) — naming a slot is opting in.
 */
export function selectChecks(resolved: readonly ResolvedCheck[], flags: RunFlags): ResolvedCheck[] {
  const only = flags.only ?? null;
  const skipSet = new Set(flags.skip ?? []);
  const includeSet = new Set(flags.include ?? []);
  const all = flags.all ?? false;
  return resolved.filter((r) => {
    if (only) return only.includes(r.slot);
    if (skipSet.has(r.slot)) return false;
    if (r.optIn && !all && !includeSet.has(r.slot) && !r.explicit) return false;
    return true;
  });
}

/**
 * Reject bad slot selections in `--only`/`--skip`/`--include`. A typo like
 * `--only lints` would otherwise slip through `selectChecks` as a filter that matched
 * nothing, silently disabling the gate — the worst kind of vacuous green in a
 * definition-of-done check. It is a usage error instead (thrown here, surfaced
 * as exit 2 at the CLI). The valid set is every resolved slot: the catalogue
 * slots plus any config custom-check names.
 *
 * A *present but empty* list is rejected for the same reason. `[]` is truthy,
 * so `selectChecks` reads it as "match nothing" rather than "no filter", and an
 * empty `only` selects zero checks. The CLI already rejects `--only ,` when it
 * parses (see `parseList`); this covers the programmatic API, where a caller can
 * hand `runChecks` an array it computed. `selectChecks` itself is left alone —
 * it is exported public surface, and the error belongs before it runs.
 */
export function validateSelection(resolved: readonly ResolvedCheck[], flags: RunFlags): void {
  const valid = new Set(resolved.map((r) => r.slot));
  for (const flag of ['only', 'skip', 'include'] as const) {
    const names = flags[flag];
    if (names === undefined || names === null) continue;
    if (names.length === 0) {
      throw new Error(`--${flag} was given an empty list, which selects nothing. Valid slots: ${[...valid].join(', ')}.`);
    }
    const unknown = names.filter((name) => !valid.has(name));
    if (unknown.length === 0) continue;
    const named = unknown.map((n) => `'${n}'`).join(', ');
    const noun = unknown.length > 1 ? 'slots' : 'slot';
    throw new Error(`unknown ${noun} ${named} in --${flag}. Valid slots: ${[...valid].join(', ')}.`);
  }
}
