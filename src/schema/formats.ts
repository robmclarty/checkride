/**
 * How the `schema` slot reads a file: the four formats, the one a file's
 * extension names, and each one's parse.
 *
 * - `json` is strict: `JSON.parse`, so a comment or a trailing comma is an
 *   error.
 * - `jsonc` allows comments and trailing commas (`jsonc-parser`).
 * - `yaml` is the YAML 1.2 core schema, with a duplicate key an error (`yaml`).
 * - `frontmatter` is the YAML between a file's first line, which must be
 *   `---`, and the next line that is exactly `---`. A file with no such block
 *   is an error.
 *
 * A parse hands back the value, and where the parser can say, the line a JSON
 * pointer into it sits on, so a validation error names a line. Strict JSON
 * keeps no positions, so its errors name the file alone.
 */

import { posix } from 'node:path';

import { isRecord } from '../json.js';
import type { SchemaFormat } from './libraries.js';
import type { JsoncLibrary, JsoncNode, SchemaLibraries, YamlLibrary } from './library-types.js';

/** Every format, in the order the docs and the errors list them. */
export const SCHEMA_FORMATS: readonly SchemaFormat[] = ['json', 'jsonc', 'yaml', 'frontmatter'];

/** The format each extension names when a rule sets none. */
const FORMAT_OF_EXTENSION: Readonly<Record<string, SchemaFormat>> = {
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'frontmatter',
  '.mdx': 'frontmatter',
};

/** The format `path`'s extension names, or `null` for one it can't place. */
export function formatOfPath(path: string): SchemaFormat | null {
  const extension = posix.extname(path).toLowerCase();
  return Object.hasOwn(FORMAT_OF_EXTENSION, extension) ? (FORMAT_OF_EXTENSION[extension] ?? null) : null;
}

/** True for one of the four formats. */
export function isSchemaFormat(value: unknown): value is SchemaFormat {
  return SCHEMA_FORMATS.some((format) => format === value);
}

/**
 * A file read as its format: its `value`, and `lineOf`, the 1-based line a
 * JSON pointer into it sits on, where the parser kept positions; or why it
 * didn't parse, under the `keyword` its finding carries, with the line when
 * the parser gave one.
 */
export type Parsed =
  | { ok: true; value: unknown; lineOf: (pointer: string) => number | undefined }
  | { ok: false; keyword: 'parse' | 'frontmatter'; message: string; line?: number };

/** The 1-based line `offset` sits on in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** A JSON pointer's segments, unescaped: `/a~1b/0` is `['a/b', '0']`. */
function segmentsOf(pointer: string): string[] {
  return pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** A failed parse, with its line when one is known. */
function failed(keyword: 'parse' | 'frontmatter', message: string, line: number | undefined): Parsed {
  return { ok: false, keyword, message, ...(line === undefined ? {} : { line }) };
}

/** Where `JSON.parse`'s error says it stopped: the line it names, or the one its position sits on. */
function jsonErrorLine(message: string, text: string): number | undefined {
  const named = /\(line (\d+) column \d+\)/.exec(message)?.[1];
  if (named !== undefined) return Number(named);
  const position = /position (\d+)/.exec(message)?.[1];
  return position === undefined ? undefined : lineAt(text, Number(position));
}

/** Strict JSON. */
function parseJson(text: string): Parsed {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value, lineOf: () => undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed('parse', message, jsonErrorLine(message, text));
  }
}

/** What `jsonc-parser` allows beyond strict JSON: comments, and a trailing comma. */
const JSONC_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false };

/** The node one `segment` below `node`: a property's value, or an array's item. */
function childNode(jsonc: JsoncLibrary, node: JsoncNode, segment: string): JsoncNode | undefined {
  return jsonc.findNodeAtLocation(node, [segment]) ?? (/^\d+$/.test(segment) ? jsonc.findNodeAtLocation(node, [Number(segment)]) : undefined);
}

/**
 * The line a pointer sits on in a JSONC `text`. The tree that places it is
 * parsed on the first call and kept, so a file with a hundred errors is
 * parsed for their lines once.
 */
