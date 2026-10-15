/**
 * The output directory: where a run writes its artifacts, and where every
 * reader looks for them. The engine, the digest, both bundled-plugin readers
 * and `doctor` take the directory from {@link outDir} and name it in text
 * through {@link CHECK_DIR}, so none of them spells `.check` itself (the
 * `no-check-dir-literal` rule holds that), and moving the directory is a
 * change to this one module.
 *
 * Scratch is not output. `snippets` and `smoke` generate files that have to
 * resolve the repo's own modules from where they sit, so they write under
 * `<cwd>/.check/` whatever this directory is, and so does the gate's dirty
 * marker.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { join } from 'node:path';

/** The gitignored directory a run writes its artifacts into, relative to where it runs. */
export const CHECK_DIR = '.check';

/** The aggregate report, beside the raw artifacts in the output directory. */
export const SUMMARY_FILE = 'summary.json';

/** The absolute output directory of a run rooted at `cwd`. */
export function outDir(cwd: string): string {
  return join(cwd, CHECK_DIR);
}
