/**
 * Discovery (R11.4): the targets a repo's own files propose, for existing-mode
 * `init` and `--discover`. It reads markers as `unclaimed` does, from the
 * files git lists, and proposes targets only for packs that ship; each pack's
 * release adds its rule.
 *
 * - A root that holds a `package.json`, `pnpm-workspace.yaml` or
 *   `tsconfig.json` and runs a ts tool of its own ({@link rootRunsTsTool})
 *   proposes one `ts` target at the root, which claims every nested ts
 *   project. Otherwise each top-most directory below the root holding a
 *   `package.json` or `tsconfig.json` proposes its own: a workspace root that
 *   only installs tools proposes its packages, not itself, and its
 *   `package.json` goes in `unclaimed.ignore` ({@link ignoreToolsRoot}).
 * - Each `go.work` directory proposes a `go` target that claims the modules
 *   its `use` directives name, and each `go.mod` no go target claims proposes
 *   one more.
 * - Each `Cargo.toml` with a `[workspace]` table proposes a `rust` target, and
 *   each `[package]` manifest no rust target claims proposes one more. A
 *   cargo-fuzz harness, whose `[package.metadata]` sets `cargo-fuzz = true`,
 *   proposes nothing: it's built through its crate, whose target claims it.
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
 * Within one of a pack's rules the top-most root wins and claims the ones
 * under it. Across a pack's two rules the inner root wins: a lock-file root
 * over the `.tf` directory above it, a `[workspace]` over a `[package]`, a
 * `go.work` over a `go.mod`. The outer root then proposes nothing, and
 * `unclaimed` reports its markers rather than the run failing on two nested
 * targets.
 *
 * A target is named after its root's last segment, `.` becoming `app`, with
 * a number added when another target, a slot or a reserved name holds it. One
 * target at the root, of the pack the root marks (R2.1), and nothing else is
 * the implicit mode a repo already runs in, which writes no `targets` block.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { SLOTS } from '../adapters.js';
import { isRecord } from '../json.js';
import type { Baseline } from '../baseline/index.js';
import { renameBaselineSlots } from '../baseline/index.js';
import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import { readGoWorkspace } from '../launch/index.js';
import { PACKS } from '../packs/index.js';
import { liftDiscovered, picksTool } from './add.js';
import { isDefaultShellFile } from './files.js';
import { isWithin, markerAt, markerKind, repoFiles, slugName } from './markers.js';
import { nameTargets } from './names.js';
import type { Target } from './resolve.js';
import { checkKeys, configProblem, configuredTargets, implicitPack, RESERVED_SLOTS } from './resolve.js';

/** A target discovery proposes. */
export type ProposedTarget = { name: string; lang: string; root: string };

/** Names a proposed target can't take: the slots', and the ones V2 reserves. */
const TAKEN: readonly string[] = [...SLOTS.map((s) => s.name), ...RESERVED_SLOTS, 'doc-snippets'];

/** The file that marks a Terraform root module, the directory `terraform init` runs in. */
const TERRAFORM_LOCK = '.terraform.lock.hcl';

/** The target-scope slots, whose top-level entries the target at the root takes. */
const TARGET_SLOTS: ReadonlySet<string> = new Set(SLOTS.filter((s) => s.scope !== 'repo').map((s) => s.name));

/** The files that make a directory a ts project, as `unclaimed` reads its markers. */
const TS_PROJECT_FILES: ReadonlySet<string> = new Set(PACKS.ts.markers);

/** The root files that make the repo root a ts root, its workspace file included. */
const TS_ROOT_FILES: readonly string[] = [...PACKS.ts.markers, 'pnpm-workspace.yaml'];

/** The ts pack's adapters for the slots a default run fills in a target, whose detection signals say a root runs a ts tool. */
const ROOT_TS_ADAPTERS = PACKS.ts.adapters.filter((a) => SLOTS.some((s) => s.name === a.slot && s.scope === 'target' && s.optIn !== true));

/** The package names a `package.json` dependency field lists, or none when it isn't an object. */
function depNames(field: unknown): string[] {
  return isRecord(field) ? Object.keys(field) : [];
}

/** The packages `repo`'s root `package.json` depends on, as detection reads them: its dependencies and devDependencies. */
function rootDeps(repo: string): ReadonlySet<string> {
  const text = readText(join(repo, 'package.json'));
  if (text === null) return new Set();
  try {
    const pkg: unknown = JSON.parse(text);
    if (!isRecord(pkg)) return new Set();
    return new Set([...depNames(pkg['dependencies']), ...depNames(pkg['devDependencies'])]);
  } catch {
    return new Set();
  }
}