function jsoncLines(jsonc: JsoncLibrary, text: string): (pointer: string) => number | undefined {
  let tree: { root: JsoncNode | undefined } | null = null;
  return (pointer) => {
    tree ??= { root: jsonc.parseTree(text, [], JSONC_OPTIONS) };
    let node = tree.root;
    for (const segment of segmentsOf(pointer)) {
      if (node === undefined) return undefined;
      node = childNode(jsonc, node, segment);
    }
    return node === undefined ? undefined : lineAt(text, node.offset);
  };
}

/** JSON with comments and trailing commas. */
function parseJsonc(text: string, jsonc: JsoncLibrary): Parsed {
  const errors: { error: number; offset: number; length: number }[] = [];
  const value = jsonc.parse(text, errors, JSONC_OPTIONS);
  const [first] = errors;
  if (first !== undefined) return failed('parse', jsonc.printParseErrorCode(first.error), lineAt(text, first.offset));
  return { ok: true, value, lineOf: jsoncLines(jsonc, text) };
}

/** YAML 1.2's core schema, a duplicate key an error, and messages without the source excerpt a terminal would repeat. */
const YAML_OPTIONS = { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: false, strict: true };

/** Where a YAML node starts in its text, or `undefined` for a value that isn't a node. */
function nodeStart(node: unknown): number | undefined {
  const range: unknown = isRecord(node) ? node['range'] : undefined;
  const start: unknown = Array.isArray(range) ? range[0] : undefined;
  return typeof start === 'number' ? start : undefined;
}

/**
 * YAML, from `text`, whose first line is line `1 + above` of its file: a
 * frontmatter block sits one line down.
 */
function parseYaml(text: string, yaml: YamlLibrary, above = 0): Parsed {
  const doc = yaml.parseDocument(text, YAML_OPTIONS);
  const [first] = doc.errors;
  if (first !== undefined) {
    const at = first.pos?.[0];
    return failed('parse', first.message.split('\n')[0] ?? first.message, at === undefined ? undefined : lineAt(text, at) + above);
  }
  const lineOf = (pointer: string): number | undefined => {
    const start = nodeStart(pointer === '' ? doc.contents : doc.getIn(segmentsOf(pointer), true));
    return start === undefined ? undefined : lineAt(text, start) + above;
  };
  return { ok: true, value: doc.toJS(), lineOf };
}

/** True for a line that is exactly `---`, its line ending aside. */
function isFence(line: string | undefined): boolean {
  return line?.replace(/\r$/, '') === '---';
}

/** The YAML between a file's opening `---` line and the next one. */
function parseFrontmatter(text: string, yaml: YamlLibrary): Parsed {
  const lines = text.split('\n');
  if (!isFence(lines[0])) return failed('frontmatter', 'has no frontmatter block: its first line must be `---`', 1);
  const end = lines.findIndex((line, at) => at > 0 && isFence(line));
  if (end === -1) return failed('frontmatter', 'has a frontmatter block that never closes: no later line is `---`', 1);
  // Each line keeps its ending, the last included, so a CRLF file's last value doesn't end in a carriage return.
  return parseYaml(lines.slice(1, end).map((line) => `${line}\n`).join(''), yaml, 1);
}

/** The library `format` parses with, which a run loads before it reads a file of that format. */
function loaded<T>(library: T | undefined, name: string, format: SchemaFormat): T {
  if (library === undefined) throw new Error(`the schema slot read a ${format} file without loading ${name}`);
  return library;
}

/** `text` read as `format`, with the libraries a run loaded for its rules. */
export function parseAs(format: SchemaFormat, text: string, libraries: Pick<SchemaLibraries, 'yaml' | 'jsonc'>): Parsed {
  if (format === 'json') return parseJson(text);
  if (format === 'jsonc') return parseJsonc(text, loaded(libraries.jsonc, 'jsonc-parser', format));
  const yaml = loaded(libraries.yaml, 'yaml', format);
  return format === 'yaml' ? parseYaml(text, yaml) : parseFrontmatter(text, yaml);
}
