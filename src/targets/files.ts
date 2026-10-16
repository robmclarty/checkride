/**
 * File lists (R11.2): the files a target of a file-list pack checks, and the
 * `{files}` argument its adapters take them through.
 *
 * A bash target has no manifest that says what it holds, so its checks run
 * over a list: the files git knows under the target's root, tracked or
 * untracked but not ignored (every file under the root, outside a git repo),
 * kept when an `include` glob matches and dropped when an `exclude` glob does.
 * With no `include`, a target keeps its `.sh` and `.bash` files and any
 * extensionless file whose first line is a shell shebang. Globs are relative to
 * the target's root and take `**`, `*`, `?` and `{a,b}`, matched here with no
 * dependency.
 */

import type { Dirent } from 'node:fs';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import { PACKS } from '../packs/index.js';

/** The argument a file-list pack's adapters take their files through: one argument per file. */
const FILES_PLACEHOLDER = '{files}';

/** The largest argv, in bytes, a file list may expand a check's to before the run stops with exit 2. */
export const MAX_FILES_ARGV_BYTES = 200_000;

/** The reason a check of a target whose list matched nothing records: skipped, not failed. */
export const NO_FILES_REASON = 'no files matched';

/** What a target keeps when it names no `include`, beside the extensionless shell scripts. */
const DEFAULT_INCLUDE: readonly string[] = ['**/*.sh', '**/*.bash'];

/** Directories the walk outside a git repo never enters. */
const WALK_SKIP: ReadonlySet<string> = new Set(['.git', 'node_modules', 'target', 'vendor']);

/**
 * A shell shebang: `#!/bin/sh`, `#!/usr/bin/env bash` or `#!/bin/dash -e`, by
 * the interpreter's own name, so `zsh` and `fish` scripts stay out.
 */
const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:bash|sh|dash|ksh)(?:\s|$)/;

/** How many bytes of a file the shebang sniff reads: enough for any first line worth matching. */
const SHEBANG_BYTES = 256;

/** The part of a target a file list reads: its name, its root and its globs. */
export type FileListTarget = {
  readonly name: string;
  readonly root: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
};

/** True for an argument list that takes a file list. */
export function takesFiles(args: readonly string[] | undefined): boolean {
  return args?.includes(FILES_PLACEHOLDER) ?? false;
}

/** True when `pack` checks a list of files rather than its root: one of its adapters takes `{files}`. */
export function isFileListPack(pack: string): boolean {
  return Object.values(PACKS).some((p) => p.name === pack && p.adapters.some((a) => takesFiles(a.args)));
}

/** `args` with each `{files}` argument replaced by `files`, one argument each. */
export function expandFiles(args: readonly string[], files: readonly string[]): string[] {
  return args.flatMap((arg) => (arg === FILES_PLACEHOLDER ? [...files] : [arg]));
}

/** The bytes `argv` takes to hand to a process: each argument and its terminating NUL. */
export function argvBytes(argv: readonly string[]): number {
  return argv.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);
}

/** Regex special characters a glob's literal text has to escape, an unclosed brace included. */
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Where a glob's `{` at `open` closes, nesting counted, or -1 when it never does. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let at = open; at < glob.length; at += 1) {
    const ch = glob.charAt(at);
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return at;
  }
  return -1;
}

/** A brace group's alternatives: its text split on the commas outside any nested group. */
function alternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < body.length; at += 1) {
    const ch = body.charAt(at);
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, at));
      start = at + 1;
    }
  }
  return [...parts, body.slice(start)];
}

/** One piece of a glob translated: its regex source, and where the next piece starts. */
type Piece = { source: string; next: number };

/**
 * The `*` or `**` at `at`. A `**` that fills a whole path segment matches any
 * number of directories, none included, so a glob that opens with one matches
 * files at the root too; anywhere else it acts as `*`, which never crosses a
 * `/`.
 */
function starPiece(glob: string, at: number): Piece {
  if (glob.charAt(at + 1) !== '*') return { source: '[^/]*', next: at + 1 };
  const segment = (at === 0 || glob.charAt(at - 1) === '/') && (at + 2 === glob.length || glob.charAt(at + 2) === '/');
  if (!segment) return { source: '[^/]*', next: at + 2 };
  return glob.charAt(at + 2) === '/' ? { source: '(?:[^/]*/)*', next: at + 3 } : { source: '.*', next: at + 2 };
}