/**
 * True when the repo root runs a ts tool of its own, so a ts target there has
 * something to check: `config` picks one for a target-scope slot, at its top
 * level or in `packs.ts.checks`, or detection would find a default check's
 * tool at the root, by a config file such as a `tsconfig.json`, an
 * `.oxlintrc.json` or a vitest config, or by a package the root
 * `package.json` lists. A workspace root that only installs tools, its
 * packages each configuring their own, runs none.
 */
export function rootRunsTsTool(repo: string, config: Record<string, unknown> | null): boolean {
  const raw = config ?? {};
  const packs = isRecord(raw['packs']) ? raw['packs'] : {};
  const ts = isRecord(packs[PACKS.ts.name]) ? packs[PACKS.ts.name] : {};
  if (picksTool(raw, TARGET_SLOTS) || (isRecord(ts) && picksTool(ts, TARGET_SLOTS))) return true;
  const atRoot = markerAt(repo);
  const deps = rootDeps(repo);
  return ROOT_TS_ADAPTERS.some((a) => a.detect.some(atRoot) || (a.detectDeps ?? []).some((dep) => deps.has(dep)));
}

/**
 * The ts roots. The repo root is one, claiming every ts project under it,
 * when it holds a `package.json`, `pnpm-workspace.yaml` or `tsconfig.json`
 * and `rootRuns` says it runs a ts tool of its own. Otherwise each top-most
 * directory below it holding a `package.json` or `tsconfig.json` is one.
 */
