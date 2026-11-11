/**
 * The `schema` built-in: validate data files against JSON Schemas, by the
 * `schemas` rules of the config.
 *
 * Each rule runs in order. Its files are the ones the repo lists at its root
 * (tracked, or untracked and not ignored; every file, outside a git repo)
 * that one of the rule's `files` globs matches. Each is read by the rule's
 * `format`, or by its extension where the rule sets none, and validated
 * against the rule's schema. A rule that matches no file is an error: a
 * config that points at nothing must not stay green.
 *
 * Every schema is compiled before any file is read, so a schema that can't be
 * used refuses the check with nothing half done.
 *
 * The result is the report the orchestrator persists as `<out>/schema.json`:
 *
 *   { "rules":  [{ "schema": "checkride:agent-skill", "files": 3 }],
 *     "errors": [{ "file": "skills/pdf/SKILL.md", "rule": 0, "instancePath": "/name",
 *                  "keyword": "pattern", "message": "must match pattern …", "line": 2 }] }
 *
 * Exit 0 with no errors, 1 otherwise. `line` is there when the parser kept
 * positions, and `param` when the keyword names the thing at fault: the
 * property a `required` error misses, the one an `additionalProperties` error
 * found. It is what tells two errors of one keyword at one pointer apart, so
 * the baseline keys on it, and never on a message.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import type { CheckOutcome } from '../links.js';
import { globRegExp, listFiles } from '../targets/index.js';
import type { ExtraCheck, ExtraError } from './bundled.js';
import { bundledSchema } from './bundled.js';
import type { Compiled, RemoteRef, SchemaSource } from './compile.js';
import { compileSchema } from './compile.js';
import type { Parsed } from './formats.js';
import { formatOfPath, parseAs } from './formats.js';
import type { SchemaFormat } from './libraries.js';
import type { AjvError, AjvValidate, SchemaLibraries } from './library-types.js';
import type { SchemaRule } from './rules.js';

/** One error of the report. `rule` is the index of the rule that found it. */
export type SchemaError = {
  file: string;
  rule: number;
  instancePath: string;
  keyword: string;
  message: string;
  /** What the keyword names as at fault, where it names something: a property, most often. */
  param?: string;
  line?: number;
};

/** The report: each rule with how many files it matched, and every error. */
export type SchemaReport = { rules: { schema: string; files: number }[]; errors: SchemaError[] };

/**
 * What the check runs with: the rules, the config file that holds them, as a
 * finding about a rule names it, the libraries a run loaded for them, and the
 * git the files are listed through.
 */
export type SchemaCheckOptions = {
  rules: readonly SchemaRule[];
  configFile: string;
  libraries: SchemaLibraries;
  git?: GitRunner;
};

/** What a run of the check came to: its outcome, or the refusal it fails with before reading a file. */
export type SchemaChecked = { outcome: CheckOutcome } | { refusal: string };

/** A rule ready to run: its schema compiled, and the check a bundled schema adds. */
type Ready = { rule: SchemaRule; compiled: Exclude<Compiled, { kind: 'refused' }>; extra?: ExtraCheck };

/**
 * A file's text, without the byte order mark an editor may have led it with,
 * or `null` for one that can't be read: a directory, a file gone or one this
 * user may not open. Bytes that aren't UTF-8 read as replacement characters,
 * which a parser then reports.
 */
