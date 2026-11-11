/**
 * The one containment rule of the `schema` slot: it reads a file only when
 * the file's real path is inside the repository.
 *
 * A config is not trusted. `--static-only` exists to check a repo whose
 * author is a stranger, and there a rule's `schema`, a `$ref` in a schema, or
 * a symlink among the data files could each name a file anywhere on the
 * machine, whose contents would then surface in a finding. So every path the
 * slot is about to read is resolved first, symlinks followed, and tested
 * against the repository's own real path. What resolves outside is never
 * opened: a schema or a reference there refuses the check, and a data file
 * there is a finding on that file.
 *
 * The test is on real paths because a lexical one is not a boundary: a
 * symlink inside the repo can point anywhere, and `..` reads differently
 * through one.
 */

import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Where a path really is: `inside` the repository, with its real path, which
 * is the one to read; `outside` it; or `missing`, for a path that resolves to
 * nothing.
 */
export type Located = { inside: string } | 'outside' | 'missing';

/** The repository root's real path, which every path is tested against; the root as given when it can't be resolved. */
export function realRoot(repo: string): string {
  try {
    return realpathSync(repo);
  } catch {
    return repo;
  }
}

/** Where the real path `real` sits against the real root `root`. The root itself is no file inside it. */
function against(root: string, real: string): Located {
  const from = relative(root, real);
  const outside = from === '' || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from);
  return outside ? 'outside' : { inside: real };
}

/** Where `path` really is, against the real root `root`. For the few schema files a run reads before it reads anything else. */
export function locatedSync(root: string, path: string): Located {
  try {
    return against(root, realpathSync(path));
  } catch {
    return 'missing';
  }
}

/** Where `path` really is, against the real root `root`. For the data files, which a run resolves one at a time between other checks' work. */
export async function located(root: string, path: string): Promise<Located> {
  try {
    return against(root, await realpath(path));
  } catch {
    return 'missing';
  }
}
