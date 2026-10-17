/**
 * `--static-only` classification (R13.4): whether a check reads the repo as
 * data, so it can run before the repo is installed or sandboxed. Its adapter
 * has to be marked `static` in the registry, or vouched for by the defaults
 * layer; its argv has to carry none of the adapter's `nonStaticArgs`; none of
 * its `codeConfigs` may sit under the check's directory; and none of its
 * `codeKeys` may be set in a config file it reads.
 *
 * Every rule here is a best-effort sniff of names and known keys, read as
 * plain text, and a tool release can add a way to load code that it doesn't
 * know. It's a selector for runs with nothing installed, never a sandbox. When
 * a sniff is unsure, it errs toward skipping the check. Whether the tool
 * resolves without an install is the launcher's to say, as the check starts.
 */

import { posix } from 'node:path';

import type { Adapter, CodeKey } from '../adapters.js';

/** What the sniffs read: the check's directory relative to the repo root, the repo's files, and a reader for one of them. */
export type StaticScope = {
  /** The directory the check runs from, relative to the repo root, `.` for the root itself. */
  dir: string;
  /** Every file the repo holds, relative to its root. */
  files: readonly string[];
  /** The text of a repo file, by its repo-relative path, or `null` when it can't be read. */
  read: (path: string) => string | null;
};

/** `path`, relative to `dir`, or `null` when it lies outside it. */
function under(path: string, dir: string): string | null {
  if (dir === '.') return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** A path glob as a regex: `**` crosses directories, `*` stays within one. */
function globRegExp(glob: string): RegExp {
  const source = glob
    .split('**/')
    .map((part) => part.split('*').map((piece) => piece.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`);
}

/** True when `rel`, a path under the check's directory, is the file `pattern` names: by name at any depth, or by glob when it holds a `/`. */
function names(pattern: string, rel: string): boolean {
  return pattern.includes('/') ? globRegExp(pattern).test(rel) : posix.basename(rel) === pattern;
}

/** Each repo file under the check's directory that `pattern` names, as its repo-relative path. */
function filesNamed(pattern: string, scope: StaticScope): string[] {
  return scope.files.filter((path) => {
    const rel = under(path, scope.dir);
    return rel !== null && names(pattern, rel);
  });
}

/** The lines after the one holding `at` that indent past nothing or open a YAML list item: a block value, read until a line that doesn't. */
function blockLines(text: string, at: number): string[] {
  const end = text.indexOf('\n', at);
  if (end === -1) return [];
  const rest = text.slice(end + 1).split('\n');
  const stop = rest.findIndex((line) => line.trim() !== '' && !/^\s|^-/.test(line));
  return rest.slice(0, stop === -1 ? undefined : stop);
}

/**
 * The text a key holds where `at` begins its value: the rest of the line,
 * through the closing `]` of an array that runs on, or, with nothing after the
 * key, the YAML block below it.
 */
function valueText(text: string, at: number): string {
  const end = text.indexOf('\n', at);
  const line = text.slice(at, end === -1 ? undefined : end).replace(/\s+#.*$/, '').trim();
  if (line === '') return blockLines(text, at).join('\n');
  if (!line.startsWith('[') || line.includes(']')) return line;
  const close = text.indexOf(']', at);
  return text.slice(at, close === -1 ? undefined : close + 1);
}

/** The values `key` holds in a config file's text, JSON or YAML, read as text: each quoted string, else each bare value, a list item's included. */
function keyValues(text: string, key: string): string[] {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^\\s*|["'])${escaped}["']?\\s*[:=]`, 'gm');
  return [...text.matchAll(pattern)].flatMap((match) => {
    const value = valueText(text, (match.index ?? 0) + match[0].length);
    const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    if (quoted.length > 0) return quoted;
    return value.split('\n').map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*-\s*/, '').trim());
  });
}

/** The first key of `codeKey` set in `text` so that it loads code, or `null`. */
function codeKeyIn(text: string, codeKey: CodeKey): string | null {
  const value = codeKey.value === undefined ? null : new RegExp(codeKey.value);
  return codeKey.keys.find((key) => {
    const values = keyValues(text, key);
    return values.length > 0 && (value === null || values.some((v) => value.test(v)));
  }) ?? null;
}

/** Why `adapter`'s config would load code here, from its code configs and keys, or `null` when it reads none that does. */
function codeCause(adapter: Adapter, scope: StaticScope): string | null {
  for (const config of adapter.codeConfigs ?? []) {
    const [file] = filesNamed(config, scope);
    if (file !== undefined) return `${file} is code ${adapter.name} would run`;
  }
  for (const codeKey of adapter.codeKeys ?? []) {
    for (const file of filesNamed(codeKey.file, scope)) {
      const text = scope.read(file);
      const key = text === null ? null : codeKeyIn(text, codeKey);
      if (key !== null) return `${file} sets ${key}, which loads code`;
    }
  }
  return null;
}

/**
 * Why `--static-only` skips a check whose adapter is `adapter`, run from
 * `scope.dir`, as the cause its `static-only: <cause>` reason gives, or
 * `null` when the check may run. The argv read is the adapter's own, its
 * `changedArgs` included, so a flag that needs the install skips it whether or
 * not the run is `--changed`.
 */
export function staticCause(adapter: Adapter, scope: StaticScope): string | null {
  if (adapter.static !== true) return `${adapter.name} isn't a static check`;
  const argv = [...adapter.args, ...(adapter.changedArgs ?? [])];
  const flag = (adapter.nonStaticArgs ?? []).find((arg) => argv.includes(arg));
  if (flag !== undefined) return `${adapter.name} runs with ${flag}, which needs the install`;
  return codeCause(adapter, scope);
}