function tsRoots(files: readonly string[], rootRuns: boolean): string[] {
  if (rootRuns && TS_ROOT_FILES.some((file) => files.includes(file))) return ['.'];
  const dirs = [...new Set(files.filter((f) => TS_PROJECT_FILES.has(posix.basename(f))).map((f) => posix.dirname(f)))].filter((dir) => dir !== '.');
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

/**
 * `roots` plus each of `candidates`, top-most first, that neither lies within
 * one of them or an earlier candidate nor holds one: within a rule the
 * top-most root, and across rules, where `roots` are the first rule's, the
 * inner one.
 */
function unclaimedRoots(roots: readonly string[], candidates: readonly string[]): string[] {
  const out = [...roots];
  for (const dir of candidates) if (!out.some((root) => isWithin(dir, root) || isWithin(root, dir))) out.push(dir);
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

/** A TOML table's header line, as `[workspace]` or `[package.metadata]`, a comment after it allowed. */
function headerOf(table: string): RegExp {
  return new RegExp(`^\\s*\\[${table.replaceAll('.', '\\.')}\\]\\s*(?:#.*)?$`);
}

/** True when `toml` opens a table named `table`. */
function hasTable(toml: string, table: string): boolean {
  return toml.split(/\r?\n/).some((line) => headerOf(table).test(line));
}

/** True when `toml` is a cargo-fuzz harness's manifest: its `[package.metadata]` table sets `cargo-fuzz = true`. */
function isFuzzHarness(toml: string): boolean {
  const lines = toml.split(/\r?\n/);
  const at = lines.findIndex((line) => headerOf('package.metadata').test(line));
  if (at === -1) return false;
  const end = lines.findIndex((line, i) => i > at && /^\s*\[/.test(line));
  return lines.slice(at + 1, end === -1 ? undefined : end).some((line) => /^\s*cargo-fuzz\s*=\s*true\s*(?:#.*)?$/.test(line));
}

/** The text of the file at `path`, or `null` when it can't be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The rust roots: each top-most `[workspace]` manifest's directory, then each
 * top-most `[package]` one no rust root claims. A cargo-fuzz harness is
 * neither, since `cargo fuzz` builds it through the crate above it.
 */
function rustRoots(repo: string, files: readonly string[]): string[] {
  const manifests = dirsOf(files, 'Cargo.toml').flatMap((dir) => {
    const toml = readText(join(repo, dir, 'Cargo.toml'));
    return toml === null || isFuzzHarness(toml) ? [] : [{ dir, toml }];
  });
  const workspaces = unclaimedRoots([], manifests.filter((m) => hasTable(m.toml, 'workspace')).map((m) => m.dir));
  return unclaimedRoots(workspaces, manifests.filter((m) => hasTable(m.toml, 'package')).map((m) => m.dir));
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

/**
 * `targets` named per R11.4 (`./names.ts`): each after its root, the bash one
 * by its rule, and a longer name for each that collides with another or with
 * a slot's, a reserved or a custom check's name in `config`.
 */
function named(targets: readonly { lang: string; root: string }[], config: Record<string, unknown> | null): ProposedTarget[] {
  const nameable = targets.map(({ lang, root }) => ({ lang, root, base: baseName(lang, root) }));
  const names = nameTargets(nameable, new Set([...TAKEN, ...checkKeys(config)]));
  return targets.map(({ lang, root }, i) => ({ name: names[i] ?? lang, lang, root }));
}

/** The name a target's root alone gives it: the bash one `scripts` or `shell`, `app` for the repo root, else the root's last segment. */
function baseName(lang: string, root: string): string {
  if (lang === PACKS.bash.name) return root === 'scripts' ? 'scripts' : 'shell';
  return (root === '.' ? 'app' : slugName(root)) || lang;
}

/**
 * The targets the repo at `repo` proposes (R11.4): ts, then go, then rust,
 * then python, then terraform, each in root order, then bash. `config`, the
 * repo's own, says whether its entries give the root a ts tool to run.
 */
export async function discoverTargets(repo: string, git: GitRunner = realGit(repo), config: Record<string, unknown> | null = null): Promise<ProposedTarget[]> {
  const files = await repoFiles(repo, git);
  const ts = tsRoots(files, rootRunsTsTool(repo, config)).toSorted().map((root) => ({ lang: PACKS.ts.name, root }));
  const go = goRoots(repo, files).toSorted().map((root) => ({ lang: PACKS.go.name, root }));
  const rust = rustRoots(repo, files).toSorted().map((root) => ({ lang: PACKS.rust.name, root }));
  const python = pythonRoots(files).toSorted().map((root) => ({ lang: PACKS.python.name, root }));
  const terraform = terraformRoots(files).toSorted().map((root) => ({ lang: PACKS.terraform.name, root }));
  const toolchains = [...ts, ...go, ...rust, ...python, ...terraform];
  const bash = bashRoot(repo, files, toolchains.map((t) => t.root));
  return named([...toolchains, ...(bash === null ? [] : [{ lang: PACKS.bash.name, root: bash }])], config);
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
  const proposed = await discoverTargets(repo, git, config);
  const pack = implicitPack(markerAt(repo));
  if (isImplicit(proposed, pack)) return { config, targets: [], declared: [], dropped: [], baseline };
  const lifted = liftDiscovered(config ?? {}, proposed, { implicitPack: pack, targetSlots: TARGET_SLOTS });
  const discovered = ignoreToolsRoot(lifted.config, repo).config;
  const problem = configProblem(discovered, { cwd: repo, layer: 'repo' });
  if (problem !== null) throw new Error(`--discover: the targets this repo proposes break a config rule: ${problem}`);
  return {
    config: discovered,
    targets: configuredTargets(discovered) ?? [],
    declared: [],
    dropped: lifted.dropped,
    baseline: baseline === null ? null : renameBaselineSlots(baseline, lifted.renames),
  };
}

/**
 * `config` with the root `package.json` listed in `unclaimed.ignore`, when
 * the root holds one and `config` declares targets but none of them a ts
 * target at the root: a workspace root that only installs tools, which no ts
 * target can claim once its packages have targets of their own, since two
 * can't nest. `changes` names the addition, and is empty when nothing changed.
 */
export function ignoreToolsRoot(config: Record<string, unknown>, repo: string): { config: Record<string, unknown>; changes: string[] } {
  const targets = configuredTargets(config);
  const unchanged = { config, changes: [] };
  if (targets === null || targets.length === 0 || !existsSync(join(repo, 'package.json'))) return unchanged;
  if (targets.some((t) => t.pack === PACKS.ts.name && t.root === '.')) return unchanged;
  const unclaimed = isRecord(config['unclaimed']) ? config['unclaimed'] : {};
  const ignore = Array.isArray(unclaimed['ignore']) ? unclaimed['ignore'] : [];
  if (ignore.includes('package.json')) return unchanged;
  return {
    config: { ...config, unclaimed: { ...unclaimed, ignore: [...ignore, 'package.json'] } },
    changes: ['unclaimed.ignore: package.json, a root that runs no ts tool of its own, so no ts target claims it'],
  };
}

/** The one stderr note for a `--discover` the config's own targets stand in for (D73). */
export function declaredNote(declared: readonly string[]): string {
  return `--discover: the config declares its targets (${declared.join(', ')}), so they stand in for discovery`;
}
