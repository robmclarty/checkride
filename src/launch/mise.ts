/**
 * The `mise` pin source: a tool is declared when a `mise.toml` or `.mise.toml`
 * between the check's directory and the repo root names it under `[tools]`,
 * and it runs as `mise exec -- <bin>`.
 *
 * Only the keys are read. mise owns version resolution (a key's value can be a
 * prefix, `latest`, or a table with options), so checkride asks whether the
 * repo pins a tool, never which version it pins (R6.1). A `--pins` file is the
 * exception: its versions are read too, since the `override` source runs each
 * tool as `mise exec <id>@<version>` outside any config mise would find
 * (R13.3).
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
 * `mise which <bin>` with installs switched off, or why not when it can't.
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
): MiseAnswer {
  return askMise(mise, ['which', bin], cwd, { ...env, ...MISE_NO_INSTALL });
}

/**
 * Whether mise answered yes, or the line of its error that says why it
 * didn't, and whether that's a config file mise hasn't trusted.
 */
export type MiseAnswer = { ok: true } | { ok: false; detail: string; untrusted: boolean };

/**
 * The line mise gives a config file it won't read until someone runs `mise
 * trust` (`Config files in <path> are not trusted.`, checked against mise
 * 2026.10.4). Its first line, `error parsing config file`, names no cause.
 */
const UNTRUSTED_LINE = /\bnot trusted\b/;

/**
 * Ask mise `args` from `cwd` with `env`, waiting at most
 * {@link MISE_WHICH_TIMEOUT_MS}: a zero exit is yes, and otherwise the detail
 * is mise's line for an untrusted config, else its first error line, its
 * `WARN` lines (an update notice, say) passed over.
 */
function askMise(mise: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>>): MiseAnswer {
  try {
    execFileSync(mise, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: MISE_WHICH_TIMEOUT_MS });
    return { ok: true };
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    const lines = stderr.split('\n').filter((l) => !l.startsWith('mise WARN'));
    const said = lines.map((l) => l.replace(/^mise ERROR\s*/, '').trim()).filter(Boolean);
    const trust = said.find((l) => UNTRUSTED_LINE.test(l));
    return { ok: false, detail: trust ?? said[0] ?? `mise ${args.join(' ')} failed`, untrusted: trust !== undefined };
  }
}

/**
 * The variable that names a `--pins` file, the way the flag does (the flag
 * wins). The CLI reads it and the gate strips it from the check it spawns.
 */
export const PINS_ENV = 'CHECKRIDE_PINS';

/**
 * What a check an override pin runs carries: mise's installs off, as for
 * every check mise launches, and mise offline, so a version prefix such as
 * `1.24` resolves against the installed copies rather than a remote list.
 */
export const OVERRIDE_ENV: Readonly<Record<string, string>> = { ...MISE_NO_INSTALL, MISE_OFFLINE: '1' };

/** A TOML string literal, basic or literal, as its content, or `null` for anything else. */
function stringValue(value: string): string | null {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? (match[2] ?? '') : null;
}

/** The version a `[tools]` value pins: a string, or an inline table's `version` string. */
function pinnedVersion(value: string): string | null {
  const plain = stringValue(value);
  if (plain !== null) return plain;
  if (!/^\{.*\}$/.test(value)) return null;
  const version = /(?:^\{|,)\s*version\s*=\s*("[^"]*"|'[^']*')/.exec(value)?.[1];
  return version === undefined ? null : stringValue(version);
}

/** One line of a `--pins` file read into `table` (the header it sits under), as the tool and version it pins, a problem, or nothing. */
function pinLine(table: string[], raw: string): { tool: string; version: string } | { problem: string } | null {
  const line = stripComment(raw.trim());
  if (line === '') return null;
  const header = headerPath(line);
  if (header !== null) {
    table.splice(0, table.length, ...header);
    const tool = toolOf(header);
    return tool === null ? null : { problem: `[tools.${tool}] is a table: pin it as ${tool} = "<version>" under [tools]` };
  }
  const eq = firstUnquoted(line, '=');
  const tool = eq <= 0 ? null : toolOf([...table, ...splitKey(line.slice(0, eq))]);
  if (tool === null) return null;
  const value = line.slice(eq + 1).trim();
  const version = pinnedVersion(value);
  if (version === null || version === '') {
    return { problem: `[tools] ${tool} must be a version string or an inline table with a version (got ${value})` };
  }
  return { tool, version };
}

/**
 * The tools a `--pins` file's text pins, by key, each with its version
 * (R13.3): a string, or an inline table's `version`. Anything else is the
 * reason the file can't be read, since a pin with no version can't say which
 * copy runs.
 */
export function miseToolVersions(text: string): ReadonlyMap<string, string> | { problem: string } {
  const table: string[] = [];
  const pins = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const read = pinLine(table, raw);
    if (read === null) continue;
    if ('problem' in read) return read;
    pins.set(read.tool, read.version);
  }
  return pins;
}

/**
 * The pins the `--pins` file at `path` declares, or throw the friendly
 * `invalid <path>: <reason>` error, a usage error, when it can't be read.
 */
export function loadPinsFile(path: string): ReadonlyMap<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const pins = miseToolVersions(text);
  if ('problem' in pins) throw new Error(`invalid ${path}: ${pins.problem}`);
  return pins;
}

/**
 * Whether mise has installed `spec` (`<id>@<version>`), asked through
 * `mise where` offline and with installs off, which exits 1 for a version it
 * hasn't installed and downloads nothing, or why not when it hasn't.
 */
export function miseHasInstalled(
  mise: string,
  spec: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): MiseAnswer {
  return askMise(mise, ['where', spec], cwd, { ...env, ...OVERRIDE_ENV });
}
