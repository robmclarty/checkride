/**
 * What a config's `schemas` rules must hold before any run reads one: `files`
 * globs, a `format` that is one of the four, a bundled schema checkride
 * ships, and, where a rule sets no `format`, globs whose extensions say how
 * to read what they match. A rule's `schema` reference itself (never a URL,
 * never absolute) is `../targets/resolve.ts`'s to check, as V8.
 */

import { posix } from 'node:path';

import { isRecord } from '../json.js';
import { bundledSchemas, isBundled, namesBundled } from './bundled.js';
import { formatOfPath, isSchemaFormat, SCHEMA_FORMATS } from './formats.js';
import type { SchemaFormat } from './libraries.js';

/** One rule, as the slot reads it. */
export type SchemaRule = {
  readonly files: readonly string[];
  readonly schema: string;
  readonly format?: SchemaFormat;
};

/** The formats, as an error lists them. */
const FORMAT_LIST = `${SCHEMA_FORMATS.slice(0, -1).join(', ')} or ${SCHEMA_FORMATS.at(-1) ?? ''}`;

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

/** A value as an error quotes it. */
function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** The glob of a rule with no `format` whose extension can't say how to read its files. */
function unplacedGlob(files: readonly string[], where: string): string | null {
  const glob = files.find((candidate) => globFormats(candidate) === null);
  if (glob === undefined) return null;
  return `${where}.files has ${show(glob)}, whose extension doesn't say how to read what it matches (.json, .jsonc, .yaml, .yml, .md or .mdx): set ${where}.format to ${FORMAT_LIST}`;
}

/** Why a rule's `schema` names no schema checkride ships, when it names a bundled one. */
function bundledProblem(schema: unknown, where: string): string | null {
  if (typeof schema !== 'string' || !namesBundled(schema) || isBundled(schema)) return null;
  return `${where}.schema ${show(schema)} is no bundled schema: the bundled schemas are ${bundledSchemas().join(' and ')}`;
}

/** The first thing wrong with one rule, or `null`. */
function ruleProblem(rule: unknown, where: string): string | null {
  if (!isRecord(rule)) return `${where} must be an object with files and schema (got ${show(rule)})`;
  const { files, format } = rule;
  if (!Array.isArray(files) || !files.every((glob): glob is string => typeof glob === 'string' && glob !== '')) {
    return `${where}.files must be an array of globs (got ${show(files)})`;
  }
  if (format !== undefined && !isSchemaFormat(format)) return `${where}.format must be ${FORMAT_LIST} (got ${show(format)})`;
  return bundledProblem(rule['schema'], where) ?? (format === undefined ? unplacedGlob(files, where) : null);
}

/** The first rule of `schemas` the slot couldn't run, as the reason for a config error, or `null` when it could run them all. */
export function schemaRulesProblem(schemas: unknown): string | null {
  if (!Array.isArray(schemas)) return null;
  for (const [at, rule] of schemas.entries()) {
    const problem = ruleProblem(rule, `schemas[${at}]`);
    if (problem !== null) return problem;
  }
  return null;
}
