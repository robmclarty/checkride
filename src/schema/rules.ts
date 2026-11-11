/**
 * What a config's `schemas` key must hold before any run reads it, all of it
 * here: an array of rules, each with a `schema` that is a bundled schema
 * checkride ships or a path inside the repo (V8: never a URL, never
 * absolute in any system's spelling, never through a `..`), `files` globs, a
 * `format` that is one of the four, and, where a rule sets no `format`, globs
 * whose extensions say how to read what they match.
 *
 * The path rules are the first half of the slot's containment
 * (`./contain.ts` is the second): a config can't so much as name a schema
 * outside the repository. A symlink can still lead out, which only the real
 * path shows, at run time.
 */

import { posix } from 'node:path';

import type { SchemaFormat, SchemaRule } from '../adapters.js';
import { SCHEMA_FORMATS } from '../adapters.js';
import { isRecord } from '../json.js';
import { hasParentSegment, isAbsoluteForm, show } from '../targets/index.js';
import { bundledSchemas, isBundled, namesBundled } from './bundled.js';
import { formatOfPath, isSchemaFormat, SCHEMA_EXTENSIONS } from './formats.js';

export type { SchemaFormat, SchemaRule };

/** `items` as an error lists alternatives: `a, b or c`. */
function oneOf(items: readonly string[]): string {
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}

/** The formats, as an error lists them. */
const FORMAT_LIST = oneOf(SCHEMA_FORMATS);

/** `glob` with a closing `{a,b}` group expanded, one glob for each alternative; itself when it closes on none. */
function endings(glob: string): string[] {
  const open = glob.lastIndexOf('{');
  if (!glob.endsWith('}') || open === -1) return [glob];
  return glob.slice(open + 1, -1).split(',').map((alternative) => `${glob.slice(0, open)}${alternative}`);
}

/** The formats `glob`'s extension names, one for each ending it can take, or `null` when one of them can't be placed. */
function globFormats(glob: string): SchemaFormat[] | null {
  const formats = endings(glob).map((ending) => formatOfPath(posix.basename(ending)));
  return formats.every((format) => format !== null) ? formats : null;
}

/** The formats a rule's files are read as: the one it sets, else the ones its globs' extensions name. */
export function ruleFormats(rule: SchemaRule): SchemaFormat[] {
  if (rule.format !== undefined) return [rule.format];
  return rule.files.flatMap((glob) => globFormats(glob) ?? []);
}

/** The glob of a rule with no `format` whose extension can't say how to read its files. */
function unplacedGlob(files: readonly string[], where: string): string | null {
  const glob = files.find((candidate) => globFormats(candidate) === null);
  if (glob === undefined) return null;
  return `${where}.files has ${show(glob)}, whose extension doesn't say how to read what it matches (${oneOf(SCHEMA_EXTENSIONS)}): set ${where}.format to ${FORMAT_LIST}`;
}

/** Why a rule's `schema` names no schema checkride ships, when it names a bundled one. */
function bundledProblem(schema: unknown, where: string): string | null {
  if (typeof schema !== 'string' || !namesBundled(schema) || isBundled(schema)) return null;
  return `${where}.schema ${show(schema)} is no bundled schema: the bundled schemas are ${bundledSchemas().join(' and ')}`;
}

/** V8 for one rule: a schema is bundled or inside the repo, never fetched and never reached by a path that leaves it. */
function schemaRefProblem(ref: unknown, where: string): string | null {
  if (typeof ref !== 'string' || ref === '') {
    return `${where} must name a bundled checkride:<id> schema or a repo-relative path (got ${show(ref)})`;
  }
  if (/^https?:\/\//i.test(ref)) {
    return `${where} ${show(ref)} is a URL, and a check never fetches: name a bundled checkride:<id> schema or a repo-relative path`;
  }
  if (isAbsoluteForm(ref)) return `${where} ${show(ref)} is absolute: give it relative to the repo root`;
  return hasParentSegment(ref) ? `${where} ${show(ref)} has a '..' segment: name a schema inside the repo` : null;
}

/** The first thing wrong with one rule beyond its `schema` reference, or `null`. */
function ruleProblem(rule: unknown, where: string): string | null {
  if (!isRecord(rule)) return `${where} must be an object with files and schema (got ${show(rule)})`;
  const { files, format } = rule;
  if (!Array.isArray(files) || !files.every((glob): glob is string => typeof glob === 'string' && glob !== '')) {
    return `${where}.files must be an array of globs (got ${show(files)})`;
  }
  if (format !== undefined && !isSchemaFormat(format)) return `${where}.format must be ${FORMAT_LIST} (got ${show(format)})`;
  return bundledProblem(rule['schema'], where) ?? (format === undefined ? unplacedGlob(files, where) : null);
}

/** The first rule of `rules` that `problemOf` finds something wrong with, or `null`. */
function firstProblem(rules: readonly unknown[], problemOf: (rule: unknown, at: number) => string | null): string | null {
  for (const [at, rule] of rules.entries()) {
    const problem = problemOf(rule, at);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * The first thing wrong with a config's `schemas`, as the reason for a config
 * error, or `null` when the slot could run every rule. Every rule's `schema`
 * reference is held to V8 before any rule's other fields are read, so a
 * reference that leaves the repo is the error named, whatever else is wrong.
 */
export function schemaRulesProblem(schemas: unknown): string | null {
  if (schemas === undefined) return null;
  if (!Array.isArray(schemas)) return `schemas must be an array of rules (got ${show(schemas)})`;
  return (
    firstProblem(schemas, (rule, at) => schemaRefProblem(isRecord(rule) ? rule['schema'] : undefined, `schemas[${at}].schema`)) ??
    firstProblem(schemas, (rule, at) => ruleProblem(rule, `schemas[${at}]`))
  );
}
