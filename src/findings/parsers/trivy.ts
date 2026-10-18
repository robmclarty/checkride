/**
 * trivy `config --format json`: `{ Results: [{ Target, Misconfigurations:
 * [{ ID, Message, Severity, Status, CauseMetadata: { StartLine } }] }] }`,
 * each `Target` a file relative to the directory scanned and each line
 * 1-based. A check names no column. `Severity` is `LOW`, `MEDIUM`, `HIGH`,
 * `CRITICAL` or `UNKNOWN`, and `Status` is `FAIL` for a misconfiguration,
 * `PASS` only under `--include-non-failures`. A scan that found nothing to
 * scan prints no `Results` at all.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** The value an argv flag takes, as `--flag=value` or `--flag value`, from its first spelling found. */
function flagValue(argv: readonly string[], spellings: readonly string[]): string | undefined {
  for (const [i, arg] of argv.entries()) {
    const spelling = spellings.find((s) => arg === s || arg.startsWith(`${s}=`));
    if (spelling !== undefined) return arg === spelling ? argv[i + 1] : arg.slice(spelling.length + 1);
  }
  return undefined;
}

/**
 * Whether a misconfiguration of `severity` fails the run: never without a
 * nonzero `--exit-code`, since trivy 0.76.0 exits 0 on any finding by
 * default, and otherwise when `--severity` lists its level, or always when
 * the flag is absent. An argv that hides trivy's flags can't say, so its
 * findings leave `gates` out; with no argv at all, the registry's own args,
 * `--exit-code 1` and no `--severity`, gate every finding.
 */
function gatesAt(severity: string, argv: Argv): boolean | undefined {
  if (argv === undefined) return true;
  if (!runsTool(argv, ['trivy'])) return undefined;
  const exitCode = Number(flagValue(argv, ['--exit-code']) ?? '0');
  if (!Number.isInteger(exitCode) || exitCode === 0) return false;
  const listed = flagValue(argv, ['--severity', '-s']);
  return listed === undefined || listed.split(',').map((s) => s.trim().toUpperCase()).includes(severity.toUpperCase());
}

/**
 * One failed check in `path` as a finding, or `null` for a passed check or
 * one with no message.
 */
function checkFinding(check: Record<string, unknown>, path: string, argv: Argv): KeyedFinding | null {
  const status = str(check['Status']);
  const message = str(check['Message']);
  if ((status && status !== 'FAIL') || !message) return null;
  const rule = str(check['ID']);
  const severity = str(check['Severity']);
  const cause = isRecord(check['CauseMetadata']) ? check['CauseMetadata'] : {};
  const gates = gatesAt(severity, argv);
  return {
    file: path,
    ...located(oneBased(cause['StartLine'], 1), undefined),
    rule,
    message,
    ...(severity ? { severity } : {}),
    ...(gates !== undefined ? { gates } : {}),
    key: findingKey(path, rule, message),
  };
}

/** The findings of one result: each failed check in the file its `Target` names. */
function resultFindings(result: unknown, context: ParseContext): KeyedFinding[] {
  if (!isRecord(result)) return [];
  const path = rebasePath(context, str(result['Target']));
  return asArray(result['Misconfigurations']).flatMap((check) => {
    const finding = isRecord(check) ? checkFinding(check, path, context.argv) : null;
    return finding === null ? [] : [finding];
  });
}

/**
 * Every failed check with a message, keyed on its ID, at the line its cause
 * starts on. Served to `checkride/findings` but never keyed into the
 * baseline: a misconfiguration is a security finding to fix, not a style
 * debt to grandfather (R12.2).
 *
 * Returns `null` for output that isn't trivy's report object: a scan that
 * failed prints its error on stderr and nothing on stdout.
 */
export const trivyConfigParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || payload['SchemaVersion'] === undefined) return null;
    return asArray(payload['Results']).flatMap((result) => resultFindings(result, context));
  },
};
