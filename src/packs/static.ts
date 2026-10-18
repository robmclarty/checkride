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

/**
 * `text` with each `\xXX`, `\uXXXX` and `\UXXXXXXXX` escape decoded, as
 * JSON, JSON5, YAML and TOML decode those they allow in a quoted key or
 * value, so a key that spells a letter of `plugins` as an escape still reads
 * as `plugins`. A code point past Unicode's last stays as written.
 */
function unescaped(text: string): string {
  return text.replaceAll(/\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8}))/g, (escape, x?: string, u?: string, big?: string) => {
    const code = Number.parseInt(x ?? u ?? big ?? '', 16);
    return code > 0x10_ffff ? escape : String.fromCodePoint(code);
  });
}

/** How a config file's quoted strings and comments read: as JSON, JSONC and JSON5 read them, or as YAML does. */
type Syntax = 'json' | 'yaml';

/**
 * The syntaxes `file`'s values are read in: JSON's for a `.json`, `.jsonc`
 * or `.json5`, YAML's for a `.yaml` or `.yml`, and both for any other name,
 * such as `.prettierrc` or a TOML file, a value that loads code in either
 * reading counting.
 */
function syntaxesOf(file: string): Syntax[] {
  if (/\.json[c5]?$/i.test(file)) return ['json'];
  if (/\.ya?ml$/i.test(file)) return ['yaml'];
  return ['json', 'yaml'];
}

/** A double-quoted string, its backslash escapes included, as JSON and YAML each write one, to its close or, left open, the text's end. */
const DOUBLE = String.raw`"(?:[^"\\]|\\[\s\S])*"?`;

/**
 * Each syntax's quoted strings and comments, in the order its parser meets
 * them, so a `#` or a bracket inside a string is the string's and a quote
 * inside a comment is the comment's. JSON5 escapes a single-quoted string as
 * a double-quoted one, and JSONC and JSON5 comment with `//` and a block
 * comment. A YAML quote opens a string only where a scalar starts, never
 * inside a plain one such as `it's`, a single-quoted string doubles a quote
 * to hold one, and a `#` opens a comment at a line's start or after a space.
 */
const TOKENS: Record<Syntax, RegExp> = {
  json: new RegExp(String.raw`${DOUBLE}|'(?:[^'\\]|\\[\s\S])*'?|//[^\n]*|/\*[\s\S]*?(?:\*/|$)`, 'g'),
  yaml: new RegExp(String.raw`(?<=^|[\s,[{]|["']:)(?:${DOUBLE}|'(?:[^']|'')*'?)|(?<!\S)#[^\n]*`, 'g'),
};

/** The mark a lifted string leaves in its place: its index between two NULs. */
const MARK = /\0(\d+)\0/g;

/**
 * `text` as `syntax` reads it: each comment blanked, and each quoted string
 * lifted out into `strings`, a mark of its index left in its place, so no
 * `#`, bracket, comma or line break inside one shapes the value around it.
 */
function lifted(text: string, syntax: Syntax): { text: string; strings: string[] } {
  const strings: string[] = [];
  const rest = text.replaceAll(TOKENS[syntax], (token) => {
    if (!token.startsWith('"') && !token.startsWith("'")) return ' ';
    strings.push(token);
    return `\0${strings.length - 1}\0`;
  });
  return { text: rest, strings };
}

/**
 * What a lifted string holds between its quotes, as written and with its
 * escapes decoded, each with a line break a `\` escapes dropped along with the
 * next line's indent, as YAML drops one. Any other line break stays rather
 * than folding to a space, which moves no string's end. A string left open,
 * which no parser takes, reads short of its last character.
 */
function contents(token: string): string[] {
  const body = token.slice(1, -1);
  return [body, unescaped(body)].map((text) => text.replaceAll(/\\\r?\n[ \t]*/g, ''));
}

/** `text`, opening a flow collection past any whitespace, through the bracket or brace that closes it, or whole when none does. */
function collection(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === '[' || char === '{') depth += 1;
    if ((char === ']' || char === '}') && (depth -= 1) === 0) return text.slice(0, i + 1);
  }
  return text;
}

