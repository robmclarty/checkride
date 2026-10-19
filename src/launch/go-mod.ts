/**
 * The `go-mod-tool` pin source: a tool is declared when the `go.mod` nearest
 * the check's directory, up to the repo root, names the tool's package in a
 * `tool` directive (Go 1.24 and later), and it runs as `go tool <bin>` (R6.1).
 * The version recorded is the one `go.mod` requires for the module that
 * provides the tool (R6.3), read from the file, never by running anything.
 *
 * Only what the source needs is read: `tool` and `require` directives, in
 * their one-line and block forms, with `//` comments dropped. Go owns the rest
 * of the file's meaning. A `go.work`'s `use` directives, read the same way,
 * say which packages `{go-packages}` names.
 *
 * Under `--changed`, a workspace's module graph (R10.4) is read the same way
 * from the `module`, `require` and local `replace` directives of its `go.mod`
 * files and its `go.work`, and from the import declarations of each module's
 * Go source ({@link goImports}), since a workspace resolves an import no
 * `require` names. Which files a module holds is the caller's to list.
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
 * The module of `modules` that provides package `pkg`, as Go resolves it: the
 * one whose path, read by `pathOf`, is `pkg` or the longest prefix of it, or
 * `undefined` when none provides it. Longest wins, so in a workspace holding
 * `example.com/shop` and `example.com/shop/api`, `example.com/shop/api/x`
 * belongs to the second.
 */
function providerOf<T>(pkg: string, modules: readonly T[], pathOf: (module: T) => string): T | undefined {
  return modules
    .filter((m) => pkg === pathOf(m) || pkg.startsWith(`${pathOf(m)}/`))
    .toSorted((a, b) => pathOf(b).length - pathOf(a).length)[0];
}

/**
 * The version a `go.mod` requires for the module that provides package `pkg`:
 * the required module whose path is `pkg` or the longest prefix of it, or
 * `undefined` when none provides it.
 */
