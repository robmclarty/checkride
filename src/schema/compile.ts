/**
 * A rule's schema, compiled: the draft its `$schema` names, the sibling
 * files its `$ref`s reach, and the validator `ajv` builds from them.
 *
 * - **Draft.** 2020-12 or draft-07 by the schema's `$schema`, 2020-12 when it
 *   names none. Any other draft is a refusal.
 * - **`format`.** The keyword is never asserted.
 * - **`$ref`.** A reference within the file works, by pointer or to an `$id`
 *   the file itself declares, and so does one to another file by relative
 *   path, which is read from beside the file that names it. A reference to
 *   the draft's own meta-schema, which `ajv` carries, works too. A reference
 *   to any other URL is a finding on the schema file, because a check makes
 *   no network call. References are read only where a schema can sit, so a
 *   `$ref` inside an `enum`, a `default`, an `examples` entry or an
 *   annotation is data.
 * - **A schema that can't be used** (unreadable, not JSON, not a valid
 *   schema, a reference nothing resolves) is a refusal naming it. So is a
 *   reference to a file outside the repository, which is never read. A file
 *   that isn't JSON is named with where it stops parsing and nothing of what
 *   it holds: the parser's own message quotes the text.
 *
 * Nothing here reads the network, and nothing reads a file but through the
 * `read` it is handed, which holds the containment rule (`../contain.ts`).
 */

import { dirname, resolve } from 'node:path';

import { isRecord } from '../json.js';
import type { AjvConstructor, AjvInstance, AjvLibrary, AjvValidate } from './library-types.js';

/** A schema as a rule names it: `label`, the rule's own word for it; its text; and `path`, where it sits on disk, `null` for a bundled one. */
export type SchemaSource = { label: string; text: string; path: string | null };

/** What reading a file came to: its text; `outside`, for one whose real path is outside the repository, which is never opened; or `missing`. */
export type SchemaRead = { text: string } | 'outside' | 'missing';

/** A `$ref` to a URL: the schema file that holds it, as its finding names it, the JSON pointer to it, and the URL. */
export type RemoteRef = { file: string; pointer: string; ref: string };

/**
 * What a rule's schema compiled to: a validator; the URLs its `$ref`s name,
 * each a finding; or the refusal the check fails with.
 */
export type Compiled = { kind: 'ready'; validate: AjvValidate } | { kind: 'remote'; refs: RemoteRef[] } | { kind: 'refused'; refusal: string };

/** What a compile reads beside the schema: `ajv`, a file's text by the containment rule, and how a finding names a file. */
export type CompileContext = {
  ajv: AjvLibrary;
  read: (path: string) => SchemaRead;
  nameOf: (path: string) => string;
};

/** How `ajv` is set up: every error of a value, `format` unasserted, and no keyword refused for being unknown. */
const AJV_OPTIONS = { allErrors: true, strict: false, validateFormats: false };

/** The base a schema file with no `$id` resolves its references against: a URL no network holds. */
const LOCAL_BASE = 'checkride:///';

/**
 * Keywords whose value is one schema, or a list of them (`items` is either,
 * by draft). Every other keyword's value is data or an annotation, never
 * walked: an `enum`, a `const`, a `default`, an `examples` entry, a
 * `required` list, an `x-` extension.
 */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/**
 * Keywords whose value maps names to schemas, so a name there is never a
 * keyword. Draft-07's `dependencies` maps a name to a schema or to a list of
 * property names, and a list is passed over as any non-schema is.
 */
const MAP_KEYWORDS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

/** A refusal's whole text: one line, `checkride:` first. */
function refusedWith(reason: string): Compiled {
  return { kind: 'refused', refusal: `checkride: ${reason}.\n` };
}

/** The constructor for the draft `schema` declares, or `null` for a draft the slot doesn't read. */
function draftOf(schema: Record<string, unknown>, ajv: AjvLibrary): AjvConstructor | null {
  const declared = schema['$schema'];
  if (declared === undefined) return ajv.draft2020;
  if (typeof declared !== 'string') return null;
  if (declared.includes('draft-07')) return ajv.draft07;
  return declared.includes('2020-12') ? ajv.draft2020 : null;
}

