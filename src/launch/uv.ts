/**
 * The `uv-lock` pin source: a Python tool is declared when the `uv.lock`
 * nearest the check's directory, up to the repo root, lists the tool's PyPI
 * package, and it runs from the project's environment, never through uv
 * itself (R6.1). The version recorded is the one the lock pins (R6.3), read
 * from the file, never by running anything.
 *
 * uv keeps one lock and one environment per project, and a workspace's
 * members share the root's, so the environment is the `.venv` beside the
 * lock, not one under the check's own directory, unless
 * `UV_PROJECT_ENVIRONMENT` names another, which a relative value names from
 * that same directory (both checked against uv 0.13.1).
 *
 * Only what the source needs is read from the lock: each `[[package]]`
 * table's own `name` and `version`. uv owns the rest of the file's meaning.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { dirsUpTo } from './walk.js';

/** The file uv locks a project's dependencies in. */
const UV_LOCK = 'uv.lock';

/** The variable that moves a uv project's environment away from its `.venv`. */
const PROJECT_ENVIRONMENT = 'UV_PROJECT_ENVIRONMENT';

/**
 * A package name as PyPI compares names (PEP 503): lowercased, each run of
 * `-`, `_` and `.` one `-`. uv writes names this way in its lock, so `PyTest`
 * in a `pyproject.toml` is `pytest` there.
 */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

/** One `[[package]]` table of a lock: its own `name` and `version`, when it has them. */
type LockedPackage = { name?: string; version?: string };

/** The header line that opens one `[[package]]` table. */
const PACKAGE_HEADER = /^\[\[package\]\][ \t]*\r?$/m;

/** Any header line, which ends the table before it. */
const ANY_HEADER = /^\[/m;

/** The string value of the key `key` on a line of its own, as uv writes `name` and `version`. */
function keyValue(body: string, key: string): string | undefined {
  return new RegExp(`^${key}[ \\t]*=[ \\t]*"([^"]*)"[ \\t]*\\r?$`, 'm').exec(body)?.[1];
}

/**
 * Every `[[package]]` table in a `uv.lock`'s text, in file order. A key
 * counts only in the table's own body: the next header, a sub-table such as
 * `[package.metadata]` included, ends it, and a dependency's `{ name = … }`
 * sits inside an array, never at the start of a line.
 */
function lockedPackages(text: string): LockedPackage[] {
  return text.split(PACKAGE_HEADER).slice(1).map((chunk) => {
    const body = chunk.slice(0, ANY_HEADER.exec(chunk)?.index ?? chunk.length);
    const name = keyValue(body, 'name');
    const version = keyValue(body, 'version');
    return { ...(name !== undefined ? { name } : {}), ...(version !== undefined ? { version } : {}) };
  });
}

/**
 * Whether a `uv.lock`'s text lists package `pypi`, and every version it locks
 * it at, in file order: one per matching `[[package]]` table, more than one
 * where a forked resolution locks it twice. A table with no `version` of its
 * own adds none, so a listed package can have no version.
 */
export function uvLockVersions(text: string, pypi: string): { listed: boolean; versions: string[] } {
  const wanted = normalizePypiName(pypi);
  const matched = lockedPackages(text).filter((p) => p.name !== undefined && normalizePypiName(p.name) === wanted);
  return { listed: matched.length > 0, versions: matched.flatMap((p) => (p.version === undefined ? [] : [p.version])) };
}

/**
 * Where a `uv.lock` declares a tool: the file, relative to the repo root, the
 * project directory that holds it, absolute, and the version it locks, when
 * every entry for the package agrees on one.
 */
export type UvLockDeclaration = { file: string; dir: string; version?: string };

/** The text of the file at `path`, or `null` when it can't be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Where the `uv.lock` nearest `cwd`, up to `repo`, declares the tool whose
 * PyPI package is `pypi`, or `null` when there's no lock or the nearest one
 * doesn't list it. A lock above the nearest one isn't read, as uv reads only
 * its project's own.
 */
export function uvLockDeclaration(cwd: string, repo: string, pypi: string): UvLockDeclaration | null {
  const path = dirsUpTo(cwd, repo).map((dir) => join(dir, UV_LOCK)).find((p) => existsSync(p));
  const text = path === undefined ? null : readText(path);
  if (path === undefined || text === null) return null;
  const { listed, versions } = uvLockVersions(text, pypi);
  if (!listed) return null;
  const [version, ...others] = new Set(versions);
  return { file: relative(repo, path) || UV_LOCK, dir: dirname(path), ...(version !== undefined && others.length === 0 ? { version } : {}) };
}

/**
 * The project environment a lock in `dir` syncs into, absolute: the one
 * `UV_PROJECT_ENVIRONMENT` in `env` names, from `dir` when it's relative, or
 * else `<dir>/.venv`.
 */
export function projectEnvironment(dir: string, env: Readonly<Record<string, string | undefined>>): string {
  const named = env[PROJECT_ENVIRONMENT];
  return named === undefined || named === '' ? join(dir, '.venv') : resolve(dir, named);
}

/**
 * Where an executable named `exe` sits in a project environment, and whether
 * the environment and the executable exist: the environment is missing until
 * `uv sync` creates it, and a tool the lock lists can still be missing from
 * it, in a dependency group the sync left out.
 */
export function environmentTool(venv: string, exe: string): { path: string; venv: boolean; tool: boolean } {
  const path = join(venv, 'bin', exe);
  return { path, venv: existsSync(venv), tool: existsSync(path) };
}