/** A line that opens a mapping entry: a key, bare or a lifted string's mark, and its `:`, past any list item's dash or explicit key's `?`. */
const ENTRY = /^\s*(?:[-?]\s+)*[^\s#,[\]{}:][^,[\]{}:\n]*:(?:\s|$)/;

/**
 * The lifted text a key's value spans, where `rest` begins it: a flow
 * collection, through its close; any other value, through the key's line and
 * on to the first line below that opens another entry no further in than the
 * key, which stands at `column`. So a YAML block below the key counts, a
 * comment's blanked line and a block scalar's `a: b` included, and so does a
 * scalar running on, in a block, where its lines indent past the key, or in a
 * flow mapping, where they needn't.
 */
function span(rest: string, column: number): string {
  if (/^\s*[[{]/.test(rest)) return collection(rest);
  const [line = '', ...below] = rest.split('\n');
  const stop = below.findIndex((next) => next.search(/\S/) <= column && ENTRY.test(next));
  return [line, ...below.slice(0, stop === -1 ? undefined : stop)].join('\n');
}

/** The bare scalars a span holds: split at its line breaks and at a flow collection's brackets, braces and commas, each shorn of a list item's dash. */
function bareItems(text: string): string[] {
  return text
    .replaceAll(MARK, ',')
    .split(/[\n,[\]{}]/)
    .map((item) => item.trim().replace(/^-\s+/, ''));
}

/** A YAML node's properties, a tag, verbatim or not, or an anchor, where a node can start. */
const PROPERTIES = /(^|[\s,[{])[!&](?:<[^>]*>|[^\s,[\]{}]*)/g;

/**
 * The strings the value of a key holds, where `at` begins it in `text` and
 * the key stands at `column` of its line, as `syntax` reads them, or `null`
 * when that reading can't tell, which counts: each quoted string the value
 * spans, as written and decoded, and each bare scalar, read with its YAML
 * tags and anchors and without them, so `!!str script` reads as `script`. A
 * YAML alias, which stands for a node anchored elsewhere, can't be told.
 */
function valuesAt(text: string, at: number, column: number, syntax: Syntax): string[] | null {
  const { text: rest, strings } = lifted(text.slice(at), syntax);
  const written = span(rest, column);
  const bare = span(rest.replaceAll(PROPERTIES, '$1'), column);
  if (bareItems(written).some((item) => item.startsWith('*'))) return null;
  return [written, bare].flatMap((s) => [...[...s.matchAll(MARK)].flatMap((m) => contents(strings[Number(m[1])] ?? '')), ...bareItems(s)]);
}

/** A character that continues a name, an HCL identifier's or a bare YAML, TOML or JSON5 key's: a letter, digit or mark, `_` or `-`. */
const IDENT = String.raw`[\p{L}\p{N}\p{M}_-]`;

/**
 * How many times a key is read for its value in one file. A key set more
 * often counts unread, so a file that repeats it can't make each occurrence
 * read on to the file's end.
 */
const KEY_REACH = 16;

/**
 * True when `text`, JSON, JSON5, YAML or TOML, sets `key` so that it loads
 * code: with any value, or with one `value` matches, read as each of
 * `syntaxes` reads it, and a value a reading can't tell counting. The key
 * counts wherever its whole name stands before a `:` or `=`, erring toward a
 * skip: at a line's start or in quotes, and as well opening a flow mapping,
 * after a comma, or past a YAML tag, anchor or `?`, each of which the tool's
 * parser reads as the same key. A longer name that ends in it, such as
 * `no-plugins`, doesn't count.
 */
function setsKey(text: string, key: string, value: RegExp | null, syntaxes: readonly Syntax[]): boolean {
  const matches = [...text.matchAll(new RegExp(`(?<!${IDENT})${escaped(key)}["']?\\s*[:=]`, 'gu'))];
  if (value === null || matches.length > KEY_REACH) return matches.length > 0;
  return matches.some((match) => {
    const from = match.index ?? 0;
    const column = from - text.lastIndexOf('\n', from) - 1;
    return syntaxes.some((syntax) => valuesAt(text, from + match[0].length, column, syntax)?.some((v) => value.test(v)) ?? true);
  });
}

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
 * its `\x`, `\u` and `\U` escapes decoded, and a key set in either reading
 * counts, since decoding one escape into a quote can hide what the raw text
 * shows; its values are read in the syntaxes its name says.
 */
function codeKeyIn(file: string, text: string, codeKey: CodeKey): string | null {
  const value = codeKey.value === undefined ? null : new RegExp(codeKey.value);
  if (/\.hcl$/i.test(file)) {
    const code = hclCode(text);
    return codeKey.keys.find((key) => hclSetsKey(code, key, value)) ?? null;
  }
  const readings = [text, unescaped(text)];
  const syntaxes = syntaxesOf(file);
  return codeKey.keys.find((key) => readings.some((reading) => setsKey(reading, key, value, syntaxes))) ?? null;
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

/** Why `adapter` isn't static: what its entry did to take the registry's mark, when it took one, or else that the registry gives none. */
function unmarked(adapter: Adapter): string {
  const drop = adapter.staticDrop;
  if (drop === undefined) return `${adapter.name} isn't a static check`;
  if ('command' in drop) return `${adapter.name}'s entry swaps its command for ${drop.command}`;
  return `${adapter.name}'s entry adds ${drop.arg}, an argument its registry row doesn't carry`;
}

/**
 * Why `--static-only` skips a check whose adapter is `adapter`, run from
 * `scope.dir`, as the cause its `static-only: <cause>` reason gives, or
 * `null` when the check may run. The argv read is the adapter's own, its
 * `changedArgs` included, so a flag that needs the install or loads code
 * skips it whether or not the run is `--changed`.
 */
export function staticCause(adapter: Adapter, scope: StaticScope): string | null {
  if (adapter.static !== true) return unmarked(adapter);
  const argv = [...adapter.args, ...(adapter.changedArgs ?? [])];
  const install = passed(argv, adapter.nonStaticArgs);
  if (install !== undefined) return `${adapter.name} runs with ${install}, which needs the install`;
  const loads = passed(argv, adapter.codeArgs);
  if (loads !== undefined) return `${adapter.name} runs with ${loads}, which can load code`;
  return codeCause(adapter, scope);
}