/** What a walk of one schema file found: each `$ref` with its JSON pointer, and each `$id`. */
type Walked = { refs: { ref: string; pointer: string }[]; ids: string[] };

/** One JSON pointer segment, escaped. */
function escaped(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Record the `$ref` and `$id` a schema object holds. */
function note(node: Record<string, unknown>, pointer: string, into: Walked): void {
  const ref = node['$ref'];
  if (typeof ref === 'string') into.refs.push({ ref, pointer: `${pointer}/$ref` });
  const id = node['$id'];
  if (typeof id === 'string') into.ids.push(id);
}

/** Walk what sits at a schema keyword: one schema, or each of a list of them. */
function walkEach(value: unknown, pointer: string, into: Walked): void {
  if (Array.isArray(value)) value.forEach((item, at) => walk(item, `${pointer}/${at}`, into));
  else walk(value, pointer, into);
}

/** Walk a schema, recording its references, through the keywords that hold schemas and no others. A boolean schema holds none. */
function walk(node: unknown, pointer: string, into: Walked): void {
  if (!isRecord(node)) return;
  note(node, pointer, into);
  for (const [key, value] of Object.entries(node)) {
    const at = `${pointer}/${escaped(key)}`;
    if (SCHEMA_KEYWORDS.has(key)) walkEach(value, at, into);
    else if (MAP_KEYWORDS.has(key) && isRecord(value)) {
      for (const [name, schema] of Object.entries(value)) walk(schema, `${at}/${escaped(name)}`, into);
    }
  }
}

/** A reference's file half, the part before any `#`. */
function fileHalf(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(0, hash);
}

/** True for a reference that names a URL, any scheme. */
function isUrl(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/** `ref` resolved against `base`, or `null` for one that resolves to no URL. */
function resolved(ref: string, base: string): string | null {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

/** One schema file being registered: its key in `ajv`, its path on disk (`null` for a bundled one), and the name its errors carry. */
type Unit = { key: string; path: string | null; label: string };

/** What a compile gathers as it follows references: the instance, the keys registered, and the URLs it met. */
type Gathering = { instance: AjvInstance; context: CompileContext; seen: Set<string>; remote: RemoteRef[] };

/** A failure to register a schema, as the refusal's reason. */
type Refusal = string;

/** The 1-based line and column `offset` sits at in `text`. */
function placeAt(text: string, offset: number): string {
  const before = text.slice(0, offset).split('\n');
  return ` (line ${before.length}, column ${(before.at(-1) ?? '').length + 1})`;
}

/**
 * Where `JSON.parse` stopped in `text`, from the position its error names, or
 * `''` when it names none. Only the place is kept: the message itself quotes
 * what it read, and a schema file's text is not a refusal's to repeat.
 */
function stoppedAt(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : '';
  const named = /\(line (\d+) column (\d+)\)/.exec(message);
  if (named !== null) return ` (line ${named[1] ?? ''}, column ${named[2] ?? ''})`;
  const position = /position (\d+)/.exec(message)?.[1];
  return position === undefined ? '' : placeAt(text, Number(position));
}

/** The schema `text` holds, or why it holds none. */
function schemaIn(text: string, label: string): Record<string, unknown> | Refusal {
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    return `the schema \`${label}\` is not valid JSON${stoppedAt(error, text)}`;
  }
  return isRecord(schema) ? schema : `the schema \`${label}\` is not a JSON Schema: it must be an object`;
}

/** True when `instance` already holds a schema under `key`, as it holds its draft's meta-schemas. */
function holds(instance: AjvInstance, key: string): boolean {
  try {
    return instance.getSchema(key) !== undefined;
  } catch {
    return false;
  }
}

/** The file a relative reference names, beside the schema at `from`, or `null` for one whose percent-encoding is malformed. */
function siblingPath(from: string, half: string): string | null {
  try {
    return resolve(dirname(from), decodeURIComponent(half));
  } catch {
    return null;
  }
}

/** Read and register the sibling file a relative reference of `unit` names, under `key`, the key `ajv` will look it up by. */
function followSibling(ref: string, key: string | null, unit: Unit, into: Gathering): Refusal | null {
  if (key === null || unit.path === null) return `the schema \`${unit.label}\` refers to \`${ref}\`, which names no file beside it`;
  const path = siblingPath(unit.path, fileHalf(ref));
  if (path === null) return `the schema \`${unit.label}\` refers to \`${ref}\`, which is no path: its percent-encoding is malformed`;
  if (into.seen.has(key)) return null;
  const read = into.context.read(path);
  if (read === 'outside') return `the schema \`${unit.label}\` refers to \`${ref}\`, which resolves outside the repository: a schema is read only from inside it`;
  if (read === 'missing') return `the schema \`${unit.label}\` refers to \`${ref}\`, and ${into.context.nameOf(path)} can't be read`;
  const label = into.context.nameOf(path);
  const schema = schemaIn(read.text, label);
  return typeof schema === 'string' ? schema : register(schema, { key, path, label }, into);
}

/**
 * Follow one `$ref` of the file `unit`. Nothing for a reference within the
 * file, by pointer or to one of the `$id`s the file declares (`ids`, each
 * resolved), whether the reference is a URL or relative. Then a URL is a
 * finding unless `ajv` holds it, as it holds its draft's meta-schemas, and a
 * relative path is the sibling file it names.
 */
function follow(ref: { ref: string; pointer: string }, unit: Unit, base: string, ids: readonly string[], into: Gathering): Refusal | null {
  const half = fileHalf(ref.ref);
  if (half === '') return null;
  const key = resolved(half, base);
  if (key !== null && ids.includes(key)) return null;
  if (!isUrl(half)) return followSibling(ref.ref, key, unit, into);
  if (!holds(into.instance, half)) into.remote.push({ file: unit.path === null ? unit.label : into.context.nameOf(unit.path), pointer: ref.pointer, ref: ref.ref });
  return null;
}

/** Register `schema` under `unit.key`, and every sibling file its references reach. */
function register(schema: Record<string, unknown>, unit: Unit, into: Gathering): Refusal | null {
  if (into.seen.has(unit.key)) return null;
  into.seen.add(unit.key);
  const walked: Walked = { refs: [], ids: [] };
  walk(schema, '', walked);
  const own = schema['$id'];
  const base = typeof own === 'string' ? (resolved(own, unit.key) ?? unit.key) : unit.key;
  const ids = [base, ...walked.ids.flatMap((id) => resolved(id, base) ?? [])].map(fileHalf);
  for (const ref of walked.refs) {
    const refusal = follow(ref, unit, base, ids, into);
    if (refusal !== null) return refusal;
  }
  try {
    into.instance.addSchema(schema, unit.key);
  } catch (error) {
    return `the schema \`${unit.label}\` is not a valid schema: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/** The validator `ajv` builds for the schema registered under `key`, or why it can't. */
function validatorOf(instance: AjvInstance, key: string, label: string): AjvValidate | Refusal {
  try {
    return instance.getSchema(key) ?? `the schema \`${label}\` is not a valid schema`;
  } catch (error) {
    return `the schema \`${label}\` is not a valid schema: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Compile `source`, following its references to the sibling files they name. */
export function compileSchema(source: SchemaSource, context: CompileContext): Compiled {
  const root = schemaIn(source.text, source.label);
  if (typeof root === 'string') return refusedWith(root);
  const draft = draftOf(root, context.ajv);
  if (draft === null) {
    return refusedWith(`the schema \`${source.label}\` declares $schema ${JSON.stringify(root['$schema'])}, and the schema slot reads draft 2020-12 and draft-07`);
  }
  const key = resolved(source.path === null ? source.label.replaceAll(':', '/') : context.nameOf(source.path), LOCAL_BASE) ?? LOCAL_BASE;
  const into: Gathering = { instance: new draft(AJV_OPTIONS), context, seen: new Set(), remote: [] };
  const refusal = register(root, { key, path: source.path, label: source.label }, into);
  if (refusal !== null) return refusedWith(refusal);
  if (into.remote.length > 0) return { kind: 'remote', refs: into.remote };
  const validate = validatorOf(into.instance, key, source.label);
  return typeof validate === 'string' ? refusedWith(validate) : { kind: 'ready', validate };
}
