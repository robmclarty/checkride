/**
 * The pack registry: every pack, by name.
 */

import { BASH_PACK } from './bash.js';
import { GO_PACK } from './go.js';
import { REPO_PACK } from './repo.js';
import { TS_PACK } from './ts.js';
import type { Pack } from './types.js';

/** Every pack, keyed by its name. */
export const PACKS: Readonly<Record<Pack['name'], Pack>> = {
  ts: TS_PACK,
  repo: REPO_PACK,
  bash: BASH_PACK,
  go: GO_PACK,
};
