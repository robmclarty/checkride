/**
 * The launcher: the argv a check spawns, built from the invocation its adapter
 * row or custom check declares.
 *
 * A pin source decides which copy of a tool runs, and how. The only one so far
 * is `js-lockfile`, which every pack's chain names: the project's package
 * manager runs the copy its lockfile installed. It owns the canonical `pnpm …`
 * invocations, translating them for the detected manager and refusing a tool
 * the project never installed where a launcher cache could stand in for it.
 * Any other command, such as a custom check's own `node scripts/x.mjs`, spawns
 * as written.
 */

import { missingToolRefusal } from './js-lockfile.js';
import type { PackageManager } from './package-manager.js';
import { translateExec } from './translate.js';

/** An executable and the arguments it spawns with. */
type Argv = { command: string; args: string[] };

/**
 * What a check launches as: the argv to spawn, or the message it fails with
 * instead, because the source it resolves through won't run it here.
 */
export type Launch = Argv | { refusal: string };

/**
 * Launch the tool a check's `command` and `args` declare, for the check
 * filling `slot` from `ctx.cwd`. `args` arrive with their placeholders already
 * expanded.
 */
export function launchCheck(
  slot: string,
  command: string,
  args: readonly string[],
  ctx: { cwd: string; pm: PackageManager },
): Launch {
  const refusal = missingToolRefusal(slot, command, args, ctx);
  if (refusal !== null) return { refusal };
  return translateExec(command, args, ctx.pm);
}

/**
 * Launch an adapter's fix command under `pm`, on the same copy of the tool the
 * check runs. A fix spawns with the terminal attached and no pre-flight, as it
 * always has.
 */
export function launchFix(command: string, args: readonly string[], pm: PackageManager): Argv {
  return translateExec(command, args, pm);
}
