/**
 * `--static-only` classification (R13.4): whether a check reads the repo as
 * data, so it can run before the repo is installed or sandboxed. Its adapter
 * has to be marked `static` in the registry, or vouched for by the defaults
 * layer; its argv has to carry none of the adapter's `nonStaticArgs` or
 * `codeArgs`; none of its `codeConfigs` may sit under the check's directory;
 * and none of its `codeKeys` may be set in a config file it reads.
 *
 * Every rule here is a best-effort sniff of names and known keys, read as
 * plain text, and a tool release can add a way to load code that it doesn't
 * know. It's a selector for runs with nothing installed, never a sandbox. When
 * a sniff is unsure, it errs toward skipping the check: a name matches in any
 * case, since a case-insensitive filesystem, macOS's default, opens a config
 * by any case of its name. Whether the tool resolves without an install is the
 * launcher's to say, as the check starts.
 */

import { posix } from 'node:path';

import type { Adapter, CodeKey } from '../adapters.js';

/** What the sniffs read: the check's directory relative to the repo root, the files under it, and a reader for one of them. */
export type StaticScope = {
  /** The directory the check runs from, relative to the repo root, `.` for the root itself. */
  dir: string;
  /** Every entry under the check's directory that isn't a directory, relative to the repo root. */
  files: readonly string[];
  /** The text of a repo file, by its repo-relative path, or `null` when it can't be read. */
  read: (path: string) => string | null;
};

