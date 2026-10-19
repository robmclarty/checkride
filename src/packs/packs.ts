/**
 * The pack registry: every pack, by name.
 */

import { BASH_PACK } from './bash.js';
import { GO_PACK } from './go.js';
import { PYTHON_PACK } from './python.js';
import { RUST_PACK } from './rust.js';
import { REPO_PACK } from './repo.js';
import { TERRAFORM_PACK } from './terraform.js';
import { TS_PACK } from './ts.js';
import type { Pack } from './types.js';

/** Every pack, keyed by its name. */
export const PACKS: Readonly<Record<Pack['name'], Pack>> = {
  ts: TS_PACK,
  repo: REPO_PACK,
  bash: BASH_PACK,
  go: GO_PACK,
  rust: RUST_PACK,
  python: PYTHON_PACK,
  terraform: TERRAFORM_PACK,
};

/** The pack named `name`, or `undefined` for none, as for a check of implicit ts mode, which has no pack. */
export function packNamed(name: string | undefined): Pack | undefined {
  return Object.values(PACKS).find((p) => p.name === name);
}
