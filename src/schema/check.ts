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
 * used refuses the check with nothing half done, and two rules that name one
 * schema share one compile.
 *
 * A file is read only when its real path is inside the repository
 * (`./contain.ts`). A schema outside it refuses the check, and a matched data
 * file outside it, a symlink that leaves the repo, is an error on that file
 * and is never opened.
 *
 * Each file is resolved, read and validated on its own, behind its own
 * `await`s, so the orchestrator's loop keeps draining the other checks' pipes
 * and firing their timers while this one works. The report keeps the order
 * the rules and the listed files have.
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

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { GitRunner } from '../git.js';
import { realGit } from '../git.js';
import type { CheckOutcome } from '../links.js';
import { globRegExp, listFiles } from '../targets/index.js';
import type { ExtraCheck, ExtraError } from './bundled.js';
import { bundledSchema } from './bundled.js';
import type { Compiled, RemoteRef, SchemaRead, SchemaSource } from './compile.js';
import { compileSchema } from './compile.js';
import type { Located } from './contain.js';
import { located, locatedSync, realRoot } from './contain.js';
import type { Parsed } from './formats.js';
import { formatOfPath, parseAs } from './formats.js';
import type { AjvError, AjvValidate, SchemaLibraries } from './library-types.js';
import type { SchemaFormat, SchemaRule } from './rules.js';

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

/** A schema ready to validate with: compiled, and the check a bundled schema adds. */
type Schema = { compiled: Exclude<Compiled, { kind: 'refused' }>; extra?: ExtraCheck };

/** A rule ready to run, with its schema. */
type Ready = Schema & { rule: SchemaRule };