function readText(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8');
    return text.startsWith('\uFEFF') ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** True for a path that is a file on disk: git still lists one a commit hasn't yet removed. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `path` as a finding names it: relative to `cwd`, with forward slashes. */
function nameIn(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join('/');
}

/** The schema a rule names: a bundled one, or the file at its repo-relative path; `null` for a file that can't be read. */
function sourceOf(rule: SchemaRule, cwd: string): { source: SchemaSource; extra?: ExtraCheck } | null {
  const bundled = bundledSchema(rule.schema);
  if (bundled !== null) return { source: { label: rule.schema, text: bundled.text, path: null }, ...(bundled.extra === undefined ? {} : { extra: bundled.extra }) };
  const path = isAbsolute(rule.schema) ? rule.schema : join(cwd, rule.schema);
  const text = readText(path);
  return text === null ? null : { source: { label: rule.schema, text, path } };
}

/** Compile one rule's schema, or the refusal for one that can't be used. */
function ready(rule: SchemaRule, at: number, cwd: string, libraries: SchemaLibraries): Ready | { refusal: string } {
  const found = sourceOf(rule, cwd);
  if (found === null) return { refusal: `checkride: schemas[${at}] names the schema \`${rule.schema}\`, which can't be read: no such file from the repo root.\n` };
  const compiled = compileSchema(found.source, { ajv: libraries.ajv, read: readText, nameOf: (path) => nameIn(cwd, path) });
  if (compiled.kind === 'refused') return { refusal: compiled.refusal };
  return { rule, compiled, ...(found.extra === undefined ? {} : { extra: found.extra }) };
}

/** What `ajv` said of one error, with the property an `additionalProperties` error is about. */
function messageOf(error: AjvError): string {
  const message = error.message ?? 'is not valid';
  const added = error.params?.['additionalProperty'];
  return typeof added === 'string' ? `${message}: '${added}'` : message;
}

/**
 * The parameters by which a keyword names the thing at fault, in the order
 * they're read: the property `required` and `dependentRequired` miss, the
 * one `additionalProperties` or `unevaluatedProperties` found, the name
 * `propertyNames` refused, and the property a `discriminator` reads. A
 * parameter that restates the schema, as `pattern`'s or `enum`'s does, isn't
 * one: it would change with the schema while the finding stayed what it was.
 */
const NAMING_PARAMS: readonly string[] = ['missingProperty', 'additionalProperty', 'unevaluatedProperty', 'propertyName', 'tag'];

/** What `error`'s keyword names as at fault, or `undefined` for a keyword that names nothing. */
function paramOf(error: AjvError): string | undefined {
  const values = NAMING_PARAMS.map((name) => error.params?.[name]);
  return values.find((value): value is string => typeof value === 'string');
}

/** One of `ajv`'s errors, in the fields the report carries. */
function reported(error: AjvError): Reported {
  const param = paramOf(error);
  return { instancePath: error.instancePath, keyword: error.keyword, message: messageOf(error), ...(param === undefined ? {} : { param }) };
}

/** An error before it is placed in its file: what a schema or a bundled check reports. */
type Reported = ExtraError & { param?: string };

/** The errors `validate` reports of `value`. A validator that throws is one error, never the end of the check. */
function invalidIn(validate: AjvValidate, value: unknown): Reported[] {
  try {
    return validate(value) ? [] : (validate.errors ?? []).map(reported);
  } catch (error) {
    return [{ instancePath: '', keyword: 'validate', message: `couldn't be validated: ${error instanceof Error ? error.message : String(error)}` }];
  }
}

/** An error of the report, with its line when `parsed` can place its pointer. */
function located(file: string, rule: number, error: Reported, parsed: Extract<Parsed, { ok: true }>): SchemaError {
  const line = parsed.lineOf(error.instancePath);
  return { file, rule, ...error, ...(line === undefined ? {} : { line }) };
}

/** An error about a whole file, with no pointer into it. */
function wholeFile(file: string, rule: number, keyword: string, message: string, line?: number): SchemaError[] {
  return [{ file, rule, instancePath: '', keyword, message, ...(line === undefined ? {} : { line }) }];
}

/** One file read as its rule's format, or by its extension where the rule sets none; or the error that stopped the read. */
function readAs(file: string, at: number, rule: SchemaRule, run: { cwd: string; libraries: SchemaLibraries }): Extract<Parsed, { ok: true }> | SchemaError[] {
  const text = readText(join(run.cwd, file));
  if (text === null) return wholeFile(file, at, 'read', "can't be read");
  const format = rule.format ?? formatOfPath(file);
  if (format === null) return wholeFile(file, at, 'format', `has an extension that doesn't say how to read it: set schemas[${at}].format`);
  const parsed = parsedSafely(format, text, run.libraries);
  return parsed.ok ? parsed : wholeFile(file, at, parsed.keyword, parsed.message, parsed.line);
}

/** {@link parseAs}, with a parser's own throw read as the file not parsing: one bad file is a finding, never the end of the check. */
function parsedSafely(format: SchemaFormat, text: string, libraries: SchemaLibraries): Parsed {
  try {
    return parseAs(format, text, libraries);
  } catch (error) {
    return { ok: false, keyword: 'parse', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Every error of one file: the one that stopped its read, or each its schema and its bundled check report. */
function fileErrors(file: string, at: number, { rule, compiled, extra }: Ready, run: { cwd: string; libraries: SchemaLibraries }): SchemaError[] {
  if (compiled.kind !== 'ready') return [];
  const parsed = readAs(file, at, rule, run);
  if (Array.isArray(parsed)) return parsed;
  const added = extra?.(join(run.cwd, file), parsed.value) ?? [];
  return [...invalidIn(compiled.validate, parsed.value), ...added].map((error) => located(file, at, error, parsed));
}

/** The finding for a `$ref` to a URL, on the schema file that holds it. */
function remoteError(ref: RemoteRef, rule: number): SchemaError {
  return { file: ref.file, rule, instancePath: ref.pointer, keyword: '$ref', message: `refers to the URL ${ref.ref}, and a check makes no network call: keep the schema it names in the repo, and refer to it by relative path` };
}

/** What every rule of one run reads: the repo, the libraries, the config file's name, and whether a listed path is a file on disk. */
type Run = { cwd: string; libraries: SchemaLibraries; configFile: string; onDisk: (file: string) => boolean };

/**
 * Whether a listed path is a file on disk, asked once for each path a rule's
 * globs match and never for the rest: a repo lists far more files than its
 * rules name, and each answer is a `stat`.
 */
function diskLookup(cwd: string): (file: string) => boolean {
  const known = new Map<string, boolean>();
  return (file) => {
    const seen = known.get(file);
    if (seen !== undefined) return seen;
    const found = isFile(join(cwd, file));
    known.set(file, found);
    return found;
  };
}

/** One rule's row of the report, and its errors, over the paths the repo lists. */
function ruleResult(item: Ready, at: number, listed: readonly string[], run: Run): { row: SchemaReport['rules'][number]; errors: SchemaError[] } {
  const globs = item.rule.files.map(globRegExp);
  const matched = listed.filter((file) => globs.some((glob) => glob.test(file)) && run.onDisk(file));
  const row = { schema: item.rule.schema, files: matched.length };
  if (matched.length === 0) {
    const message = `matches no files (${item.rule.files.join(', ')})`;
    return { row, errors: [{ file: run.configFile, rule: at, instancePath: `/schemas/${at}/files`, keyword: 'files', message }] };
  }
  const remote = item.compiled.kind === 'remote' ? item.compiled.refs.map((ref) => remoteError(ref, at)) : [];
  return { row, errors: [...remote, ...matched.flatMap((file) => fileErrors(file, at, item, run))] };
}

/** One error as stderr prints it: `schema: <file>:<line>: <pointer> <message> [<keyword>]`. */
function printed(error: SchemaError): string {
  const place = error.line === undefined ? error.file : `${error.file}:${error.line}`;
  const what = error.instancePath === '' ? error.message : `${error.instancePath} ${error.message}`;
  return `schema: ${place}: ${what} [${error.keyword}]`;
}

/** The outcome of a report: exit 0 with no errors, 1 otherwise, the report on stdout either way. */
function outcomeOf(report: SchemaReport): CheckOutcome {
  const ok = report.errors.length === 0;
  const stderr = ok ? '' : `${report.errors.map(printed).join('\n')}\n`;
  return { ok, exit_code: ok ? 0 : 1, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr };
}

/** The paths the repo lists, sorted, or the refusal for a git that can't list them. */
async function listedFiles(cwd: string, git: GitRunner): Promise<string[] | string> {
  try {
    return (await listFiles(cwd, '.', git, 'the schema check')).toSorted();
  } catch (error) {
    return `checkride: ${error instanceof Error ? error.message : String(error)}.\n`;
  }
}

/**
 * Run every rule against the repo at `cwd`. A schema that can't be used
 * refuses the check before any file is read; a file that can't be read or
 * parsed is an error of the report, never a throw.
 */
export async function checkSchemas(cwd: string, options: SchemaCheckOptions): Promise<SchemaChecked> {
  const items: Ready[] = [];
  for (const [at, rule] of options.rules.entries()) {
    const item = ready(rule, at, cwd, options.libraries);
    if ('refusal' in item) return item;
    items.push(item);
  }
  const listed = await listedFiles(cwd, options.git ?? realGit(cwd));
  if (typeof listed === 'string') return { refusal: listed };
  const run: Run = { cwd, libraries: options.libraries, configFile: options.configFile, onDisk: diskLookup(cwd) };
  const results = items.map((item, at) => ruleResult(item, at, listed, run));
  return { outcome: outcomeOf({ rules: results.map((r) => r.row), errors: results.flatMap((r) => r.errors) }) };
}
