/**
 * ESLint `--format json`: an array of `{ filePath, messages: [{ ruleId,
 * severity, message, line, column }], suppressedMessages, … }`, one result
 * per file it linted, its paths absolute and its line and column 1-based.
 * `severity` is 2 for an error and 1 for a warning, and a file eslint couldn't
 * parse holds one message with `fatal: true`, no `ruleId` and severity 2.
 * Checked against eslint 9.36.0.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** Each numeric severity as eslint's own formatters print it. */
const SEVERITY_WORDS: ReadonlyMap<unknown, string> = new Map([
  [1, 'warning'],
  [2, 'error'],
]);

/**
 * Whether a warning can fail the run, not only an error. `--max-warnings`
 * makes eslint exit 1 past its count while each warning still reports
 * severity 1, so only the argv shows it. An argv that hides eslint's flags,
 * or none at all, counts as gating everything, as oxlint's does: keying a
 * warning that can't fail costs a false red, while skipping one that can
 * would mask a red run green.
 */
function eslintWarningsGate(argv: Argv): boolean {
  if (argv === undefined || !runsTool(argv, ['eslint'])) return true;
  return argv.some((arg) => arg === '--max-warnings' || arg.startsWith('--max-warnings='));
}

/** One message of the result for `file` as a finding, or `null` when it isn't one eslint's format can print. */
function messageFinding(m: unknown, file: string, warningsGate: boolean): KeyedFinding | null {
  if (!isRecord(m) || typeof m['message'] !== 'string' || m['message'].trim() === '') return null;
  const severity = SEVERITY_WORDS.get(m['severity']);
  if (severity === undefined) return null;
  const rule = str(m['ruleId']);
  return {
    file,
    ...located(oneBased(m['line'], 1), oneBased(m['column'], 1)),
    rule,
    message: m['message'],
    severity,
    gates: severity === 'error' || warningsGate,
    key: findingKey(file, rule, m['message']),
  };
}

/** One file's result as its findings, or `null` when it isn't a result eslint's format can print. */
function resultFindings(result: unknown, context: ParseContext, warningsGate: boolean): KeyedFinding[] | null {
  if (!isRecord(result) || typeof result['filePath'] !== 'string' || !Array.isArray(result['messages'])) return null;
  const file = rebasePath(context, result['filePath']);
  const findings: KeyedFinding[] = [];
  for (const m of result['messages']) {
    const found = messageFinding(m, file, warningsGate);
    if (found === null) return null;
    findings.push(found);
  }
  return findings;
}

/**
 * Every message eslint reported, keyed on its rule, and a parse error with
 * an empty rule. An error gates, and a warning gates under `--max-warnings`.
 * A message an inline directive suppressed sits in `suppressedMessages`,
 * which eslint doesn't count, so it isn't a finding. `severity` is the word
 * eslint's formatters print for the message's number.
 *
 * Returns `null` unless the payload is an array of results whose every
 * message is one the format can print: a config eslint can't load prints its
 * error on stderr and nothing here, and reading that as clean would let the
 * ratchet prune every grandfathered key, while dropping one message it can't
 * read could mask a red run green.
 */
export const eslintParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!Array.isArray(payload)) return null;
    const warningsGate = eslintWarningsGate(context.argv);
    const findings: KeyedFinding[] = [];
    for (const result of payload) {
      const found = resultFindings(result, context, warningsGate);
      if (found === null) return null;
      findings.push(...found);
    }
    return findings;
  },
};
