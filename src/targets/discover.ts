/**
 * Discovery (R11.4): the targets a repo's own files propose, for existing-mode
 * `init` and `--discover`. It reads markers as `unclaimed` does, from the
 * files git lists, and proposes targets only for packs that ship; each pack's
 * release adds its rule.
 *
 * - A root `package.json` or `pnpm-workspace.yaml` proposes one `ts` target at
 *   the root, which claims every nested `package.json`. Otherwise each
 *   top-most `package.json` proposes its own.
 * - Each `go.work` directory proposes a `go` target that claims the modules
 *   its `use` directives name, and each `go.mod` no go target claims proposes
 *   one more.
 * - Each `Cargo.toml` with a `[workspace]` table proposes a `rust` target, and
 *   each `[package]` manifest no rust target claims proposes one more.
 * - Each top-most directory holding a `pyproject.toml`, `setup.cfg` or
 *   `setup.py` proposes a `python` target, which claims the nested ones, a uv
 *   workspace's members among them.
 * - Each top-most directory holding a `.terraform.lock.hcl`, the mark of a
 *   root module, proposes a `terraform` target, which claims the `.tf`
 *   directories under it, and each top-most directory holding `.tf` files that
 *   none of those claims proposes one more.
 * - Shell files R11.2's defaults keep, outside every other proposed target's
 *   root, propose one `bash` target at the deepest directory holding them
 *   all, named `scripts` when that's `scripts` and `shell` otherwise.
 *
 * A target claims every marker of its pack at or below its root, as
 * `unclaimed` reads a claim, so two targets of one pack never nest (V4).
 *
 * A target is named after its root's last segment, `.` becoming `app`, with
 * a number added when another target, a slot or a reserved name holds it. One
 * target at the root, of the pack the root marks (R2.1), and nothing else is
 * the implicit mode a repo already runs in, which writes no `targets` block.
 */

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { SLOTS } from '../adapters.js';
import type { Baseline } from '../baseline/index.js';
import { renameBaselineSlots } from '../baseline/index.js';
import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import { readGoWorkspace } from '../launch/index.js';
import { PACKS } from '../packs/index.js';
import { liftDiscovered } from './add.js';
import { isDefaultShellFile } from './files.js';
import { isWithin, markerAt, markerKind, numbered, repoFiles, slugName } from './markers.js';
import type { Target } from './resolve.js';
import { configProblem, configuredTargets, implicitPack, RESERVED_SLOTS } from './resolve.js';

/** A target discovery proposes. */
export type ProposedTarget = { name: string; lang: string; root: string };

/** Names a proposed target can't take: the slots', and the ones V2 reserves. */
const TAKEN: readonly string[] = [...SLOTS.map((s) => s.name), ...RESERVED_SLOTS, 'doc-snippets'];

/** The file that marks a Terraform root module, the directory `terraform init` runs in. */
const TERRAFORM_LOCK = '.terraform.lock.hcl';

/** The ts roots: the repo root when it holds a `package.json` or `pnpm-workspace.yaml`, else each top-most `package.json` directory. */
function tsRoots(files: readonly string[]): string[] {
  if (files.includes('package.json') || files.includes('pnpm-workspace.yaml')) return ['.'];
  const dirs = files.filter((f) => posix.basename(f) === 'package.json').map((f) => posix.dirname(f));
  return dirs.filter((dir) => !dirs.some((other) => other !== dir && isWithin(dir, other)));
}

/**
 * The directory of each file in `files` named `name`, top-most first. Path
 * order alone isn't enough: a directory such as `-legacy` sorts before `.`.
 */
function dirsOf(files: readonly string[], name: string): string[] {
  const dirs = files.filter((f) => posix.basename(f) === name).map((f) => posix.dirname(f));
  return dirs.toSorted((a, b) => depthOf(a) - depthOf(b));
}

/** How many segments deep `dir` sits, the root at 0. */
function depthOf(dir: string): number {
  return dir === '.' ? 0 : dir.split('/').length;
}

/** `roots` plus each of `candidates` none of them, nor an earlier candidate, holds: the top-most ones. */
function unclaimedRoots(roots: readonly string[], candidates: readonly string[]): string[] {
  const out = [...roots];
  for (const dir of candidates) if (!out.some((root) => isWithin(dir, root))) out.push(dir);
  return out;
}

