/**
 * Which targets a `--changed` run checks (R10.3). A target is affected when a
 * changed path lies under its root, and the checks of a target that isn't are
 * skipped with `no changes under <root>`. Paths and roots are both relative to
 * the repo root and `/`-separated, with `.` for the root itself.
 */

/** True when `path` lies under `root`. Every path lies under `.`. */
function isUnder(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

/** True when some changed path lies under `root`, so the target there is affected. */
export function changedUnder(paths: readonly string[], root: string): boolean {
  return paths.some((path) => isUnder(path, root));
}

/** Why the checks of a target with nothing changed under `root` sit out. */
export function noChangesReason(root: string): string {
  return `no changes under ${root}`;
}
