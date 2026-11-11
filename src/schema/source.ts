/**
 * Which libraries a run of this process validates with: the standalone
 * binary's bundled copies, or the install of the repo it runs in, as this
 * checkride's runtime names it. The run and `doctor` each take the source
 * from here and hand it on.
 */

import { runtime } from '../channel.js';
import type { LibrarySource } from './libraries.js';
import { bundledSource, repoSource } from './libraries.js';

/** Each place libraries are loaded from, as the source that loads them for a run in `repo`. */
const SOURCES: Record<LibrarySource['label'], (repo: string) => LibrarySource> = {
  repo: repoSource,
  bundled: () => bundledSource(),
};

/** The source a run in `repo` reads its libraries from. */
export function schemaLibrarySource(repo: string): LibrarySource {
  return SOURCES[runtime().libraries](repo);
}
