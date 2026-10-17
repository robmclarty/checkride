/**
 * The `unclaimed` check (R11.3): a toolchain marker no target claims is a
 * directory of code no check reads, the polyglot form of a vacuous green.
 *
 * A marker is a file R11.3 names as marking one language's code:
 * `package.json` and `tsconfig.json` for ts, read from `PACKS`, and the
 * markers of the packs that haven't shipped, which no target can claim yet.
 * A marker in a directory is claimed when some target of that pack is rooted
 * there or above it, which covers a workspace's packages under a root target.
 * Every marker no target claims is reported, with the target that would claim
 * it, in checkride's own `unclaimed.json`, and fails the check.
 */

import { posix, relative, resolve } from 'node:path';

import { SLOTS } from '../adapters.js';
import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import type { CheckOutcome } from '../links.js';
import { PACKS } from '../packs/index.js';
import { excluded, globRegExp, listFiles } from './files.js';
import { RESERVED_SLOTS } from './resolve.js';

/** A target as `unclaimed` reads it: the pack that checks it, from its root. */
export type Claimant = { readonly name: string; readonly pack: string; readonly root: string };

/** One marker no target claims, and the target that would. */
export type Unclaimed = { path: string; kind: string; suggest: { name: string; lang: string; root: string } };

/** What `unclaimed` checks: the targets that claim, the globs it never reports, and the run's output directory. */
export type UnclaimedInput = {
  readonly targets: readonly Claimant[];
  readonly ignore?: readonly string[];
  /** The output directory, absolute or relative to the repo root; what's under it is checkride's own. */
  readonly out?: string;
};

/**
 * Directories whose markers are never reported, at any depth: installed
 * dependencies, build output, virtual environments, checkride's own artifacts
 * and test data, none of which a target is meant to check.
 */
const NEVER_REPORTED: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'target', '.venv', '.terraform', '.check', 'testdata']);

/** A target name: a lowercase letter, then up to 31 lowercase letters, digits and hyphens (V1). */
const NAME_LENGTH = 32;

/**
 * The markers R11.3 names for packs that haven't shipped. Code in one of
 * these directories is code no target can check yet, so it's reported all the
 * same; the release that adds a pack moves its row into that pack's `markers`.
 */
const PENDING_MARKERS: Readonly<Record<string, readonly string[]>> = {
  go: ['go.mod', 'go.work'],
  rust: ['Cargo.toml'],
  python: ['pyproject.toml', 'setup.cfg', 'setup.py'],
  terraform: ['.terraform.lock.hcl', '*.tf'],
};

/** Every marker by the pack it marks: each shipped pack's own, then the pending ones of packs not in `PACKS`. */
const MARKER_KINDS: readonly (readonly [string, readonly string[]])[] = [
  ...Object.values(PACKS).map((pack) => [pack.name, pack.markers] as const),
  ...Object.entries(PENDING_MARKERS).filter(([kind]) => !Object.hasOwn(PACKS, kind)),
];

/** The markers, compiled: the kind a file's name marks, by pattern. */
const MARKERS: readonly { kind: string; pattern: RegExp }[] = MARKER_KINDS.flatMap(([kind, markers]) =>
  markers.map((marker) => ({ kind, pattern: globRegExp(marker) })),
);

/** The pack whose markers `path`'s file name matches, or `null`. */
function kindOf(path: string): string | null {
  const name = posix.basename(path);
  return MARKERS.find((m) => m.pattern.test(name))?.kind ?? null;
}

/** True when `path` sits under a directory no marker is reported from, or under `test/fixtures/`. */
function underSkipped(path: string): boolean {
  const dirs = path.split('/').slice(0, -1);
  return dirs.some((dir, i) => NEVER_REPORTED.has(dir) || (dir === 'test' && dirs[i + 1] === 'fixtures'));
}

/** True when `dir` is `root` or lies below it. Every directory lies under `.`. */
function isWithin(dir: string, root: string): boolean {
  return root === '.' || dir === root || dir.startsWith(`${root}/`);
}

