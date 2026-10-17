/**
 * The `go-mod-tool` pin source: a tool is declared when the `go.mod` nearest
 * the check's directory, up to the repo root, names the tool's package in a
 * `tool` directive (Go 1.24 and later), and it runs as `go tool <bin>` (R6.1).
 * The version recorded is the one `go.mod` requires for the module that
 * provides the tool (R6.3), read from the file, never by running anything.
 *
 * Only what the source needs is read: `tool` and `require` directives, in
 * their one-line and block forms, with `//` comments dropped. Go owns the rest
 * of the file's meaning, `replace` included.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { dirsUpTo } from './walk.js';

/** The file a Go module declares itself in. */
const GO_MOD = 'go.mod';

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

/** Every directive in a `go.mod`'s text, in order, with comments and blank lines dropped. */
function directives(text: string): Directive[] {
  const state: ReadState = { block: null };
  const out: Directive[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const comment = raw.indexOf('//');
    const line = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    const directive = line === '' ? null : readLine(state, line);
    if (directive !== null) out.push(directive);
  }
  return out;
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
