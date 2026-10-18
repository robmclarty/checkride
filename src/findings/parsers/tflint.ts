/**
 * tflint `--format=json`: `{ issues: [{ rule: { name, severity }, message,
 * range: { filename, start: { line, column } } }], errors: [{ message }] }`,
 * its line and column 1-based and its `filename` relative to the directory it
 * ran from, a nested module's included under `--recursive`. A rule's
 * `severity` is `error`, `warning` or `info`, the JSON's name for a notice.
 *
 * Where `PWD` reaches that directory through a symlink, as it does for a repo
 * under macOS's `/tmp` checked without targets, tflint names a nested
 * module's file from the symlinked path while the file is its real one, so
 * the name climbs to `/` and back down (`../../../private/tmp/r/mod/a.tf`).
 * Read from `/`, such a name is the file's absolute path, which `repoRoot`
 * names from the repo root when the file lies inside it.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import type { PathBase } from '../paths.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** How severe each level is, `--minimum-failure-severity`'s values and the JSON's `info` alike. */
const RANK: Readonly<Record<string, number>> = { error: 3, warning: 2, notice: 1, info: 1 };

/** The flag that sets the lowest severity a run fails on. */
const MINIMUM = '--minimum-failure-severity';

/** The value `argv` gives `--minimum-failure-severity`, as `--flag=value` or `--flag value`, or `undefined`. */
function minimumIn(argv: readonly string[]): string | undefined {
  const at = argv.findIndex((arg) => arg === MINIMUM || arg.startsWith(`${MINIMUM}=`));
  if (at === -1) return undefined;
  const arg = argv[at] ?? '';
  return arg === MINIMUM ? argv[at + 1] : arg.slice(MINIMUM.length + 1);
}

/**
 * The lowest severity rank that fails the run, or `null` when nothing does,
 * as under `--force`. tflint 0.64.0 fails on every issue by default, a notice
 * included. An argv that hides tflint's flags, or none at all, counts as the
 * default: keying an issue that can't fail costs a false red, while skipping
 * one that can would mask a red run green.
 */
function failureRank(argv: Argv): number | null {
  if (argv === undefined || !runsTool(argv, ['tflint'])) return 1;
  if (argv.includes('--force')) return null;
  return RANK[minimumIn(argv) ?? 'notice'] ?? 1;
}

/** `file` as a finding names it: a name that climbs to `/` and back into the repo, as its real path inside it. */
function issuePath(base: PathBase, file: string): string {
  const climbed = /^(?:\.\.\/)+/.exec(file)?.[0];
  if (climbed !== undefined && base.repoRoot !== undefined) {
    const real = rebasePath(base, `/${file.slice(climbed.length)}`);
    if (!real.startsWith('/')) return real;
  }
  return rebasePath(base, file);
}

/** A record field as a record, or `{}` when it's missing or isn't one. */
function field(record: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = record[name];
  return isRecord(value) ? value : {};
}

/**
 * One issue as a finding, gating at or above `minimum` (none when it's
 * `null`), or `null` when it names no file or no message.
 */
function issueFinding(issue: Record<string, unknown>, context: ParseContext, minimum: number | null): KeyedFinding | null {
  const range = field(issue, 'range');
  const file = str(range['filename']);
  const message = str(issue['message']);
  if (!file || !message) return null;
  const rule = field(issue, 'rule');
  const name = str(rule['name']);
  const severity = str(rule['severity']);
  const path = issuePath(context, file);
  const at = field(range, 'start');
  return {
    file: path,
    ...located(oneBased(at['line'], 1), oneBased(at['column'], 1)),
    rule: name,
    message,
    ...(severity ? { severity } : {}),
    // A level tflint doesn't document counts as an error.
    gates: minimum !== null && (RANK[severity] ?? 3) >= minimum,
    key: findingKey(path, name, message),
  };
}

/**
 * Every issue that names a file and a message, keyed on its rule. An issue
 * below `--minimum-failure-severity` is marked as not gating, so the baseline
 * doesn't key it.
 *
 * Returns `null` for output with no `issues` list, or with an entry in
 * `errors`: tflint stopped short in some directory, as where a plugin
 * `tflint --init` installs is missing, so a missing issue there isn't a fixed
 * one.
 */
export const tflintParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['issues']) || asArray(payload['errors']).length > 0) return null;
    const minimum = failureRank(context.argv);
    return asArray(payload['issues']).flatMap((issue) => {
      const finding = isRecord(issue) ? issueFinding(issue, context, minimum) : null;
      return finding === null ? [] : [finding];
    });
  },
};