/** `path`, relative to `dir`, or `null` when it lies outside it. */
function under(path: string, dir: string): string | null {
  if (dir === '.') return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** `text` with every character a regex treats specially escaped. */
function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A path glob as a regex: `**` crosses directories, `*` stays within one. */
function globRegExp(glob: string): RegExp {
  const source = glob
    .split('**/')
    .map((part) => part.split('*').map(escaped).join('[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`);
}

/**
 * True when `rel`, a path under the check's directory, is one `pattern` names,
 * in any case: a name ending in `/` names a directory, and a path through one
 * of that name counts, the entry itself included, as a symlink in its place
 * is; a name holding another `/` is a path glob; any other is a file's name,
 * at any depth.
 */
function names(pattern: string, rel: string): boolean {
  const path = rel.toLowerCase();
  const name = pattern.toLowerCase();
  if (name.endsWith('/')) return path.split('/').includes(name.slice(0, -1));
  return name.includes('/') ? globRegExp(name).test(path) : posix.basename(path) === name;
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

/**
 * The values `key` holds in a config file's text, JSON, YAML or TOML, read as
 * text: each quoted string, else each bare value, a list item's included.
 */
function keyValues(text: string, key: string): string[] {
  const pattern = new RegExp(`(?:^\\s*|["'])${escaped(key)}["']?\\s*[:=]`, 'gm');
  return [...text.matchAll(pattern)].flatMap((match) => {
    const value = valueText(text, (match.index ?? 0) + match[0].length);
    const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
    if (quoted.length > 0) return quoted;
    return value.split('\n').map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*-\s*/, '').trim());
  });
}

/**
 * `text` with each `\uXXXX` escape decoded, as JSON, YAML and TOML decode one
 * in a quoted key or value, so a key that spells a letter of `plugin` as an
 * escape still reads as `plugin`.
 */
function unescapeUnicode(text: string): string {
  return text.replaceAll(/\\u([\dA-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** True when `text`, JSON, YAML or TOML, sets `key` so that it loads code: with any value, or with one `value` matches. */
function setsKey(text: string, key: string, value: RegExp | null): boolean {
  const values = keyValues(text, key);
  return values.length > 0 && (value === null || values.some((v) => value.test(v)));
}

/** A character that continues an HCL identifier: a letter, digit or mark, `_` or `-`. */
const IDENT = String.raw`[\p{L}\p{N}\p{M}_-]`;

/** What HCL allows between a block's type, its label and its brace: whitespace and block comments. */
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/)*`;

/** A block's label and opening brace, read after its type: a quoted label, escapes and all, or a bare one. */
const LABEL = new RegExp(String.raw`^${GAP}("(?:[^"\\\n]|\\.)*"|${IDENT}+)${GAP}\{`, 'u');

/**
 * How far past a block's type its label and brace are looked for. A header
 * spread wider reads as unreadable, so it counts, and a file of unclosed
 * comments can't make each occurrence scan to its end.
 */
const LABEL_REACH = 1024;

/** HCL's block comments, quoted strings, each ending with its line, and line comments, in the order a reader meets them. */
const HCL_TOKENS = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\.)*"?|(?:#|\/\/)[^\n]*/g;

/**
 * `text`, HCL, with its `#` and `//` comments dropped, read as HCL reads them:
 * never inside a quoted string or a block comment. Block comments stay, since
 * one that only a heredoc's text seems to open must hide nothing, and the
 * label reading steps over them.
 */
function hclCode(text: string): string {
  return text.replaceAll(HCL_TOKENS, (token) => (token.startsWith('#') || token.startsWith('//') ? '' : token));
}

/**
 * True when `code`, HCL with its line comments dropped, sets `key` so that it
 * loads code. HCL has no free text outside strings and comments, so every
 * occurrence of the key as a whole identifier counts, erring toward a skip,
 * unless `value` is given and the occurrence opens a block whose label
 * `value` rejects, as tflint's `plugin "terraform" {` or `plugin terraform {`.
 * A label is tested as written, its escapes undecoded.
 */
function hclSetsKey(code: string, key: string, value: RegExp | null): boolean {
  const token = new RegExp(`(?<!${IDENT})${escaped(key)}(?!${IDENT})`, 'gu');
  return [...code.matchAll(token)].some((match) => {
    if (value === null) return true;
    const at = (match.index ?? 0) + match[0].length;
    const label = LABEL.exec(code.slice(at, at + LABEL_REACH))?.[1];
    return label === undefined || value.test(label.replace(/^"|"$/g, ''));
  });
}

/**
 * The first key of `codeKey` set in `file`'s text so that it loads code, or
 * `null`. A `.hcl` file is read as HCL. Any other is read as written and with
 * its `\u` escapes decoded, and a key set in either reading counts, since
 * decoding one escape into a quote can hide what the raw text shows.
 */
function codeKeyIn(file: string, text: string, codeKey: CodeKey): string | null {
  const value = codeKey.value === undefined ? null : new RegExp(codeKey.value);
  if (/\.hcl$/i.test(file)) {
    const code = hclCode(text);
    return codeKey.keys.find((key) => hclSetsKey(code, key, value)) ?? null;
  }
  const readings = [text, unescapeUnicode(text)];
  return codeKey.keys.find((key) => readings.some((reading) => setsKey(reading, key, value))) ?? null;
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
      const key = text === null ? null : codeKeyIn(file, text, codeKey);
      if (key !== null) return `${file} sets ${key}, which loads code`;
    }
  }
  return null;
}

/**
 * True when `arg` passes `flag`: as itself, with its value after `=`, or, for
 * a one-letter flag, in a cluster such as `-vc`, the way most command lines
 * read one.
 */
function passes(arg: string, flag: string): boolean {
  if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  return /^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]/.test(arg) && arg.slice(1).includes(flag.slice(1));
}

/** The first of `flags` that `argv` passes, or `undefined`. */
function passed(argv: readonly string[], flags: readonly string[] | undefined): string | undefined {
  return flags?.find((flag) => argv.some((arg) => passes(arg, flag)));
}

/**
 * Why `--static-only` skips a check whose adapter is `adapter`, run from
 * `scope.dir`, as the cause its `static-only: <cause>` reason gives, or
 * `null` when the check may run. The argv read is the adapter's own, its
 * `changedArgs` included, so a flag that needs the install or loads code
 * skips it whether or not the run is `--changed`.
 */
export function staticCause(adapter: Adapter, scope: StaticScope): string | null {
  if (adapter.static !== true) return `${adapter.name} isn't a static check`;
  const argv = [...adapter.args, ...(adapter.changedArgs ?? [])];
  const install = passed(argv, adapter.nonStaticArgs);
  if (install !== undefined) return `${adapter.name} runs with ${install}, which needs the install`;
  const loads = passed(argv, adapter.codeArgs);
  if (loads !== undefined) return `${adapter.name} runs with ${loads}, which can load code`;
  return codeCause(adapter, scope);
}
