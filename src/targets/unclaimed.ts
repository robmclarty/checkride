/**
 * The `unclaimed` check (R11.3): a toolchain marker no target claims is a
 * directory of code no check reads, the polyglot form of a vacuous green.
 *
 * A marker (`./markers.ts`) is a file R11.3 names as marking one language's
 * code. A marker in a directory is claimed when some target of that pack is
 * rooted there or above it, which covers a workspace's packages under a root
 * target.
 * Every marker no target claims is reported, with the target that would claim
 * it, in checkride's own `unclaimed.json`, and fails the check.
 */

import { posix, relative, resolve } from 'node:path';

import { SLOTS } from '../adapters.js';
import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import type { CheckOutcome } from '../links.js';
import { excluded, globRegExp } from './files.js';
import { isWithin, markerKind, repoFiles, slugName } from './markers.js';
import { nameTargets } from './names.js';
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
  /** Names the config's `checks` blocks take, a custom check's among them, which a suggested target can't. */
  readonly taken?: readonly string[];
};

/**
 * A name for each target `wanted` suggests, by `${kind}:${dir}`, free of
 * every name in `taken`, under the rule discovery names its targets by
 * (`./names.ts`).
 */
function suggestNames(wanted: readonly { kind: string; dir: string }[], taken: ReadonlySet<string>): Map<string, string> {
  const names = nameTargets(wanted.map(({ kind, dir }) => ({ lang: kind, root: dir, base: (dir === '.' ? 'app' : slugName(dir)) || kind })), taken);
  return new Map(wanted.map(({ kind, dir }, i) => [`${kind}:${dir}`, names[i] ?? kind]));
}

/** The output directory relative to the repo root, when it sits inside it. */
function outPrefix(repo: string, out: string | undefined): string | null {
  if (out === undefined) return null;
  const rel = relative(repo, resolve(repo, out)).split('\\').join('/');
  return rel === '' || rel.startsWith('..') || posix.isAbsolute(rel) ? null : rel;
}

/**
 * Every marker under `repo` no target in `input` claims, in path order, each
 * with the target that would claim it, which markers of one kind in one
 * directory share, as the `.tf` files of one module do. Markers under the
 * output directory, under a directory none is reported from, or matched by an
 * `ignore` glob are left out.
 */
export async function findUnclaimed(repo: string, input: UnclaimedInput, git: GitRunner = realGit(repo)): Promise<Unclaimed[]> {
  const ignore = (input.ignore ?? []).map(globRegExp);
  const out = outPrefix(repo, input.out);
  const taken = new Set([...SLOTS.map((s) => s.name), ...RESERVED_SLOTS, ...input.targets.map((t) => t.name), ...(input.taken ?? [])]);
  const paths = await repoFiles(repo, git);
  const found = paths.flatMap((path) => {
    const kind = markerKind(path);
    if (kind === null || excluded(path, ignore)) return [];
    if (out !== null && isWithin(path, out)) return [];
    const dir = posix.dirname(path);
    return input.targets.some((t) => t.pack === kind && isWithin(dir, t.root)) ? [] : [{ path, kind, dir }];
  });
  const wanted = [...new Map(found.map(({ kind, dir }) => [`${kind}:${dir}`, { kind, dir }])).values()];
  const names = suggestNames(wanted, taken);
  return found.map(({ path, kind, dir }) => ({ path, kind, suggest: { name: names.get(`${kind}:${dir}`) ?? kind, lang: kind, root: dir } }));
}

/**
 * How to quiet unclaimed markers: the target entry that would claim them, or
 * the ignore. When that target would hold one of `targets` of its pack, which
 * two targets of one pack can't do (V4), as a root `go.mod` above a `go.work`
 * target's would, only the ignore can, and the line says why.
 */
function remedy({ suggest }: Unclaimed, targets: readonly Claimant[]): string {
  const inner = targets.find((t) => t.pack === suggest.lang && isWithin(t.root, suggest.root));
  if (inner !== undefined) {
    const held = `the ${inner.pack} target ${inner.name} at ${inner.root}`;
    return `  no ${suggest.lang} target can claim it: one rooted at ${suggest.root} would hold ${held}, and two targets of one pack can't nest; list it in unclaimed.ignore`;
  }
  return `  claim it: "${suggest.name}": { "lang": "${suggest.lang}", "root": "${suggest.root}" } under targets, or list it in unclaimed.ignore`;
}

/**
 * The lines a red `unclaimed` prints: the markers one target would claim, in
 * the order the first of them was found, then how to quiet them, once, read
 * against the `targets` that claim.
 */
function explain(found: readonly Unclaimed[], targets: readonly Claimant[]): string {
  const groups = Map.groupBy(found, (u) => `${u.kind}:${u.suggest.root}`);
  const lines = [...groups.values()].flatMap((group) => [
    ...group.map((u) => `unclaimed: ${u.path} marks ${u.kind} code that no ${u.kind} target checks.`),
    ...group.slice(0, 1).map((u) => remedy(u, targets)),
  ]);
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
  return { ok: false, exit_code: 1, stdout, stderr: explain(found, input.targets) };
}
