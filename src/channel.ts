/**
 * The distribution channel this process runs from: the npm package, or the
 * standalone binary (R14.1), a Node single executable application with the
 * CLI and the package's own files embedded.
 *
 * The one place that asks `node:sea`. Everything that behaves differently in
 * the binary (where bundled files are read from, how the entry point is
 * recognized, what `doctor` reports, which `extends` entries resolve) asks
 * here.
 *
 * The module is looked up when asked and never imported: a runtime that has
 * no `node:sea`, as Bun has none, would fail a static import while loading
 * the npm package, and a runtime without it is by definition not the binary.
 */

/** How checkride was installed: from npm, or as the standalone binary. */
export type Channel = 'npm' | 'binary';

/** What this module asks of `node:sea`. */
type Sea = { isSea: () => boolean; getAsset: (key: string, encoding: string) => string };

/** `node:sea`, or `undefined` on a runtime that has none. */
function sea(): Sea | undefined {
  try {
    return process.getBuiltinModule('node:sea');
  } catch {
    return undefined;
  }
}

/** The channel this process runs from. */
export function channel(): Channel {
  return sea()?.isSea() === true ? 'binary' : 'npm';
}

/** The version of the Node this process runs on, which in the binary is the one embedded in it. */
export function nodeVersion(): string {
  return process.versions.node;
}

/**
 * A file embedded in the binary, as UTF-8, by the key `build/sea/build.mjs`
 * embedded it under. Throws for a key the binary doesn't carry, and outside
 * the binary, which carries none.
 */
export function embeddedAsset(key: string): string {
  const module = sea();
  if (module === undefined || !module.isSea()) throw new Error(`no embedded asset ${key}: not the standalone binary`);
  return module.getAsset(key, 'utf8');
}