/** `dir`'s last segment as a target name, or `''` when nothing of it survives. */
function nameFrom(dir: string): string {
  const base = posix.basename(dir).toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '');
  return base.slice(0, NAME_LENGTH).replace(/-+$/, '');
}

/**
 * A name for a target rooted at `dir`, free of every name in `taken`: the
 * directory's own, `app` for the repo root, then the kind added, then a number.
 */
function suggestName(dir: string, kind: string, taken: Set<string>): string {
  const base = (dir === '.' ? 'app' : nameFrom(dir)) || kind;
  const candidates = [base, `${base}-${kind}`.slice(0, NAME_LENGTH)];
  const free = candidates.find((n) => !taken.has(n)) ?? numbered(base, taken);
  taken.add(free);
  return free;
}

/** `base-2`, `base-3` and so on, the first `taken` lacks. */
function numbered(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n += 1) {
    const name = `${base.slice(0, NAME_LENGTH - String(n).length - 1)}-${n}`;
    if (!taken.has(name)) return name;
  }
}

/** The output directory relative to the repo root, when it sits inside it. */
function outPrefix(repo: string, out: string | undefined): string | null {
  if (out === undefined) return null;
  const rel = relative(repo, resolve(repo, out)).split('\\').join('/');
  return rel === '' || rel.startsWith('..') || posix.isAbsolute(rel) ? null : rel;
}

/**
 * Every marker under `repo` no target in `input` claims, in path order, each
 * with the target that would claim it. Markers under the output directory,
 * under a directory none is reported from, or matched by an `ignore` glob are
 * left out.
 */
export async function findUnclaimed(repo: string, input: UnclaimedInput, git: GitRunner = realGit(repo)): Promise<Unclaimed[]> {
  const ignore = (input.ignore ?? []).map(globRegExp);
  const out = outPrefix(repo, input.out);
  const taken = new Set([...SLOTS.map((s) => s.name), ...RESERVED_SLOTS, ...input.targets.map((t) => t.name)]);
  const paths = (await listFiles(repo, '.', git, 'the repo')).toSorted();
  return paths.flatMap((path) => {
    const kind = kindOf(path);
    if (kind === null || underSkipped(path) || excluded(path, ignore)) return [];
    if (out !== null && isWithin(path, out)) return [];
    const dir = posix.dirname(path);
    if (input.targets.some((t) => t.pack === kind && isWithin(dir, t.root))) return [];
    return [{ path, kind, suggest: { name: suggestName(dir, kind, taken), lang: kind, root: dir } }];
  });
}

/** How to quiet one unclaimed marker: the target entry that would claim it, or, for a pack not shipped yet, the ignore. */
function remedy({ kind, suggest }: Unclaimed): string {
  if (!Object.hasOwn(PACKS, kind)) return `  no ${kind} pack ships yet, so list it in unclaimed.ignore until one does`;
  return `  claim it: "${suggest.name}": { "lang": "${suggest.lang}", "root": "${suggest.root}" } under targets, or list it in unclaimed.ignore`;
}

/** The lines a red `unclaimed` prints: each marker, and how to quiet it. */
function explain(found: readonly Unclaimed[]): string {
  const lines = found.flatMap((u) => [`unclaimed: ${u.path} marks ${u.kind} code that no ${u.kind} target checks.`, remedy(u)]);
  return `${lines.join('\n')}\n`;
}

/**
 * The `unclaimed` check: its report on stdout, `{ "unclaimed": [...] }`, for
 * the run to write as `unclaimed.json`, and exit 1 when any marker is
 * unclaimed. A repo whose files can't be listed fails with exit -1, since
 * nothing was checked.
 */
export async function checkUnclaimed(repo: string, input: UnclaimedInput, git?: GitRunner): Promise<CheckOutcome> {
  let found: Unclaimed[];
  try {
    found = await findUnclaimed(repo, input, git);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, exit_code: -1, stdout: '', stderr: `check-unclaimed: ${why}\n` };
  }
  const stdout = `${JSON.stringify({ unclaimed: found }, null, 2)}\n`;
  if (found.length === 0) return { ok: true, exit_code: 0, stdout, stderr: '' };
  return { ok: false, exit_code: 1, stdout, stderr: explain(found) };
}
