/**
 * The `mise` pin source: a tool is declared when a `mise.toml` or `.mise.toml`
 * between the check's directory and the repo root names it under `[tools]`,
 * and it runs as `mise exec -- <bin>`.
 *
 * Only the keys are read. mise owns version resolution (a key's value can be a
 * prefix, `latest`, or a table with options), so checkride asks whether the
 * repo pins a tool, never which version it pins (R6.1).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { dirsUpTo } from './walk.js';

/** The config files mise reads in each directory that the source looks in. */
const MISE_FILES = ['mise.toml', '.mise.toml'] as const;

/**
 * Variables every check launched through mise runs with, so mise never
 * installs a missing tool: `exec_auto_install` covers `mise exec`, and
 * `not_found_auto_install` covers a shim on `PATH` that names a tool mise
 * hasn't installed. A check never fetches a tool (D14).
 */
export const MISE_NO_INSTALL: Readonly<Record<string, string>> = {
  MISE_EXEC_AUTO_INSTALL: 'false',
  MISE_NOT_FOUND_AUTO_INSTALL: 'false',
};

/** One character of a line that sits outside every quoted string, with its index. */
type Unquoted = { ch: string; at: number };

/** The characters of `line` outside its quoted strings, in order. */
function unquoted(line: string): Unquoted[] {
  const out: Unquoted[] = [];
  let quote: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const ch = line.charAt(at);
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else {
      out.push({ ch, at });
    }
  }
  return out;
}

/** The index of the first `ch` in `line` outside quotes, or -1. */
function firstUnquoted(line: string, ch: string): number {
  return unquoted(line).find((c) => c.ch === ch)?.at ?? -1;
}

/** A line without its trailing comment: everything from a `#` outside quotes on. */
function stripComment(line: string): string {
  const at = firstUnquoted(line, '#');
  return at === -1 ? line : line.slice(0, at).trimEnd();
}

/** A TOML key, bare or quoted, split on the dots outside quotes, with each part's quotes removed. */
function splitKey(key: string): string[] {
  const dots = unquoted(key).filter((c) => c.ch === '.').map((c) => c.at);
  const bounds = [-1, ...dots, key.length];
  return bounds.slice(1).map((end, i) => key.slice((bounds[i] ?? -1) + 1, end).trim().replace(/^(["'])(.*)\1$/, '$2'));
}

/** The table a TOML header line names, `[tools]` and `[tools.x]` alike, as its dotted path. */
function headerPath(line: string): string[] | null {
  const match = /^\[\[?\s*(.*?)\s*\]\]?$/.exec(stripComment(line));
  return match ? splitKey(match[1] ?? '') : null;
}

/** How far a value moves the bracket depth of a multi-line array or inline table, comment and quotes aside. */
function depthChange(value: string): number {
  const opens = new Set(['[', '{']);
  const closes = new Set([']', '}']);
  return unquoted(stripComment(value)).reduce((depth, c) => depth + (opens.has(c.ch) ? 1 : 0) - (closes.has(c.ch) ? 1 : 0), 0);
}

/** The tool a dotted key path declares: the segment after `tools`, or `null`. */
function toolOf(path: readonly string[]): string | null {
  return path[0] === 'tools' && path[1] !== undefined && path[1] !== '' ? path[1] : null;
}

/** Where a scan stands: the table its lines belong to, and how deep inside a value that spans lines. */
type ScanState = { table: string[]; depth: number };

/**
 * Read one line into `state`, returning the tool it declares, if any. A line
 * inside a value that spans lines, such as an array, is never read as a key.
 */
function scanLine(state: ScanState, raw: string): string | null {
  const line = raw.trim();
  if (state.depth > 0) {
    state.depth = Math.max(0, state.depth + depthChange(line));
    return null;
  }
  if (line === '' || line.startsWith('#')) return null;
  const header = headerPath(line);
  if (header !== null) {
    state.table = header;
    return toolOf(header);
  }
  const eq = firstUnquoted(line, '=');
  if (eq <= 0) return null;
  state.depth = Math.max(0, depthChange(line.slice(eq + 1)));
  return toolOf([...state.table, ...splitKey(line.slice(0, eq))]);
}

/**
 * Every tool a mise config's text declares: each key under `[tools]`, each
 * `[tools.<key>]` table, and each top-level `tools.<key>` dotted key.
 */
export function miseToolKeys(text: string): Set<string> {
  const state: ScanState = { table: [], depth: 0 };
  const keys = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const tool = scanLine(state, raw);
    if (tool !== null) keys.add(tool);
  }
  return keys;
}

/** Where mise declares a tool: the config file, relative to the repo root, and the key that named it. */
export type MiseDeclaration = { file: string; id: string };

/** The tool keys of the mise config at `path`, or none when it's missing or unreadable. */
function configKeys(path: string): Set<string> {
  try {
    return existsSync(path) ? miseToolKeys(readFileSync(path, 'utf8')) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * The first mise config between `cwd` and `repo` that declares one of `ids`,
 * nearest first, or `null` when none does. mise merges every config file up
 * the tree, so a key in any of them declares the tool.
 */
export function miseDeclaration(cwd: string, repo: string, ids: readonly string[]): MiseDeclaration | null {
  for (const dir of dirsUpTo(cwd, repo)) {
    for (const name of MISE_FILES) {
      const path = join(dir, name);
      const keys = configKeys(path);
      const id = ids.find((candidate) => keys.has(candidate));
      if (id !== undefined) return { file: relative(repo, path) || name, id };
    }
  }
  return null;
}

/** How long `mise which` may take before the check fails rather than wait on it. */
const MISE_WHICH_TIMEOUT_MS = 10_000;

/**
 * Whether mise can run the copy of `bin` it pins for `cwd`, asked through
 * `mise which <bin>` with installs switched off, or the first line of mise's
 * answer when it can't.
 *
 * `mise exec` can't be trusted with this. With auto-install off, a pinned
 * version that isn't installed makes it warn and run whatever `bin` is on
 * `PATH` (checked against mise 2026.10.4), which is the fall-through a pin
 * exists to rule out (D12). `mise which` exits 1 for that pin instead. The
 * question costs one short spawn per check mise launches, and asks for no
 * version: only whether the pinned copy is there.
 */
export function miseCanRun(
  mise: string,
  bin: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true } | { ok: false; detail: string } {
  try {
    execFileSync(mise, ['which', bin], {
      cwd,
      env: { ...env, ...MISE_NO_INSTALL },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MISE_WHICH_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    const line = stderr.split('\n').map((l) => l.replace(/^mise ERROR\s*/, '').trim()).find(Boolean);
    return { ok: false, detail: line ?? `mise which ${bin} failed` };
  }
}
