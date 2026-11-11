/**
 * The one containment rule for a file a config names: checkride reads it only
 * when its real path is inside the repository. The `schema` slot keeps it for
 * its schemas, their references and the data files, and the `prose` slot for
 * its `exemplars`.
 *
 * A config is not trusted. `--static-only` exists to check a repo whose
 * author is a stranger, and there a rule's `schema`, a `$ref` in a schema, an
 * `exemplars` path, or a symlink among the files any of them match could each
 * name a file anywhere on the machine, whose contents or whose presence would
 * then surface in a report. So every such path is resolved first, symlinks
 * followed, and tested against the repository's own real path. What resolves
 * outside is never opened: a schema, a reference or an exemplar there refuses
 * the check, and a data file there is a finding on that file.
 *
 * The test is on real paths because a lexical one is not a boundary: a
 * symlink inside the repo can point anywhere.
 *
 * And the resolving itself never touches a path outside the repository. A
 * `realpath` would: it follows a link wherever it leads, and whether it
 * succeeds says whether the target is there, which is an answer about the
 * machine a refusal would then carry. So the path is walked a segment at a
 * time from the repository's real root, each segment read with `lstat` and,
 * for a link, `readlink`, both of which read the entry inside the repository
 * and nothing it names. A link's target is resolved as text. One that lands
 * outside is `outside` there and then, whether or not anything is at the
 * other end; one that lands inside is walked in turn. A `..` in the path as
 * given is resolved as text too, before the walk.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Where a path really is: `inside` the repository, with its real path, which
 * is the one to read; `outside` it; or `missing`, for a path that resolves to
 * nothing inside it.
 */
export type Located = { inside: string } | 'outside' | 'missing';

/**
 * A repository root, in both of its spellings: `given`, as the paths a run
 * builds from it are spelled, and `real`, with every symlink above it
 * resolved, which is where the walk starts. On macOS a temp directory is
 * `/var/…` as given and `/private/var/…` for real.
 */
export type Root = { given: string; real: string };

/** The root of the repository at `repo`. Its real path is the one as given when that can't be resolved. */
export function repoRoot(repo: string): Root {
  const given = resolve(repo);
  try {
    return { given, real: realpathSync(given) };
  } catch {
    return { given, real: given };
  }
}

/** The most links one path may pass through, which a link that names itself would otherwise never reach the end of. */
const MAX_LINKS = 40;

/** A walk under way: `at`, a real directory inside the repository, the segments still `ahead` of it, and the links followed so far. */
type Walk = { at: string; ahead: readonly string[]; links: number };

/** What one entry inside the repository is: nothing, a link with the target it names, or anything else. */
type Probe = 'missing' | 'entry' | { link: string };

/** `path`'s segments below the root, by either of its spellings, or `null` for a path that is under neither. Nothing is read. */
function segmentsUnder(root: Root, path: string): string[] | null {
  for (const base of [root.given, root.real]) {
    const below = relative(base, path);
    if (below === '') return [];
    if (below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below)) return below.split(sep);
  }
  return null;
}

/** The walk after its next segment, at `next`, probed as `probe`; or where the path is, once that is known. */
function stepped(root: Root, walk: Walk, next: string, probe: Probe): Walk | { found: Located } {
  const ahead = walk.ahead.slice(1);
  if (probe === 'missing') return { found: 'missing' };
  if (probe === 'entry') return { at: next, ahead, links: walk.links };
  const target = segmentsUnder(root, resolve(walk.at, probe.link));
  if (target === null) return { found: 'outside' };
  if (walk.links >= MAX_LINKS) return { found: 'missing' };
  return { at: root.real, ahead: [...target, ...ahead], links: walk.links + 1 };
}

/** The walk `path` starts, or `outside` for a path that is under neither spelling of the root. */
function started(root: Root, path: string): Walk | { found: Located } {
  const ahead = segmentsUnder(root, resolve(root.given, path));
  return ahead === null ? { found: 'outside' } : { at: root.real, ahead, links: 0 };
}

/** The entry at `path`, which is inside the repository, read without following it. */
function probeSync(path: string): Probe {
  try {
    return lstatSync(path).isSymbolicLink() ? { link: readlinkSync(path) } : 'entry';
  } catch {
    return 'missing';
  }
}

/** {@link probeSync}, without blocking. */
async function probed(path: string): Promise<Probe> {
  try {
    return (await lstat(path)).isSymbolicLink() ? { link: await readlink(path) } : 'entry';
  } catch {
    return 'missing';
  }
}

/**
 * The walk of `path` against `root`, as the one thing both forms run: it
 * yields each entry it needs probed, always one inside the repository, takes
 * the probe back, and returns where the path is. The root itself is inside it.
 */
function* walking(root: Root, path: string): Generator<string, Located, Probe> {
  let walk = started(root, path);
  while (!('found' in walk)) {
    const [segment] = walk.ahead;
    if (segment === undefined) return { inside: walk.at };
    const next = join(walk.at, segment);
    walk = stepped(root, walk, next, yield next);
  }
  return walk.found;
}

/**
 * Where `path` really is, against `root`. For the few paths a run resolves
 * before it reads anything else: a schema, an exemplars directory.
 */
export function locatedSync(root: Root, path: string): Located {
  const walk = walking(root, path);
  let step = walk.next();
  while (step.done !== true) step = walk.next(probeSync(step.value));
  return step.value;
}

/** Where `path` really is, against `root`, as {@link locatedSync} finds it. For the data files, which a run resolves one at a time between other checks' work. */
export async function located(root: Root, path: string): Promise<Located> {
  const walk = walking(root, path);
  let step = walk.next();
  // oxlint-disable-next-line no-await-in-loop -- sequential by nature: each probe says where the next entry is.
  while (step.done !== true) step = walk.next(await probed(step.value));
  return step.value;
}