/** `text` without the byte order mark an editor may have led it with. */
function withoutMark(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * A schema file's text, by the containment rule: read only when its real
 * path is inside the repository at the real root `root`. `missing` covers a
 * directory, a file gone and one this user may not open.
 */
function readSchema(root: string, path: string): SchemaRead {
  const where = locatedSync(root, path);
  if (typeof where === 'string') return where;
  try {
    return { text: withoutMark(readFileSync(where.inside, 'utf8')) };
  } catch {
    return 'missing';
  }
}

/** `path` as a finding names it: relative to `cwd`, with forward slashes. */
function nameIn(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join('/');
}

/** Where a run reads from: the repo as a finding names paths from it, and its real path, which containment is tested against. */
type Repo = { cwd: string; root: string };

/** The schema a rule names: a bundled one, or the file at its repo-relative path; or why that file isn't read. */
function sourceOf(rule: SchemaRule, repo: Repo): { source: SchemaSource; extra?: ExtraCheck } | 'outside' | 'missing' {
  const bundled = bundledSchema(rule.schema);
  if (bundled !== null) return { source: { label: rule.schema, text: bundled.text, path: null }, ...(bundled.extra === undefined ? {} : { extra: bundled.extra }) };
  const path = isAbsolute(rule.schema) ? rule.schema : join(repo.cwd, rule.schema);
  const read = readSchema(repo.root, path);
  return typeof read === 'string' ? read : { source: { label: rule.schema, text: read.text, path } };
}

/** Compile one rule's schema, or the refusal for one that can't be used. */
function compiledFor(rule: SchemaRule, at: number, repo: Repo, libraries: SchemaLibraries): Schema | { refusal: string } {
  const found = sourceOf(rule, repo);
  if (found === 'outside') return { refusal: `checkride: schemas[${at}] names the schema \`${rule.schema}\`, which resolves outside the repository: a schema is read only from inside it.\n` };
  if (found === 'missing') return { refusal: `checkride: schemas[${at}] names the schema \`${rule.schema}\`, which can't be read: no such file from the repo root.\n` };
  const compiled = compileSchema(found.source, { ajv: libraries.ajv, read: (path) => readSchema(repo.root, path), nameOf: (path) => nameIn(repo.cwd, path) });
  if (compiled.kind === 'refused') return { refusal: compiled.refusal };
  return { compiled, ...(found.extra === undefined ? {} : { extra: found.extra }) };
}

/**
 * Every rule with its schema compiled, or the first refusal. A schema two
 * rules name is read and compiled once, at the first rule that names it.
 */
function readyRules(rules: readonly SchemaRule[], repo: Repo, libraries: SchemaLibraries): Ready[] | { refusal: string } {
  const schemas = new Map<string, Schema>();
  const items: Ready[] = [];
  for (const [at, rule] of rules.entries()) {
    const schema = schemas.get(rule.schema) ?? compiledFor(rule, at, repo, libraries);
    if ('refusal' in schema) return schema;
    schemas.set(rule.schema, schema);
    items.push({ ...schema, rule });
  }
  return items;
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
function placed(file: string, rule: number, error: Reported, parsed: Extract<Parsed, { ok: true }>): SchemaError {
  const line = parsed.lineOf(error.instancePath);
  return { file, rule, ...error, ...(line === undefined ? {} : { line }) };
}

/** An error about a whole file, with no pointer into it. */
function wholeFile(file: string, rule: number, keyword: string, message: string, line?: number): SchemaError[] {
  return [{ file, rule, instancePath: '', keyword, message, ...(line === undefined ? {} : { line }) }];
}

/** What every rule of one run reads: the repo, the libraries, the config file's name, and where each listed path really is. */
type Run = Repo & { libraries: SchemaLibraries; configFile: string; where: (file: string) => Promise<Entry> };

/**
 * A listed path, resolved: `file`, with the real path to read it by; `outside`,
 * a symlink that leaves the repository; or `none`, for a path that is no file
 * on disk, as git still lists one a commit hasn't yet removed.
 */
type Entry = { kind: 'file'; real: string } | { kind: 'outside' } | { kind: 'none' };

/** {@link Entry} for where a listed path was {@link Located}. A path inside the repo counts only when it is a regular file. */
async function entryOf(where: Located): Promise<Entry> {
  if (where === 'outside') return { kind: 'outside' };
  if (where === 'missing') return { kind: 'none' };
  try {
    return (await stat(where.inside)).isFile() ? { kind: 'file', real: where.inside } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/**
 * Where each listed path really is, asked once for each path a rule's globs
 * match and never for the rest: a repo lists far more files than its rules
 * name, and each answer is a `realpath` and a `stat`.
 */
function entryLookup(repo: Repo): (file: string) => Promise<Entry> {
  const known = new Map<string, Promise<Entry>>();
  return (file) => {
    const seen = known.get(file);
    if (seen !== undefined) return seen;
    const found = located(repo.root, join(repo.cwd, file)).then(entryOf);
    known.set(file, found);
    return found;
  };
}

/** The text at the real path `real`, or `null` for a file that can't be read. Bytes that aren't UTF-8 read as replacement characters, which a parser then reports. */
async function readData(real: string): Promise<string | null> {
  try {
    return withoutMark(await readFile(real, 'utf8'));
  } catch {
    return null;
  }
}

/** One file read as its rule's format, or by its extension where the rule sets none; or the error that stopped the read. */
async function readAs(file: string, real: string, at: number, rule: SchemaRule, run: Run): Promise<Extract<Parsed, { ok: true }> | SchemaError[]> {
  const text = await readData(real);
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

/**
 * Every error of one matched file: that it leaves the repository, which
 * stops it being read at all; the one that stopped its read; or each its
 * schema and its bundled check report.
 */
async function fileErrors(file: string, at: number, { rule, compiled, extra }: Ready, run: Run): Promise<SchemaError[]> {
  const entry = await run.where(file);
  if (entry.kind !== 'file') return wholeFile(file, at, 'symlink', "resolves outside the repository, so it isn't read");
  if (compiled.kind !== 'ready') return [];
  const parsed = await readAs(file, entry.real, at, rule, run);
  if (Array.isArray(parsed)) return parsed;
  const added = extra?.(join(run.cwd, file), parsed.value) ?? [];
  return [...invalidIn(compiled.validate, parsed.value), ...added].map((error) => placed(file, at, error, parsed));
}

/** The finding for a `$ref` to a URL, on the schema file that holds it. */
function remoteError(ref: RemoteRef, rule: number): SchemaError {
  return { file: ref.file, rule, instancePath: ref.pointer, keyword: '$ref', message: `refers to the URL ${ref.ref}, and a check makes no network call: keep the schema it names in the repo, and refer to it by relative path` };
}

/** The paths among `listed` that `item`'s globs match and that are there to check: a file, or a symlink that leaves the repo. */
async function matchedBy(item: Ready, listed: readonly string[], run: Run): Promise<string[]> {
  const globs = item.rule.files.map(globRegExp);
  const named = listed.filter((file) => globs.some((glob) => glob.test(file)));
  const entries = await Promise.all(named.map((file) => run.where(file)));
  return named.filter((_, at) => entries[at]?.kind !== 'none');
}

/** One rule's row of the report, and its errors, over the paths the repo lists. */
async function ruleResult(item: Ready, at: number, listed: readonly string[], run: Run): Promise<{ row: SchemaReport['rules'][number]; errors: SchemaError[] }> {
  const matched = await matchedBy(item, listed, run);
  const row = { schema: item.rule.schema, files: matched.length };
  if (matched.length === 0) {
    const message = `matches no files (${item.rule.files.join(', ')})`;
    return { row, errors: [{ file: run.configFile, rule: at, instancePath: `/schemas/${at}/files`, keyword: 'files', message }] };
  }
  const remote = item.compiled.kind === 'remote' ? item.compiled.refs.map((ref) => remoteError(ref, at)) : [];
  // Each file is read and checked on its own, behind its own awaits; `map` keeps the listed order.
  const perFile = await Promise.all(matched.map((file) => fileErrors(file, at, item, run)));
  return { row, errors: [...remote, ...perFile.flat()] };
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
  const repo: Repo = { cwd, root: realRoot(cwd) };
  const items = readyRules(options.rules, repo, options.libraries);
  if ('refusal' in items) return items;
  const listed = await listedFiles(cwd, options.git ?? realGit(cwd));
  if (typeof listed === 'string') return { refusal: listed };
  const run: Run = { ...repo, libraries: options.libraries, configFile: options.configFile, where: entryLookup(repo) };
  const results = await Promise.all(items.map((item, at) => ruleResult(item, at, listed, run)));
  return { outcome: outcomeOf({ rules: results.map((r) => r.row), errors: results.flatMap((r) => r.errors) }) };
}
