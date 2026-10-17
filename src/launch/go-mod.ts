/**
 * The `go-mod-tool` pin source: a tool is declared when the `go.mod` nearest
 * the check's directory, up to the repo root, names the tool's package in a
 * `tool` directive (Go 1.24 and later), and it runs as `go tool <bin>` (R6.1).
 * The version recorded is the one `go.mod` requires for the module that
 * provides the tool (R6.3), read from the file, never by running anything.
 *
 * Only what the source needs is read: `tool` and `require` directives, in
 * their one-line and block forms, with `//` comments dropped. Go owns the rest
 * of the file's meaning, `replace` included. A `go.work`'s `use` directives,
 * read the same way, say which packages `{go-packages}` names.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { dirsUpTo } from './walk.js';

/** The file a Go module declares itself in. */
const GO_MOD = 'go.mod';

/** The file a Go workspace lists its modules in. */
const GO_WORK = 'go.work';

/** One directive: its verb (`tool`, `require`) and its arguments, a block's lines each under the block's verb. */
type Directive = { verb: string; args: string[] };

/** A line's whitespace-separated fields, each with any Go string quotes removed. */
function fields(line: string): string[] {
  return line.split(/\s+/).filter(Boolean).map((f) => f.replace(/^(["`])(.*)\1$/, '$2'));
}

/** The verb a line opens a block with, as in `require (`, or `null` for any other line. */
function blockOpener(line: string): string | null {
  return /^(\w+)\s*\($/.exec(line)?.[1] ?? null;
}

/** Where a read stands: the verb of the block it's inside, or `null` outside one. */
type ReadState = { block: string | null };

/** Read one comment-free, trimmed line, returning the directive it holds, if any. */
function readLine(state: ReadState, line: string): Directive | null {
  const block = state.block;
  if (block !== null) {
    if (line !== ')') return { verb: block, args: fields(line) };
    state.block = null;
    return null;
  }
  const opener = blockOpener(line);
  if (opener !== null) {
    state.block = opener;
    return null;
  }
  const [verb, ...args] = fields(line);
  return verb === undefined ? null : { verb, args };
}

/**
 * Every directive in a `go.mod` or `go.work`'s text, in order, with comments
 * and blank lines dropped, or `null` when a block is still open at the end,
 * the one way the text can fail to read.
 */
function readDirectives(text: string): Directive[] | null {
  const state: ReadState = { block: null };
  const out: Directive[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const comment = raw.indexOf('//');
    const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    const directive = line === '' ? null : readLine(state, line);
    if (directive !== null) out.push(directive);
  }
  return state.block === null ? out : null;
}

/** Every directive a text holds, as {@link readDirectives} reads them, and what it read of an unclosed block. */
function directives(text: string): Directive[] {
  return readDirectives(text) ?? readDirectives(`${text}\n)`) ?? [];
}

/** The package paths a `go.mod`'s `tool` directives name, one-line and block forms alike. */
export function goModTools(text: string): string[] {
  return directives(text).filter((d) => d.verb === 'tool' && d.args[0] !== undefined).map((d) => d.args[0] ?? '');
}

/**
 * The version a `go.mod` requires for the module that provides package `pkg`:
 * the required module whose path is `pkg` or the longest prefix of it, or
 * `undefined` when none provides it.
 */
export function goModRequiredVersion(text: string, pkg: string): string | undefined {
  const providers = directives(text)
    .filter((d) => d.verb === 'require' && d.args.length >= 2)
    .filter(({ args: [path = ''] }) => pkg === path || pkg.startsWith(`${path}/`))
    .toSorted((a, b) => (b.args[0] ?? '').length - (a.args[0] ?? '').length);
  return providers[0]?.args[1];
}

/** Where a `go.mod` declares a tool: the file, relative to the repo root, and the version it requires, when it does. */
export type GoModDeclaration = { file: string; version?: string };

/** The `go.mod` nearest `cwd`, up to `repo`, or `null` when there's none. */
function nearestGoMod(cwd: string, repo: string): string | null {
  return dirsUpTo(cwd, repo).map((dir) => join(dir, GO_MOD)).find((path) => existsSync(path)) ?? null;
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
 * Where the `go.mod` nearest `cwd`, up to `repo`, declares the tool whose
 * package is `goTool`, or `null` when that file has no `tool` directive for
 * it, or there's no `go.mod` to read.
 */
export function goModDeclaration(cwd: string, repo: string, goTool: string): GoModDeclaration | null {
  const path = nearestGoMod(cwd, repo);
  const text = path === null ? null : readText(path);
  if (path === null || text === null || !goModTools(text).includes(goTool)) return null;
  const version = goModRequiredVersion(text, goTool);
  return { file: relative(repo, path) || GO_MOD, ...(version !== undefined ? { version } : {}) };
}

/** The argument a Go adapter takes its packages through: one argument per pattern. */
const GO_PACKAGES_PLACEHOLDER = '{go-packages}';

/** True for an argument list that takes Go package patterns. */
export function takesGoPackages(args: readonly string[] | undefined): boolean {
  return args?.includes(GO_PACKAGES_PLACEHOLDER) ?? false;
}

/** `args` with each `{go-packages}` argument replaced by `patterns`, one argument each. */
export function expandGoPackages(args: readonly string[], patterns: readonly string[]): string[] {
  return args.flatMap((arg) => (arg === GO_PACKAGES_PLACEHOLDER ? [...patterns] : [arg]));
}

/** The pattern that names every package under a `use` directory, relative to the `go.work` that names it. */
export function usePattern(dir: string): string {
  const rel = posix.normalize(dir).replace(/\/$/, '');
  if (rel === '.') return './...';
  return rel.startsWith('../') || posix.isAbsolute(rel) ? `${rel}/...` : `./${rel}/...`;
}

/**
 * The package patterns `{go-packages}` expands to for a check run from `root`
 * (R5.5): `./<dir>/...` for each `use` directive of a `go.work` there, in its
 * order, one-line and block forms alike, since a workspace root's own `./...`
 * matches none of its modules; `./...` for a module root, or a `go.work` with
 * no `use` it can read.
 */
export function goPackagePatterns(root: string): string[] {
  const work = readText(join(root, GO_WORK));
  const uses = work === null ? [] : directives(work).filter((d) => d.verb === 'use').flatMap((d) => d.args.slice(0, 1));
  return uses.length === 0 ? ['./...'] : uses.map(usePattern);
}

/**
 * One module a `go.work` uses: its `use` directory, relative to the `go.work`
 * and `/`-separated (`.` for the workspace root itself), the module path its
 * `go.mod` declares, the module paths it requires, and the directories, as
 * `use` would name them, its local `replace` directives point at.
 */
export type WorkModule = { dir: string; path: string; requires: string[]; replacedBy: string[] };

/**
 * A Go workspace (R10.4): the modules its `go.work` uses, in `use` order, and
 * the directories its own local `replace` directives point at, by the module
 * path each replaces.
 */
export type GoWorkspace = { modules: WorkModule[]; replaces: ReadonlyMap<string, string> };

/** A `use` or replacement directory as a workspace-relative, `/`-separated path. */
function workDir(dir: string): string {
  return posix.normalize(dir).replace(/\/$/, '') || '.';
}

/** A `replace` directive's target, when it's a local directory rather than another module version. */
function localTarget(args: readonly string[]): { from: string; to: string } | null {
  const arrow = args.indexOf('=>');
  const from = args[0];
  const to = args[arrow + 1];
  if (arrow < 1 || from === undefined || to === undefined) return null;
  return /^(?:\.{1,2}\/|\/)/.test(to) || to === '.' || to === '..' ? { from, to } : null;
}

/** The module a `use` directory holds, read from its `go.mod`, or `null` when that file can't be read or names no module. */
function readWorkModule(root: string, dir: string): WorkModule | null {
  const text = readText(join(root, dir, GO_MOD));
  const list = text === null ? null : readDirectives(text);
  const path = list?.find((d) => d.verb === 'module')?.args[0];
  if (list === null || list === undefined || path === undefined) return null;
  const requires = list.filter((d) => d.verb === 'require' && d.args[0] !== undefined).map((d) => d.args[0] ?? '');
  const replacedBy = list.flatMap((d) => {
    const local = d.verb === 'replace' ? localTarget(d.args) : null;
    return local === null ? [] : [workDir(posix.join(dir, local.to))];
  });
  return { dir, path, requires, replacedBy };
}

/**
 * The workspace a `go.work` at `root` declares, `null` when `root` holds no
 * `go.work`, or `'unreadable'` when the `go.work` or a `go.mod` it uses can't be
 * read, leaves a block open, or a used module names no module path.
 */
export function readGoWorkspace(root: string): GoWorkspace | null | 'unreadable' {
  const text = readText(join(root, GO_WORK));
  if (text === null) return existsSync(join(root, GO_WORK)) ? 'unreadable' : null;
  const list = readDirectives(text);
  if (list === null) return 'unreadable';
  const modules: WorkModule[] = [];
  for (const use of list.filter((d) => d.verb === 'use')) {
    const module = use.args[0] === undefined ? null : readWorkModule(root, workDir(use.args[0]));
    if (module === null) return 'unreadable';
    modules.push(module);
  }
  const replaces = new Map(list.flatMap((d) => {
    const local = d.verb === 'replace' ? localTarget(d.args) : null;
    return local === null ? [] : [[local.from, workDir(local.to)] as const];
  }));
  return { modules, replaces };
}

/**
 * Whether `a` depends on `b` (R10.4): `a`'s `go.mod` requires `b`'s module
 * path, or replaces something with `b`'s directory, or requires a module the
 * `go.work` replaces with `b`'s directory.
 */
function dependsOn(a: WorkModule, b: WorkModule, replaces: ReadonlyMap<string, string>): boolean {
  if (a === b) return false;
  if (a.requires.includes(b.path) || a.replacedBy.includes(b.dir)) return true;
  return a.requires.some((path) => replaces.get(path) === b.dir);
}

/**
 * The modules `changed` names together with every module that depends on one
 * of them, transitively, as indices into `workspace.modules`, in `use` order.
 * Only edges between the workspace's own modules count.
 */
export function withDependents(workspace: GoWorkspace, changed: ReadonlySet<number>): number[] {
  const { modules, replaces } = workspace;
  const affected = new Set(changed);
  const queue = [...changed];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    const target = modules[at];
    for (const [i, module] of modules.entries()) {
      if (target === undefined || affected.has(i) || !dependsOn(module, target, replaces)) continue;
      affected.add(i);
      queue.push(i);
    }
  }
  return [...affected].toSorted((x, y) => x - y);
}