/** The glob piece at `at`: a wildcard, a brace group, or one literal character. */
function piece(glob: string, at: number): Piece {
  const ch = glob.charAt(at);
  if (ch === '*') return starPiece(glob, at);
  if (ch === '?') return { source: '[^/]', next: at + 1 };
  const close = ch === '{' ? closingBrace(glob, at) : -1;
  if (close !== -1) {
    const group = alternatives(glob.slice(at + 1, close)).map(globSource).join('|');
    return { source: `(?:${group})`, next: close + 1 };
  }
  return { source: ch.replace(REGEX_SPECIAL, '\\$&'), next: at + 1 };
}

/** A glob's regex source, unanchored. */
function globSource(glob: string): string {
  let source = '';
  for (let at = 0; at < glob.length;) {
    const next = piece(glob, at);
    source += next.source;
    at = next.next;
  }
  return source;
}

/** The regex that matches a whole `/`-separated path against `glob`. */
export function globRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`);
}

/** {@link DEFAULT_INCLUDE}, compiled once. */
const DEFAULT_GLOBS: readonly RegExp[] = DEFAULT_INCLUDE.map(globRegExp);

/** True when `path` or a directory above it matches one of `globs`, so excluding `vendor` leaves out what's under it. */
function excluded(path: string, globs: readonly RegExp[]): boolean {
  const segments = path.split('/');
  return segments.some((_, i) => {
    const prefix = segments.slice(0, i + 1).join('/');
    return globs.some((re) => re.test(prefix));
  });
}

/** True when the file at `abs` opens with a shell shebang. */
function hasShellShebang(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const head = Buffer.alloc(SHEBANG_BYTES);
    const read = readSync(fd, head, 0, SHEBANG_BYTES, 0);
    const first = head.subarray(0, read).toString('utf8').split('\n')[0] ?? '';
    return SHELL_SHEBANG.test(first.replace(/\r$/, ''));
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** True when `abs` is a regular file, following a symlink: a deleted or dangling path isn't. */
function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** The entries of `dir`, or none when it can't be read. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file under `dir`, relative to it, skipping the {@link WALK_SKIP} directories. */
function walk(dir: string, prefix = ''): string[] {
  return entriesOf(dir).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return WALK_SKIP.has(entry.name) ? [] : walk(join(dir, entry.name), rel);
    return [rel];
  });
}

/**
 * The paths git lists under `root` (tracked, and untracked but not ignored),
 * relative to `root`; every file under it outside a git repo or without git.
 * Any other git failure throws: a list built some other way would check files
 * the repo ignores.
 */
async function candidates(repo: string, target: FileListTarget, git: GitRunner): Promise<string[]> {
  const listed = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', target.root]);
  if (!listed.ok) {
    if (listed.error === 'missing' || listed.error === 'not-a-repo') return walk(join(repo, target.root));
    throw new Error(`can't list the files of target '${target.name}': ${listed.detail}`);
  }
  const strip = target.root === '.' ? '' : `${target.root}/`;
  const paths = listed.stdout.split('\0').filter((p) => p !== '' && p.startsWith(strip));
  return [...new Set(paths.map((p) => p.slice(strip.length)))];
}

/** True when the target keeps `path`: an `include` glob matches it, or with none, the default does. */
function included(path: string, abs: string, include: readonly RegExp[] | null): boolean {
  if (include !== null) return include.some((re) => re.test(path));
  if (DEFAULT_GLOBS.some((re) => re.test(path))) return true;
  return posix.extname(path) === '' && hasShellShebang(abs);
}

/**
 * The files `target` checks, relative to its root and sorted, from the repo at
 * `repo`. An empty list means the check has nothing to run over, which skips
 * it ({@link NO_FILES_REASON}).
 */
export async function targetFiles(repo: string, target: FileListTarget, git: GitRunner = realGit(repo)): Promise<string[]> {
  const root = join(repo, target.root);
  const include = target.include === undefined ? null : target.include.map(globRegExp);
  const exclude = (target.exclude ?? []).map(globRegExp);
  const kept = (await candidates(repo, target, git)).filter((path) => {
    const abs = join(root, path);
    return !excluded(path, exclude) && isFile(abs) && included(path, abs, include);
  });
  return kept.toSorted();
}