export function goModRequiredVersion(text: string, pkg: string): string | undefined {
  const requires = directives(text).filter((d) => d.verb === 'require' && d.args.length >= 2);
  return providerOf(pkg, requires, (d) => d.args[0] ?? '')?.args[1];
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

/** Where the `go.mod` at `path` declares `goTool`, named relative to `repo`, or `null` when it doesn't. */
function declarationIn(path: string, repo: string, goTool: string): GoModDeclaration | null {
  const text = readText(path);
  if (text === null || !goModTools(text).includes(goTool)) return null;
  const version = goModRequiredVersion(text, goTool);
  return { file: relative(repo, path) || GO_MOD, ...(version !== undefined ? { version } : {}) };
}

/**
 * Where a workspace at `dir` declares `goTool`: the first module its
 * `go.work` uses whose `go.mod` has a `tool` directive for it, as `go tool`
 * finds one from a workspace root.
 */
function workspaceDeclaration(dir: string, repo: string, goTool: string): GoModDeclaration | null {
  const work = readText(join(dir, GO_WORK));
  const uses = work === null ? [] : directives(work).filter((d) => d.verb === 'use').flatMap((d) => d.args.slice(0, 1));
  for (const use of uses) {
    const found = declarationIn(join(dir, use, GO_MOD), repo, goTool);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Where the `go.mod` nearest `cwd`, up to `repo`, declares the tool whose
 * package is `goTool`. With no `go.mod` between them, a `go.work` there stands
 * in, as Go's workspace mode does: the tool any module it uses declares. `null`
 * when nothing declares it.
 */
export function goModDeclaration(cwd: string, repo: string, goTool: string): GoModDeclaration | null {
  const path = nearestGoMod(cwd, repo);
  if (path !== null) return declarationIn(path, repo, goTool);
  const work = dirsUpTo(cwd, repo).find((dir) => existsSync(join(dir, GO_WORK)));
  return work === undefined ? null : workspaceDeclaration(work, repo, goTool);
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
 * path each replaces. It holds what the workspace's files declare; what its
 * modules' Go source imports is read only when {@link withDependents} asks.
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
 * Go source's comments, and the literals a comment marker can sit inside
 * without opening one: interpreted strings, raw strings and runes. A match
 * with group 1 is a literal, kept whole; any other is a comment.
 */
const GO_COMMENT_OR_LITERAL = /("(?:[^"\\\n]|\\.)*"|`[^`]*`|'(?:[^'\\\n]|\\.)*')|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** A Go file's package clause, which every import declaration follows. */
const GO_PACKAGE_CLAUSE = /^\s*package\s+[\p{L}_][\p{L}\p{N}_]*\s*;?/u;

/** One import declaration: a single spec up to the line's end, or a parenthesized group of them. */
const GO_IMPORT_DECL = /^\s*import\b\s*(\([^)]*\)|[^\n;]*)\s*;?/;

/** An import spec's path: an interpreted or a raw string literal. */
const GO_IMPORT_PATH = /"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g;

/**
 * The import paths `text`, one Go source file, declares: the path of each
 * import spec, single declarations and grouped ones alike, with any name, `.`
 * or `_` before it ignored. Go allows import declarations only straight after
 * the package clause, so the read stops at the first declaration that isn't
 * one. A file with no package clause declares none.
 */
export function goImports(text: string): string[] {
  let rest = text.replaceAll(GO_COMMENT_OR_LITERAL, (_match, literal?: string) => literal ?? ' ');
  const clause = GO_PACKAGE_CLAUSE.exec(rest);
  if (clause === null) return [];
  rest = rest.slice(clause[0].length);
  const paths: string[] = [];
  for (let decl = GO_IMPORT_DECL.exec(rest); decl !== null; decl = GO_IMPORT_DECL.exec(rest)) {
    for (const spec of (decl[1] ?? '').matchAll(GO_IMPORT_PATH)) paths.push(spec[1] ?? spec[2] ?? '');
    rest = rest.slice(decl[0].length);
  }
  return paths;
}

/**
 * What a module's Go source imports, for {@link withDependents}: every import
 * path its files declare, or `null` when a file of it can't be read, which
 * makes the module depend on every other.
 */
export type ModuleImports = (module: WorkModule) => readonly string[] | null;

/**
 * The module paths of `modules` that `imports` reach: each path mapped to the
 * module that provides it ({@link providerOf}), and every module when the
 * imports can't be known.
 */
function importedModules(modules: readonly WorkModule[], imports: readonly string[] | null): ReadonlySet<string> {
  if (imports === null) return new Set(modules.map((m) => m.path));
  const paths = imports.flatMap((pkg) => providerOf(pkg, modules, (m) => m.path)?.path ?? []);
  return new Set(paths);
}

/**
 * Whether `a` depends on `b` (R10.4): `a`'s `go.mod` requires `b`'s module
 * path, or replaces something with `b`'s directory, or requires a module the
 * `go.work` replaces with `b`'s directory, or `a`'s Go source imports a
 * package of `b`'s, which `imported` holds as the module paths `a` imports.
 * A workspace resolves an import with no `require`, so `go.mod` alone misses
 * that last edge.
 */
function dependsOn(a: WorkModule, b: WorkModule, replaces: ReadonlyMap<string, string>, imported: () => ReadonlySet<string>): boolean {
  if (a === b) return false;
  if (a.requires.includes(b.path) || a.replacedBy.includes(b.dir)) return true;
  return a.requires.some((path) => replaces.get(path) === b.dir) || imported().has(b.path);
}

/**
 * The modules `changed` names together with every module that depends on one
 * of them, transitively, as indices into `workspace.modules`, in `use` order.
 * Only edges between the workspace's own modules count. `importsOf` reads a
 * module's imports, and is asked at most once per module; without it, only
 * `go.mod` and `go.work` say what depends on what.
 */
export function withDependents(workspace: GoWorkspace, changed: ReadonlySet<number>, importsOf: ModuleImports = () => []): number[] {
  const { modules, replaces } = workspace;
  const imported = new Map<WorkModule, ReadonlySet<string>>();
  const importedBy = (module: WorkModule) => (): ReadonlySet<string> => {
    const known = imported.get(module) ?? importedModules(modules, importsOf(module));
    imported.set(module, known);
    return known;
  };
  const affected = new Set(changed);
  const queue = [...changed];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    const target = modules[at];
    for (const [i, module] of modules.entries()) {
      if (target === undefined || affected.has(i) || !dependsOn(module, target, replaces, importedBy(module))) continue;
      affected.add(i);
      queue.push(i);
    }
  }
  return [...affected].toSorted((x, y) => x - y);
}
