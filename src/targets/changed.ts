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

/** The files whose change can move a Go workspace's module graph, so a run checks every module (R10.4). */
const GO_GRAPH_FILES: ReadonlySet<string> = new Set(['go.work', 'go.work.sum', 'go.mod']);

/**
 * The workspace modules a `--changed` run's paths touch (R10.4): each path's
 * module is the deepest `use` directory it lies under, and a path under none
 * is ignored. `null` means check every module, because a path changes the
 * module graph itself: `go.work`, `go.work.sum` or any `go.mod`. `moduleDirs`
 * and `paths` are relative to the workspace root and `/`-separated, with `.`
 * for the root.
 */
export function changedGoModules(moduleDirs: readonly string[], paths: readonly string[]): Set<number> | null {
  if (paths.some((path) => GO_GRAPH_FILES.has(path.split('/').at(-1) ?? ''))) return null;
  const changed = new Set<number>();
  for (const path of paths) {
    const owner = moduleDirs
      .map((dir, i) => ({ dir, i }))
      .filter(({ dir }) => isUnder(path, dir))
      .toSorted((a, b) => depth(b.dir) - depth(a.dir))[0];
    if (owner !== undefined) changed.add(owner.i);
  }
  return changed;
}

/** How deep a directory sits under the workspace root: `.` at 0. */
function depth(dir: string): number {
  return dir === '.' ? 0 : dir.split('/').length;
}

/**
 * The changed paths under `root`, made relative to it, from paths relative to
 * the repo root.
 */
export function pathsUnder(paths: readonly string[], root: string): string[] {
  if (root === '.') return [...paths];
  return paths.filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1));
}

/** Why a Go check sits out a `--changed` run that touched no module under `root`. */
export function noGoModuleChangedReason(root: string): string {
  return `no Go module changed under ${root}`;
}