/** The repo-relative module directories a `go.work` at `dir` uses, beyond the ones under `dir` itself. */
function usedModules(repo: string, dir: string): string[] {
  const workspace = readGoWorkspace(join(repo, dir));
  if (workspace === null || workspace === 'unreadable') return [];
  return workspace.modules.map((m) => posix.normalize(posix.join(dir, m.dir)));
}

/**
 * The go roots: each top-most `go.work` directory, then each top-most `go.mod`
 * directory no go root claims, a `go.work` claiming its `use` modules too.
 */
function goRoots(repo: string, files: readonly string[]): string[] {
  const works = unclaimedRoots([], dirsOf(files, 'go.work'));
  const used = works.flatMap((dir) => usedModules(repo, dir));
  return unclaimedRoots(works, dirsOf(files, 'go.mod').filter((dir) => !used.includes(dir)));
}

/** True when the TOML at `path` opens a table named `table`, as `[workspace]` or `[package]`. */
function hasTable(path: string, table: string): boolean {
  try {
    return new RegExp(`^\\s*\\[${table}\\]\\s*(?:#.*)?$`, 'm').test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** The rust roots: each top-most `[workspace]` manifest's directory, then each top-most `[package]` one no rust root claims. */
function rustRoots(repo: string, files: readonly string[]): string[] {
  const manifests = dirsOf(files, 'Cargo.toml');
  const at = (dir: string, table: string): boolean => hasTable(join(repo, dir, 'Cargo.toml'), table);
  const workspaces = unclaimedRoots([], manifests.filter((dir) => at(dir, 'workspace')));
  return unclaimedRoots(workspaces, manifests.filter((dir) => at(dir, 'package')));
}

/** The python roots: each top-most directory holding one of the python pack's markers. */
function pythonRoots(files: readonly string[]): string[] {
  const dirs = PACKS.python.markers.flatMap((marker) => dirsOf(files, marker));
  return unclaimedRoots([], [...new Set(dirs)].toSorted((a, b) => depthOf(a) - depthOf(b)));
}

/**
 * The terraform roots: each top-most directory a `.terraform.lock.hcl` marks
 * as a root module, then each top-most directory holding a `.tf` file that
 * none of them holds, such as a shared modules directory.
 */
function terraformRoots(files: readonly string[]): string[] {
  const marked = files.filter((f) => markerKind(f) === PACKS.terraform.name).map((f) => posix.dirname(f));
  const clusters = [...new Set(marked)].toSorted((a, b) => depthOf(a) - depthOf(b));
  return unclaimedRoots(unclaimedRoots([], dirsOf(files, TERRAFORM_LOCK)), clusters);
}

/** The deepest directory every one of `dirs` lies under, `.` for the root. */
function commonAncestor(dirs: readonly string[]): string {
  const [first = [], ...rest] = dirs.map((d) => (d === '.' ? [] : d.split('/')));
  let depth = 0;
  while (depth < first.length && rest.every((parts) => parts[depth] === first[depth])) depth += 1;
  return depth === 0 ? '.' : first.slice(0, depth).join('/');
}

/** The bash root: where the shell files outside every root in `taken` gather, or `null` when there are none. */
function bashRoot(repo: string, files: readonly string[], taken: readonly string[]): string | null {
  const shell = files.filter((f) => !taken.some((root) => isWithin(posix.dirname(f), root)) && isDefaultShellFile(f, join(repo, f)));
  return shell.length === 0 ? null : commonAncestor(shell.map((f) => posix.dirname(f)));
}

/** `targets` named per R11.4: each after its root, the bash one by its rule, a number added on a collision. */
function named(targets: readonly { lang: string; root: string }[]): ProposedTarget[] {
  const taken = new Set(TAKEN);
  return targets.map(({ lang, root }) => {
    const base = lang === PACKS.bash.name ? (root === 'scripts' ? 'scripts' : 'shell') : (root === '.' ? 'app' : slugName(root)) || lang;
    const name = taken.has(base) ? numbered(base, taken) : base;
    taken.add(name);
    return { name, lang, root };
  });
}

/** The targets the repo at `repo` proposes (R11.4): ts, then go, then rust, then python, then terraform, each in root order, then bash. */
export async function discoverTargets(repo: string, git: GitRunner = realGit(repo)): Promise<ProposedTarget[]> {
  const files = await repoFiles(repo, git);
  const ts = tsRoots(files).toSorted().map((root) => ({ lang: PACKS.ts.name, root }));
  const go = goRoots(repo, files).toSorted().map((root) => ({ lang: PACKS.go.name, root }));
  const rust = rustRoots(repo, files).toSorted().map((root) => ({ lang: PACKS.rust.name, root }));
  const python = pythonRoots(files).toSorted().map((root) => ({ lang: PACKS.python.name, root }));
  const terraform = terraformRoots(files).toSorted().map((root) => ({ lang: PACKS.terraform.name, root }));
  const toolchains = [...ts, ...go, ...rust, ...python, ...terraform];
  const bash = bashRoot(repo, files, toolchains.map((t) => t.root));
  return named([...toolchains, ...(bash === null ? [] : [{ lang: PACKS.bash.name, root: bash }])]);
}

/**
 * True when `proposed` is the implicit mode the repo runs in without targets:
 * none, or one target at the root whose pack is `pack`, the one the root
 * marks (R2.1). A lone root target of another pack, a bash one say, isn't.
 */
export function isImplicit(proposed: readonly ProposedTarget[], pack: string): boolean {
  const [only, ...rest] = proposed;
  return only === undefined || (rest.length === 0 && only.root === '.' && only.lang === pack);
}

/** The target-scope slots, whose top-level entries the target at the root takes. */
const TARGET_SLOTS: ReadonlySet<string> = new Set(SLOTS.filter((s) => s.scope !== 'repo').map((s) => s.name));

/** What a `--discover` run checks with (R13.2). */
type DiscoveredRun = {
  /** The config with the proposed targets declared, or the one given when discovery left the repo implicit or the config declares its own. */
  config: Record<string, unknown> | null;
  /** The targets discovery declared, in its order; empty when the repo stays implicit or the config declares its own. */
  targets: Target[];
  /** The names of the targets the config already declares, in its order, which stand in for discovery; empty when discovery ran. */
  declared: string[];
  /** The top-level target-scope entries no target at the root could take, so the run drops them. */
  dropped: string[];
  /** The baseline, its implicit entries renamed to the root target's, so masking holds; `null` stays `null`. */
  baseline: Baseline | null;
};

/**
 * `--discover` (R13.2): the targets the repo at `repo` proposes, applied to
 * `config` in memory as if it declared them, with nothing written. The target
 * at the root of the pack the root marks takes the top-level target-scope
 * entries and the baseline's entries, `lint` reading as `app:lint`, as
 * `target add` would hand them over; with no such target they're dropped.
 * Proposing only the implicit target changes nothing, and a `config` that
 * already declares targets keeps them, named in `declared`, with nothing
 * discovered (D73). Throws, a usage error, when the proposed targets break a
 * config rule.
 */
export async function discoverRun(
  repo: string,
  config: Record<string, unknown> | null,
  baseline: Baseline | null,
  git: GitRunner = realGit(repo),
): Promise<DiscoveredRun> {
  const declared = configuredTargets(config);
  if (declared !== null) return { config, targets: [], declared: declared.map((t) => t.name), dropped: [], baseline };
  const proposed = await discoverTargets(repo, git);
  const pack = implicitPack(markerAt(repo));
  if (isImplicit(proposed, pack)) return { config, targets: [], declared: [], dropped: [], baseline };
  const lifted = liftDiscovered(config ?? {}, proposed, { implicitPack: pack, targetSlots: TARGET_SLOTS });
  const problem = configProblem(lifted.config, { cwd: repo, layer: 'repo' });
  if (problem !== null) throw new Error(`--discover: the targets this repo proposes break a config rule: ${problem}`);
  return {
    config: lifted.config,
    targets: configuredTargets(lifted.config) ?? [],
    declared: [],
    dropped: lifted.dropped,
    baseline: baseline === null ? null : renameBaselineSlots(baseline, lifted.renames),
  };
}

/** The one stderr note for a `--discover` the config's own targets stand in for (D73). */
export function declaredNote(declared: readonly string[]): string {
  return `--discover: the config declares its targets (${declared.join(', ')}), so they stand in for discovery`;
}
