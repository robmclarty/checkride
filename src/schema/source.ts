/**
 * Which libraries a run of this process validates with: the standalone
 * binary's bundled copies, or the install of the repo it runs in. The one
 * place the `schema` slot asks which channel it runs from; the run and
 * `doctor` each take the source from here and hand it on.
 */

import { channel } from '../channel.js';
import type { LibrarySource } from './libraries.js';
import { bundledSource, repoSource } from './libraries.js';

/** The source a run in `repo` reads its libraries from. */
export function schemaLibrarySource(repo: string): LibrarySource {
  return channel() === 'binary' ? bundledSource() : repoSource(repo);
}
